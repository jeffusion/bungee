import { Readable } from 'node:stream';
import { constants, createGunzip, createZstdDecompress } from 'node:zlib';

export class BodyProcessingError extends Error {
  constructor(readonly status: number, readonly code: string, readonly limitBytes?: number, readonly receivedBytes?: number) { super(code); this.name = 'BodyProcessingError'; }
}
let retainedBytes = 0;
let activeDecoders = 0;
let activeObserverDecoders = 0;
const RETAINED_LIMIT = 128 * 1024 * 1024;
function reserve(bytes: number): void {
  if (retainedBytes + bytes > RETAINED_LIMIT) throw new BodyProcessingError(503, 'body_buffer_capacity');
  retainedBytes += bytes;
}
/** Shared lease also accounts for pending necessary SSE frames. */
export class BodyBufferLease {
  private bytes = 0;
  add(bytes: number): void { reserve(bytes); this.bytes += bytes; }
  release(bytes: number): void { const count=Math.min(bytes,this.bytes);this.bytes-=count;retainedBytes-=count; }
  dispose(): void { this.release(this.bytes); }
}
export function isJsonMediaType(value: string): boolean { return /^(?:application\/json|[^;\s]+\+json)(?:\s*;|$)/i.test(value); }
export function isObjectBody(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** A single owned reader. Reading JSON preserves the wire representation for dispatch. */
export class BodySource {
  private source: ReadableStream<Uint8Array> | null;
  private bytes?: Uint8Array;
  private jsonPromise?: Promise<unknown>;
  private decodedPromise?: Promise<Uint8Array>;
  private retained = 0;
  private consumed = false;
  private disposed = false;
  readonly reasons: string[] = [];
  lastError?: BodyProcessingError;
  mode: 'empty' | 'opaque-stream' | 'replayable-bytes';
  constructor(source: ReadableStream<Uint8Array> | null, readonly maxBytes: number, readonly coding = '', readonly signal?: AbortSignal) {
    this.source = source; this.mode = source ? 'opaque-stream' : 'empty';
  }
  get replayable(): boolean { return this.mode === 'empty' || this.bytes !== undefined; }
  private hold(bytes: number): void { reserve(bytes); this.retained += bytes; }
  dispose(): void { if (this.disposed) return; this.disposed = true; retainedBytes -= this.retained; this.retained = 0; this.bytes = undefined; this.jsonPromise = undefined; this.decodedPromise = undefined; }
  async buffer(reason: string): Promise<Uint8Array> {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
    if (this.bytes) return this.bytes;
    if (this.consumed) throw new BodyProcessingError(503, 'body_not_replayable');
    this.consumed = true;
    if (!this.source) return this.bytes = new Uint8Array();
    const reader = this.source.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const part = await readBodyChunk(reader, this.signal); if (part.done) break;
        total += part.value.byteLength;
        if (total > this.maxBytes) throw new BodyProcessingError(413, 'request_body_too_large', this.maxBytes, total);
        this.hold(part.value.byteLength); chunks.push(part.value);
      }
      this.hold(total);
      const result = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      retainedBytes -= total; this.retained -= total;
      this.bytes = result; this.source = null; this.mode = 'replayable-bytes'; return result;
    } catch (error) { void reader.cancel(error).catch(() => undefined); this.dispose(); throw error; }
    finally { reader.releaseLock(); }
  }
  async decoded(reason: string): Promise<Uint8Array> {
    if (!this.decodedPromise) this.decodedPromise = (async()=> {
      const wire = await this.buffer(reason);
      if (!this.coding || this.coding.trim().toLowerCase() === 'identity') return wire;
      const input = new ReadableStream<Uint8Array>({start(controller){controller.enqueue(wire);controller.close();}});
      const reader = decodeStream(input,this.coding,this.maxBytes,this.signal).getReader();const chunks:Uint8Array[]=[];let size=0;
      try {while(true){const part=await reader.read();if(part.done)break;this.hold(part.value.byteLength);size+=part.value.byteLength;chunks.push(part.value);}
        this.hold(size);const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
        retainedBytes-=size;this.retained-=size;return result;
      } catch(error){void reader.cancel(error).catch(()=>undefined);throw error;} finally{reader.releaseLock();}
    })();
    return this.decodedPromise;
  }
  async json(reason: string, emptyObject = false): Promise<any> {
    if (!this.jsonPromise) this.jsonPromise = (async () => {
      const decoded = await this.decoded(reason);
      if (!decoded.byteLength && emptyObject) return {};
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); }
      catch { throw new BodyProcessingError(400, 'invalid_json_body'); }
    })();
    return this.jsonPromise;
  }
  take(): BodyInit | null {
    if (this.bytes) return this.bytes as BodyInit;
    if (!this.source) return null;
    if (this.consumed) throw new BodyProcessingError(503, 'body_not_replayable');
    this.consumed = true;
    const stream = limitStream(this.source, this.maxBytes, this.signal, error => {if(error instanceof BodyProcessingError)this.lastError=error;}); this.source = null; return stream;
  }
}
export async function readBodyChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw new BodyProcessingError(408, 'body_processing_timeout');
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new BodyProcessingError(408, 'body_processing_timeout')); void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export interface OwnedDecodedStream extends ReadableStream<Uint8Array> { dispose():void }
export function limitStream(source: ReadableStream<Uint8Array>, max: number, signal?: AbortSignal, onError?: (error:unknown)=>void): OwnedDecodedStream {
  const reader = source.getReader(); let count = 0;
  const detach=()=>signal?.removeEventListener('abort',dispose);
  const dispose=()=>{detach();void reader.cancel(signal?.reason ?? 'body stream disposed').catch(()=>undefined);};
  const output = new ReadableStream<Uint8Array>({
    async pull(controller) { try { const part = await readBodyChunk(reader, signal); if (part.done) { detach();controller.close(); return; }
      count += part.value.byteLength; if (count > max) throw new BodyProcessingError(413, 'request_body_too_large', max, count); controller.enqueue(part.value);
    } catch (error) { detach();onError?.(error); void reader.cancel(error).catch(() => undefined); controller.error(error); } },
    cancel(reason) {detach();return reader.cancel(reason); },
  }, { highWaterMark: 0 }) as OwnedDecodedStream;
  Object.defineProperty(output,'dispose',{value:dispose});
  signal?.addEventListener('abort',dispose,{once:true});if(signal?.aborted)dispose();
  return output;
}
export function decodeStream(source: ReadableStream<Uint8Array>, coding: string, max: number, signal?: AbortSignal, optional = false): OwnedDecodedStream {
  const normalized = coding.trim().toLowerCase();
  if (!normalized || normalized === 'identity') return limitStream(source, max, signal);
  if (normalized !== 'gzip' && normalized !== 'zstd') throw new BodyProcessingError(415, 'unsupported_content_encoding');
  if ((optional ? activeObserverDecoders : activeDecoders) >= 2) throw new BodyProcessingError(503, 'body_decoder_capacity');
  if (optional) activeObserverDecoders++; else activeDecoders++;
  let nodeStream: ReturnType<typeof createGunzip>;
  try {
    nodeStream = normalized === 'gzip' ? createGunzip() : createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: 23 } }) as any;
  } catch { (optional ? activeObserverDecoders-- : activeDecoders--); throw new BodyProcessingError(400, 'invalid_compressed_body'); }
  const input = Readable.fromWeb(limitStream(source, max, signal) as any);
  const onInputError = (error: Error) => nodeStream.destroy(error);
  input.on('error', onInputError); input.pipe(nodeStream);
  let released = false;
  const release = () => { if (!released) { released = true; signal?.removeEventListener('abort',release); (optional ? activeObserverDecoders-- : activeDecoders--); input.destroy(); nodeStream.destroy(); } };
  const reader = (Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>).getReader(); let bytes = 0;
  const output=new ReadableStream<Uint8Array>({
    async pull(controller) { try { const part = await readBodyChunk(reader, signal); if (part.done) { release(); controller.close(); return; }
      bytes += part.value.byteLength; if (bytes > max) throw new BodyProcessingError(413, 'decoded_body_too_large', max, bytes); controller.enqueue(part.value);
    } catch (error) { release(); void reader.cancel(error).catch(() => undefined); controller.error(error instanceof BodyProcessingError ? error : new BodyProcessingError(400, 'invalid_compressed_body')); } },
    async cancel(reason) { release(); await reader.cancel(reason).catch(() => undefined); },
  }, { highWaterMark: 0 }) as OwnedDecodedStream;
  Object.defineProperty(output,'dispose',{value:release});
  signal?.addEventListener('abort',release,{once:true});if(signal?.aborted)release();
  return output;
}
export function reconcileEntityHeaders(headers: Headers, body: BodyInit | null, modified: boolean): void {
  if (!modified) return;
  headers.delete('content-encoding'); headers.delete('transfer-encoding'); headers.delete('content-length');
  if (typeof body === 'string') headers.set('content-length', String(Buffer.byteLength(body)));
  else if (body instanceof Uint8Array) headers.set('content-length', String(body.byteLength));
}
