import { BodyProcessingError, decodeStream } from '../worker/request/body-source';
import { formatSSELog } from '@jeffusion/bungee-types';

const TOTAL_LIMIT = 32 * 1024 * 1024;
const MAX_CAPTURES = 64;
let retainedBytes = 0;
let captures = 0;
const pending = new Set<Promise<void>>();

/** Register only independent logging work, so shutdown can flush it without delaying HTTP. */
export function trackBodyLogTask(task: Promise<void>): void {
  pending.add(task);
  void task.then(() => pending.delete(task), () => pending.delete(task));
}

export type BodyCapture = { body: ReadableStream<Uint8Array>; completion: Promise<void>; stop(): void };
export type BodyCaptureReason = 'size_limit' | 'buffer_capacity' | 'cancelled' | 'stream_failed' | 'not_consumed' | 'capture_failed' | 'decode_failed';

/** Copies only bytes pulled by the transport. Logging never reads ahead or owns a second wire reader. */
export function captureBody(
  source: ReadableStream<Uint8Array>, maxBytes: number, coding: string,
  save: (body: unknown) => Promise<void>, incomplete: (reason: BodyCaptureReason) => void,
  signal?: AbortSignal,
  contentType = '',
  requestAccept = '',
): BodyCapture {
  // Acquire first: a locked source must not leak a capture/buffer reservation.
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  let size = 0;
  let finished = false;
  let resolve!: () => void;
  const completion = new Promise<void>(done => { resolve = done; });
  let admitted = captures < MAX_CAPTURES;
  if (admitted) captures++;
  const release = () => { retainedBytes -= held; held = 0; chunks.length = 0; if (admitted) { captures--; admitted = false; } };
  const detach = () => signal?.removeEventListener('abort', abort);
  const stop = (reason: BodyCaptureReason) => {
    if (finished) return;
    finished = true; detach(); release();
    try { incomplete(reason); } catch { /* logging cannot affect transport */ }
    resolve();
  };
  const reserve = (bytes: number) => {
    if (retainedBytes + bytes > TOTAL_LIMIT) return false;
    retainedBytes += bytes; held += bytes; return true;
  };
  const abort = () => stop('cancelled');
  if (!admitted) stop('buffer_capacity');
  if (!finished) signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  const finish = () => {
    if (finished) return;
    finished = true; detach();
    // Decode only the independent copy after wire EOF. The forward path never waits for this work.
    const work = (async () => {
      try {
        let bytes: Uint8Array;
        let encoded = false;
        const normalized = coding.trim().toLowerCase();
        if (normalized === 'gzip' || normalized === 'zstd') {
          let index = 0;
          const input = new ReadableStream<Uint8Array>({ pull(controller) {
            if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close();
          } });
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), 1000);
          let decoded: ReturnType<typeof decodeStream> | undefined;
          try {
            decoded = decodeStream(input, normalized, maxBytes, deadline.signal, true);
            const reader = decoded.getReader(); const parts: Uint8Array[] = []; let count = 0;
            try {
              while (true) {
                const part = await reader.read(); if (part.done) break;
                if (!reserve(part.value.byteLength)) throw new BodyProcessingError(503, 'body_buffer_capacity');
                count += part.value.byteLength; parts.push(part.value);
              }
              if (!reserve(count)) throw new BodyProcessingError(503, 'body_buffer_capacity');
              bytes = Buffer.concat(parts, count);
            } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          } catch (error) {
            if (error instanceof BodyProcessingError && (error.status === 413 || error.code === 'body_buffer_capacity')) throw error;
            if (!reserve(size)) throw new BodyProcessingError(503, 'body_buffer_capacity');
            bytes = Buffer.concat(chunks, size);
            encoded = true;
            try { incomplete('decode_failed'); } catch { /* isolated */ }
          } finally { clearTimeout(timer); decoded?.dispose(); }
        } else {
          if (!reserve(size)) throw new BodyProcessingError(503, 'body_buffer_capacity');
          bytes = Buffer.concat(chunks, size);
        }
        // Budget the string/base64 representation as well as the retained wire copy.
        if (!reserve(Math.ceil(bytes.byteLength * 8 / 3))) throw new BodyProcessingError(503, 'body_buffer_capacity');
        let value: unknown;
        const base64 = () => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
        if (encoded || (normalized && !['identity','gzip','zstd'].includes(normalized))) {
          value = { encoding: 'base64', content_encoding: coding, data: base64() };
        } else {
          try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
          catch { value = { encoding: 'base64', data: base64() }; }
        }
        value = formatSSELog(value, contentType, bytes => {
          if (!reserve(bytes)) throw new BodyProcessingError(503, 'body_buffer_capacity');
        }, requestAccept);
        await save(value);
      } catch (error) {
        const reason = error instanceof BodyProcessingError
          ? error.status === 413 ? 'size_limit' : error.status === 503 ? 'buffer_capacity' : 'capture_failed'
          : 'capture_failed';
        try { incomplete(reason); } catch { /* isolated */ }
      }
      finally { release(); resolve(); }
    })();
    trackBodyLogTask(work);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { reader.releaseLock(); finish(); controller.close(); return; }
        if (!finished) {
          try {
            size += part.value.byteLength;
            if (size > maxBytes) stop('size_limit');
            else if (!reserve(part.value.byteLength)) stop('buffer_capacity');
            else chunks.push(new Uint8Array(part.value));
          } catch { stop('capture_failed'); }
        }
        controller.enqueue(part.value);
      } catch (error) { stop('stream_failed'); reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { stop('cancelled'); try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
  return { body, completion, stop: () => stop('not_consumed') };
}

/** Worker shutdown may wait for log writes; transport never does. */
export async function flushBodyCaptures(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => { while (pending.size) await Promise.all([...pending]); })(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
