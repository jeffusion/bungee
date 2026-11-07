import { createBodySource } from '../gateway/body-factory';
import { BodyBufferLease, BodyProcessingError, bodySourceFor, bodySourceForHandle } from '../gateway/body-service';
import type { BodyHandle, BodyViewIdentity } from '../gateway/body-contracts';
import type { RequestLogBodyHandler } from '../gateway/request-log-contracts';
import { bodyResources } from '../gateway/body-resources';

let captures = 0;
const pending = new Set<Promise<void>>();
export function trackBodyLogTask(task: Promise<void>): void {
  pending.add(task);
  void task.then(() => pending.delete(task), () => pending.delete(task));
}
export type BodyCapture = { body: ReadableStream<Uint8Array>; completion: Promise<void>; stop(): void };
export type BodyCaptureReason = 'size_limit' | 'buffer_capacity' | 'cancelled' | 'stream_failed' | 'not_consumed' | 'capture_failed' | 'decode_failed' | 'parser_timeout' | 'storage_failed';
export interface BodyCaptureOptions { bodyHandle?: BodyHandle; identity?: BodyViewIdentity; maxBodyBytes?: number }
type StreamSink = (chunks: AsyncIterable<string>, completed: Promise<void>, signal: AbortSignal, format?: 'text') => Promise<void>;

/** Transport pulls the wire; the parser has only an optional bounded view. */
export function captureBody(
  source: ReadableStream<Uint8Array>, maxBytes: number, coding: string, parse: RequestLogBodyHandler,
  save: (body: unknown) => Promise<void>, incomplete: (reason: BodyCaptureReason) => void,
  signal?: AbortSignal, options: BodyCaptureOptions = {}, saveStream?: StreamSink,
): BodyCapture {
  if (source.locked) throw new TypeError('body stream is locked');
  const existing = bodySourceFor(source);
  const owner = existing ?? createBodySource(source, options.maxBodyBytes ?? Number.MAX_SAFE_INTEGER, coding, undefined, options.identity);
  const raw = options.bodyHandle ?? owner.handle(options.identity);
  const retainingOwner = bodySourceForHandle(raw) ?? owner;
  const allocation = new BodyBufferLease(true, true);
  const abort = new AbortController();
  const consumer = Object.freeze({ id: 'request-log-body', mandatory: false, signal: abort.signal });
  const streaming = typeof parse !== 'function';
  let admitted = false;
  let wireFinished = false;
  let releaseRetention = () => {};
  let deadline: Timer | undefined;
  let resolve!: () => void;
  const completion = new Promise<void>(done => { resolve = done; });
  const finish = (reason?: BodyCaptureReason) => {
    if (abort.signal.aborted) return;
    abort.abort();
    clearTimeout(deadline);
    releaseRetention();
    allocation.dispose();
    if (admitted && !streaming) captures--;
    signal?.removeEventListener('abort', cancel);
    if (reason) {
      try { incomplete(reason); } catch { /* logging cannot own traffic */ }
    }
    resolve();
  };
  const cancel = () => finish('cancelled');
  const parserFailed = (error: unknown) => finish(error instanceof BodyProcessingError
    ? error.status === 413 ? 'size_limit' : error.status === 503 ? 'buffer_capacity' : 'decode_failed'
    : error instanceof Error && error.message === 'body_log_storage_failed' ? 'storage_failed' : 'capture_failed');
  const checkSize = (bytes: number) => {
    if (bytes > maxBytes) throw new BodyProcessingError(413, 'body_log_too_large');
  };
  const readBytes = async (read: () => Promise<Uint8Array>) => {
    await owner.completion;
    abort.signal.throwIfAborted();
    const bytes = await read();
    abort.signal.throwIfAborted();
    checkSize(bytes.byteLength);
    return bytes;
  };
  const decoded = () => readBytes(() => raw.decoded(consumer));
  const copyBytes = (bytes: Uint8Array) => {
    abort.signal.throwIfAborted();
    allocation.add(bytes.byteLength);
    return new Uint8Array(bytes);
  };
  const bodyHandle: BodyHandle = Object.freeze({
    identity: Object.freeze({ ...raw.identity, ...options.identity }),
    maxBytes,
    bytes: () => readBytes(() => raw.bytes(consumer)).then(copyBytes),
    decoded: () => decoded().then(copyBytes),
    async json() {
      await decoded();
      return raw.json(consumer);
    },
    async *events() {
      let bytes = 0;
      abort.signal.throwIfAborted();
      for await (const event of raw.events(consumer)) {
        abort.signal.throwIfAborted();
        bytes += Buffer.byteLength(event.raw ?? event.data);
        checkSize(bytes);
        allocation.add(128 + event.data.length * 8);
        yield event;
      }
    },
  });

  if (captures >= bodyResources.loggerConsumers) finish('buffer_capacity');
  else if (signal?.aborted) cancel();
  else {
    admitted = true;
    captures++;
    signal?.addEventListener('abort', cancel, { once: true });
    let parsed: Promise<unknown>;
    if (typeof parse === 'function') {
      releaseRetention = retainingOwner.retain(maxBytes, error => finish(error.status === 413 ? 'size_limit' : 'buffer_capacity'), true);
      parsed = (async () => parse(bodyHandle, consumer))();
    } else {
      parsed = (async () => {
        if (!saveStream) throw new Error('body_log_storage_failed');
        const view = Object.freeze({
          textChunks: () => owner.logText(maxBytes, abort.signal),
          async *events() {
            let bytes = 0;
            for await (const event of raw.events(consumer)) {
              abort.signal.throwIfAborted();
              bytes += Buffer.byteLength(event.raw ?? event.data);
              checkSize(bytes);
              yield event;
            }
          },
        });
        await saveStream(parse.stream(view), owner.completion, abort.signal, parse.format);
      })();
    }
    if (streaming) {
      // The disk operation can still hold its buffer after the logical capture times out.
      const releaseSlot = () => { captures--; };
      trackBodyLogTask(parsed.then(releaseSlot, releaseSlot));
    }
    void parsed.catch(parserFailed);
    void owner.completion.then(async () => {
      if (abort.signal.aborted) return;
      wireFinished = true;
      signal?.removeEventListener('abort', cancel);
      const work = (async () => {
        deadline = setTimeout(() => finish('parser_timeout'), bodyResources.optionalDecodeMs);
        deadline.unref();
        try {
          const value = await parsed;
          if (abort.signal.aborted) return;
          clearTimeout(deadline);
          if (value !== undefined) await save(value);
          finish();
        } catch (error) {
          parserFailed(error);
        }
      })();
      trackBodyLogTask(completion);
      await work;
    }, error => finish(signal?.aborted || (error instanceof BodyProcessingError && error.code === 'body_stream_cancelled')
      ? 'cancelled' : 'stream_failed'));
  }
  const body = existing ? source : owner.take() as ReadableStream<Uint8Array>;
  return { body, completion, stop: () => { if (!wireFinished) finish('not_consumed'); } };
}

export async function flushBodyCaptures(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => { while (pending.size) await Promise.allSettled([...pending]); })(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
