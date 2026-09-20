import { randomUUID } from 'node:crypto';
import {
  RATE_LIMIT_MAX_BYTES,
  RATE_LIMIT_MAX_DEADLINE_MS,
  RateLimitProtocolError,
  serializeRateLimitMessage,
  signRateLimitDebitRequest,
  verifyRateLimitDebitResponse,
  type RateLimitCredential,
  type RateLimitDebitRequestBody,
  type RateLimitDebitResponseBody,
  type RateLimitIngressIdentity,
  type RateLimitWireCounters,
} from './protocol';
import { IngressTokenBucketStore } from './store';
import { rateLimitFailureReasonForProtocolCode } from './profile';
import type {
  RateLimitFailure,
  RateLimitFailureReason,
  RateLimitFailureStage,
  RateLimitObserver,
  RateLimitTimingStage,
} from './profile';

export const RATE_LIMIT_HTTP_PATH = '/__bungee/internal/rate-limit/v1' as const;

const JSON_TYPE = 'application/json';
const MAX_PREAUTH_BODY_READS = 64;
const MAX_PENDING_OPERATIONS = 64;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type BodyErrorCode = 'body_timeout' | 'body_aborted' | 'message_too_large';

class BodyError extends Error {
  constructor(readonly code: BodyErrorCode) { super(code); }
}

class HttpError extends Error {
  constructor(readonly code: 'wrong_route' | 'inactive' | 'busy' | 'unsupported_content_type') { super(code); }
}

function failureFor(error: unknown, stage: RateLimitFailureStage, attempts: number): RateLimitFailure {
  let reason: RateLimitFailureReason = 'unexpected';
  let protocolCode: string | undefined;
  let remoteStatus: number | undefined;
  if (error instanceof RateLimitHttpError) {
    reason = error.failureReason ?? error.code;
    protocolCode = error.protocolCode;
    remoteStatus = error.remoteStatus;
  } else if (error instanceof BodyError) {
    reason = error.code === 'body_timeout' ? 'timeout' : error.code === 'body_aborted' ? 'aborted' : 'transport_invalid';
    protocolCode = error.code === 'message_too_large' ? error.code : undefined;
  } else if (error instanceof HttpError) {
    reason = error.code === 'busy' ? 'busy' : error.code === 'inactive' ? 'disposed' : 'transport_invalid';
  } else if (error instanceof RateLimitProtocolError) {
    reason = rateLimitFailureReasonForProtocolCode(error.code);
    protocolCode = error.code;
  } else if (stage === 'sign') {
    reason = 'configuration_invalid';
  } else if (stage === 'session') {
    reason = 'unavailable';
  } else if (stage === 'fetch') {
    reason = 'network_error';
  }
  return {
    reason,
    stage,
    ...(protocolCode === undefined ? {} : { protocolCode }),
    ...(remoteStatus === undefined ? {} : { remoteStatus }),
    attempts,
    totalMs: 0,
  };
}

function isServerReadProtocolError(error: RateLimitProtocolError): boolean {
  return ['malformed_message', 'unsupported_protocol', 'message_too_large']
    .includes(error.code);
}

function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null, reason?: unknown): void {
  if (body === null) return;
  try { void Promise.resolve(body.cancel(reason)).catch(() => undefined); } catch { /* cancellation is best effort */ }
}

async function readBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, deadlineAt: number, wallClock: () => number, signal: AbortSignal): Promise<Uint8Array> {
  let terminal: BodyError | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const cancel = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    cancelBody(reader ?? body, reason);
  };
  const terminate = (error: BodyError): BodyError => {
    if (terminal === undefined) {
      terminal = error;
      cancel(error);
    }
    return terminal;
  };
  const checkpoint = (): void => {
    if (terminal !== undefined) throw terminal;
    if (signal.aborted) throw terminate(new BodyError('body_aborted'));
    if (wallClock() >= deadlineAt) throw terminate(new BodyError('body_timeout'));
  };
  checkpoint();
  if (body === null) return new Uint8Array();
  reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => reject(terminate(new BodyError('body_timeout'))), Math.max(0, deadlineAt - wallClock()));
    });
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(terminate(new BodyError('body_aborted')));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    while (true) {
      checkpoint();
      if (terminal !== undefined) throw terminal;
      const part = await Promise.race([reader.read(), timeout, aborted]);
      checkpoint();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) throw terminate(new BodyError('message_too_large'));
      chunks.push(part.value);
    }
    checkpoint();
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    if (error instanceof BodyError) throw terminate(error);
    if (terminal !== undefined) throw terminal;
    throw terminate(new BodyError('body_aborted'));
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function errorResponse(error: unknown): Response {
  const code = error instanceof BodyError ? error.code : error instanceof HttpError ? error.code : 'transport_invalid';
  const status = error instanceof BodyError && error.code === 'message_too_large' ? 413
    : error instanceof BodyError && error.code === 'body_timeout' ? 408
      : error instanceof HttpError && error.code === 'busy' ? 429
        : error instanceof HttpError && error.code === 'wrong_route' ? 404
          : error instanceof HttpError && error.code === 'unsupported_content_type' ? 415
            : error instanceof RateLimitProtocolError && (error.code === 'invalid_mac' || error.code === 'identity_mismatch' || error.code === 'worker_unknown' || error.code === 'worker_prepared') ? 403
              : 400;
  return Response.json({ error: code }, { status, headers: { 'content-type': JSON_TYPE } });
}

export type RateLimitHttpServerOptions = {
  /** The store owns trusted synchronous worker membership via authorizeWorker. */
  readonly store: IngressTokenBucketStore;
  readonly wallClock?: () => number;
  readonly bodyTimeoutMs?: number;
  readonly maxPreauthBodyReads?: number;
  readonly counters?: RateLimitWireCounters;
  readonly observer?: RateLimitObserver;
  readonly monotonicClock?: () => number;
  readonly now?: () => number;
};

export class RateLimitHttpServer {
  private readonly wallClock: () => number;
  private readonly bodyTimeoutMs: number;
  private readonly maxPreauthBodyReads: number;
  private readonly lifetime = new AbortController();
  private readonly bodyReads = new Set<AbortController>();
  private disposed = false;
  private preauthBodyReads = 0;
  private readonly observer: RateLimitObserver | undefined;
  private readonly now: (() => number) | undefined;

  constructor(private readonly options: RateLimitHttpServerOptions) {
    this.wallClock = options.wallClock ?? Date.now;
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? 5_000;
    this.maxPreauthBodyReads = options.maxPreauthBodyReads ?? MAX_PREAUTH_BODY_READS;
    this.observer = options.observer;
    this.now = options.observer === undefined ? undefined : options.monotonicClock ?? options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.bodyTimeoutMs) || this.bodyTimeoutMs <= 0 || this.bodyTimeoutMs > RATE_LIMIT_MAX_DEADLINE_MS
      || !Number.isSafeInteger(this.maxPreauthBodyReads) || this.maxPreauthBodyReads < 1 || this.maxPreauthBodyReads > MAX_PREAUTH_BODY_READS) {
      throw new Error('invalid rate-limit HTTP bounds');
    }
  }

  get preauthBodyReadCount(): number { return this.preauthBodyReads; }
  fetch(request: Request): Promise<Response> { return this.handle(request); }

  async handle(request: Request): Promise<Response> {
    const startedAt = this.now?.();
    let stage: RateLimitFailureStage = 'precondition';
    let totalEmitted = false;
    const emitTiming = (timingStage: RateLimitTimingStage, started: number): void => {
      if (this.observer?.timing === undefined || this.now === undefined) return;
      try { this.observer.timing({ stage: timingStage, durationMs: Math.max(0, this.now() - started) }); } catch { /* diagnostics never affect transport */ }
    };
    const emitFailure = (error: unknown): void => {
      if (this.observer?.failure === undefined || this.now === undefined || startedAt === undefined) return;
      const failure = failureFor(error, stage, 1);
      try { this.observer.failure({ ...failure, totalMs: Math.max(0, this.now() - startedAt) }); } catch { /* diagnostics never affect transport */ }
    };
    if (this.disposed) {
      cancelBody(request.body, 'disposed');
      emitFailure(new HttpError('inactive'));
      if (startedAt !== undefined) emitTiming('server_total', startedAt);
      return errorResponse(new HttpError('inactive'));
    }
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== RATE_LIMIT_HTTP_PATH || url.search !== '' || url.hash !== '') {
        cancelBody(request.body, 'wrong route');
        throw new HttpError('wrong_route');
      }
      if (request.headers.get('content-type')?.toLowerCase() !== JSON_TYPE) {
        cancelBody(request.body, 'unsupported content type');
        throw new HttpError('unsupported_content_type');
      }
      if (this.preauthBodyReads >= this.maxPreauthBodyReads) {
        cancelBody(request.body, 'busy');
        throw new HttpError('busy');
      }
      this.preauthBodyReads += 1;
      const controller = new AbortController();
      const abort = (): void => controller.abort('disposed');
      const abortRequest = (): void => controller.abort('request aborted');
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      request.signal.addEventListener('abort', abortRequest, { once: true });
      if (request.signal.aborted) abortRequest();
      this.bodyReads.add(controller);
      let bytes: Uint8Array;
      try {
        stage = 'read';
        const readStarted = this.now?.();
        try {
          bytes = await readBody(request.body, RATE_LIMIT_MAX_BYTES, this.wallClock() + this.bodyTimeoutMs, this.wallClock, controller.signal);
        } finally {
          if (readStarted !== undefined) emitTiming('server_read', readStarted);
        }
      } finally {
        this.bodyReads.delete(controller);
        this.preauthBodyReads -= 1;
        this.lifetime.signal.removeEventListener('abort', abort);
        request.signal.removeEventListener('abort', abortRequest);
      }
      if (this.disposed) throw new HttpError('inactive');
      if (controller.signal.aborted) throw new BodyError('body_aborted');
      stage = 'server_store';
      const storeStarted = this.now?.();
      let response: ReturnType<IngressTokenBucketStore['handleDebitWire']>;
      try {
        response = this.options.store.handleDebitWire(bytes, this.options.counters);
      } finally {
        if (storeStarted !== undefined) emitTiming('server_store_total', storeStarted);
      }
      if (this.disposed) throw new HttpError('inactive');
      if (controller.signal.aborted) throw new BodyError('body_aborted');
      if (this.disposed) throw new HttpError('inactive');
      if (controller.signal.aborted) throw new BodyError('body_aborted');
      stage = 'server_serialize';
      const serializeStarted = this.now?.();
      try {
        return new Response(serializeRateLimitMessage(response, this.options.counters), { status: 200, headers: { 'content-type': JSON_TYPE } });
      } finally {
        if (serializeStarted !== undefined) emitTiming('server_serialize', serializeStarted);
      }
    } catch (error) {
      if (error instanceof BodyError && stage === 'read') stage = 'server_read';
      if (error instanceof RateLimitProtocolError && isServerReadProtocolError(error)) stage = 'server_read';
      emitFailure(error);
      return errorResponse(error);
    } finally {
      if (!totalEmitted && startedAt !== undefined) {
        totalEmitted = true;
        emitTiming('server_total', startedAt);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort('disposed');
    for (const reader of this.bodyReads) reader.abort('disposed');
    this.bodyReads.clear();
  }
}

export function createRateLimitHttpServer(options: RateLimitHttpServerOptions): RateLimitHttpServer {
  return new RateLimitHttpServer(options);
}

export type RateLimitHttpSession = {
  readonly credential: RateLimitCredential;
  readonly expectedIngress: RateLimitIngressIdentity;
};

export type RateLimitHttpClientOptions = {
  readonly baseUrl: string;
  readonly session: () => RateLimitHttpSession | null | Promise<RateLimitHttpSession | null>;
  readonly fetchImpl?: FetchLike;
  readonly wallClock?: () => number;
  readonly deadlineMs?: number;
  readonly counters?: RateLimitWireCounters;
  readonly observer?: RateLimitObserver;
  readonly monotonicClock?: () => number;
  readonly now?: () => number;
};

export class RateLimitHttpError extends Error {
  readonly name = 'RateLimitHttpError';
  constructor(readonly code: 'unavailable' | 'busy' | 'aborted' | 'disposed' | 'timeout' | 'network_error' | 'transport_invalid', options?: {
    cause?: unknown;
    remoteStatus?: number;
    failureReason?: RateLimitFailureReason;
    protocolCode?: string;
  }) {
    super(code, options);
    this.remoteStatus = options?.remoteStatus;
    this.failureReason = options?.failureReason;
    this.protocolCode = options?.protocolCode;
  }
  readonly remoteStatus?: number;
  readonly failureReason?: RateLimitFailureReason;
  readonly protocolCode?: string;
}

function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RateLimitHttpError('unavailable'); }
  const host = url.hostname.toLowerCase();
  const port = Number(url.port);
  if (url.protocol !== 'http:' || (host !== '127.0.0.1' && host !== '::1' && host !== '[::1]')
    || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new RateLimitHttpError('unavailable');
  return new URL(RATE_LIMIT_HTTP_PATH, url).toString();
}

function abortable<T>(task: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: any) => void, value: any): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const late = (value: T): void => { try { onLateValue?.(value); } catch { /* cancellation is best effort */ } };
    const abort = (): void => finish(reject, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void task.then((value) => {
      if (settled || signal.aborted) { late(value); return; }
      finish(resolve, value);
    }, (error) => {
      if (settled || signal.aborted) return;
      finish(reject, error);
    });
  });
}

function abortableFetch(task: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return abortable(task, signal, (response) => cancelBody(response.body, signal.reason));
}

export class RateLimitHttpClient {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly wallClock: () => number;
  private readonly deadlineMs: number;
  private readonly pending = new Set<AbortController>();
  private disposed = false;
  private readonly observer: RateLimitObserver | undefined;
  private readonly now: (() => number) | undefined;

  constructor(private readonly options: RateLimitHttpClientOptions) {
    this.endpoint = endpoint(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wallClock = options.wallClock ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? RATE_LIMIT_MAX_DEADLINE_MS;
    this.observer = options.observer;
    this.now = options.observer === undefined ? undefined : options.monotonicClock ?? options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > RATE_LIMIT_MAX_DEADLINE_MS) {
      throw new RateLimitHttpError('timeout');
    }
  }

  get pendingCount(): number { return this.pending.size; }

  async debit(body: RateLimitDebitRequestBody, signal?: AbortSignal): Promise<RateLimitDebitResponseBody> {
    const startedAt = this.now?.();
    let stage: RateLimitFailureStage = 'precondition';
    let attempts = 0;
    let totalEmitted = false;
    const emitTiming = (timingStage: RateLimitTimingStage, started: number): void => {
      if (this.observer?.timing === undefined || this.now === undefined) return;
      try { this.observer.timing({ stage: timingStage, durationMs: Math.max(0, this.now() - started) }); } catch { /* diagnostics never affect transport */ }
    };
    const emitFailure = (error: unknown): void => {
      if (this.observer?.failure === undefined || this.now === undefined || startedAt === undefined) return;
      const failure = failureFor(error, stage, attempts);
      try { this.observer.failure({ ...failure, totalMs: Math.max(0, this.now() - startedAt) }); } catch { /* diagnostics never affect transport */ }
    };
    if (this.disposed) { const error = new RateLimitHttpError('disposed'); emitFailure(error); if (startedAt !== undefined) emitTiming('total', startedAt); throw error; }
    if (signal?.aborted) { const error = new RateLimitHttpError('aborted'); emitFailure(error); if (startedAt !== undefined) emitTiming('total', startedAt); throw error; }
    const deadlineAt = this.wallClock() + this.deadlineMs;
    if (this.pending.size >= MAX_PENDING_OPERATIONS) { const error = new RateLimitHttpError('busy'); emitFailure(error); if (startedAt !== undefined) emitTiming('total', startedAt); throw error; }
    const controller = new AbortController();
    const relay = (): void => controller.abort('aborted');
    signal?.addEventListener('abort', relay, { once: true });
    if (signal?.aborted) relay();
    const remaining = Math.min(this.deadlineMs, Math.max(0, deadlineAt - this.wallClock()));
    const timer = setTimeout(() => controller.abort('timeout'), remaining);
    this.pending.add(controller);
    try {
      let session: RateLimitHttpSession | null;
      try {
        stage = 'session';
        const sessionStarted = this.now?.();
        try {
          session = await abortable(Promise.resolve().then(() => this.options.session()), controller.signal);
        } finally {
          if (sessionStarted !== undefined) emitTiming('session', sessionStarted);
        }
      } catch (cause) {
        this.fence(controller, deadlineAt, signal);
        throw new RateLimitHttpError('unavailable', { cause });
      }
      this.fence(controller, deadlineAt, signal);
      if (session === null) throw new RateLimitHttpError('unavailable');
      stage = 'sign';
      const signStarted = this.now?.();
      let request;
      let wire: string;
      try {
        request = signRateLimitDebitRequest({ request_id: randomUUID(), debit_id: randomUUID(), deadline_at: deadlineAt, body }, session.credential);
        wire = serializeRateLimitMessage(request, this.options.counters);
      } catch (error) {
        throw new RateLimitHttpError('unavailable', { cause: error, failureReason: 'configuration_invalid' });
      } finally {
        if (signStarted !== undefined) emitTiming('sign', signStarted);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        attempts = attempt + 1;
        this.fence(controller, deadlineAt, signal);
        let response: Response | undefined;
        try {
          stage = 'fetch';
          const fetchStarted = this.now?.();
          try {
            response = await abortableFetch(Promise.resolve().then(() => this.fetchImpl(this.endpoint, {
              method: 'POST', body: wire, redirect: 'manual', signal: controller.signal, headers: { 'content-type': JSON_TYPE },
            })), controller.signal);
          } finally {
            if (fetchStarted !== undefined) emitTiming(attempt === 0 ? 'fetch1' : 'fetch2', fetchStarted);
          }
          this.fence(controller, deadlineAt, signal);
          if (response.status !== 200 || response.headers.get('content-type')?.toLowerCase() !== JSON_TYPE) {
            throw new RateLimitHttpError('transport_invalid', { remoteStatus: response.status });
          }
          stage = 'read';
          const readStarted = this.now?.();
          let responseBytes: Uint8Array;
          try {
            responseBytes = await readBody(response.body, RATE_LIMIT_MAX_BYTES, deadlineAt, this.wallClock, controller.signal);
          } finally {
            if (readStarted !== undefined) emitTiming('read', readStarted);
          }
          response = undefined;
          this.fence(controller, deadlineAt, signal);
          stage = 'verify';
          const verifyStarted = this.now?.();
          let verified;
          try {
            verified = verifyRateLimitDebitResponse(responseBytes, session.credential, session.expectedIngress, request, this.options.counters);
          } finally {
            if (verifyStarted !== undefined) emitTiming('verify', verifyStarted);
          }
          this.fence(controller, deadlineAt, signal);
          return verified.body;
        } catch (error) {
          cancelBody(response?.body ?? null, controller.signal.reason);
          if (error instanceof RateLimitHttpError) throw error;
          this.fence(controller, deadlineAt, signal);
          if (error instanceof BodyError) {
            const failureReason = error.code === 'body_timeout' ? 'timeout' : error.code === 'body_aborted' ? 'aborted' : 'transport_invalid';
            throw new RateLimitHttpError('transport_invalid', {
              cause: error,
              failureReason,
              ...(error.code === 'message_too_large' ? { protocolCode: error.code } : {}),
            });
          }
          if (error instanceof RateLimitProtocolError) {
            throw new RateLimitHttpError('transport_invalid', {
              cause: error,
              failureReason: rateLimitFailureReasonForProtocolCode(error.code),
              protocolCode: error.code,
            });
          }
          if (attempt === 1 || this.wallClock() >= deadlineAt) throw new RateLimitHttpError('network_error', { cause: error });
        }
      }
      throw new RateLimitHttpError('timeout');
    } catch (error) {
      emitFailure(error);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
      this.pending.delete(controller);
      controller.abort('finished');
      if (!totalEmitted && startedAt !== undefined) {
        totalEmitted = true;
        emitTiming('total', startedAt);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.pending) controller.abort('disposed');
    this.pending.clear();
  }

  private fence(controller: AbortController, deadlineAt: number, signal?: AbortSignal): void {
    if (!controller.signal.aborted) {
      if (this.wallClock() >= deadlineAt) controller.abort('timeout');
      else if (this.disposed) controller.abort('disposed');
      else if (signal?.aborted) controller.abort('aborted');
    }
    if (!controller.signal.aborted) return;
    const code = controller.signal.reason === 'disposed' ? 'disposed'
      : controller.signal.reason === 'aborted' ? 'aborted' : 'timeout';
    throw new RateLimitHttpError(code);
  }
}

export function createRateLimitHttpClient(options: RateLimitHttpClientOptions): RateLimitHttpClient {
  return new RateLimitHttpClient(options);
}
