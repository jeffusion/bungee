import { BodyBufferLease, BodyProcessingError } from '../gateway/body-service';
import { bodyResources } from '../gateway/body-resources';
import type { RequestLogWebSocketBody } from '../gateway/request-log-contracts';
import type { WebSocketMessageView } from '../gateway/websocket-contracts';
import type { AccessLogEntry, ProcessingStep } from './access-log-writer';
import type { BodyStorageManager } from './body-storage';
import { trackBodyLogTask, type BodyCaptureReason } from './body-capture';

const SECRET_KEY = /^(?:authorization|proxy[_-]?authorization|(?:set[_-]?)?cookie|(?:x[_-])?api[_-]?key|(?:access|refresh|id)[_-]?token|client[_-]?secret|password)$/i;
const SECRET_TEXT = /\b(Bearer|Basic)\s+[^\s,;"'<>]+|\b(?:bng_data_[\w-]+|sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/gi;
const SECRET_ASSIGNMENT = /((?:\b(?:x[_-])?api[_-]?key\b|["'](?:x[_-])?api[_-]?key["'])\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&;,}]+)/gi;
let active = 0;

function serialize(message: WebSocketMessageView, maxBytes: number): string {
  if (message.byteLength > maxBytes) throw new BodyProcessingError(413, 'body_log_too_large');
  if (message.byteLength > bodyResources.loggerMemoryBytes) throw new BodyProcessingError(503, 'body_buffer_capacity');
  const value = message.json({ binary: true });
  if (value === undefined) throw new Error('body_log_invalid_message');
  const content = JSON.stringify(value, (key, value: unknown) => SECRET_KEY.test(key) ? '[REDACTED]'
    : typeof value === 'string' ? value.replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
      .replace(SECRET_TEXT, (_, scheme: string | undefined) => scheme ? `${scheme} [REDACTED]` : '[REDACTED]')
      : value);
  if (Buffer.byteLength(content) > maxBytes) throw new BodyProcessingError(413, 'body_log_too_large');
  return content;
}

function captureReason(error: unknown): BodyCaptureReason {
  if (error instanceof BodyProcessingError) return error.status === 413 ? 'size_limit' : 'buffer_capacity';
  return 'capture_failed';
}

type BodyResult = Pick<AccessLogEntry, 'originalReqBodyId' | 'respBodyId' | 'processingSteps'>;
type Chunk = { text: string; retained: number };

/** One bounded optional spool per operation, independent of its lifecycle observation. */
export class WebSocketBodyCapture implements RequestLogWebSocketBody {
  private readonly allocation = new BodyBufferLease(true, true);
  private readonly abort = new AbortController();
  private readonly queue: Chunk[] = [];
  private wake?: () => void;
  private request?: Chunk;
  private requestReason?: BodyCaptureReason | 'ambiguous';
  private responseReason?: BodyCaptureReason | 'ambiguous';
  private responseBytes = 0;
  private queuedBytes = 0;
  private attached = false;
  private ended = false;
  private slot = false;
  private requestSave?: Promise<string | null>;
  private responseSave?: Promise<string | null>;

  constructor(message: WebSocketMessageView, private readonly maxBytes: number) {
    try {
      const text = serialize(message, maxBytes);
      const retained = text.length * 2 + 64;
      this.allocation.add(retained);
      this.request = { text, retained };
    } catch (error) { this.requestReason = captureReason(error); }
  }

  append(message: WebSocketMessageView): void {
    if (this.ended || this.responseReason) return;
    try {
      const text = (this.responseBytes ? ',' : '[') + serialize(message, this.maxBytes - this.responseBytes - 2);
      const retained = text.length * 2 + 64;
      if (this.queue.length >= bodyResources.observerBacklogEvents || this.queuedBytes + retained > bodyResources.observerBacklogBytes) {
        this.failResponse('buffer_capacity');
        return;
      }
      this.allocation.add(retained);
      this.queue.push({ text, retained });
      this.queuedBytes += retained;
      this.responseBytes += Buffer.byteLength(text);
      this.wake?.();
    } catch (error) { this.failResponse(captureReason(error)); }
  }

  discardResponse(reason: 'size_limit' | 'ambiguous' = 'ambiguous'): void { this.failResponse(reason); }

  discardRequest(): void {
    if (this.attached) return;
    if (this.request) this.allocation.release(this.request.retained);
    this.request = undefined;
    this.requestReason ??= 'ambiguous';
  }

  discard(): void {
    if (this.attached) return;
    this.ended = true;
    this.failResponse('cancelled');
    this.request = undefined;
    this.release();
  }

  attach(id: string, storage: Pick<BodyStorageManager, 'saveStream'>): boolean {
    if (this.attached || this.ended) return false;
    this.attached = true;
    const request = this.request;
    this.request = undefined;
    if (active >= bodyResources.loggerConsumers) {
      this.failResponse('buffer_capacity');
      this.requestReason ??= 'buffer_capacity';
      this.release();
      return true;
    }
    this.slot = true;
    active++;
    if (request) {
      this.requestSave = Promise.resolve().then(() => storage.saveStream(id, [request.text],
        'original-request', this.maxBytes, Promise.resolve(), AbortSignal.timeout(bodyResources.optionalDecodeMs)))
        .catch(() => null).finally(() => this.allocation.release(request.retained));
    }
    if (!this.responseReason) {
      this.responseSave = Promise.resolve().then(() => storage.saveStream(id, this.chunks(), 'response',
        this.maxBytes, Promise.resolve(), this.abort.signal))
        .catch(() => { this.failResponse('storage_failed'); return null; });
      trackBodyLogTask(this.responseSave.then(() => undefined));
    }
    return true;
  }

  async finish(incomplete: boolean): Promise<BodyResult> {
    this.ended = true;
    if (incomplete) this.failResponse('stream_failed');
    this.wake?.();
    const deadline = setTimeout(() => this.failResponse('parser_timeout'), bodyResources.optionalDecodeMs);
    deadline.unref();
    try {
      const [request, response] = await Promise.all([this.requestSave, this.responseSave]);
      if (this.requestSave && !request) this.requestReason ??= 'storage_failed';
      if (this.responseSave && !response) this.responseReason ??= 'storage_failed';
      const processingSteps: ProcessingStep[] = [];
      for (const [direction, reason] of [['original-request', this.requestReason], ['response', this.responseReason]]) {
        if (reason) processingSteps.push({
          step: 'body_logging_incomplete', timestamp: Date.now(), detail: { direction, reason, observer_incomplete: true },
        });
      }
      return { originalReqBodyId: request ?? undefined, respBodyId: response ?? undefined, processingSteps };
    } finally {
      clearTimeout(deadline);
      this.release();
    }
  }

  private async *chunks(): AsyncIterable<string> {
    while (!this.abort.signal.aborted) {
      const next = this.queue.shift();
      if (next) {
        try { yield next.text; }
        finally {
          this.queuedBytes -= next.retained;
          this.allocation.release(next.retained);
        }
      } else if (this.ended) {
        yield this.responseBytes ? ']' : '[]';
        return;
      } else {
        await new Promise<void>(resolve => { this.wake = resolve; });
        this.wake = undefined;
      }
    }
  }

  private failResponse(reason: BodyCaptureReason | 'ambiguous'): void {
    if (this.responseReason) return;
    this.responseReason = reason;
    this.abort.abort();
    for (const item of this.queue) {
      this.queuedBytes -= item.retained;
      this.allocation.release(item.retained);
    }
    this.queue.length = 0;
    this.wake?.();
  }

  private release(): void {
    if (this.slot) { this.slot = false; active--; }
    this.allocation.dispose();
  }
}
