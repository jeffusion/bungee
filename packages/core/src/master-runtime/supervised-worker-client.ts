import { randomUUID } from 'node:crypto';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import { validateDigest } from '../config-storage/repository-validation';
import { isLowercaseUuid } from '../config-storage/validation';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../config-publication/types';
import type { ConfigWorkerRuntimeMessage } from '../config-publication/worker-runtime-contract';
import {
  hashSupervisionBody,
  parseWorkerRuntimeSnapshot,
  parseSupervisionMessage,
  signSupervisionMessage,
  verifySupervisionMessage,
  type ControllerAuthority,
  type SupervisionMessage,
  type SupervisionProcessCredential,
  type WorkerRuntimeSnapshot,
} from '../supervision';
import { parseWorkerDescriptorEvidence, type WorkerDescriptorEvidence } from '../supervision/worker-descriptor';
import { parseStrictJson } from '../supervision/strict-json';

export type WorkerStatusPayload = {
  readonly schema: 'bungee-worker-status-v1';
  readonly role: 'worker';
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
  readonly pid: number;
  readonly control_port: number;
  readonly master_control_port?: number;
  readonly phase: 'candidate' | 'serving' | 'draining' | 'stopped';
  readonly frozen: boolean;
  readonly private_port: number | null;
  readonly revision: number | null;
  readonly content_hash: `sha256:${string}` | null;
  readonly plugin_catalog_hash: `sha256:${string}` | null;
  readonly started_at: number;
  readonly snapshot_hash: `sha256:${string}`;
  readonly authority: ControllerAuthority;
  readonly request_correlation: string;
  readonly replay: { readonly sequence: number; readonly request_id: string };
  readonly evidence: WorkerDescriptorEvidence;
};

export type WorkerControllerClientOptions = {
  readonly baseUrl: string;
  readonly credential: SupervisionProcessCredential;
  readonly authority: ControllerAuthority;
  readonly timeoutMs?: number;
  readonly leaseDurationMs?: number;
  readonly renewBeforeMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly timers?: WorkerControllerClientTimers;
};

export type WorkerControllerClientTimers = {
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

const RUNTIME_SNAPSHOT_TIMEOUT_MS = 750;
const RUNTIME_SNAPSHOT_RESPONSE_BYTES = 256 * 1024;

export class WorkerControllerClientError extends Error {
  readonly name = 'WorkerControllerClientError';
  constructor(readonly code: 'timeout' | 'http' | 'network' | 'response_too_large' | 'protocol' | 'recovering', message: string, cause?: unknown) {
    super(message, { cause });
  }
}

type StatusResponse = { readonly message: SupervisionMessage; readonly body: WorkerStatusPayload };

const STATUS_KEYS = [
  'authority', 'boot_nonce', 'content_hash', 'control_port', 'evidence', 'frozen', 'master_generation',
  'phase', 'pid', 'plugin_catalog_hash', 'private_port', 'replay', 'request_correlation', 'revision',
  'role', 'schema', 'snapshot_hash', 'started_at', 'worker_instance_id', 'worker_slot',
] as const;
const STATUS_KEYS_WITH_MASTER_CONTROL = [...STATUS_KEYS, 'master_control_port'] as const;

function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new WorkerControllerClientError('protocol', 'supervision response must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new WorkerControllerClientError('protocol', 'supervision response has unexpected fields');
  }
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isLowercaseUuid(value)) throw new WorkerControllerClientError('protocol', `${name} is invalid`);
  return value;
}

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkerControllerClientError('protocol', `${name} is invalid`);
  }
  return value;
}

function digest(value: unknown, name: string): `sha256:${string}` | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !validateDigest(value)) throw new WorkerControllerClientError('protocol', `${name} is invalid`);
  return value as `sha256:${string}`;
}

/** Parses JSON only after rejecting duplicate object keys at every nesting level. */
function parseUniqueJson(bytes: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new WorkerControllerClientError('protocol', 'worker runtime snapshot is invalid UTF-8', error); }
  try { return parseStrictJson(text); }
  catch (error) { throw new WorkerControllerClientError('protocol', 'worker runtime snapshot is invalid JSON', error); }
}

function parseStatusBody(value: unknown): WorkerStatusPayload {
  const input = plain(snapshotJsonGraph(value));
  exact(input, input.master_control_port === undefined ? STATUS_KEYS : STATUS_KEYS_WITH_MASTER_CONTROL);
  if (input.schema !== 'bungee-worker-status-v1' || input.role !== 'worker') throw new WorkerControllerClientError('protocol', 'status schema is invalid');
  const phase = input.phase;
  if (phase !== 'candidate' && phase !== 'serving' && phase !== 'draining' && phase !== 'stopped') throw new WorkerControllerClientError('protocol', 'status phase is invalid');
  if (typeof input.frozen !== 'boolean') throw new WorkerControllerClientError('protocol', 'status frozen is invalid');
  const privatePort = input.private_port === null ? null : integer(input.private_port, 'private_port', 1, 65_535);
  const revision = input.revision === null ? null : integer(input.revision, 'revision', 1);
  const contentHash = digest(input.content_hash, 'content_hash');
  const pluginCatalogHash = digest(input.plugin_catalog_hash, 'plugin_catalog_hash');
  if ((revision === null) !== (contentHash === null) || (revision === null) !== (pluginCatalogHash === null)) {
    throw new WorkerControllerClientError('protocol', 'status revision and digests are inconsistent');
  }
  const authority = plain(input.authority);
  exact(authority, ['controller_epoch', 'controller_id']);
  const replay = plain(input.replay);
  exact(replay, ['request_id', 'sequence']);
  const requestId = uuid(input.request_correlation, 'request_correlation');
  const replayRequestId = uuid(replay.request_id, 'replay.request_id');
  const evidence = parseWorkerDescriptorEvidence(input.evidence);
  const snapshotHash = input.snapshot_hash;
  if (typeof snapshotHash !== 'string' || !validateDigest(snapshotHash)) throw new WorkerControllerClientError('protocol', 'snapshot_hash is invalid');
  const withoutHash = { ...input };
  delete withoutHash.snapshot_hash;
  if (hashSupervisionBody(withoutHash) !== snapshotHash) throw new WorkerControllerClientError('protocol', 'snapshot_hash does not match');
  return {
    schema: 'bungee-worker-status-v1', role: 'worker', master_generation: uuid(input.master_generation, 'master_generation'),
    worker_instance_id: uuid(input.worker_instance_id, 'worker_instance_id'), worker_slot: integer(input.worker_slot, 'worker_slot', 0),
    boot_nonce: uuid(input.boot_nonce, 'boot_nonce'), pid: integer(input.pid, 'pid', 1),
     control_port: integer(input.control_port, 'control_port', 1, 65_535),
     ...(input.master_control_port === undefined ? {} : { master_control_port: integer(input.master_control_port, 'master_control_port', 1, 65_535) }),
     phase, frozen: input.frozen,
    private_port: privatePort, revision, content_hash: contentHash, plugin_catalog_hash: pluginCatalogHash,
    started_at: integer(input.started_at, 'started_at', 0), snapshot_hash: snapshotHash as `sha256:${string}`,
    authority: { controller_epoch: integer(authority.controller_epoch, 'controller_epoch', 0), controller_id: uuid(authority.controller_id, 'controller_id') },
    request_correlation: requestId, replay: { sequence: integer(replay.sequence, 'replay.sequence', 1), request_id: replayRequestId }, evidence,
  };
}

function sameAuthority(left: ControllerAuthority, right: ControllerAuthority): boolean {
  return left.controller_epoch === right.controller_epoch && left.controller_id === right.controller_id;
}

function abortable<Result>(operation: PromiseLike<Result>, signal: AbortSignal, message = 'worker runtime snapshot timed out'): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const resolveOnce = (value: Result): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => rejectOnce(new WorkerControllerClientError('timeout', message));
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve(operation).then(
      resolveOnce,
      rejectOnce,
    );
    if (signal.aborted) abort();
  });
}

function cancelBestEffort(cancel: () => unknown): void {
  try { void Promise.resolve(cancel()).catch(() => undefined); }
  catch {}
}

export class WorkerControllerClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly leaseDurationMs: number;
  private readonly renewBeforeMs: number;
  private readonly maxResponseBytes: number;
  private readonly timers: WorkerControllerClientTimers;
  private sequence = 1;
  private statusSequence = 0;
  private statusRequestId: string | null = null;
  private queue = Promise.resolve();
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewController: AbortController | null = null;
  private stopped = false;
  private terminating = false;
  private draining = false;
  private shutdownPromise: Promise<WorkerStatusPayload> | null = null;
  private readonly ordinaryAbort = new AbortController();
  private recoveryDelayMs = 250;
  private lastStatus: WorkerStatusPayload | null = null;
  state: 'detached' | 'attached' | 'recovering' | 'unavailable' | 'disconnected' = 'detached';
  private readonly controlStateListeners = new Set<(state: WorkerControllerClient['state']) => void>();
  private readonly runtimeControllers = new Set<AbortController>();

  constructor(private readonly options: WorkerControllerClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 10_000;
    this.renewBeforeMs = options.renewBeforeMs ?? Math.max(100, Math.floor(this.leaseDurationMs / 3));
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    this.timers = options.timers ?? { setTimeout, clearTimeout };
    let url: URL;
    try { url = new URL(options.baseUrl); } catch (error) {
      throw new WorkerControllerClientError('protocol', 'baseUrl is invalid', error);
    }
    if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== '::1' && url.hostname !== '[::1]')
      || url.pathname !== '/' || url.search !== '' || url.hash !== '' || !Number.isSafeInteger(Number(url.port))
      || Number(url.port) <= 0 || Number(url.port) > 65_535 || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new WorkerControllerClientError('protocol', 'baseUrl is invalid');
    }
  }

  subscribeControlState(listener: (state: WorkerControllerClient['state']) => void): () => void {
    this.controlStateListeners.add(listener);
    return () => { this.controlStateListeners.delete(listener); };
  }

  get credential(): SupervisionProcessCredential { return this.options.credential; }
  get authority(): ControllerAuthority { return { ...this.options.authority }; }
  get cachedStatus(): WorkerStatusPayload | null { return this.lastStatus; }

  private setState(state: WorkerControllerClient['state']): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.controlStateListeners]) listener(state);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.stopped || this.terminating) throw new WorkerControllerClientError('recovering', 'worker controller client is stopping');
      return operation();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueRuntime<T>(operation: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
    const queued = this.queue.then(() => {
      if (this.stopped || this.terminating || signal.aborted || Date.now() >= deadline) {
        throw new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out');
      }
      return abortable(operation(), signal);
    });
    this.queue = queued.then(() => undefined, () => undefined);
    return abortable(queued, signal);
  }

  private nextSequence(): number { return this.sequence++; }

  private cancelRenewal(): void {
    if (this.renewTimer !== null) this.timers.clearTimeout(this.renewTimer);
    this.renewTimer = null;
    this.renewController?.abort('drain');
  }

  private beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.cancelRenewal();
  }

  private enqueueRenewal<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return this.enqueue(async () => {
      if (this.draining || controller.signal.aborted) {
        throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
      }
      this.renewController = controller;
      try { return await operation(controller.signal); }
      finally {
        if (this.renewController === controller) this.renewController = null;
      }
    });
  }

  private async fetchJson(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    let lastError: unknown;
    let transportFailed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = this.timers.setTimeout(() => controller.abort(), this.timeoutMs);
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted || (this.terminating && signal !== undefined)) {
          throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
        }
        const fetchOperation = Promise.resolve(this.fetcher(`${this.options.baseUrl}${path}`, {
          method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
        }));
        void fetchOperation.then((late) => {
          if (controller.signal.aborted) cancelBestEffort(() => late.body?.cancel('supervision_aborted'));
        }, () => undefined);
        const response = await abortable(fetchOperation, controller.signal, 'worker supervision request timed out');
        const reader = response.body?.getReader();
        if (reader === undefined) throw new WorkerControllerClientError('protocol', 'worker supervision response has no body');
        const chunks: Uint8Array[] = [];
        let total = 0;
        let responseTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const responseTimeout = new Promise<never>((_, reject) => {
            responseTimer = this.timers.setTimeout(() => reject(new WorkerControllerClientError('timeout', 'worker supervision response timed out')), this.timeoutMs);
          });
          while (true) {
            const result = await Promise.race([abortable(reader.read(), controller.signal, 'worker supervision request timed out'), responseTimeout]);
            if (result.done) break;
            total += result.value.byteLength;
            if (total > this.maxResponseBytes) {
              cancelBestEffort(() => reader.cancel('response_too_large'));
              throw new WorkerControllerClientError('response_too_large', 'worker supervision response is too large');
            }
            chunks.push(result.value);
          }
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          let parsed: unknown;
          try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
          catch (error) { throw new WorkerControllerClientError('protocol', 'worker supervision response is invalid JSON', error); }
          if (signal?.aborted || (this.terminating && signal !== undefined)) {
            throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
          }
          if (!response.ok) throw new WorkerControllerClientError('http', `worker supervision HTTP ${response.status}`);
          return parsed;
        } finally {
          if (responseTimer !== undefined) this.timers.clearTimeout(responseTimer);
          cancelBestEffort(() => reader.cancel());
        }
      } catch (error) {
        lastError = signal?.aborted || (this.terminating && signal !== undefined)
          ? new WorkerControllerClientError('timeout', 'worker supervision request was cancelled', error)
          : error instanceof DOMException && error.name === 'AbortError'
          ? new WorkerControllerClientError('timeout', 'worker supervision request timed out', error)
          : error instanceof WorkerControllerClientError
            ? error : new WorkerControllerClientError('network', 'worker supervision request failed', error);
        if (lastError instanceof WorkerControllerClientError && (lastError.code === 'timeout' || lastError.code === 'network')) transportFailed = true;
        if (signal?.aborted || (this.terminating && signal !== undefined)
          || attempt === 1 || (lastError instanceof WorkerControllerClientError
          && (lastError.code === 'protocol' || lastError.code === 'response_too_large'))) {
          if (attempt === 1 && transportFailed && !this.terminating && !signal?.aborted) this.setState('unavailable');
          throw lastError;
        }
      } finally {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }
    if (transportFailed && !this.terminating && !signal?.aborted) this.setState('unavailable');
    throw lastError instanceof WorkerControllerClientError
      ? lastError : new WorkerControllerClientError('network', 'worker supervision request failed', lastError);
  }

  private verifyProcessMessage(value: unknown, requestId: string, sequence: number | undefined, kind: 'challenge' | 'status'): SupervisionMessage {
    const message = parseSupervisionMessage(value);
    verifySupervisionMessage(message, this.options.credential);
    if (message.kind !== kind || message.direction !== 'process-to-controller' || message.role !== 'worker'
      || message.process_instance_id !== this.options.credential.identity.process_instance_id
      || message.boot_nonce !== this.options.credential.identity.boot_nonce
      || message.controller_epoch !== this.options.authority.controller_epoch
      || message.controller_id !== this.options.authority.controller_id
      || message.request_id !== requestId || (sequence !== undefined && message.sequence !== sequence)) {
      throw new WorkerControllerClientError('protocol', 'worker response identity or correlation mismatch');
    }
    return message;
  }

  private acceptStatus(response: unknown, requestId: string, allowTerminating = false): WorkerStatusPayload {
    const root = plain(snapshotJsonGraph(response));
    exact(root, ['body', 'message']);
    const message = this.verifyProcessMessage(root.message, requestId, undefined, 'status');
    if (message.kind !== 'status') throw new WorkerControllerClientError('protocol', 'worker response is not status');
    const body = parseStatusBody(root.body);
    if (message.body_hash !== hashSupervisionBody(body) || body.request_correlation !== requestId
      || body.replay.request_id !== requestId || !sameAuthority(body.authority, this.options.authority)
      || body.replay.sequence !== message.sequence || (message.status !== (body.frozen ? 'frozen' : body.phase))) {
      throw new WorkerControllerClientError('protocol', 'worker status body correlation mismatch');
    }
    if (body.worker_instance_id !== this.options.credential.identity.process_instance_id || body.boot_nonce !== this.options.credential.identity.boot_nonce) {
      throw new WorkerControllerClientError('protocol', 'worker status identity mismatch');
    }
    if (this.terminating && !allowTerminating) {
      throw new WorkerControllerClientError('recovering', 'worker controller client is terminating');
    }
    if (message.sequence < this.statusSequence || (message.sequence === this.statusSequence && this.statusRequestId !== requestId)) {
      throw new WorkerControllerClientError('protocol', 'worker status replay detected');
    }
    this.statusSequence = message.sequence;
    this.statusRequestId = requestId;
    this.lastStatus = body;
    if (!this.stopped) this.setState('attached');
    return body;
  }

  private acceptRuntimeSnapshot(response: unknown, requestId: string): WorkerRuntimeSnapshot {
    const root = plain(snapshotJsonGraph(response));
    exact(root, ['body', 'message']);
    const message = this.verifyProcessMessage(root.message, requestId, undefined, 'status');
    if (message.kind !== 'status' || message.status !== 'runtime') {
      throw new WorkerControllerClientError('protocol', 'worker response is not a runtime snapshot');
    }
    const body = parseWorkerRuntimeSnapshot(root.body);
    if (message.body_hash !== hashSupervisionBody(body)) {
      throw new WorkerControllerClientError('protocol', 'worker runtime snapshot body hash mismatch');
    }
    const expected = this.lastStatus;
    if (expected === null || body.master_generation !== expected.master_generation
      || body.worker_instance_id !== expected.worker_instance_id || body.worker_slot !== expected.worker_slot
      || body.boot_nonce !== expected.boot_nonce || body.pid !== expected.pid || body.private_port !== expected.private_port
      || body.revision !== expected.revision || body.content_hash !== expected.content_hash
      || body.plugin_catalog_hash !== expected.plugin_catalog_hash) {
      throw new WorkerControllerClientError('protocol', 'worker runtime snapshot identity mismatch');
    }
    if (message.sequence < this.statusSequence || (message.sequence === this.statusSequence && this.statusRequestId !== requestId)) {
      throw new WorkerControllerClientError('protocol', 'worker runtime snapshot replay detected');
    }
    this.statusSequence = message.sequence;
    this.statusRequestId = requestId;
    return body;
  }

  private async fetchRuntimeJson(payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out');
    try {
      const fetchOperation = this.fetcher(`${this.options.baseUrl}/__supervision/runtime`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal,
      });
      void fetchOperation.then((late) => {
        if (signal.aborted) cancelBestEffort(() => late.body?.cancel('runtime_aborted'));
      }, () => undefined);
      const response = await abortable(fetchOperation, signal);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new WorkerControllerClientError('protocol', 'worker runtime snapshot has no body');
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > RUNTIME_SNAPSHOT_RESPONSE_BYTES) {
            cancelBestEffort(() => reader.cancel('response_too_large'));
            throw new WorkerControllerClientError('response_too_large', 'worker runtime snapshot is too large');
          }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const parsed = parseUniqueJson(bytes);
        if (!response.ok) throw new WorkerControllerClientError('http', `worker runtime snapshot HTTP ${response.status}`);
        if (this.stopped || this.terminating || signal.aborted) throw new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out');
        return parsed;
      } finally {
        cancelBestEffort(() => reader.cancel());
      }
    } catch (error) {
      if (error instanceof WorkerControllerClientError) throw error;
      if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') {
        throw new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out', error);
      }
      throw new WorkerControllerClientError('network', 'worker runtime snapshot request failed', error);
    }
  }

  runtimeSnapshot(signal?: AbortSignal, deadline = Date.now() + RUNTIME_SNAPSHOT_TIMEOUT_MS): Promise<WorkerRuntimeSnapshot> {
    if (this.stopped || this.terminating || signal?.aborted) return Promise.reject(new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out'));
    const controller = new AbortController();
    const timeout = this.timers.setTimeout(() => controller.abort('deadline'), Math.max(0, deadline - Date.now()));
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.runtimeControllers.add(controller);
    const finish = () => {
      this.timers.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      this.runtimeControllers.delete(controller);
    };
    return this.enqueueRuntime(async () => {
      try {
        if (this.stopped || this.terminating || controller.signal.aborted || Date.now() >= deadline) throw new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out');
        const requestId = randomUUID();
        const sequence = this.nextSequence();
        const message = signSupervisionMessage({
          protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
          ...this.options.credential.identity, ...this.options.authority, sequence, request_id: requestId,
          status: 'request', body_hash: hashSupervisionBody(null),
        }, this.options.credential);
        const response = await this.fetchRuntimeJson(message, controller.signal);
        if (this.stopped || this.terminating || controller.signal.aborted || Date.now() >= deadline) throw new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out');
        const snapshot = this.acceptRuntimeSnapshot(response, requestId);
        if (this.stopped || this.terminating || controller.signal.aborted || Date.now() >= deadline) throw new WorkerControllerClientError('timeout', 'worker runtime snapshot timed out');
        return snapshot;
      } finally { finish(); }
    }, controller.signal, deadline).finally(finish);
  }

  private async challenge(signal = this.ordinaryAbort.signal): Promise<string> {
    const requestId = randomUUID();
    const sequence = this.nextSequence();
    const response = plain(await this.fetchJson('/__supervision/challenge', {
      controller_epoch: this.options.authority.controller_epoch, controller_id: this.options.authority.controller_id, request_id: requestId, sequence,
    }, signal));
    exact(response, ['message']);
    const message = this.verifyProcessMessage(response.message, requestId, sequence, 'challenge');
    if (message.kind !== 'challenge') throw new WorkerControllerClientError('protocol', 'challenge response is invalid');
    return message.challenge_nonce;
  }

  private async attachOnce(signal = this.ordinaryAbort.signal): Promise<WorkerStatusPayload> {
    const challengeNonce = await this.challenge(signal);
    const attachId = randomUUID();
    const attachSequence = this.nextSequence();
    const attach = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...this.options.credential.identity, ...this.options.authority, sequence: attachSequence, request_id: attachId, challenge_nonce: challengeNonce }, this.options.credential);
    let attached: WorkerStatusPayload;
    try {
      const response = await this.fetchJson('/__supervision/attach', attach, signal);
      if (signal.aborted) throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
      attached = this.acceptStatus(response, attachId);
    } catch (error) {
      if (!(error instanceof WorkerControllerClientError)
        || (error.code !== 'timeout' && error.code !== 'http' && error.code !== 'network')) throw error;
      try { attached = await this.statusOnce(signal); }
      catch { throw error; }
    }
    const leaseId = randomUUID();
    const leaseSequence = this.nextSequence();
    const lease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...this.options.credential.identity, ...this.options.authority, sequence: leaseSequence, request_id: leaseId,
      lease_expires_at: Date.now() + this.leaseDurationMs }, this.options.credential);
    const leaseResponse = await this.fetchJson('/__supervision/lease', lease, signal);
    if (signal.aborted) throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
    const leased = this.acceptStatus(leaseResponse, leaseId);
    if (signal.aborted) throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
    this.setState('attached');
    this.recoveryDelayMs = 250;
    this.scheduleRenewal();
    return leased ?? attached;
  }

  attach(): Promise<WorkerStatusPayload> { return this.enqueue(() => this.attachOnce()); }

  private scheduleRenewal(): void {
    if (this.stopped || this.terminating || this.draining) return;
    if (this.renewTimer !== null) this.timers.clearTimeout(this.renewTimer);
    this.renewTimer = this.timers.setTimeout(() => {
      this.renewTimer = null;
      void this.enqueueRenewal((signal) => this.renewOnce(signal)).catch((error) => {
        if (!this.stopped && !this.terminating && !this.draining) this.scheduleRecovery();
        return error;
      });
    }, Math.max(1, this.leaseDurationMs - this.renewBeforeMs));
  }

  private async renewOnce(signal = this.ordinaryAbort.signal): Promise<WorkerStatusPayload> {
    const requestId = randomUUID();
    const sequence = this.nextSequence();
    const lease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...this.options.credential.identity, ...this.options.authority, sequence, request_id: requestId,
      lease_expires_at: Date.now() + this.leaseDurationMs }, this.options.credential);
    const response = await this.fetchJson('/__supervision/lease', lease, signal);
    if (signal.aborted || this.draining) throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
    const result = this.acceptStatus(response, requestId);
    if (signal.aborted || this.draining) throw new WorkerControllerClientError('timeout', 'worker supervision request was cancelled');
    this.setState('attached');
    this.scheduleRenewal();
    return result;
  }

  private scheduleRecovery(): void {
    if (this.stopped || this.terminating || this.draining) return;
    this.setState('recovering');
    if (this.renewTimer !== null) this.timers.clearTimeout(this.renewTimer);
    const delay = this.recoveryDelayMs;
    this.recoveryDelayMs = Math.min(this.recoveryDelayMs * 2, 10_000);
    this.renewTimer = this.timers.setTimeout(() => {
      this.renewTimer = null;
      void this.enqueueRenewal((signal) => this.attachOnce(signal)).catch(() => {
        if (!this.stopped && !this.terminating && !this.draining) this.scheduleRecovery();
      });
    }, delay);
  }

  lease(): Promise<WorkerStatusPayload> { return this.enqueueRenewal((signal) => this.renewOnce(signal)); }

  status(): Promise<WorkerStatusPayload> {
    return this.enqueue(() => this.statusOnce());
  }

  private async statusOnce(signal = this.ordinaryAbort.signal): Promise<WorkerStatusPayload> {
    const requestId = randomUUID();
    const sequence = this.nextSequence();
    const message = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
      ...this.options.credential.identity, ...this.options.authority, sequence, request_id: requestId,
      status: 'request', body_hash: hashSupervisionBody(null) }, this.options.credential);
    // The status request is controller-originated in practice; the protocol's status direction is process-to-controller,
    // so the worker accepts it as the signed request used by the existing supervision contract.
    return this.acceptStatus(await this.fetchJson('/__supervision/status', message, signal), requestId);
  }

  command(message: ConfigMasterMessage): Promise<WorkerStatusPayload> {
    const command = 'command' in message ? message.command : null;
    const path = command === 'drain-worker' ? '/drain' : command === 'start-config-worker' || command === 'start-current-config-worker' ? '/start' : null;
    if (path === null) return Promise.reject(new WorkerControllerClientError('protocol', 'unsupported worker command'));
    if (path === '/drain') this.beginDrain();
    return this.enqueue(() => this.commandOnce(path, message, this.ordinaryAbort.signal));
  }

  private async commandOnce(path: '/start' | '/drain' | '/shutdown', body: unknown, signal?: AbortSignal, allowTerminating = false): Promise<WorkerStatusPayload> {
    const requestId = randomUUID();
    const sequence = this.nextSequence();
    const message = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process',
      ...this.options.credential.identity, ...this.options.authority, sequence, request_id: requestId, method: 'POST', path,
      body_hash: hashSupervisionBody(body) }, this.options.credential);
    return this.acceptStatus(await this.fetchJson('/__supervision/command', { message, body }, signal), requestId, allowTerminating);
  }

  start(message: ConfigMasterMessage): Promise<WorkerStatusPayload> {
    if (!('command' in message) || (message.command !== 'start-config-worker' && message.command !== 'start-current-config-worker')) {
      return Promise.reject(new WorkerControllerClientError('protocol', 'unsupported start command'));
    }
    return this.command(message);
  }

  drain(message: ConfigMasterMessage): Promise<WorkerStatusPayload> {
    if (!('command' in message) || message.command !== 'drain-worker') {
      return Promise.reject(new WorkerControllerClientError('protocol', 'unsupported drain command'));
    }
    return this.command(message);
  }

  shutdown(): Promise<WorkerStatusPayload> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.terminating = true;
    this.ordinaryAbort.abort('shutdown');
    this.cancelRenewal();
    const attempt = this.commandOnce('/shutdown', {}, undefined, true);
    this.shutdownPromise = attempt;
    void attempt.then(undefined, () => {
      if (this.shutdownPromise === attempt) this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  disconnect(expireLease = true): void {
    this.stopped = true;
    this.ordinaryAbort.abort('disconnected');
    this.cancelRenewal();
    for (const controller of this.runtimeControllers) controller.abort('disconnected');
    if (expireLease && !this.terminating && this.state === 'attached') {
      const requestId = randomUUID();
      const sequence = this.nextSequence();
      const lease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
        ...this.options.credential.identity, ...this.options.authority, sequence, request_id: requestId,
        lease_expires_at: Date.now() + 1_000 }, this.options.credential);
      void this.fetchJson('/__supervision/lease', lease).catch(() => undefined);
    }
    this.setState('disconnected');
  }
}
