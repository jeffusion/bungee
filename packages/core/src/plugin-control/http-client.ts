import { randomUUID } from 'node:crypto';
import {
  startCancelPluginControlHttpBody,
  encodePluginControlRpcMessage,
  hashPluginControlRpcBody,
  PLUGIN_CONTROL_HTTP_PATH,
  PluginControlHttpBodyError,
  readPluginControlHttpBody,
  samePluginControlRpcCredential,
  signPluginControlRpcMessage,
  PluginControlRpcProtocolError,
  type PluginControlRpcAuthority,
  type PluginControlRpcCall,
  type PluginControlRpcCancel,
  type PluginControlRpcCredential,
  type PluginControlRpcErrorCode,
  type PluginControlRpcUnsignedCall,
  type PluginControlRpcUnsignedCancel,
} from './http-protocol';
import { PLUGIN_CONTROL_RPC_MAX_BYTES, PLUGIN_CONTROL_RPC_MAX_DEADLINE_MS } from './http-protocol';
import { PluginControlRpcResponseGuard } from './http-rpc-guard';

const JSON_TYPE = 'application/json';
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type PluginControlHttpSession = {
  readonly credential: PluginControlRpcCredential;
  readonly authority: PluginControlRpcAuthority;
};

export type PluginControlHttpCall = {
  readonly revision: number;
  readonly endpoint_id: string;
  readonly attempt_id: string;
  readonly method: string;
  readonly payload: unknown;
};

export type PluginControlHttpErrorCode = PluginControlRpcErrorCode;

export class PluginControlHttpError extends Error {
  readonly name = 'PluginControlHttpError';

  constructor(readonly code: PluginControlHttpErrorCode, options?: { readonly cause?: unknown }) {
    super(code, options);
  }
}

export type PluginControlHttpClientOptions = {
  readonly baseUrl: string;
  readonly session: () => PluginControlHttpSession | null | Promise<PluginControlHttpSession | null>;
  readonly fetchImpl?: FetchLike;
  readonly wallClock?: () => number;
  /** Test/lifecycle bound; every call still uses one absolute deadline. */
  readonly deadlineMs?: number;
  readonly responseTimeoutMs?: number;
};

type PendingOperation = {
  readonly request: PluginControlRpcCall;
  readonly guard: PluginControlRpcResponseGuard;
  readonly credential: PluginControlRpcCredential;
  readonly controller: AbortController;
  readonly cancel: () => void;
  readonly fail: (error: unknown) => void;
};

type CancelTransport = {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly settle: (reason: string) => void;
};

class TransportError extends Error {
  constructor(readonly code: 'network_error' | 'timeout' | 'http_error' | 'invalid_response' | 'message_too_large') { super(code); }
}

function loopbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new PluginControlHttpError('unavailable'); }
  const hostname = url.hostname.toLowerCase();
  const port = Number(url.port);
  if (url.protocol !== 'http:' || (hostname !== '127.0.0.1' && hostname !== '::1' && hostname !== '[::1]')
    || !Number.isSafeInteger(port) || port <= 0 || port > 65_535
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new PluginControlHttpError('unavailable');
  }
  return url;
}

function protocolError(error: unknown, fallback: PluginControlHttpErrorCode): PluginControlHttpError {
  if (error instanceof PluginControlHttpError) return error;
  if (error instanceof TransportError) return new PluginControlHttpError(error.code, { cause: error });
  if (error instanceof PluginControlHttpBodyError) {
    return new PluginControlHttpError(error.code === 'body_timeout' ? 'timeout' : error.code === 'body_aborted' ? 'aborted' : 'message_too_large', { cause: error });
  }
  if (error instanceof PluginControlRpcProtocolError) {
    return new PluginControlHttpError(error.code === 'deadline_expired' ? 'timeout' : error.code, { cause: error });
  }
  return new PluginControlHttpError(fallback, { cause: error });
}

export class PluginControlHttpClient {
  private readonly endpoint: string;
  private readonly getSession: PluginControlHttpClientOptions['session'];
  private readonly fetchImpl: FetchLike;
  private readonly wallClock: () => number;
  private readonly deadlineMs: number;
  private readonly operations = new Map<string, PendingOperation>();
  private readonly cancelTransports = new Map<AbortController, CancelTransport>();
  private guard: PluginControlRpcResponseGuard | null = null;
  private credential: PluginControlRpcCredential | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(options: PluginControlHttpClientOptions) {
    const base = loopbackUrl(options.baseUrl);
    this.endpoint = new URL(PLUGIN_CONTROL_HTTP_PATH, base).toString();
    this.getSession = options.session;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wallClock = options.wallClock ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? options.responseTimeoutMs ?? PLUGIN_CONTROL_RPC_MAX_DEADLINE_MS;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs <= 0 || this.deadlineMs > PLUGIN_CONTROL_RPC_MAX_DEADLINE_MS) {
      throw new PluginControlHttpError('timeout');
    }
  }

  async call<TResult = unknown>(input: PluginControlHttpCall, signal: AbortSignal): Promise<TResult> {
    if (this.disposed) throw new PluginControlHttpError('disposed');
    if (signal.aborted) throw new PluginControlHttpError('aborted');
    let session: PluginControlHttpSession | null;
    try { session = await this.getSession(); } catch (error) { throw protocolError(error, 'unavailable'); }
    if (session === null) throw new PluginControlHttpError('unavailable');
    if (this.disposed) throw new PluginControlHttpError('disposed');
    if (signal.aborted) throw new PluginControlHttpError('aborted');

    const guard = this.ensureGuard(session);
    const requestId = randomUUID();
    const deadlineAt = this.wallClock() + this.deadlineMs;
    const body = {
      revision: input.revision, endpoint_id: input.endpoint_id, attempt_id: input.attempt_id,
      method: input.method, payload: input.payload,
    };
    const unsigned: PluginControlRpcUnsignedCall = {
      protocol: 'bungee-plugin-control-rpc/v1', kind: 'call', direction: 'worker-to-controller',
      authority: session.authority, sequence: ++this.sequence, request_id: requestId,
      deadline_at: deadlineAt, body_hash: hashPluginControlRpcBody(body), body,
    };
    const request = signPluginControlRpcMessage(unsigned, session.credential) as PluginControlRpcCall;
    const bytes = encodePluginControlRpcMessage(request);
    const pending = guard.registerCall(request);
    const controller = new AbortController();

    return new Promise<TResult>((resolve, reject) => {
      let done = false;
      let cancelSent = false;
      const cancel = (): void => {
        if (cancelSent) return;
        cancelSent = true;
        this.sendCancel(request, guard, session.credential);
      };
      const finish = (error?: unknown, result?: TResult): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        controller.abort('finished');
        this.operations.delete(requestId);
        if (error !== undefined) reject(error); else resolve(result as TResult);
      };
      const abort = (): void => {
        if (done) return;
        cancel();
        controller.abort('aborted');
        finish(new PluginControlHttpError('aborted'));
      };
      const fail = (error: unknown): void => {
        const mapped = protocolError(error, 'network_error');
        if (mapped.code === 'timeout') cancel();
        finish(mapped);
      };
      this.operations.set(requestId, { request, guard, credential: session.credential, controller, cancel, fail });
      signal.addEventListener('abort', abort, { once: true });
      void pending.then((result) => {
        if (result.body.ok) finish(undefined, result.body.result as TResult);
        else finish(new PluginControlHttpError(result.body.error as PluginControlRpcErrorCode));
      }, fail);
      void this.exchange(bytes, controller.signal, deadlineAt).then((responseBytes) => {
        if (done) return;
        try { guard.acceptResult(responseBytes); }
        catch (error) { guard.rejectCall(requestId, error instanceof PluginControlRpcProtocolError ? error.code : 'invalid_response'); }
      }, (error) => {
        if (done) return;
        const mapped = protocolError(error, 'network_error');
        guard.rejectCall(requestId, mapped.code);
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateSession('disposed');
    this.clearCancelTransports('disposed');
  }

  /** Abort the current authority's work while keeping this client reusable. */
  invalidateSession(code: PluginControlHttpErrorCode = 'stale_controller'): void {
    for (const operation of this.operations.values()) {
      operation.cancel();
      operation.controller.abort(code);
      operation.fail(new PluginControlHttpError(code));
    }
    this.operations.clear();
    this.guard?.dispose();
    this.guard = null;
    this.credential = null;
  }

  private ensureGuard(session: PluginControlHttpSession): PluginControlRpcResponseGuard {
    if (this.guard !== null && this.credential !== null && samePluginControlRpcCredential(this.credential, session.credential)) {
      const current = this.guard.currentAuthority;
      if (current.controller_epoch !== session.authority.controller_epoch || current.controller_id !== session.authority.controller_id) {
        for (const operation of this.operations.values()) if (operation.guard === this.guard) {
          operation.cancel();
          operation.fail(new PluginControlHttpError('stale_controller'));
        }
        this.guard.replaceAuthority(session.authority);
      }
      return this.guard;
    }
    if (this.guard !== null) {
      for (const operation of this.operations.values()) if (operation.guard === this.guard) {
        operation.cancel();
        operation.fail(new PluginControlHttpError('stale_controller'));
      }
      this.guard.dispose();
    }
    this.credential = session.credential;
    this.guard = new PluginControlRpcResponseGuard({ credential: session.credential, authority: session.authority, wallClock: this.wallClock, maxDeadlineMs: this.deadlineMs });
    return this.guard;
  }

  private clearCancelTransports(reason: string): void {
    for (const transport of [...this.cancelTransports.values()]) transport.settle(reason);
  }

  private async exchange(bytes: Uint8Array, parentSignal: AbortSignal, deadlineAt: number): Promise<Uint8Array> {
    const body = new TextDecoder().decode(bytes);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadlineAt - this.wallClock();
      if (remaining <= 0) throw new TransportError('timeout');
      const controller = new AbortController();
      let timedOut = false;
      const relay = (): void => controller.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', relay, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort('timeout'); }, remaining);
      try {
        const response = await this.fetchImpl(this.endpoint, { method: 'POST', body, redirect: 'manual', signal: controller.signal, headers: { 'content-type': JSON_TYPE } });
        if (response.status !== 200) {
          startCancelPluginControlHttpBody(response.body);
          throw new TransportError('http_error');
        }
        if (response.headers.get('content-type')?.toLowerCase() !== JSON_TYPE) {
          startCancelPluginControlHttpBody(response.body);
          throw new TransportError('invalid_response');
        }
        return await readPluginControlHttpBody(response.body, { maxBytes: PLUGIN_CONTROL_RPC_MAX_BYTES, deadlineAt, wallClock: this.wallClock, signal: controller.signal });
      } catch (error) {
        if (parentSignal.aborted) throw new PluginControlHttpError('aborted');
        if (timedOut || (error instanceof DOMException && error.name === 'AbortError')) {
          if (attempt === 0 && deadlineAt > this.wallClock()) continue;
          throw new TransportError('timeout');
        }
        if (error instanceof PluginControlHttpBodyError) {
          if (error.code === 'body_timeout' || error.code === 'body_aborted') {
            if (attempt === 0 && deadlineAt > this.wallClock()) continue;
            throw new TransportError('timeout');
          }
          throw new TransportError('message_too_large');
        }
        if (error instanceof TransportError) {
          if (error.code === 'timeout' && attempt === 0 && deadlineAt > this.wallClock()) continue;
          throw error;
        }
        if (attempt === 0 && deadlineAt > this.wallClock()) continue;
        throw new TransportError('network_error');
      } finally {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', relay);
      }
    }
    throw new TransportError('network_error');
  }

  private sendCancel(request: PluginControlRpcCall, guard: PluginControlRpcResponseGuard, credential: PluginControlRpcCredential): void {
    const body = { target_request_id: request.request_id };
    try {
      const unsigned: PluginControlRpcUnsignedCancel = {
        protocol: 'bungee-plugin-control-rpc/v1', kind: 'cancel', direction: 'worker-to-controller',
        authority: request.authority, sequence: ++this.sequence, request_id: randomUUID(),
        deadline_at: this.wallClock() + this.deadlineMs,
        body_hash: hashPluginControlRpcBody(body), body,
      };
      const cancel = signPluginControlRpcMessage(unsigned, credential) as PluginControlRpcCancel;
      guard.registerCancel(cancel);
      const bytes = encodePluginControlRpcMessage(cancel);
      const controller = new AbortController();
      const deadlineAt = cancel.deadline_at;
      const remaining = Math.max(0, deadlineAt - this.wallClock());
      let timer!: ReturnType<typeof setTimeout>;
      let active = true;
      let settleTracking!: () => void;
      const tracking = new Promise<void>((resolve) => { settleTracking = resolve; });
      const settle = (reason: string): void => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        this.cancelTransports.delete(controller);
        controller.abort(reason);
        settleTracking();
      };
      timer = setTimeout(() => settle('cancel timeout'), remaining);
      this.cancelTransports.set(controller, { timer, settle });
      const fetchTask = Promise.resolve().then(() => this.fetchImpl(this.endpoint, {
        method: 'POST', body: new TextDecoder().decode(bytes), redirect: 'manual', signal: controller.signal, headers: { 'content-type': JSON_TYPE },
      }));
      const fetchOutcome = fetchTask.then((response) => {
        startCancelPluginControlHttpBody(response.body);
      }, () => undefined);
      void Promise.race([fetchOutcome, tracking]).then(() => settle('cancel settled'), () => settle('cancel failed'));
    } catch { /* best effort only; the caller is already cancelled */ }
  }
}

export function createPluginControlHttpClient(options: PluginControlHttpClientOptions): PluginControlHttpClient {
  return new PluginControlHttpClient(options);
}
