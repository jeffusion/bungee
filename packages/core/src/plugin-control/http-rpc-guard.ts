import { canonicalJson } from '../config-storage/content-hash';
import type { ControllerAuthority } from '../supervision/protocol';
import {
  createPluginControlRpcResult,
  parsePluginControlRpcMessage,
  verifyPluginControlRpcMessage,
  verifyPluginControlRpcResult,
  PluginControlRpcProtocolError,
  type PluginControlRpcAuthority,
  type PluginControlRpcCall,
  type PluginControlRpcCancel,
  type PluginControlRpcCredential,
  type PluginControlRpcErrorCode,
  type PluginControlRpcMessage,
  type PluginControlRpcResult,
} from './http-protocol';
import {
  PLUGIN_CONTROL_RPC_CACHE_CAPACITY,
  PLUGIN_CONTROL_RPC_MAX_DEADLINE_MS,
  PLUGIN_CONTROL_RPC_MAX_INFLIGHT,
  PLUGIN_CONTROL_RPC_SEQUENCE_WINDOW,
} from './http-protocol';

export type PluginControlRpcGlobalCapacity = { readonly limit: number; active: number };

export type PluginControlRpcAction = (call: PluginControlRpcCall, signal: AbortSignal) => unknown | Promise<unknown>;

type GuardOptions = {
  readonly credential: PluginControlRpcCredential;
  readonly authority: PluginControlRpcAuthority;
  readonly globalCapacity?: PluginControlRpcGlobalCapacity;
  readonly wallClock?: () => number;
  readonly maxInflight?: number;
  readonly cacheCapacity?: number;
  readonly graceMs?: number;
  readonly maxDeadlineMs?: number;
};

export type PluginControlRpcRequestGuardOptions = GuardOptions & { readonly execute?: PluginControlRpcAction };
export type PluginControlRpcResponseGuardOptions = GuardOptions;

type RequestEntry = {
  readonly request: PluginControlRpcCall;
  readonly fingerprint: string;
  readonly promise: Promise<PluginControlRpcResult>;
  readonly resolve: (result: PluginControlRpcResult) => void;
  readonly abort: AbortController;
  readonly deadlineAt: number;
  active: boolean;
  result?: PluginControlRpcResult;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  evictionTimer?: ReturnType<typeof setTimeout>;
};

type ResponseEntry = {
  readonly request: PluginControlRpcCall;
  readonly fingerprint: string;
  readonly promise: Promise<PluginControlRpcResult>;
  readonly resolve: (result: PluginControlRpcResult) => void;
  readonly reject: (error: unknown) => void;
  readonly deadlineAt: number;
  active: boolean;
  reason?: PluginControlRpcErrorCode;
  result?: PluginControlRpcResult;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  evictionTimer?: ReturnType<typeof setTimeout>;
};

type Tombstone = { readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> };
type CancelEntry = { readonly fingerprint: string; readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> };

const failure = (code: PluginControlRpcErrorCode, message: string = code): PluginControlRpcProtocolError => new PluginControlRpcProtocolError(code, message);

function authorityEqual(left: PluginControlRpcAuthority, right: PluginControlRpcAuthority): boolean {
  return left.controller_epoch === right.controller_epoch && left.controller_id === right.controller_id;
}

function fingerprint(request: PluginControlRpcCall | PluginControlRpcCancel): string {
  return canonicalJson({
    authority: request.authority, worker: request.worker, kind: request.kind,
    deadline_at: request.deadline_at, body_hash: request.body_hash,
    ...(request.kind === 'cancel' ? { target_request_id: request.body.target_request_id } : {}),
  });
}

function resultFingerprint(result: PluginControlRpcResult): string {
  return canonicalJson({
    authority: result.authority, worker: result.worker, kind: result.kind,
    request_id: result.request_id, body_hash: result.body_hash,
  });
}

function isOversize(error: unknown): boolean {
  return error instanceof PluginControlRpcProtocolError && error.code === 'message_too_large';
}

abstract class PluginControlRpcGuardBase {
  protected readonly credential: PluginControlRpcCredential;
  protected authority: PluginControlRpcAuthority;
  protected readonly globalCapacity: PluginControlRpcGlobalCapacity;
  protected readonly wallClock: () => number;
  protected readonly maxInflight: number;
  protected readonly cacheCapacity: number;
  protected readonly graceMs: number;
  protected readonly maxDeadlineMs: number;
  protected readonly seenSequences = new Set<number>();
  protected maximumSequence = 0;
  protected closed = false;

  constructor(options: GuardOptions) {
    this.credential = options.credential;
    this.authority = { ...options.authority };
    this.globalCapacity = options.globalCapacity ?? { limit: PLUGIN_CONTROL_RPC_MAX_INFLIGHT, active: 0 };
    this.wallClock = options.wallClock ?? Date.now;
    this.maxInflight = Math.min(PLUGIN_CONTROL_RPC_MAX_INFLIGHT, Math.max(1, options.maxInflight ?? PLUGIN_CONTROL_RPC_MAX_INFLIGHT));
    this.cacheCapacity = Math.min(PLUGIN_CONTROL_RPC_CACHE_CAPACITY, Math.max(1, options.cacheCapacity ?? PLUGIN_CONTROL_RPC_CACHE_CAPACITY));
    this.graceMs = Math.min(1_000, Math.max(0, options.graceMs ?? 250));
    this.maxDeadlineMs = Math.max(0, options.maxDeadlineMs ?? PLUGIN_CONTROL_RPC_MAX_DEADLINE_MS);
  }

  protected assertOpen(): void {
    if (this.closed) throw failure('disposed', 'RPC guard is disposed');
  }

  protected assertAuthority(value: PluginControlRpcAuthority): void {
    if (authorityEqual(value, this.authority)) return;
    if (value.controller_epoch === this.authority.controller_epoch) throw failure('split_brain', 'controller epoch has multiple IDs');
    throw failure('stale_controller', 'request authority is not the trusted authority');
  }

  protected checkDeadline(deadlineAt: number): void {
    const now = this.wallClock();
    if (deadlineAt <= now) throw failure('deadline_expired', 'request deadline has expired');
    if (deadlineAt > now + this.maxDeadlineMs) throw failure('deadline_too_far', 'request deadline is too far in the future');
  }

  protected consumeSequence(sequence: number): void {
    if (this.maximumSequence > 0 && sequence < this.maximumSequence - (PLUGIN_CONTROL_RPC_SEQUENCE_WINDOW - 1)) {
      throw failure('sequence_replay', 'sequence is below the sliding window');
    }
    if (this.seenSequences.has(sequence)) throw failure('sequence_replay', 'sequence was already seen');
    this.seenSequences.add(sequence);
    if (sequence > this.maximumSequence) this.maximumSequence = sequence;
    const lower = this.maximumSequence - (PLUGIN_CONTROL_RPC_SEQUENCE_WINDOW - 1);
    for (const value of this.seenSequences) if (value < lower) this.seenSequences.delete(value);
  }

  protected replaceAuthorityBase(next: PluginControlRpcAuthority, reset: () => void): void {
    this.assertOpen();
    if (authorityEqual(next, this.authority)) return;
    if (next.controller_epoch < this.authority.controller_epoch) throw failure('stale_controller', 'controller epoch is stale');
    if (next.controller_epoch === this.authority.controller_epoch) throw failure('split_brain', 'controller epoch has multiple IDs');
    reset();
    this.authority = { ...next };
    this.maximumSequence = 0;
    this.seenSequences.clear();
  }
}

export class PluginControlRpcRequestGuard extends PluginControlRpcGuardBase {
  private readonly execute?: PluginControlRpcAction;
  private readonly entries = new Map<string, RequestEntry>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly cancels = new Map<string, CancelEntry>();
  private inflight = 0;

  constructor(options: PluginControlRpcRequestGuardOptions) {
    super(options);
    this.execute = options.execute;
  }

  get activeCount(): number { return this.inflight; }
  get cachedCount(): number { return this.entries.size + this.tombstones.size + this.cancels.size; }
  get currentAuthority(): PluginControlRpcAuthority { return { ...this.authority }; }

  private prune(): void {
    const now = this.wallClock();
    for (const [id, entry] of this.entries) {
      if (entry.evictionTimer === undefined && entry.deadlineAt <= now && entry.active) this.settle(entry, { ok: false, error: 'deadline_expired' });
      if (!entry.active && entry.evictionTimer !== undefined && entry.deadlineAt + this.graceMs <= now) {
        clearTimeout(entry.evictionTimer);
        this.entries.delete(id);
      }
    }
    for (const [id, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) {
        clearTimeout(tombstone.timer);
        this.tombstones.delete(id);
      }
    }
    for (const [id, cancel] of this.cancels) {
      if (cancel.expiresAt <= this.wallClock()) {
        clearTimeout(cancel.timer);
        this.cancels.delete(id);
      }
    }
  }

  private ensureCapacity(additional = 1): void {
    this.prune();
    if (this.entries.size + this.tombstones.size + this.cancels.size + additional > this.cacheCapacity) throw failure('capacity', 'request cache capacity is exhausted');
  }

  private settle(entry: RequestEntry, body: PluginControlRpcResult['body']): void {
    if (!entry.active || this.entries.get(entry.request.request_id) !== entry) return;
    entry.active = false;
    clearTimeout(entry.deadlineTimer);
    this.inflight -= 1;
    this.globalCapacity.active = Math.max(0, this.globalCapacity.active - 1);
    try {
      entry.result = createPluginControlRpcResult(entry.request, body, this.credential);
    } catch (cause) {
      entry.result = createPluginControlRpcResult(entry.request, { ok: false, error: isOversize(cause) ? 'response_too_large' : 'action_failed' }, this.credential);
    }
    entry.resolve(entry.result);
    entry.evictionTimer = setTimeout(() => {
      if (this.entries.get(entry.request.request_id) === entry) this.entries.delete(entry.request.request_id);
    }, Math.max(1, entry.deadlineAt + this.graceMs - this.wallClock()));
  }

  private resetActive(code: 'stale_controller' | 'disposed'): void {
    for (const entry of this.entries.values()) {
      if (entry.active) {
        entry.abort.abort(code);
        this.settle(entry, { ok: false, error: code });
      }
      clearTimeout(entry.deadlineTimer);
      clearTimeout(entry.evictionTimer);
    }
    this.entries.clear();
    for (const tombstone of this.tombstones.values()) clearTimeout(tombstone.timer);
    this.tombstones.clear();
    for (const cancel of this.cancels.values()) clearTimeout(cancel.timer);
    this.cancels.clear();
    this.maximumSequence = 0;
    this.seenSequences.clear();
  }

  replaceAuthority(next: PluginControlRpcAuthority): void { this.replaceAuthorityBase(next, () => this.resetActive('stale_controller')); }

  handleCall(call: PluginControlRpcCall, action = this.execute): Promise<PluginControlRpcResult> {
    this.assertOpen();
    verifyPluginControlRpcMessage(call, this.credential);
    this.assertAuthority(call.authority);
    this.prune();
    const id = call.request_id;
    const fp = fingerprint(call);
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fp) throw failure('request_replay', 'request ID has different semantics');
      return existing.promise;
    }
    this.checkDeadline(call.deadline_at);
    this.consumeSequence(call.sequence);
    if (this.tombstones.has(id)) {
      this.ensureCapacity();
      const result = createPluginControlRpcResult(call, { ok: false, error: 'cancelled' }, this.credential);
      return this.addSettled(call, fp, result);
    }
    if (action === undefined) throw failure('action_failed', 'no RPC action was provided');
    this.ensureCapacity();
    if (this.inflight >= this.maxInflight || this.globalCapacity.active >= this.globalCapacity.limit) throw failure('concurrency_limit', 'RPC concurrency is exhausted');
    let resolve!: (result: PluginControlRpcResult) => void;
    const promise = new Promise<PluginControlRpcResult>((done) => { resolve = done; });
    const entry: RequestEntry = { request: call, fingerprint: fp, promise, resolve, abort: new AbortController(), deadlineAt: call.deadline_at, active: true };
    this.entries.set(id, entry);
    this.inflight += 1;
    this.globalCapacity.active += 1;
    entry.deadlineTimer = setTimeout(() => {
      if (entry.active) entry.abort.abort('deadline_expired');
      this.settle(entry, { ok: false, error: 'deadline_expired' });
    }, Math.max(1, call.deadline_at - this.wallClock()));
    void Promise.resolve().then(async () => {
      if (!entry.active || this.entries.get(id) !== entry) return;
      try {
        const result = await action(call, entry.abort.signal);
        if (entry.active && this.entries.get(id) === entry) this.settle(entry, this.wallClock() >= call.deadline_at ? { ok: false, error: 'deadline_expired' } : { ok: true, result });
      } catch {
        if (entry.active && this.entries.get(id) === entry) this.settle(entry, { ok: false, error: 'action_failed' });
      }
    });
    return promise;
  }

  private addSettled(call: PluginControlRpcCall | PluginControlRpcCancel, fp: string, result: PluginControlRpcResult): Promise<PluginControlRpcResult> {
    this.ensureCapacity();
    let resolve!: (value: PluginControlRpcResult) => void;
    const promise = new Promise<PluginControlRpcResult>((done) => { resolve = done; });
    const entry = { request: call as PluginControlRpcCall, fingerprint: fp, promise, resolve, abort: new AbortController(), deadlineAt: call.deadline_at, active: false, result } as RequestEntry;
    this.entries.set(call.request_id, entry);
    entry.evictionTimer = setTimeout(() => this.entries.delete(call.request_id), Math.max(1, call.deadline_at + this.graceMs - this.wallClock()));
    resolve(result);
    return promise;
  }

  handleCancel(cancel: PluginControlRpcCancel): Promise<void> {
    this.assertOpen();
    verifyPluginControlRpcMessage(cancel, this.credential);
    this.assertAuthority(cancel.authority);
    this.prune();
    const fp = fingerprint(cancel);
    const existing = this.cancels.get(cancel.request_id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fp) throw failure('request_replay', 'request ID has different semantics');
      return Promise.resolve();
    }
    this.checkDeadline(cancel.deadline_at);
    this.consumeSequence(cancel.sequence);
    const target = this.entries.get(cancel.body.target_request_id);
    const wasActive = target?.active === true;
    if (wasActive) {
      target.abort.abort('cancelled');
      this.settle(target, { ok: false, error: 'cancelled' });
    } else if (target === undefined && !this.tombstones.has(cancel.body.target_request_id)) {
      this.ensureCapacity(2);
      const expiresAt = this.wallClock() + this.maxDeadlineMs + this.graceMs;
      const timer = setTimeout(() => {
        const tombstone = this.tombstones.get(cancel.body.target_request_id);
        if (tombstone?.timer === timer) this.tombstones.delete(cancel.body.target_request_id);
      }, Math.max(1, expiresAt - this.wallClock()));
      this.tombstones.set(cancel.body.target_request_id, { expiresAt, timer });
    }
    this.ensureCapacity();
    const expiresAt = this.wallClock() + this.maxDeadlineMs + this.graceMs;
    const timer = setTimeout(() => {
      const entry = this.cancels.get(cancel.request_id);
      if (entry?.timer === timer) this.cancels.delete(cancel.request_id);
    }, Math.max(1, expiresAt - this.wallClock()));
    this.cancels.set(cancel.request_id, { fingerprint: fp, expiresAt, timer });
    return Promise.resolve();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.resetActive('disposed');
  }
}

export class PluginControlRpcResponseGuard extends PluginControlRpcGuardBase {
  private readonly entries = new Map<string, ResponseEntry>();
  private inflight = 0;

  get activeCount(): number { return this.inflight; }
  get cachedCount(): number { return this.entries.size; }
  get currentAuthority(): PluginControlRpcAuthority { return { ...this.authority }; }

  private prune(): void {
    const now = this.wallClock();
    for (const [id, entry] of this.entries) {
      if (!entry.active && entry.evictionTimer !== undefined && entry.deadlineAt + this.graceMs <= now) {
        clearTimeout(entry.evictionTimer);
        this.entries.delete(id);
      }
    }
  }

  private ensureCapacity(additional = 1): void {
    this.prune();
    if (this.entries.size + additional > this.cacheCapacity) throw failure('capacity', 'response cache capacity is exhausted');
  }

  private rejectEntry(entry: ResponseEntry, reason: PluginControlRpcErrorCode): void {
    if (!entry.active || this.entries.get(entry.request.request_id) !== entry) return;
    entry.active = false;
    entry.reason = reason;
    clearTimeout(entry.deadlineTimer);
    this.inflight -= 1;
    this.globalCapacity.active = Math.max(0, this.globalCapacity.active - 1);
    entry.reject(failure(reason));
    entry.evictionTimer = setTimeout(() => {
      if (this.entries.get(entry.request.request_id) === entry) this.entries.delete(entry.request.request_id);
    }, Math.max(1, entry.deadlineAt + this.graceMs - this.wallClock()));
  }

  private resolveEntry(entry: ResponseEntry, result: PluginControlRpcResult): void {
    if (!entry.active || this.entries.get(entry.request.request_id) !== entry) return;
    entry.active = false;
    clearTimeout(entry.deadlineTimer);
    this.inflight -= 1;
    this.globalCapacity.active = Math.max(0, this.globalCapacity.active - 1);
    entry.result = result;
    entry.resolve(result);
    entry.evictionTimer = setTimeout(() => {
      if (this.entries.get(entry.request.request_id) === entry) this.entries.delete(entry.request.request_id);
    }, Math.max(1, entry.deadlineAt + this.graceMs - this.wallClock()));
  }

  private reset(code: PluginControlRpcErrorCode): void {
    for (const entry of this.entries.values()) {
      if (entry.active) this.rejectEntry(entry, code);
      clearTimeout(entry.deadlineTimer);
      clearTimeout(entry.evictionTimer);
    }
    this.entries.clear();
  }

  replaceAuthority(next: PluginControlRpcAuthority): void { this.replaceAuthorityBase(next, () => this.reset('stale_controller')); }

  registerCall(call: PluginControlRpcCall): Promise<PluginControlRpcResult> {
    this.assertOpen();
    verifyPluginControlRpcMessage(call, this.credential);
    this.assertAuthority(call.authority);
    this.prune();
    const fp = fingerprint(call);
    const existing = this.entries.get(call.request_id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fp) throw failure('request_replay', 'request ID has different semantics');
      return existing.promise;
    }
    this.checkDeadline(call.deadline_at);
    this.ensureCapacity();
    if (this.inflight >= this.maxInflight || this.globalCapacity.active >= this.globalCapacity.limit) throw failure('concurrency_limit', 'response concurrency is exhausted');
    let resolve!: (value: PluginControlRpcResult) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<PluginControlRpcResult>((done, failPromise) => { resolve = done; reject = failPromise; });
    const entry: ResponseEntry = { request: call, fingerprint: fp, promise, resolve, reject, deadlineAt: call.deadline_at, active: true };
    this.entries.set(call.request_id, entry);
    this.inflight += 1;
    this.globalCapacity.active += 1;
    entry.deadlineTimer = setTimeout(() => this.rejectEntry(entry, 'deadline_expired'), Math.max(1, call.deadline_at - this.wallClock()));
    return promise;
  }

  registerCancel(cancel: PluginControlRpcCancel): void {
    this.assertOpen();
    verifyPluginControlRpcMessage(cancel, this.credential);
    this.assertAuthority(cancel.authority);
    this.checkDeadline(cancel.deadline_at);
    this.consumeSequence(cancel.sequence);
    const target = this.entries.get(cancel.body.target_request_id);
    if (target?.active) this.rejectEntry(target, 'cancelled');
  }

  /** Reject a transport-local operation without accepting any wire response. */
  rejectCall(requestId: string, reason: PluginControlRpcErrorCode): void {
    this.assertOpen();
    const entry = this.entries.get(requestId);
    if (entry?.active) this.rejectEntry(entry, reason);
  }

  acceptResult(value: unknown): PluginControlRpcResult {
    this.assertOpen();
    let parsed: PluginControlRpcMessage;
    try {
      parsed = parsePluginControlRpcMessage(value);
    } catch (cause) {
      throw cause instanceof PluginControlRpcProtocolError && cause.code === 'invalid_response' ? cause : failure('invalid_response', 'controller response is invalid');
    }
    if (parsed.kind !== 'result') throw failure('invalid_response', 'controller response is not a result');
    const entry = this.entries.get(parsed.request_id);
    if (entry === undefined) throw failure('invalid_response', 'controller response is unknown');
    try { verifyPluginControlRpcResult(parsed, entry.request, this.credential); }
    catch (cause) { throw cause instanceof PluginControlRpcProtocolError && cause.code === 'invalid_response' ? cause : failure('invalid_response', 'controller response is invalid'); }
    if (!entry.active && entry.result !== undefined) {
      if (resultFingerprint(entry.result) !== resultFingerprint(parsed)) throw failure('request_replay', 'request ID has a conflicting result');
      return entry.result;
    }
    if (!entry.active) throw failure(entry.reason ?? 'deadline_expired', 'response request has ended');
    if (this.wallClock() >= entry.deadlineAt) {
      this.rejectEntry(entry, 'deadline_expired');
      throw failure('deadline_expired', 'response request has expired');
    }
    this.consumeSequence(parsed.sequence);
    this.resolveEntry(entry, parsed);
    return parsed;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.reset('disposed');
  }
}
