import { Readable } from 'node:stream';
import { constants, createGunzip, createZstdDecompress } from 'node:zlib';

export class BodyProcessingError extends Error {
  constructor(readonly status: number, readonly code: string, readonly limitBytes?: number, readonly receivedBytes?: number) { super(code); this.name = 'BodyProcessingError'; }
}
import type { BodyConsumer, BodyEvent, BodyHandle, BodyViewIdentity } from './body-contracts';
import { bodyMetrics, bodyResources, DEFAULT_BODY_PARSER_BYTES } from './body-resources';
import { BodyEventSession, BodySSEFramer } from './body-events';
const handles = new WeakMap<BodyHandle, BodySource>();
export function bodySourceForHandle(handle: BodyHandle): BodySource | undefined {return handles.get(handle);}
const sources = new WeakMap<ReadableStream<Uint8Array>, BodySource>();
const readerCancellations = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, Promise<void>>();
/** Cancellation belongs to the reader owner and remains observable until the source settles. */
export function cancelBodyReader(reader:ReadableStreamDefaultReader<Uint8Array>, reason?:unknown):Promise<void> {
  let work=readerCancellations.get(reader);
  if(!work){work=reader.cancel(reason);readerCancellations.set(reader,work);void work.catch(()=>undefined);}
  return work;
}
export function bindBodySource(stream:ReadableStream<Uint8Array>,source:BodySource):void {sources.set(stream,source);}
export function bodySourceFor(stream: ReadableStream<Uint8Array>): BodySource | undefined { return sources.get(stream); }
function reserve(bytes: number, optional = false, logging=false): void {
  if(logging && bodyMetrics.loggerBytes+bytes>bodyResources.loggerMemoryBytes)throw new BodyProcessingError(503,'body_buffer_capacity');
  if (bodyMetrics.retainedBytes + bytes > bodyResources.workerMemoryBytes || (optional && bodyMetrics.optionalBytes + bytes > bodyResources.optionalMemoryBytes)) throw new BodyProcessingError(503, 'body_buffer_capacity');
  if(logging)bodyMetrics.loggerBytes+=bytes;
  bodyMetrics.retainedBytes += bytes;
  if(optional) bodyMetrics.optionalBytes += bytes;
  bodyMetrics.peakBytes = Math.max(bodyMetrics.peakBytes, bodyMetrics.retainedBytes);
}
/** One accounting lease per retained allocation, shared references do not reserve twice. */
export class BodyBufferLease {
  private bytes = 0;
  constructor(private optional = false,private logging=false) {}
  promote(): void {if(this.optional){bodyMetrics.optionalBytes-=this.bytes;this.optional=false;}}
  add(bytes: number): void { reserve(bytes, this.optional,this.logging); this.bytes += bytes; }
  release(bytes: number): void { const count=Math.min(bytes,this.bytes);this.bytes-=count;bodyMetrics.retainedBytes-=count;if(this.optional)bodyMetrics.optionalBytes-=count;if(this.logging)bodyMetrics.loggerBytes-=count; }
  dispose(): void { this.release(this.bytes); }
}
export function freezeBodyValue<T>(root:T):T {
  const pending:object[]=[];if(root!==null&&typeof root==='object')pending.push(root);
  while(pending.length){const value=pending.pop()!;if(Object.isFrozen(value))continue;Object.freeze(value);
    for(const key in value){if(!Object.hasOwn(value,key))continue;const child=(value as Record<string,unknown>)[key];if(child!==null&&typeof child==='object'&&!Object.isFrozen(child))pending.push(child);}
  }return root;
}
function consumerResult<T>(work: Promise<T>, consumer?: BodyConsumer): Promise<T> {
  const signal=consumer?.signal;
  if(!signal) return work;
  if(signal.aborted) return Promise.reject(new BodyProcessingError(408,'body_consumer_cancelled'));
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new BodyProcessingError(408,'body_consumer_cancelled'));};
    signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export const defaultBodyIdentity: BodyViewIdentity = Object.freeze({requestId:'',attemptId:'',direction:'request',stage:'original-request',version:0,contentType:'',contentEncoding:''});
export function isJsonMediaType(value: string): boolean { return /^(?:application\/json|[^;\s]+\+json)(?:\s*;|$)/i.test(value); }
export function isObjectBody(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Single wire owner and computation cache for one immutable representation. */
export class BodySource {
  private source!: ReadableStream<Uint8Array> | null;
  private bytes?: Uint8Array;
  private output?: ReadableStream<Uint8Array>;
  private bufferPromise?: Promise<Uint8Array>;
  private jsonPromise?: Promise<unknown>;
  private mutableJSON?: Promise<unknown>;
  private decodedPromise?: Promise<Uint8Array>;
  private eventsPromise?: Promise<readonly BodyEvent[]>;
  private eventSession?: BodyEventSession;
  private eventFrames:BodyEvent[]=[];private eventFrameReleases:(()=>void)[]=[];private eventFrameLogQuota=0;
  private eventDecoded:Uint8Array[]=[];private eventDecodedSize=0;private eventDecodedLease=new BodyBufferLease(true,true);
  private lease = new BodyBufferLease(true);
  private consumed = false;
  private disposed = false;
  private mandatory = false;
  private mandatoryConsumers=new Set<symbol>();
  private activeConsumers=new Set<symbol>();
  private lifecycle=new AbortController();
  private wireReader?:ReadableStreamDefaultReader<Uint8Array>;
  private wireCancellation?:Promise<void>;
  private wireError?:Error;
  private wireController?:ReadableStreamDefaultController<Uint8Array>;
  private optionalCache=false;private decodedOptional=false;private jsonOptional=false;
  private loggerWire=0;
  private captures = new Map<symbol, { max: number; logging:boolean; stop: (error: BodyProcessingError) => void }>();
  private chunks: Uint8Array[] = [];
  private size = 0;private collectedSize=0;
  private resolveEOF!: () => void;
  private rejectEOF!: (error: unknown) => void;
  readonly completion!: Promise<void>;
  readonly reasons: string[] = [];
  lastError?: BodyProcessingError;
  mode!: 'empty' | 'opaque-stream' | 'replayable-bytes';
  constructor(source: ReadableStream<Uint8Array> | null, public maxBytes: number, readonly coding = '', public signal?: AbortSignal,
    readonly identity: BodyViewIdentity = { ...defaultBodyIdentity, contentEncoding: coding }) {
    const existing=source && sources.get(source);
    if(existing){existing.maxBytes=Math.min(existing.maxBytes,maxBytes);if(existing.eventSession)existing.eventSession.maxBytes=existing.maxBytes;if(signal)existing.signal=signal;return existing;}
    this.source = source; this.mode = source ? 'opaque-stream' : 'empty';
    this.completion = new Promise((resolve,reject)=>{this.resolveEOF=resolve;this.rejectEOF=reject;});
    void this.completion.catch(()=>undefined);
    if(!source) this.resolveEOF();
  }
  get replayable(): boolean { return this.mode === 'empty' || this.bytes !== undefined; }
  get hasMandatoryConsumers():boolean {return this.mandatoryConsumers.size>0;}
  get hasActiveConsumers():boolean {return this.activeConsumers.size>0;}
  private get readSignal():AbortSignal {return this.signal?AbortSignal.any([this.signal,this.lifecycle.signal]):this.lifecycle.signal;}
  /** Cancel the physical reader exactly once, including a source's asynchronous cancel gate. */
  cancelReading(reason:unknown=new BodyProcessingError(408,'body_consumer_cancelled')):Promise<void> {
    if(this.wireCancellation)return this.wireCancellation;
    this.wireError=reason instanceof Error?reason:new BodyProcessingError(400,'body_stream_cancelled');
    const reader=this.wireReader;
    this.wireCancellation=(async()=>{
      try{if(reader)await cancelBodyReader(reader,reason);else if(this.source){await this.source.cancel(reason);this.source=null;}}
      finally{try{reader?.releaseLock();}catch{}this.dispose();}
    })();
    void this.wireCancellation.catch(()=>undefined);
    this.lifecycle.abort(reason);this.eventSession?.end(this.wireError);this.rejectEOF(this.wireError);
    try{this.wireController?.error(this.wireError);}catch{}
    return this.wireCancellation;
  }
  private registerConsumer(consumer?:BodyConsumer):{release:(cancel?:boolean)=>Promise<void>} {
    const key=Symbol();let released=false;let cancellation:Promise<void>|undefined;
    this.activeConsumers.add(key);
    if(consumer?.mandatory!==false)this.mandatoryConsumers.add(key);
    const release=(cancel=false):Promise<void>=>{
      if(!released){released=true;this.activeConsumers.delete(key);this.mandatoryConsumers.delete(key);consumer?.signal?.removeEventListener('abort',abort);
        if(cancel && consumer?.mandatory!==false && !this.mandatoryConsumers.size)cancellation=this.cancelReading();}
      return cancellation??Promise.resolve();
    };
    const abort=()=>{void release(true).catch(()=>undefined);};
    consumer?.signal?.addEventListener('abort',abort,{once:true});if(consumer?.signal?.aborted)abort();
    return {release};
  }
  consumerWork<T>(read:()=>Promise<T>,consumer?:BodyConsumer):Promise<T> {
    const owned=this.registerConsumer(consumer);const signal=consumer?.signal;
    if(signal?.aborted)return owned.release(true).catch(()=>undefined).then(()=>{throw new BodyProcessingError(408,'body_consumer_cancelled');});
    return new Promise<T>((resolve,reject)=>{
      let cancelled=false;
      const abort=()=>{cancelled=true;signal?.removeEventListener('abort',abort);void owned.release(true).catch(()=>undefined).then(()=>reject(new BodyProcessingError(408,'body_consumer_cancelled')));};
      signal?.addEventListener('abort',abort,{once:true});
      let work:Promise<T>;try{work=read();}catch(error){work=Promise.reject(error);}
      work.then(value=>{if(!cancelled)resolve(value);},error=>{if(!cancelled)reject(error);}).finally(()=>{signal?.removeEventListener('abort',abort);void owned.release();});
    });
  }
  private hold(bytes: number): void { this.lease.add(bytes); }
  private releaseEventFrames():void {for(const release of this.eventFrameReleases)release();this.eventFrameReleases=[];this.eventFrames=[];bodyMetrics.loggerBytes-=this.eventFrameLogQuota;this.eventFrameLogQuota=0;}
  cachedLogMessages(): {event:string;data:unknown}[]|undefined {return this.eventFrames.length ? this.eventFrames.filter(event=>event.hasData!==false).map(event=>({event:event.event||'message',data:event.json===undefined?event.data:event.json})) : undefined;}
  private captureEventFrame(event:BodyEvent,bytes:number,retain:()=>()=>void):void {
    if(![...this.captures.values()].some(c=>c.logging))return;
    const quota=128+bytes*4;
    if(bodyMetrics.loggerBytes+quota>bodyResources.loggerMemoryBytes){for(const [key,c] of this.captures)if(c.logging){this.captures.delete(key);c.stop(new BodyProcessingError(503,'body_buffer_capacity'));}return;}
    bodyMetrics.loggerBytes+=quota;this.eventFrameLogQuota+=quota;this.eventFrameReleases.push(retain());this.eventFrames.push(event);
  }
  private clear(): void {this.releaseEventFrames(); this.eventDecodedLease.dispose();this.eventDecoded=[];this.eventDecodedSize=0;this.lease.dispose();this.optionalCache=false;this.collectedSize=0;this.chunks=[];this.bytes=undefined;this.jsonPromise=undefined;this.mutableJSON=undefined;this.decodedPromise=undefined;this.eventsPromise=undefined; }
  dispose(): void { this.disposed=true;if(!this.captures.size)this.clear(); }
  /** Optional retention follows actual pulls. Releasing a consumer never cancels the wire. */
  retain(max: number, stop: (error: BodyProcessingError) => void,logging=false): () => void {
    const key=Symbol();this.captures.set(key,{max,stop,logging});
    return ()=>{this.captures.delete(key);this.releaseLoggingWire();if(!this.captures.size && (!this.mandatory || this.disposed))this.clear();};
  }
  private releaseLoggingWire():void {if(![...this.captures.values()].some(c=>c.logging)){bodyMetrics.loggerBytes-=this.loggerWire;this.loggerWire=0;this.releaseEventFrames();}}
  private append(chunk: Uint8Array): void {
    this.eventSession?.push(chunk);this.size+=chunk.byteLength;
    for(const [key,consumer] of this.captures) if(this.size>consumer.max){this.captures.delete(key);consumer.stop(new BodyProcessingError(413,'request_body_too_large',consumer.max,this.size));}
    this.releaseLoggingWire();
    if([...this.captures.values()].some(c=>c.logging)){
      if(bodyMetrics.loggerBytes+chunk.byteLength>bodyResources.loggerMemoryBytes){for(const [key,c] of this.captures)if(c.logging){this.captures.delete(key);c.stop(new BodyProcessingError(503,'body_buffer_capacity'));}this.releaseLoggingWire();}
      else {bodyMetrics.loggerBytes+=chunk.byteLength;this.loggerWire+=chunk.byteLength;}
    }
    if(!this.mandatory && !this.optionalCache && !this.captures.size)return;
    try {this.hold(chunk.byteLength);this.chunks.push(new Uint8Array(chunk));this.collectedSize+=chunk.byteLength;}
    catch(error){if(this.mandatory)throw error;for(const c of this.captures.values())c.stop(error as BodyProcessingError);this.captures.clear();this.clear();}
  }
  private finish(): void {
    this.eventSession?.end();
    if(this.mandatory || this.optionalCache || this.captures.size){
      if(this.collectedSize!==this.size)throw new BodyProcessingError(503,'body_not_replayable');
      this.hold(this.size);const bytes=new Uint8Array(this.size);let offset=0;
      for(const chunk of this.chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      this.lease.release(this.size);this.chunks=[];this.bytes=bytes;this.mode='replayable-bytes';
    }
    this.resolveEOF();
  }
  async buffer(reason: string, optional=false): Promise<Uint8Array> {
    if(!this.reasons.includes(reason))this.reasons.push(reason);
    if(this.bytes){if(!optional&&this.bytes.byteLength>this.maxBytes)throw new BodyProcessingError(413,'request_body_too_large',this.maxBytes,this.bytes.byteLength);return this.bytes;}
    if(this.bufferPromise)return this.bufferPromise;
    if(this.disposed)throw new BodyProcessingError(503,'body_disposed');
    if(!optional){this.mandatory=true;this.lease.promote();}else this.optionalCache=true;
    this.bufferPromise=(async()=>{
      if(!this.source && (!this.output || this.output.locked)){if(!this.consumed)return this.bytes=new Uint8Array();await this.completion;if(this.bytes)return this.bytes;throw new BodyProcessingError(503,'body_not_replayable');}
      const stream=(this.source ? this.take() : this.output) as ReadableStream<Uint8Array>;const reader=stream.getReader();
      try{while(!(await readBodyChunk(reader,this.readSignal)).done){}if(this.wireError)throw this.wireError;return this.bytes??new Uint8Array();}
      catch(error){await cancelBodyReader(reader,error).catch(()=>undefined);this.dispose();throw error;}
      finally{reader.releaseLock();}
    })();return this.bufferPromise;
  }
  private receiveEventDecoded(chunk:Uint8Array):void {
    const logs=[...this.captures.entries()].filter(([,c])=>c.logging);if(!logs.length)return;
    this.eventDecodedSize+=chunk.byteLength;
    for(const [key,c] of logs)if(this.eventDecodedSize>c.max){this.captures.delete(key);c.stop(new BodyProcessingError(413,'decoded_body_too_large',c.max,this.eventDecodedSize));}
    if(![...this.captures.values()].some(c=>c.logging))return;
    try{this.eventDecodedLease.add(chunk.byteLength);this.eventDecoded.push(new Uint8Array(chunk));}
    catch(error){for(const [key,c] of this.captures)if(c.logging){this.captures.delete(key);c.stop(error as BodyProcessingError);}}
  }
  private finishEventDecoded():void {
    if(![...this.captures.values()].some(c=>c.logging) || !this.eventDecoded.length)return;
    try{this.eventDecodedLease.add(this.eventDecodedSize);const bytes=new Uint8Array(this.eventDecodedSize);let offset=0;
      for(const chunk of this.eventDecoded){bytes.set(chunk,offset);offset+=chunk.byteLength;}this.eventDecoded=[];this.eventDecodedLease.release(this.eventDecodedSize);this.decodedOptional=true;this.decodedPromise=Promise.resolve(bytes);
    }catch(error){for(const [key,c] of this.captures)if(c.logging){this.captures.delete(key);c.stop(error as BodyProcessingError);}}
  }
  private async cachedDecoded(optional=false): Promise<Uint8Array> {
    if(optional && this.eventSession && !this.decodedPromise && [...this.captures.values()].some(c=>c.logging))await this.eventSession.completion;
    if(!optional){this.mandatory=true;this.lease.promote();if(this.bytes && this.bytes.byteLength>this.maxBytes)throw new BodyProcessingError(413,'request_body_too_large',this.maxBytes,this.bytes.byteLength);}
    if(!optional && this.decodedPromise && this.decodedOptional)return this.decodedPromise.catch(error=>{if(error instanceof BodyProcessingError && (error.status===503||error.status===408))return this.cachedDecoded(false);throw error;}).then(bytes=>{if(bytes.byteLength>this.maxBytes)throw new BodyProcessingError(413,'decoded_body_too_large',this.maxBytes,bytes.byteLength);return bytes;});
    if(!this.decodedPromise){const work=(async()=>{
      const wire=this.bytes ?? await this.buffer('decoded',optional);
      if(!this.coding || this.coding.trim().toLowerCase()==='identity')return wire;
      const input=new Response(wire as BodyInit).body!;
      const timeout=optional?new AbortController():undefined;
      const timer=timeout?setTimeout(()=>timeout.abort(),bodyResources.optionalDecodeMs):undefined;
      let stream:OwnedDecodedStream;
      try{stream=decodeStream(input,this.coding,Math.max(this.maxBytes,...[...this.captures.values()].map(c=>c.max)),timeout?AbortSignal.any([timeout.signal,this.lifecycle.signal]):this.readSignal,optional);}catch(error){if(timer)clearTimeout(timer);throw error;}
      const reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0;const allocation=new BodyBufferLease(optional);
      try{while(true){const part=await reader.read();if(part.done)break;allocation.add(part.value.byteLength);size+=part.value.byteLength;chunks.push(part.value);}
        this.hold(size);const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
      }finally{if(timer)clearTimeout(timer);allocation.dispose();stream.dispose();await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    })();this.decodedOptional=optional;this.decodedPromise=work;void work.catch(()=>{if(this.decodedPromise===work)this.decodedPromise=undefined;});}
    return this.decodedPromise.then(bytes=>{if(!optional&&bytes.byteLength>this.maxBytes)throw new BodyProcessingError(413,'decoded_body_too_large',this.maxBytes,bytes.byteLength);return bytes;});
  }
  async decoded(reason: string): Promise<Uint8Array> {if(!this.reasons.includes(reason))this.reasons.push(reason);return this.cachedDecoded();}
  private canonicalJSON(emptyObject=false,optional=false): Promise<unknown> {
    if(!optional){this.mandatory=true;this.lease.promote();}
    if(!optional && this.jsonPromise && this.jsonOptional)return this.jsonPromise.catch(error=>{if(error instanceof BodyProcessingError && (error.status===503||error.status===408))return this.canonicalJSON(emptyObject,false);throw error;});
    if(!this.jsonPromise){const work=(async()=>{
      const bytes=await this.cachedDecoded(optional);
      if(bytes.byteLength>this.maxBytes)throw new BodyProcessingError(413,'decoded_body_too_large',this.maxBytes,bytes.byteLength);
      if(!bytes.byteLength && emptyObject)return freezeBodyValue({});
      try{bodyMetrics.jsonParses++;const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));this.hold(bytes.byteLength*2);return freezeBodyValue(value);}
      catch(error){if(error instanceof BodyProcessingError)throw error;throw new BodyProcessingError(400,'invalid_json_body');}
    })();this.jsonOptional=optional;this.jsonPromise=work;void work.catch(()=>{if(this.jsonPromise===work)this.jsonPromise=undefined;});}
    return this.jsonPromise;
  }
  async json(reason: string, emptyObject=false): Promise<any> {
    if(!this.reasons.includes(reason))this.reasons.push(reason);
    this.mutableJSON ??= this.canonicalJSON(emptyObject).then(async value=>{this.hold((await this.cachedDecoded()).byteLength*2);return structuredClone(value);});
    return this.mutableJSON;
  }
  handle(identity: BodyViewIdentity = this.identity): BodyHandle {
    const source=this;const view=Object.freeze({...identity});
    const handle:BodyHandle=Object.freeze({identity:view,get maxBytes(){return source.maxBytes;},
      bytes(consumer?:BodyConsumer){return source.consumerWork(()=>source.bytes ? Promise.resolve(source.bytes) : source.buffer(consumer?.id??'body-handle',consumer?.mandatory===false),consumer);},
      decoded(consumer?:BodyConsumer){return source.consumerWork(()=>source.cachedDecoded(consumer?.mandatory===false),consumer);},
      json(consumer?:BodyConsumer,emptyObject=false){return source.consumerWork(()=>source.canonicalJSON(emptyObject,consumer?.mandatory===false),consumer);},
      events(consumer?:BodyConsumer):AsyncIterable<BodyEvent>{
        const owned=source.registerConsumer(consumer);
        if(!source.bytes){source.eventSession??=new BodyEventSession(source.coding,source.maxBytes===Number.MAX_SAFE_INTEGER?DEFAULT_BODY_PARSER_BYTES:source.maxBytes,source.lifecycle.signal,chunk=>source.receiveEventDecoded(chunk),()=>source.finishEventDecoded(),(event,size,retain)=>source.captureEventFrame(event,size,retain));const events=source.eventSession.events(consumer);return {async *[Symbol.asyncIterator](){let finished=false;let failed=false;try{yield* events;finished=true;}catch(error){failed=!(error instanceof BodyProcessingError && error.code==='body_consumer_cancelled');throw error;}finally{const cleanup=owned.release(!finished || !!consumer?.signal?.aborted).catch(()=>undefined);if(failed)void cleanup;else await cleanup;}}};}
        return {async *[Symbol.asyncIterator](){
          try{
          if(!source.eventsPromise)source.eventsPromise=(async()=>{const bytes=await source.cachedDecoded(consumer?.mandatory===false);const result:BodyEvent[]=[];bodyMetrics.sseParses++;
            const parser=new BodySSEFramer(source.maxBytes,(event,size)=>{source.hold(128+size*4);result.push(event);});parser.feed(bytes);parser.finish(true);return result;
          })();
          for(const event of await consumerResult(source.eventsPromise,consumer)){if(consumer?.signal?.aborted)throw new BodyProcessingError(408,'body_consumer_cancelled');yield event;}
          }finally{await owned.release(!!consumer?.signal?.aborted).catch(()=>undefined);}
        }};
      },
    });handles.set(handle,this);return handle;
  }
  take(): BodyInit | null {
    if(this.bytes)return this.bytes as BodyInit;
    if(!this.source){if(this.output && !this.output.locked)return this.output;return null;}
    if(this.consumed)throw new BodyProcessingError(503,'body_not_replayable');
    this.consumed=true;const input=this.source;this.source=null;const reader=input.getReader();this.wireReader=reader;let count=0;
    const output=new ReadableStream<Uint8Array>({
      start:controller=>{this.wireController=controller;},
      pull:async controller=>{try{const part=await readBodyChunk(reader,this.readSignal);if(this.wireError)throw this.wireError;if(part.done){
        try{this.finish();}catch(error){if(this.mandatory)throw error;for(const c of this.captures.values())c.stop(error as BodyProcessingError);this.captures.clear();this.clear();this.resolveEOF();}
        reader.releaseLock();this.wireReader=undefined;controller.close();return;}
        count+=part.value.byteLength;if((this.identity.direction==='request' || this.mandatory) && count>this.maxBytes)throw new BodyProcessingError(413,'request_body_too_large',this.maxBytes,count);
        this.append(part.value);controller.enqueue(part.value);
      }catch(error){if(error instanceof BodyProcessingError)this.lastError=error;this.eventSession?.end(error);this.rejectEOF(error);await this.cancelReading(error).catch(()=>undefined);try{controller.error(error);}catch{}}},
      cancel:reason=>this.cancelReading(reason),
    },{highWaterMark:0});sources.set(output,this);this.output=output;return output;
  }
}
export async function readBodyChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw signal.reason instanceof Error?signal.reason:new BodyProcessingError(408, 'body_processing_timeout');
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason instanceof Error?signal.reason:new BodyProcessingError(408, 'body_processing_timeout')); void cancelBodyReader(reader,signal.reason).catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export interface OwnedDecodedStream extends ReadableStream<Uint8Array> { dispose():void; promote?():void }
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
  if ((optional ? bodyMetrics.activeOptionalDecoders : bodyMetrics.activeDecoders) >= (optional ? bodyResources.optionalDecoders : bodyResources.mandatoryDecoders)) throw new BodyProcessingError(503, 'body_decoder_capacity');
  bodyMetrics.decompressions++;
  if (optional) bodyMetrics.activeOptionalDecoders++; else bodyMetrics.activeDecoders++;
  let nodeStream: ReturnType<typeof createGunzip>;
  try {
    nodeStream = normalized === 'gzip' ? createGunzip() : createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: bodyResources.zstdWindowLog } }) as any;
  } catch { (optional ? bodyMetrics.activeOptionalDecoders-- : bodyMetrics.activeDecoders--); throw new BodyProcessingError(400, 'invalid_compressed_body'); }
  const input = Readable.fromWeb(limitStream(source, max, signal) as any);
  const onInputError = (error: Error) => nodeStream.destroy(error);
  input.on('error', onInputError); input.pipe(nodeStream);
  let released = false;let optionalSlot=optional;
  const promote=()=>{if(released||!optionalSlot)return;if(bodyMetrics.activeDecoders>=bodyResources.mandatoryDecoders)throw new BodyProcessingError(503,'body_decoder_capacity');bodyMetrics.activeOptionalDecoders--;bodyMetrics.activeDecoders++;optionalSlot=false;};
  const release = () => { if (!released) { released = true; signal?.removeEventListener('abort',release); (optionalSlot ? bodyMetrics.activeOptionalDecoders-- : bodyMetrics.activeDecoders--); input.destroy(); nodeStream.destroy(); } };
  const reader = (Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>).getReader(); let bytes = 0;
  const output=new ReadableStream<Uint8Array>({
    async pull(controller) { try { const part = await readBodyChunk(reader, signal); if (part.done) { release(); controller.close(); return; }
      bytes += part.value.byteLength; if (bytes > max) throw new BodyProcessingError(413, 'decoded_body_too_large', max, bytes); controller.enqueue(part.value);
    } catch (error) { release(); void reader.cancel(error).catch(() => undefined); controller.error(error instanceof BodyProcessingError ? error : new BodyProcessingError(400, 'invalid_compressed_body')); } },
    async cancel(reason) { release(); await reader.cancel(reason).catch(() => undefined); },
  }, { highWaterMark: 0 }) as OwnedDecodedStream;
  Object.defineProperty(output,'dispose',{value:release});Object.defineProperty(output,'promote',{value:promote});
  signal?.addEventListener('abort',release,{once:true});if(signal?.aborted)release();
  return output;
}
export function reconcileEntityHeaders(headers: Headers, body: BodyInit | null, modified: boolean): void {
  if (!modified) return;
  headers.delete('content-encoding'); headers.delete('transfer-encoding'); headers.delete('content-length');
  if (typeof body === 'string') headers.set('content-length', String(Buffer.byteLength(body)));
  else if (body instanceof Uint8Array) headers.set('content-length', String(body.byteLength));
}
