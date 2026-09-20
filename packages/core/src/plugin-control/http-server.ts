import { canonicalJson } from '../config-storage/content-hash';
import {
  startCancelPluginControlHttpBody,
  encodePluginControlRpcMessage,
  parsePluginControlRpcMessage,
  PLUGIN_CONTROL_HTTP_PATH,
  PluginControlHttpBodyError,
  readPluginControlHttpBody,
  samePluginControlRpcCredential,
  PluginControlRpcProtocolError,
  verifyPluginControlRpcMessage,
  type PluginControlRpcAuthority,
  type PluginControlRpcCredential,
  type PluginControlRpcWorker,
} from './http-protocol';
import { PLUGIN_CONTROL_RPC_MAX_BYTES, PLUGIN_CONTROL_RPC_MAX_INFLIGHT } from './http-protocol';
import {
  PluginControlRpcRequestGuard,
  type PluginControlRpcAction,
  type PluginControlRpcGlobalCapacity,
} from './http-rpc-guard';

const JSON_TYPE = 'application/json';
const MAX_PREAUTH_BODY_READS = 64;

type HttpAdapterErrorCode = 'body_timeout' | 'body_aborted' | 'message_too_large' | 'unknown_active' | 'wrong_route' | 'inactive' | 'busy';

class HttpAdapterError extends Error {
  constructor(readonly code: HttpAdapterErrorCode) { super(code); }
}

export type PluginControlHttpSession = {
  readonly credential: PluginControlRpcCredential;
  readonly authority: PluginControlRpcAuthority;
};

export type PluginControlHttpServerOptions = {
  readonly resolveCredential: (worker: PluginControlRpcWorker) => PluginControlHttpSession | null;
  readonly execute: PluginControlRpcAction;
  readonly globalCapacity?: PluginControlRpcGlobalCapacity;
  readonly wallClock?: () => number;
  readonly bodyTimeoutMs?: number;
  readonly maxBodyBytes?: number;
};

type GuardRecord = {
  readonly credential: PluginControlRpcCredential;
  readonly guard: PluginControlRpcRequestGuard;
};

function workerKey(worker: PluginControlRpcWorker): string { return canonicalJson(worker); }

function unauthorized(error: unknown): boolean {
  return error instanceof HttpAdapterError && error.code === 'unknown_active'
    || error instanceof PluginControlRpcProtocolError
      && (error.code === 'invalid_mac' || error.code === 'identity_mismatch' || error.code === 'stale_controller' || error.code === 'split_brain');
}

function errorStatus(error: unknown): number {
  if (unauthorized(error)) return 403;
  if (error instanceof HttpAdapterError && error.code === 'message_too_large') return 413;
  if (error instanceof HttpAdapterError && error.code === 'busy') return 429;
  if (error instanceof HttpAdapterError && error.code === 'body_timeout') return 408;
  if (error instanceof HttpAdapterError && error.code === 'wrong_route') return 404;
  return 400;
}

function errorResponse(error: unknown): Response {
  return unauthorized(error)
    ? Response.json({ error: 'unauthorized' }, { status: 403, headers: { 'content-type': JSON_TYPE } })
    : Response.json({ error: error instanceof HttpAdapterError ? error.code : 'protocol_error' }, { status: errorStatus(error), headers: { 'content-type': JSON_TYPE } });
}

export class PluginControlHttpServer {
  private readonly resolveCredential: PluginControlHttpServerOptions['resolveCredential'];
  private readonly execute: PluginControlRpcAction;
  private readonly globalCapacity: PluginControlRpcGlobalCapacity;
  private readonly wallClock: () => number;
  private readonly bodyTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly guards = new Map<string, GuardRecord>();
  private readonly bodyReads = new Set<AbortController>();
  private preauthBodyReads = 0;
  private readonly lifetime = new AbortController();
  private generation = 0;
  private disposed = false;

  constructor(options: PluginControlHttpServerOptions) {
    this.resolveCredential = options.resolveCredential;
    this.execute = options.execute;
    this.globalCapacity = options.globalCapacity ?? { limit: PLUGIN_CONTROL_RPC_MAX_INFLIGHT, active: 0 };
    this.wallClock = options.wallClock ?? Date.now;
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? 5_000;
    this.maxBodyBytes = options.maxBodyBytes ?? PLUGIN_CONTROL_RPC_MAX_BYTES;
    if (!Number.isSafeInteger(this.bodyTimeoutMs) || this.bodyTimeoutMs <= 0
      || !Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0 || this.maxBodyBytes > PLUGIN_CONTROL_RPC_MAX_BYTES) {
      throw new Error('invalid plugin control HTTP bounds');
    }
  }

  get guardCount(): number { return this.guards.size; }
  get preauthBodyReadCount(): number { return this.preauthBodyReads; }
  fetch(request: Request): Promise<Response> { return this.handle(request); }

  async handle(request: Request): Promise<Response> {
    const requestGeneration = this.generation;
    if (this.disposed) {
      startCancelPluginControlHttpBody(request.body);
      return errorResponse(new HttpAdapterError('inactive'));
    }
    try {
      const url = new URL(request.url);
      if (url.pathname !== PLUGIN_CONTROL_HTTP_PATH || url.search !== '' || url.hash !== '' || request.method !== 'POST') {
        startCancelPluginControlHttpBody(request.body);
        throw new HttpAdapterError('wrong_route');
      }
      if (request.headers.get('content-type')?.toLowerCase() !== JSON_TYPE) {
        startCancelPluginControlHttpBody(request.body);
        return Response.json({ error: 'unsupported_content_type' }, { status: 415, headers: { 'content-type': JSON_TYPE } });
      }
      if (this.preauthBodyReads >= MAX_PREAUTH_BODY_READS) {
        startCancelPluginControlHttpBody(request.body);
        throw new HttpAdapterError('busy');
      }
      this.preauthBodyReads += 1;
      const bodyLifetime = new AbortController();
      const onDispose = (): void => bodyLifetime.abort('disposed');
      this.lifetime.signal.addEventListener('abort', onDispose, { once: true });
      this.bodyReads.add(bodyLifetime);
      let body: Uint8Array;
      try {
        body = await readPluginControlHttpBody(request.body, {
          maxBytes: this.maxBodyBytes,
          deadlineAt: this.wallClock() + this.bodyTimeoutMs,
          wallClock: this.wallClock,
          signal: bodyLifetime.signal,
        });
      } finally {
        if (this.bodyReads.delete(bodyLifetime)) this.preauthBodyReads -= 1;
        this.lifetime.signal.removeEventListener('abort', onDispose);
      }
      this.assertActive(requestGeneration);
      const message = parsePluginControlRpcMessage(body);
      if (message.kind !== 'call' && message.kind !== 'cancel') throw new PluginControlRpcProtocolError('malformed_message');
      const resolved = this.resolveCredential(message.worker);
      this.assertActive(requestGeneration);
      if (resolved === null) throw new HttpAdapterError('unknown_active');
      verifyPluginControlRpcMessage(message, resolved.credential);
      if (message.authority.controller_epoch !== resolved.authority.controller_epoch) throw new PluginControlRpcProtocolError('stale_controller');
      if (message.authority.controller_id !== resolved.authority.controller_id) throw new PluginControlRpcProtocolError('split_brain');
      const guard = this.guardFor(message.worker, resolved, requestGeneration);
      if (message.kind === 'cancel') {
        await guard.handleCancel(message);
        this.assertActive(requestGeneration);
        return new Response(null, { status: 204 });
      }
      const result = await guard.handleCall(message, this.execute);
      this.assertActive(requestGeneration);
      return new Response(new Uint8Array(encodePluginControlRpcMessage(result)), {
        status: 200,
        headers: { 'content-type': JSON_TYPE },
      });
    } catch (error) {
      if (error instanceof PluginControlHttpBodyError) {
        return errorResponse(new HttpAdapterError(error.code));
      }
      return errorResponse(error);
    }
  }

  /** Caller must atomically replace the active session map before pruning this cache. */
  pruneGuards(activeWorkers: Iterable<PluginControlRpcWorker>): void {
    this.generation += 1;
    for (const bodyRead of this.bodyReads) bodyRead.abort('reconciled');
    this.bodyReads.clear();
    this.preauthBodyReads = 0;
    const active = new Set([...activeWorkers].map(workerKey));
    for (const [key, record] of this.guards) {
      if (!active.has(key)) {
        record.guard.dispose();
        this.guards.delete(key);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.lifetime.abort('disposed');
    for (const bodyRead of this.bodyReads) bodyRead.abort('disposed');
    this.bodyReads.clear();
    this.preauthBodyReads = 0;
    for (const record of this.guards.values()) record.guard.dispose();
    this.guards.clear();
  }

  private assertActive(requestGeneration: number): void {
    if (this.disposed || requestGeneration !== this.generation) throw new HttpAdapterError('inactive');
  }

  private guardFor(worker: PluginControlRpcWorker, session: PluginControlHttpSession, requestGeneration: number): PluginControlRpcRequestGuard {
    this.assertActive(requestGeneration);
    const key = workerKey(worker);
    const current = this.guards.get(key);
    if (current !== undefined && !samePluginControlRpcCredential(current.credential, session.credential)) {
      current.guard.dispose();
      this.guards.delete(key);
    }
    const existing = this.guards.get(key);
    if (existing !== undefined) {
      existing.guard.replaceAuthority(session.authority);
      return existing.guard;
    }
    const guard = new PluginControlRpcRequestGuard({
      credential: session.credential,
      authority: session.authority,
      globalCapacity: this.globalCapacity,
      wallClock: this.wallClock,
    });
    if (this.disposed) {
      guard.dispose();
      throw new HttpAdapterError('inactive');
    }
    this.guards.set(key, { credential: session.credential, guard });
    return guard;
  }
}

export function createPluginControlHttpServer(options: PluginControlHttpServerOptions): PluginControlHttpServer {
  return new PluginControlHttpServer(options);
}
