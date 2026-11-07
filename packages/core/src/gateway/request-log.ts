import { randomUUID } from 'node:crypto';
import type { PluginHooks } from '../hooks';
import type { AccessLogEntry } from '../logger/access-log-writer';
import { trackBodyLogTask } from '../logger/body-capture';
import type { RequestLoggerDependencies } from '../logger/request-logger';
import { WebSocketBodyCapture } from '../logger/websocket-body-capture';
import { createWebSocketMessageView } from '../websocket/message';
import { bodyResources } from './body-resources';
import type { BodyConsumer, BodyHandle } from './body-contracts';
import { createBodySource } from './body-factory';
import { BodyBufferLease, BodyProcessingError, bodyObservationSourceFor } from './body-service';
import type {
  RequestLogContext, RequestLogEvent, RequestLogObserver, RequestLogRecords, RequestLogWebSocketBodies, RequestLogWebSocketBody, RequestLogWebSocketEvent,
} from './request-log-contracts';

const LOG_NAME = /^[a-zA-Z0-9_.-]{1,128}$/;
const MAX_ACTIVE_OPERATIONS = 64;
const MAX_WS_INSPECTION_BYTES = 64 * 1024;
const FINISH_DEADLINE_MS = 250;
const HTTP_DISCONNECT_TERMINAL = 'terminal_before_client_disconnect';

type RequestLogDelivery = (records: RequestLogRecords) => void | Promise<void>;

export class RequestLogSession {
  private readonly open = new Map<string, AccessLogEntry>();
  private readonly captures = new Map<RequestLogWebSocketBody, WebSocketBodyCapture>();
  private readonly activeBodies = new Map<string, WebSocketBodyCapture>();
  private readonly deliveries = new WeakMap<RequestLogWebSocketEvent['message'], {
    event: RequestLogWebSocketEvent;
    deliver?: RequestLogDelivery;
  }>();
  private readonly bodies?: RequestLogWebSocketBodies;
  private stopped = false;
  private httpStarted = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly observer: RequestLogObserver,
    private readonly context: RequestLogContext,
    private readonly accessId: string,
    private readonly routePath: string,
    private readonly logging: RequestLoggerDependencies,
    private readonly acceptsOperations?: () => boolean | Promise<boolean>,
    maxBodyBytes?: number,
  ) {
    if (maxBodyBytes && logging.captureBody !== false && logging.bodyStorage?.saveStream) {
      this.bodies = Object.freeze({
        start: (request: RequestLogWebSocketEvent['message']) => {
          if (this.stopped || this.captures.size >= MAX_ACTIVE_OPERATIONS) return;
          const capture = new WebSocketBodyCapture(request, maxBodyBytes);
          const body = Object.freeze({
            append: (message: RequestLogWebSocketEvent['message']) => capture.append(message),
            discardRequest: () => capture.discardRequest(),
            discardResponse: (reason?: 'size_limit') => capture.discardResponse(reason),
            discard: () => { if (this.captures.delete(body)) capture.discard(); },
          });
          this.captures.set(body, capture);
          return body;
        },
      });
    }
  }

  prepareWebSocket(input: Omit<RequestLogWebSocketEvent, 'timestamp'>): RequestLogWebSocketEvent['message'] | undefined {
    if (this.stopped) return;
    const event = { ...input, timestamp: Date.now() };
    if (this.observer.prepareWebSocket) {
      let delivery;
      try {
        const message = event.message;
        const inspected = message.byteLength > bodyResources.loggerMemoryBytes ? {
          ...event, oversized: true as const, message: Object.freeze({ ...message, json: () => undefined }),
        } : event;
        delivery = this.observer.prepareWebSocket(Object.freeze(inspected), this.bodies);
      } catch {
        delivery = () => { throw new Error('request_log_websocket_prepare_failed'); };
      }
      if (!delivery) return;
      const projection = createWebSocketMessageView('');
      this.deliveries.set(projection, { event: { ...event, message: projection }, deliver: delivery });
      return projection;
    }
    if (event.settled) return;
    if (event.message.byteLength <= MAX_WS_INSPECTION_BYTES) {
      try { if (this.observer.shouldObserveWebSocket?.(event.direction, event.message) === false) return; }
      catch { /* observe conservatively */ }
    }
    this.deliveries.set(event.message, { event });
    return event.message;
  }

  observeWebSocket(message: RequestLogWebSocketEvent['message'], isActive: () => boolean): void | Promise<void> {
    const delivery = this.deliveries.get(message);
    this.deliveries.delete(message);
    if (delivery) return this.observe(delivery.event, isActive, delivery.deliver);
  }

  observe(event: RequestLogEvent, isActive: () => boolean, deliver?: RequestLogDelivery): void | Promise<void> {
    if (this.stopped) return;
    const active = () => !this.stopped && isActive();
    let started = false;
    const records: RequestLogRecords = {
      start: async ({ protocol, operation, body, startedAt }) => {
        if (!active() || started || this.open.size >= MAX_ACTIVE_OPERATIONS
          || !LOG_NAME.test(protocol) || !LOG_NAME.test(operation)) return;
        if (event.kind === 'http' && this.httpStarted) return;
        started = true;
        if (this.acceptsOperations && (!await this.acceptsOperations() || !active())) return;
        this.httpStarted = event.kind === 'http';
        const id = (event.kind === 'websocket' ? event.relatedOperationId : undefined) ?? randomUUID();
        let timestamp = event.kind === 'websocket' ? event.timestamp : Date.now();
        if (event.kind === 'websocket' && typeof startedAt === 'number' && Number.isSafeInteger(startedAt)) {
          timestamp = Math.min(timestamp, Math.max(this.startedAt, startedAt));
        }
        const entry: AccessLogEntry = {
          recordKind: 'operation', requestId: id, operationId: id, accessId: this.accessId,
          path: this.context.path, transportType: this.context.transportType, routePath: this.routePath, protocol, operation, timestamp,
          method: this.context.method,
          status: event.kind === 'http' ? event.status : 101, duration: 0, requestType: 'final', success: false,
        };
        this.open.set(id, entry);
        const capture = body && this.captures.get(body);
        const storage = this.logging.bodyStorage;
        if (event.kind === 'websocket' && body && capture && storage?.saveStream) {
          this.captures.delete(body);
          if (capture.attach(id, { saveStream: storage.saveStream.bind(storage) })) this.activeBodies.set(id, capture);
        }
        this.write(entry, false);
        return id;
      },
      finish: (id, result) => {
        if (!active() || (result && !['completed', 'failed', 'incomplete', 'cancelled'].includes(result.outcome))) return;
        if (event.kind === 'websocket' && event.relatedOperationId !== undefined && id !== event.relatedOperationId) return;
        const entry = this.open.get(id);
        if (!entry) return;
        this.open.delete(id);
        const endedAt = event.kind === 'websocket' ? event.timestamp : Date.now();
        if (!result) {
          this.finalizeIncomplete(entry, endedAt);
          return;
        }
        const acceptedHttpDisconnect = event.kind === 'http' && result.outcome === 'completed' && result.acceptClientDisconnect === true;
        const finished: AccessLogEntry = {
          ...entry, duration: Math.max(0, endedAt - entry.timestamp), protocolOutcome: result.outcome,
          protocolCode: result.code && LOG_NAME.test(result.code) ? result.code : undefined,
          // Upstream WS messages are observed after the client-facing send accepts them.
          transportOutcome: event.kind === 'websocket' && event.direction === 'upstream' ? 'completed' : entry.transportOutcome,
          transportCode: acceptedHttpDisconnect ? HTTP_DISCONNECT_TERMINAL : entry.transportCode,
          observationOutcome: 'complete', success: result.outcome === 'completed',
        };
        this.finalizeOperation(finished);
      },
    };
    const writer = Object.freeze(records);
    return deliver ? deliver(writer) : this.observer.observe(Object.freeze(event), writer);
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.open.values()) this.finalizeIncomplete(entry, Date.now());
    this.open.clear();
    for (const capture of this.captures.values()) capture.discard();
    this.captures.clear();
  }

  private finalizeIncomplete(entry: AccessLogEntry, endedAt: number): void {
    this.finalizeOperation({ ...entry, duration: Math.max(0, endedAt - entry.timestamp), observationOutcome: 'incomplete' });
  }

  private finalizeOperation(entry: AccessLogEntry): void {
    const capture = this.activeBodies.get(entry.requestId);
    if (!capture) { this.write(entry, true); return; }
    this.activeBodies.delete(entry.requestId);
    this.writeAccess(entry, true);
    trackBodyLogTask(capture.finish(entry.observationOutcome === 'incomplete').then(result => {
      const completed = { ...entry, ...result };
      this.writeAccess(completed, true);
      this.writeFile(completed);
    }));
  }

  private write(entry: AccessLogEntry, final: boolean): void {
    this.writeAccess(entry, final);
    if (final) this.writeFile(entry);
  }

  private writeAccess(entry: AccessLogEntry, final: boolean): void {
    try {
      this.logging.accessLogWriter?.write({ ...entry, replacePendingTransport: final });
    } catch { /* access logging cannot own traffic */ }
  }

  private writeFile(entry: AccessLogEntry): void {
    try { void Promise.resolve(this.logging.fileLogWriter?.write(entry)).catch(() => undefined); }
    catch { /* independent file sink */ }
  }
}

export function hasRequestLogCollector(hooks: PluginHooks): boolean {
  try { return hooks.onRequestLog.call() === true; }
  catch { return false; }
}

export function createRequestLog(
  hooks: PluginHooks | undefined, globalHooks: PluginHooks, request: Request, routePath: string, transportType: RequestLogContext['transportType'],
  accessId: string, logging: RequestLoggerDependencies | undefined,
  options?: { acceptsOperations: () => boolean | Promise<boolean>; webSocketMode?: RequestLogContext['webSocketMode']; maxBodyBytes?: number },
): RequestLogSession | undefined {
  if (!logging?.accessLogWriter && !logging?.fileLogWriter) return;
  const context = Object.freeze({
    method: request.method, path: new URL(request.url).pathname, transportType, webSocketMode: options?.webSocketMode,
  });
  for (const source of new Set([hooks, globalHooks])) {
    try {
      const observer = source?.onRequestLogApplication.call(context);
      if (observer) return new RequestLogSession(observer, context, accessId, routePath, logging, options?.acceptsOperations, options?.maxBodyBytes);
    } catch { /* protocol observation is optional */ }
  }
}

/** The response consumer drives the wire. Every view uses an optional lease. */
export function observeRequestLogHttp(
  response: Response, session: RequestLogSession, accessId: string, signal: AbortSignal, maxBytes: number,
): Response {
  const contentType = response.headers.get('content-type') ?? '';
  const contentEncoding = response.headers.get('content-encoding') ?? '';
  const existing = response.body && bodyObservationSourceFor(response.body);
  const source = existing || createBodySource(response.body, maxBytes, contentEncoding, undefined, {
    requestId: accessId, attemptId: accessId, direction: 'response', stage: 'client-response', version: 0, contentType, contentEncoding,
  });
  const wire = existing ? response.body : source.take();
  const controller = new AbortController();
  const allocation = new BodyBufferLease(true);
  const streaming = /^text\/event-stream(?:\s*;|$)/i.test(contentType.trim());
  const finiteSignal = AbortSignal.any([signal, controller.signal]);
  const observationSignal = streaming ? controller.signal : finiteSignal;
  let deadline: Timer | undefined;
  let settled = false;
  const raw = source.handle({ ...source.identity, direction: 'response', stage: 'client-response', contentType, contentEncoding }, streaming);
  const optional = (consumer?: BodyConsumer, viewSignal = finiteSignal): BodyConsumer => ({
    ...consumer, id: consumer?.id ?? 'request-log-application', mandatory: false,
    signal: consumer?.signal ? AbortSignal.any([viewSignal, consumer.signal]) : viewSignal,
  });
  const finite = async <T>(read: () => Promise<T>): Promise<T> => {
    finiteSignal.throwIfAborted();
    const release = source.retain(maxBytes, () => controller.abort());
    try {
      await source.completion;
      finiteSignal.throwIfAborted();
      return await read();
    } finally { release(); }
  };
  const copyBytes = async (read: () => Promise<Uint8Array>) => {
    const bytes = await read();
    finiteSignal.throwIfAborted();
    if (bytes.byteLength > maxBytes) throw new BodyProcessingError(413, 'body_log_too_large');
    allocation.add(bytes.byteLength);
    return new Uint8Array(bytes);
  };
  const body: BodyHandle = Object.freeze({
    ...raw,
    bytes: (consumer?: BodyConsumer) => finite(() => copyBytes(() => raw.bytes(optional(consumer)))),
    decoded: (consumer?: BodyConsumer) => finite(() => copyBytes(() => raw.decoded(optional(consumer)))),
    json: (consumer?: BodyConsumer, emptyObject?: boolean) => finite(() => raw.json(optional(consumer), emptyObject)),
    events: (consumer?: BodyConsumer) => {
      finiteSignal.throwIfAborted();
      return raw.events(optional(consumer, observationSignal));
    },
  });
  const stop = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    signal.removeEventListener('abort', startFinishDeadline);
    controller.abort();
    allocation.dispose();
    session.close();
    if (!existing) source.dispose();
  };
  // Bound cleanup without cancelling delivery of SSE frames already read from the wire.
  function startFinishDeadline(): void {
    if (settled || deadline) return;
    deadline = setTimeout(stop, FINISH_DEADLINE_MS);
    deadline.unref();
  }
  if (signal.aborted) stop();
  else if (streaming) signal.addEventListener('abort', startFinishDeadline, { once: true });
  else observationSignal.addEventListener('abort', stop, { once: true });
  let observing: Promise<void>;
  try {
    observing = Promise.resolve(session.observe({ kind: 'http', status: response.status, contentType, body, signal: observationSignal },
      () => !observationSignal.aborted));
  } catch (error) { observing = Promise.reject(error); }
  const finished = observing.catch(() => undefined).finally(() => {
    observationSignal.removeEventListener('abort', stop);
    stop();
  });
  // A streaming response can stay open indefinitely; track only its final drain.
  const trackFinish = () => {
    if (settled) return;
    startFinishDeadline();
    trackBodyLogTask(Promise.race([finished, new Promise<void>(resolve => observationSignal.addEventListener('abort', () => resolve(), { once: true }))]));
  };
  void source.completion.then(trackFinish, streaming ? trackFinish : stop);
  return existing ? response : new Response(wire, { status: response.status, statusText: response.statusText, headers: response.headers });
}
