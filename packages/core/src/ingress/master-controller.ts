import { randomUUID } from 'node:crypto';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { clearDaemonBootstrapEnvironment, DAEMON_BOOTSTRAP_ENV_NAMES } from '../daemon-control/bootstrap';
import { DAEMON_PROCESS_IDENTITY_MARKER_PREFIX, type Sha256Digest } from '@jeffusion/bungee-types';
import { validateDigest } from '../config-storage/repository-validation';
import { isLowercaseUuid } from '../config-storage/validation';
import type { PreparedWorkerAdmission, ServingConfigWorker, WorkerAdmissionController } from '../config-publication';
import { admissionSetIdentity, type AdmissionSet } from './admission-set';
import { canonicalJson } from '../config-storage/content-hash';
import {
  deriveSupervisionProcessKey,
  serializeSupervisionCredential,
  type ControllerAuthority,
  type ProcessIdentity,
  type SupervisionProcessCredential,
  type SupervisionRootKeyMaterial,
} from '../supervision';
import {
  discoverIngressIdentity,
  IngressDiscoveryError,
  IngressControllerClient,
  type IngressStatusPayload,
} from './supervision-http';
import { SupervisionProtocolError } from '../supervision';
import type { SupervisedWorkerRateLimitSession } from '../config-worker/process-environment';

export type MasterIngressControllerOptions = {
  readonly rootKey: SupervisionRootKeyMaterial;
  readonly instanceId: string;
  readonly controllerId: string;
  readonly controllerEpoch: number;
  readonly controlPort: number;
  readonly publicHost: string;
  readonly publicPort: number;
  readonly instanceLockPath: string;
  readonly transportSecret: string;
  readonly executable: string;
  readonly entry: string;
  readonly cwd: string;
  readonly startupTimeoutMs?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly spawn?: typeof spawnChild;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly onRecovered?: (event: MasterIngressRecoveryEvent) => Promise<MasterIngressRecoveryResult | void>
    | MasterIngressRecoveryResult | void;
  readonly onNewBootAccepted?: (event: Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }>) => void;
  readonly onAdmissionResolved?: (event: { readonly target: AdmissionSet; readonly outcome: 'committed' | 'not_committed' }) => Promise<void> | void;
};

export type MasterIngressControllerState = 'attached' | 'control_recovering' | 'stopped';
export type MasterIngressControllerOrigin = 'adopted' | 'spawned';
export type MasterIngressRecoveryResult = 'complete' | 'retryable' | 'fatal';
export type IngressBootRecoveryToken = number;
export type MasterIngressStartupFailureDisposition =
  | {
    readonly kind: 'preserved';
    readonly origin: MasterIngressControllerOrigin | null;
    readonly evidence: {
      readonly registry: IngressStatusPayload['registry'] | null;
      readonly statusRefreshed: boolean;
      readonly pendingAdmission: boolean;
      readonly uncertainAdmission: boolean;
      readonly pendingRetiredRelease: boolean;
      readonly reason: 'adopted' | 'active' | 'prepared' | 'uncertain' | 'status_unavailable' | 'unowned';
    };
  }
  | {
    readonly kind: 'shutdown_safe_empty';
    readonly origin: 'spawned';
    readonly evidence: {
      readonly registry: IngressStatusPayload['registry'];
      readonly statusRefreshed: true;
      readonly pendingAdmission: false;
      readonly uncertainAdmission: false;
      readonly pendingRetiredRelease: false;
    };
  };
function immutableRegistry(registry: IngressStatusPayload['registry'] | null): IngressStatusPayload['registry'] | null {
  const immutableAdmission = (set: AdmissionSet | null): AdmissionSet | null => set === null ? null : Object.freeze({
    ...set,
    workers: Object.freeze(set.workers.map((worker) => Object.freeze({ ...worker }))),
  });
  return registry === null ? null : Object.freeze({
    active: immutableAdmission(registry.active),
    prepared: immutableAdmission(registry.prepared),
    retired: Object.freeze(registry.retired.map((set) => immutableAdmission(set)!)),
  });
}

export type MasterIngressRecoveryEvent =
  | { readonly kind: 'same_boot'; readonly token?: IngressBootRecoveryToken }
  | { readonly kind: 'new_boot'; readonly previous: ProcessIdentity; readonly current: ProcessIdentity; readonly token: IngressBootRecoveryToken };
const DISCOVERY_TIMEOUT_MS = 250;

export class MasterIngressControllerError extends Error {
  readonly name = 'MasterIngressControllerError';
  constructor(readonly code: 'control_recovering' | 'outcome_unknown' | 'admission_not_committed' | 'not_attached' | 'unavailable' | 'invalid_options' | 'stale_boot', message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

type AdmissionHandleScope = {
  readonly boot: number;
  connection: number;
  readonly lifecycle: number;
};

function requirePositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new MasterIngressControllerError('invalid_options', `${name} must be positive`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new MasterIngressControllerError('control_recovering', 'ingress admission was cancelled');
}

type QueueTask<Result> = {
  readonly result: Promise<Result>;
  readonly quiesced: Promise<void>;
  readonly signal: AbortSignal;
};

function isConnectionUnavailable(error: unknown, seen = new Set<unknown>()): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function') || seen.has(error)) return false;
  seen.add(error);
  const value = error as { readonly code?: unknown; readonly message?: unknown; readonly cause?: unknown };
  const text = `${typeof value.code === 'string' ? value.code : ''} ${typeof value.message === 'string' ? value.message : ''}`.toLowerCase();
  return text.includes('econnrefused') || text.includes('connection refused') || text.includes('unable to connect')
    || isConnectionUnavailable(value.cause, seen);
}

export class MasterIngressController implements WorkerAdmissionController {
  private readonly spawn: typeof spawnChild;
  private readonly startupTimeoutMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private authority: ControllerAuthority;
  private client: IngressControllerClient | null = null;
  private child: ChildProcess | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queueGeneration = 0;
  private queueGenerationController = new AbortController();
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimerScheduled = false;
  private recoveryAttempt = 0;
  private sequence = 1;
  private admissionSequence = 0;
  private state: MasterIngressControllerState = 'stopped';
  private ingressOrigin: MasterIngressControllerOrigin | null = null;
  private disconnected = true;
  private recoveryCallbackRunning = false;
  private recoveryCallbackPending = false;
  private childCredential: SupervisionProcessCredential;
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly stateListeners = new Set<(state: MasterIngressControllerState) => void>();
  private readonly eligibilityListeners = new Set<() => void>();
  private pendingAdmission: { readonly fingerprint: string; readonly promise: Promise<PreparedWorkerAdmission> } | null = null;
  private trustedStatus: IngressStatusPayload | null = null;
  private leaseDeadline = 0;
  private trustedStatusAt = -1;
  private trustedStatusAuthority: ControllerAuthority | null = null;
  /** Set only after a challenge/attach exchange and a signed status response. */
  private authenticatedIngressIdentity: import('../supervision').ProcessIdentity | null = null;
  private pendingRetiredRelease: { readonly identity: string; readonly set: AdmissionSet } | null = null;
  private uncertainAdmission: {
    readonly target: AdmissionSet;
    readonly identity: string;
    readonly previousActive: AdmissionSet | null;
    pendingResolution: 'committed' | 'not_committed' | null;
    resolutionPromise: Promise<void> | null;
  } | null = null;
  private pendingPrepareRecovery: {
    readonly target: AdmissionSet;
    readonly identity: string;
    outcome: 'active' | 'prepared' | 'absent' | null;
    recovering: boolean;
  } | null = null;
  private resolvingUncertain = false;
  private recoveryEvent: MasterIngressRecoveryEvent | null = null;
  private pendingNewBootEvent: Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }> | null = null;
  private pendingSameBoot: IngressBootRecoveryToken | null = null;
  private retryRecoveryEvent: MasterIngressRecoveryEvent | null = null;
  private recoveryTokenActive = false;
  private bootGeneration = 0;
  private connectionGeneration = 0;
  private lifecycleGeneration = 0;
  private sessionPublicationAllowed = true;

  constructor(private readonly options: MasterIngressControllerOptions) {
    requirePositive(options.controlPort, 'controlPort');
    requirePositive(options.publicPort, 'publicPort');
    this.spawn = options.spawn ?? spawnChild;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    requirePositive(this.startupTimeoutMs, 'startupTimeoutMs');
    requirePositive(this.leaseDurationMs, 'leaseDurationMs');
    this.authority = { controller_epoch: options.controllerEpoch, controller_id: options.controllerId };
    this.childCredential = deriveSupervisionProcessKey(options.rootKey, options.instanceId, 'ingress', randomUUID(), randomUUID());
    this.fetch = options.fetch ?? fetch;
  }

  get currentState(): MasterIngressControllerState { return this.state; }
  get origin(): MasterIngressControllerOrigin | null { return this.ingressOrigin; }
  get controlPort(): number { return this.options.controlPort; }
  get publicPort(): number { return this.options.publicPort; }

  authenticatedRateLimitSession(token?: IngressBootRecoveryToken): SupervisedWorkerRateLimitSession | null {
    const identity = this.authenticatedIngressIdentity;
    if (!this.sessionPublicationAllowed || this.client === null || identity === null
      || (this.recoveryTokenActive && token !== this.bootGeneration)
      || (token !== undefined && token !== this.bootGeneration)) return null;
    return {
      supervisionPort: this.options.controlPort,
      expectedIngress: {
        process_instance_id: identity.process_instance_id,
        boot_nonce: identity.boot_nonce,
      },
    };
  }

  subscribeState(listener: (state: MasterIngressControllerState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  subscribeEligibilityChange(listener: () => void): () => void {
    this.eligibilityListeners.add(listener);
    return () => { this.eligibilityListeners.delete(listener); };
  }

  isMutationReady(evidence?: {
    readonly revision: number;
    readonly content_hash: string;
    readonly plugin_catalog_hash: string;
    readonly hasActiveOperation: boolean;
  }): boolean {
    const status = this.trustedStatus;
    const freshnessMargin = Math.max(1, Math.floor(this.leaseDurationMs / 3));
    if (this.client === null || this.state !== 'attached' || status === null || status.state !== 'attached'
      || this.trustedStatusAuthority?.controller_id !== this.authority.controller_id
      || this.trustedStatusAuthority?.controller_epoch !== this.authority.controller_epoch
      || this.trustedStatusAt < 0 || this.monotonicNow() >= this.leaseDeadline - freshnessMargin) return false;
    const active = status.registry.active;
    if (active === null || status.registry.prepared !== null || status.registry.retired.length > 0
      || this.pendingRetiredRelease !== null) return false;
    if (evidence === undefined) return true;
    return !evidence.hasActiveOperation
      && active.revision === evidence.revision
      && active.content_hash === evidence.content_hash
      && active.plugin_catalog_hash === evidence.plugin_catalog_hash;
  }

  /** Recovery control may run with no active workers, but never with an untrusted control plane. */
  isRecoveryReady(): boolean {
    const status = this.trustedStatus;
    const freshnessMargin = Math.max(1, Math.floor(this.leaseDurationMs / 3));
    return this.client !== null && this.state === 'attached' && status !== null && status.state === 'attached'
      && this.trustedStatusAuthority?.controller_id === this.authority.controller_id
      && this.trustedStatusAuthority?.controller_epoch === this.authority.controller_epoch
      && this.trustedStatusAt >= 0 && this.monotonicNow() < this.leaseDeadline - freshnessMargin
      && status.registry.prepared === null && status.registry.retired.length === 0
      && this.pendingAdmission === null && this.uncertainAdmission === null
      && this.pendingRetiredRelease === null;
  }

  hasTrustedActiveAdmission(): boolean {
    return this.trustedStatus !== null && this.trustedStatus.registry.active !== null;
  }

  trustedActiveAdmission(): AdmissionSet | null {
    return this.trustedStatus?.registry.active ?? null;
  }

  trustedActiveAdmissionIfFresh(): AdmissionSet | null {
    const status = this.trustedStatus;
    if (this.client === null || this.state !== 'attached' || status?.state !== 'attached'
      || this.trustedStatusAuthority?.controller_id !== this.authority.controller_id
      || this.trustedStatusAuthority?.controller_epoch !== this.authority.controller_epoch
      || this.trustedStatusAt < 0 || this.monotonicNow() >= this.leaseDeadline) return null;
    return status.registry.active;
  }

  currentControllerAuthority(): ControllerAuthority { return { ...this.authority }; }

  async cleanupAfterStartupFailure(): Promise<MasterIngressStartupFailureDisposition> {
    let statusRefreshed = false;
    if (this.client !== null) {
      try { await this.status(); } catch { /* disconnect below preserves an ambiguous data plane */ }
      statusRefreshed = this.trustedStatus !== null;
    }
    const registry = this.trustedStatus?.registry ?? null;
    const safeEmpty = this.ingressOrigin === 'spawned'
      && statusRefreshed
      && registry !== null
      && registry.active === null
      && registry.prepared === null
      && this.pendingAdmission === null
      && this.uncertainAdmission === null
      && this.pendingRetiredRelease === null;
    const disposition = this.ingressOrigin === 'adopted'
      ? this.startupFailureDisposition('preserved', statusRefreshed, 'adopted')
      : safeEmpty ? Object.freeze({
        kind: 'shutdown_safe_empty' as const,
        origin: 'spawned' as const,
        evidence: Object.freeze({
          registry: immutableRegistry(registry)!,
          statusRefreshed: true as const,
          pendingAdmission: false as const,
          uncertainAdmission: false as const,
          pendingRetiredRelease: false as const,
        }),
      })
      : this.startupFailureDisposition('preserved', statusRefreshed,
        this.ingressOrigin === null ? 'unowned' as const
          : !statusRefreshed ? 'status_unavailable' as const
            : this.uncertainAdmission !== null || this.pendingAdmission !== null || this.pendingRetiredRelease !== null ? 'uncertain' as const
              : registry?.active !== null ? 'active' as const : 'prepared' as const);
    if (disposition.kind === 'shutdown_safe_empty') {
      await this.shutdownDataPlane();
    } else {
      await this.disconnect();
    }
    return disposition;
  }

  private startupFailureDisposition(
    kind: 'preserved',
    statusRefreshed: boolean,
    reason: 'adopted' | 'active' | 'prepared' | 'uncertain' | 'status_unavailable' | 'unowned',
  ): MasterIngressStartupFailureDisposition {
    return Object.freeze({
      kind,
      origin: this.ingressOrigin,
      evidence: Object.freeze({
        registry: immutableRegistry(this.trustedStatus?.registry ?? null),
        statusRefreshed,
        pendingAdmission: this.pendingAdmission !== null,
        uncertainAdmission: this.uncertainAdmission !== null,
        pendingRetiredRelease: this.pendingRetiredRelease !== null,
        reason,
      }),
    });
  }

  async connect(): Promise<void> {
    this.disconnected = false;
    this.lifecycleGeneration += 1;
    this.sessionPublicationAllowed = false;
    try {
      await this.attachToExisting();
    } catch (error) {
      if (!(error instanceof MasterIngressControllerError)
        || error.code !== 'unavailable') throw error;
      await this.spawnAndAttach();
    }
    if (this.disconnected) return;
    if (this.client === null) throw new MasterIngressControllerError('not_attached', 'ingress controller did not attach');
    try {
      const leaseDeadline = this.monotonicNow() + this.leaseDurationMs;
      await this.enqueue((signal) => this.client!.lease(
        this.authority,
        this.now() + this.leaseDurationMs,
        this.nextSequence(signal),
        undefined,
        signal,
      ));
      this.leaseDeadline = leaseDeadline;
    } catch (error) {
      this.clearFreshness();
      this.markControlRecovering(error);
      throw error;
    }
    const status = await this.enqueue((signal) => this.statusNow(undefined, signal));
    if (this.disconnected) return;
    this.admissionSequence = Math.max(
      this.admissionSequence,
      status.registry.active?.admission_sequence ?? 0,
      status.registry.prepared?.admission_sequence ?? 0,
    );
    if (status.registry.retired.length > 0 && this.pendingRetiredRelease === null) {
      this.markControlRecovering(new Error('retired ingress admission has no local exit proof'));
      return;
    }
    this.startLeaseRenewal();
  }

  prepare(workers: readonly ServingConfigWorker[], signal?: AbortSignal): Promise<PreparedWorkerAdmission> {
    this.requireMutation();
    throwIfAborted(signal);
    const scope = this.captureAdmissionHandleScope();
    const set = this.toAdmissionSet(workers);
    const fingerprint = canonicalJson({ ...set, admission_sequence: 0 });
    if (this.pendingAdmission?.fingerprint === fingerprint) return this.pendingAdmission.promise;
    this.beginPrepareRecovery(set);
    let pending: { readonly fingerprint: string; readonly promise: Promise<PreparedWorkerAdmission> };
    const promise = (async (): Promise<PreparedWorkerAdmission> => {
      let previousActive: AdmissionSet | null = null;
      const task = this.enqueueTask(async (queueSignal) => {
        try {
          this.assertAdmissionHandleScope(scope);
          await this.command('/prepare', set, scope, queueSignal);
          throwIfAborted(queueSignal);
          previousActive = (await this.statusNow(scope, queueSignal)).registry.active;
          throwIfAborted(queueSignal);
          this.assertAdmissionHandleScope(scope);
        }
        catch (cause) {
          throwIfAborted(queueSignal);
          this.assertAdmissionHandleScope(scope);
          const observed = await this.statusAfterFailure(cause, scope, queueSignal);
          throwIfAborted(queueSignal);
          this.assertAdmissionHandleScope(scope);
          previousActive = observed.registry.active;
          const identity = admissionSetIdentity(set);
          const prepared = observed.registry.prepared !== null && admissionSetIdentity(observed.registry.prepared) === identity;
          const active = observed.registry.active !== null && admissionSetIdentity(observed.registry.active) === identity;
          if (!prepared && !active) this.admissionOutcomeUnknown('ingress prepare outcome is unknown', cause);
        }
      }, signal, this.startupTimeoutMs);
      try {
        await task.result;
      } catch (cause) {
        if (!(cause instanceof MasterIngressControllerError) || cause.code !== 'control_recovering'
          || this.pendingPrepareRecovery?.identity !== admissionSetIdentity(set)) throw cause;
        await this.recover();
        const recovery = this.pendingPrepareRecovery;
        if (recovery === null || recovery.outcome === null || recovery.outcome === 'absent') {
          throw new MasterIngressControllerError('admission_not_committed', 'ingress prepare was not applied; abort is safe');
        }
      }
      let commitPromise: Promise<void> | null = null;
      return {
        commit: async () => {
          const run = async (): Promise<void> => {
            try {
              throwIfAborted(signal);
              this.assertAdmissionHandleScope(scope);
              this.beginUncertainAdmission(set);
              const task = this.enqueueTask((queueSignal) => this.commitAdmission(set, scope, queueSignal), signal, this.startupTimeoutMs);
              let outcome: 'committed' | 'not_committed';
              let resolvedByRecovery = false;
              try {
                outcome = await task.result;
              } catch (cause) {
                if (!(cause instanceof MasterIngressControllerError) || cause.code !== 'control_recovering'
                  || this.uncertainAdmission?.identity !== admissionSetIdentity(set)) throw cause;
                await this.recover();
                const active = this.trustedStatus?.registry.active;
                if (active === null || active === undefined || admissionSetIdentity(active) !== admissionSetIdentity(set)) {
                  throw new MasterIngressControllerError('admission_not_committed', 'ingress commit was not applied; abort is safe');
                }
                outcome = 'committed';
                resolvedByRecovery = true;
              }
              throwIfAborted(signal);
              this.assertAdmissionHandleScope(scope);
              if (!resolvedByRecovery) await this.resolveAdmission(set, outcome, scope, signal);
              this.assertAdmissionHandleScope(scope);
              if (outcome === 'not_committed') {
                throw new MasterIngressControllerError('admission_not_committed', 'ingress commit was not applied; abort is safe');
              }
            } finally { if (this.pendingAdmission === pending) this.pendingAdmission = null; }
          };
          if (commitPromise === null) {
            commitPromise = run().catch((error) => {
              commitPromise = null;
              throw error;
            });
          }
          return commitPromise;
        },
        abort: async () => {
          try { this.assertAdmissionHandleScope(scope); await this.abortAdmission(set, scope, signal); }
          finally { if (this.pendingAdmission === pending) this.pendingAdmission = null; }
        },
        releaseRetiredAfterExitProof: async () => {
          try {
            this.assertAdmissionHandleScope(scope);
            await this.enqueue((queueSignal) => this.releaseRetiredAfterExitProof(previousActive, scope, queueSignal), signal);
          } finally {
            if (this.pendingAdmission === pending) this.pendingAdmission = null;
          }
        },
      };
    })();
    pending = { fingerprint, promise };
    this.pendingAdmission = pending;
    void promise.catch(() => { if (this.pendingAdmission === pending) this.pendingAdmission = null; });
    void promise.then(() => {
      if (this.pendingPrepareRecovery?.identity === admissionSetIdentity(set)) this.pendingPrepareRecovery = null;
    }, () => {
      if (this.pendingPrepareRecovery?.identity === admissionSetIdentity(set)) this.pendingPrepareRecovery = null;
    });
    return promise;
  }

  async status(scope?: AdmissionHandleScope): Promise<IngressStatusPayload> {
    return this.enqueue((signal) => this.statusNow(scope, signal));
  }

  private async statusNow(scope?: AdmissionHandleScope, signal?: AbortSignal): Promise<IngressStatusPayload> {
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    throwIfAborted(signal);
    if (this.client === null) throw new MasterIngressControllerError('not_attached', 'ingress controller is not connected');
    const client = this.client;
    try {
      const status = await client.status(this.authority, this.nextSequence(signal), signal);
      throwIfAborted(signal);
      if (scope !== undefined) this.assertAdmissionHandleScope(scope);
      this.trustStatus(status);
      return status;
    } catch (error) {
      this.clearFreshness();
      throw error;
    }
  }

  /** Establishes a sequence fence, then returns fresh signed registry evidence. */
  async fenceAndStatus(token?: IngressBootRecoveryToken): Promise<IngressStatusPayload['registry']> {
    if (token !== undefined) this.assertCurrentRecoveryToken(token);
    if (this.client === null) throw new MasterIngressControllerError('not_attached', 'ingress controller is not connected');
    const scope = this.captureAdmissionHandleScope();
    try {
      return await this.enqueue(async (signal) => {
        this.assertAdmissionHandleScope(scope);
        if (token !== undefined) this.assertCurrentRecoveryToken(token);
        const status = await this.client!.fence(this.authority, this.nextSequence(signal), undefined, signal);
        throwIfAborted(signal);
        this.assertAdmissionHandleScope(scope);
        if (token !== undefined) this.assertCurrentRecoveryToken(token);
        this.trustStatus(status);
        return status.registry;
      });
    } catch (error) {
      this.markControlRecovering(error);
      throw error;
    }
  }

  async recover(): Promise<void> {
    if (this.client === null) throw new MasterIngressControllerError('not_attached', 'ingress controller is not connected');
    this.cancelTimer();
    const task = this.enqueueTask((signal) => this.recoverNow(signal));
    const recovered = await task.result;
    throwIfAborted(task.signal);
    await this.resolvePendingAdmission(task.signal);
    if (recovered) await this.invokeRecovered();
  }

  async disconnect(): Promise<void> {
    this.stopRecovery();
    this.client = null;
    this.child = null;
    this.setState('stopped');
  }

  /** Synchronously prevents queued recovery, spawning, and session publication. */
  stopRecovery(): void {
    this.lifecycleGeneration += 1;
    this.sessionPublicationAllowed = false;
    this.recoveryEvent = null;
    this.pendingNewBootEvent = null;
    this.pendingSameBoot = null;
    this.retryRecoveryEvent = null;
    this.recoveryTokenActive = false;
    this.pendingPrepareRecovery = null;
    this.rotateQueueGeneration(new MasterIngressControllerError('not_attached', 'ingress recovery was stopped'));
    this.disconnected = true;
    this.cancelTimer();
    this.clearFreshness();
  }

  async shutdownDataPlane(): Promise<void> {
    const errors: unknown[] = [];
    const client = this.client;
    this.stopRecovery();
    if (client !== null && this.state !== 'stopped') {
      try { await client.command(this.authority, this.nextSequence(), '/shutdown', null); }
      catch (error) { errors.push(error); }
    }
    if (this.ingressOrigin === 'spawned' && this.child !== null) {
      try { this.child.kill('SIGTERM'); } catch (error) { errors.push(error); }
    }
    await this.disconnect();
    if (errors.length > 0) throw new AggregateError(errors, 'ingress controller shutdown failed');
  }

  async stop(shutdown = true): Promise<void> {
    if (!shutdown) return this.disconnect();
    return this.shutdownDataPlane();
  }

  private async attachToExisting(): Promise<void> {
    const lifecycle = this.lifecycleGeneration;
    this.assertRecoveryEligible(lifecycle);
    const baseUrl = this.baseUrl();
    let identity;
    try { identity = await discoverIngressIdentity(baseUrl, this.fetch, DISCOVERY_TIMEOUT_MS); }
    catch (cause) {
      if (cause instanceof IngressDiscoveryError && cause.code === 'unavailable') {
        throw new MasterIngressControllerError('unavailable', 'ingress control endpoint is unavailable', { cause });
      }
      if (cause instanceof IngressDiscoveryError && cause.code === 'outcome_unknown') {
        throw new MasterIngressControllerError('outcome_unknown', 'ingress identity discovery outcome is unknown', { cause });
      }
      throw cause;
    }
    this.assertRecoveryEligible(lifecycle);
    const credential = this.credential(identity);
    const client = new IngressControllerClient({ baseUrl, credential, fetch: this.fetch });
    try { await client.identity(); }
    catch (cause) { throw this.mapDiscoveryFailure(cause); }
    this.assertRecoveryEligible(lifecycle);
    const challenge = await client.challenge(this.authority);
    this.assertRecoveryEligible(lifecycle);
    await client.attach(challenge, this.authority, this.nextSequence());
    this.assertRecoveryEligible(lifecycle);
    const attachedStatus = await client.status(this.authority, this.nextSequence());
    this.assertRecoveryEligible(lifecycle);
    this.client = client;
    this.authenticatedIngressIdentity = identity;
    this.connectionGeneration += 1;
    this.sessionPublicationAllowed = true;
    this.trustStatus(attachedStatus);
    this.ingressOrigin = 'adopted';
    this.setState('attached');
  }

  private async spawnAndAttach(previous?: ProcessIdentity, signal?: AbortSignal): Promise<Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }> | null> {
    const lifecycle = this.lifecycleGeneration;
    if (!this.isRecoveryEligible(lifecycle)) return null;
    this.childCredential = deriveSupervisionProcessKey(this.options.rootKey, this.options.instanceId, 'ingress', randomUUID(), randomUUID());
    const childEnvironment: NodeJS.ProcessEnv = { ...(this.options.environment ?? process.env) };
    for (const name of [
      'BUNGEE_PLUGIN_SECRETS_KEY', 'BUNGEE_ROLE', 'HOST', 'PORT', 'WORKER_ID', 'WORKER_COUNT',
      'BUNGEE_INGRESS_CREDENTIAL', 'BUNGEE_INGRESS_TRANSPORT_SECRET', 'BUNGEE_INGRESS_INSTANCE_LOCK_PATH',
      'BUNGEE_INGRESS_PUBLIC_HOST', 'BUNGEE_INGRESS_PUBLIC_PORT', 'BUNGEE_INGRESS_SUPERVISION_PORT',
    ]) delete childEnvironment[name];
    const identity = await this.waitForIdentityAfterSpawn(childEnvironment, signal);
    this.assertSpawnEligible(lifecycle);
    if (identity.process_instance_id !== this.childCredential.identity.process_instance_id
      || identity.boot_nonce !== this.childCredential.identity.boot_nonce) {
      try { this.child?.kill(); } catch { /* best effort */ }
      throw new SupervisionProtocolError('identity_mismatch', 'spawned ingress identity does not match its credential');
    }
    const client = new IngressControllerClient({ baseUrl: this.baseUrl(), credential: this.childCredential, fetch: this.fetch });
    try { await client.identity(signal); }
    catch (cause) { throw this.mapDiscoveryFailure(cause); }
    this.assertSpawnEligible(lifecycle);
    const challenge = await client.challenge(this.authority, randomUUID(), 1, signal);
    this.assertSpawnEligible(lifecycle);
    await client.attach(challenge, this.authority, this.nextSequence(signal), randomUUID(), signal);
    this.assertSpawnEligible(lifecycle);
    const attachedStatus = await client.status(this.authority, this.nextSequence(signal), signal);
    if (!this.isRecoveryEligible(lifecycle)) {
      try { this.child?.kill('SIGTERM'); } catch { /* best effort */ }
      return null;
    }
    if (previous !== undefined) {
      return this.acceptNewBoot(previous, identity, client, attachedStatus, 'spawned');
    }
    this.client = client;
    this.authenticatedIngressIdentity = identity;
    this.connectionGeneration += 1;
    this.sessionPublicationAllowed = true;
    this.trustStatus(attachedStatus);
    this.setState('attached');
    return null;
  }

  private async waitForIdentityAfterSpawn(environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<import('../supervision').ProcessIdentity> {
    const lifecycle = this.lifecycleGeneration;
    this.assertRecoveryEligible(lifecycle);
    for (const name of Object.values(DAEMON_BOOTSTRAP_ENV_NAMES)) delete environment[name];
    clearDaemonBootstrapEnvironment(environment);
    this.child = this.spawn(this.options.executable, [this.options.entry,
      `${DAEMON_PROCESS_IDENTITY_MARKER_PREFIX}${this.childCredential.identity.process_instance_id}`], {
      cwd: this.options.cwd, detached: true, shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...environment,
        BUNGEE_ROLE: 'ingress',
        BUNGEE_INGRESS_CREDENTIAL: serializeSupervisionCredential(this.childCredential),
        BUNGEE_INGRESS_TRANSPORT_SECRET: this.options.transportSecret,
        BUNGEE_INGRESS_INSTANCE_LOCK_PATH: this.options.instanceLockPath,
        BUNGEE_INGRESS_PUBLIC_HOST: this.options.publicHost,
        BUNGEE_INGRESS_PUBLIC_PORT: String(this.options.publicPort),
        BUNGEE_INGRESS_SUPERVISION_PORT: String(this.options.controlPort),
      },
    });
    this.ingressOrigin = 'spawned';
    this.child.unref();
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      try {
        throwIfAborted(signal);
        const identity = await discoverIngressIdentity(this.baseUrl(), this.fetch, DISCOVERY_TIMEOUT_MS, signal);
        throwIfAborted(signal);
        this.assertSpawnEligible(lifecycle);
        return identity;
      }
      catch (error) {
        if (error instanceof SupervisionProtocolError) {
          try { this.child.kill(); } catch { /* best effort */ }
          throw error;
        }
        if (!(error instanceof IngressDiscoveryError) || error.code !== 'unavailable') {
          try { this.child.kill(); } catch { /* best effort */ }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        throwIfAborted(signal);
        this.assertSpawnEligible(lifecycle);
      }
    }
    try { this.child.kill(); } catch { /* best effort */ }
    throw new MasterIngressControllerError('outcome_unknown', 'spawned ingress did not become discoverable');
  }

  private credential(identity: import('../supervision').ProcessIdentity): SupervisionProcessCredential {
    return deriveSupervisionProcessKey(this.options.rootKey, this.options.instanceId, identity.role,
      identity.process_instance_id, identity.boot_nonce);
  }

  private mapDiscoveryFailure(error: unknown): unknown {
    if (!(error instanceof IngressDiscoveryError)) return error;
    return new MasterIngressControllerError(error.code, `ingress identity discovery ${error.code}`, { cause: error });
  }

  private baseUrl(): string { return `http://127.0.0.1:${this.options.controlPort}`; }

  private isRecoveryEligible(lifecycle: number): boolean {
    return !this.disconnected && lifecycle === this.lifecycleGeneration;
  }

  private assertRecoveryEligible(lifecycle: number): void {
    if (!this.isRecoveryEligible(lifecycle)) {
      throw new MasterIngressControllerError('not_attached', 'ingress recovery was stopped');
    }
  }

  private assertSpawnEligible(lifecycle: number): void {
    try { this.assertRecoveryEligible(lifecycle); }
    catch (error) {
      try { this.child?.kill('SIGTERM'); } catch { /* best effort */ }
      throw error;
    }
  }

  private captureAdmissionHandleScope(): AdmissionHandleScope {
    return { boot: this.bootGeneration, connection: this.connectionGeneration, lifecycle: this.lifecycleGeneration };
  }

  private assertAdmissionHandleScope(scope: AdmissionHandleScope): void {
    if (scope.lifecycle !== this.lifecycleGeneration || this.disconnected) {
      throw new MasterIngressControllerError('not_attached', 'ingress admission handle is no longer active');
    }
    if (scope.boot !== this.bootGeneration) {
      throw new MasterIngressControllerError('stale_boot', 'ingress admission handle belongs to a previous ingress boot');
    }
    // A same-boot reattach may replace the HTTP client; rebind the idempotent
    // handle to that authenticated connection, but never cross a boot boundary.
    if (scope.connection !== this.connectionGeneration) scope.connection = this.connectionGeneration;
  }

  private startLeaseRenewal(): void {
    this.cancelTimer();
    this.scheduleLeaseRenewal();
  }

  private scheduleLeaseRenewal(): void {
    const lifecycle = this.lifecycleGeneration;
    this.leaseTimer = setTimeout(() => {
      if (!this.isRecoveryEligible(lifecycle)) return;
      void this.enqueue(async (signal) => {
        if (!this.isRecoveryEligible(lifecycle) || this.client === null || this.state !== 'attached') return;
        try {
          const leaseDeadline = this.monotonicNow() + this.leaseDurationMs;
          await this.client.lease(this.authority, this.now() + this.leaseDurationMs, this.nextSequence(signal), undefined, signal);
          throwIfAborted(signal);
          if (!this.isRecoveryEligible(lifecycle)) return;
          this.leaseDeadline = leaseDeadline;
          await this.statusNow(undefined, signal);
          if (this.disconnected || this.client === null || this.state !== 'attached') return;
          this.scheduleLeaseRenewal();
        } catch (error) {
          this.markControlRecovering(error);
          throw error;
        }
      }).catch(() => undefined);
    }, Math.max(1, Math.floor(this.leaseDurationMs / 3)));
  }

  private scheduleRecovery(): void {
    if (this.disconnected || this.client === null || this.state !== 'control_recovering'
      || this.recoveryTimerScheduled) return;
    if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
    const delay = Math.min(this.leaseDurationMs, 25 * (2 ** Math.min(this.recoveryAttempt, 8)));
    this.recoveryAttempt += 1;
    this.recoveryTimerScheduled = true;
    const lifecycle = this.lifecycleGeneration;
    this.leaseTimer = setTimeout(() => {
      this.recoveryTimerScheduled = false;
      if (!this.isRecoveryEligible(lifecycle)) return;
      void this.enqueue((signal) => this.recoverNow(signal)).then(
        async (recovered) => {
          if (!this.isRecoveryEligible(lifecycle)) return;
          await this.resolvePendingAdmission();
          if (recovered) await this.invokeRecovered();
        },
        () => undefined,
      );
    }, delay);
  }

  private async recoverNow(signal?: AbortSignal): Promise<boolean> {
    if (this.client === null) throw new MasterIngressControllerError('not_attached', 'ingress controller is not connected');
    const lifecycle = this.lifecycleGeneration;
    this.assertRecoveryEligible(lifecycle);
    try {
      const wasRecovering = this.state === 'control_recovering';
      let newBoot = false;
      if (this.pendingPrepareRecovery !== null) {
        this.pendingPrepareRecovery.recovering = true;
        this.pendingPrepareRecovery.outcome = await this.resolvePrepareRecovery(signal);
        throwIfAborted(signal);
      } else if (this.uncertainAdmission !== null) {
        const fenced = await this.client.fence(this.authority, this.nextSequence(signal), undefined, signal);
        throwIfAborted(signal);
        this.trustStatus(fenced);
        await this.resolveUncertain(fenced, undefined, signal, false, true);
        throwIfAborted(signal);
      }
      try {
        await this.statusNow(undefined, signal);
        this.assertRecoveryEligible(lifecycle);
      } catch (cause) {
        const event = await this.recoverNewBoot(cause, signal);
        if (event === null) throw cause;
        newBoot = true;
      }
      this.assertRecoveryEligible(lifecycle);
      const leaseDeadline = this.monotonicNow() + this.leaseDurationMs;
      await this.client.lease(this.authority, this.now() + this.leaseDurationMs, this.nextSequence(signal), undefined, signal);
      throwIfAborted(signal);
      this.assertRecoveryEligible(lifecycle);
      this.leaseDeadline = leaseDeadline;
      await this.statusNow(undefined, signal);
      const pendingRelease = this.pendingRetiredRelease;
      if (!newBoot && pendingRelease !== null) await this.releaseRetiredAfterExitProof(pendingRelease.set, undefined, signal);
      const recoveredStatus = this.trustedStatus;
      if (!newBoot && recoveredStatus !== null && recoveredStatus.registry.retired.length > 0) {
        this.setState('control_recovering');
        this.scheduleRecovery();
        return false;
      }
      if (this.disconnected || this.client === null) return false;
      this.setState('attached');
      this.recoveryAttempt = 0;
      this.scheduleLeaseRenewal();
      if (this.recoveryCallbackRunning) {
        this.recoveryCallbackPending = true;
        return false;
      }
      if (!newBoot && wasRecovering) this.queueRecoveryEvent({ kind: 'same_boot', token: this.bootGeneration });
      return wasRecovering || newBoot;
    } catch (cause) {
      this.markControlRecovering(cause);
      throw cause;
    }
  }

  private async recoverNewBoot(_cause: unknown, signal?: AbortSignal): Promise<MasterIngressRecoveryEvent | null> {
    const lifecycle = this.lifecycleGeneration;
    if (!this.isRecoveryEligible(lifecycle)) return null;
    const previous = this.authenticatedIngressIdentity;
    if (previous === null) return null;
    let candidate: ProcessIdentity;
    try {
      candidate = await discoverIngressIdentity(this.baseUrl(), this.fetch, DISCOVERY_TIMEOUT_MS, signal);
    } catch (error) {
      if (!(error instanceof IngressDiscoveryError) || error.code !== 'unavailable') throw error;
      if (!this.isRecoveryEligible(lifecycle)) return null;
      return this.spawnAndAttach(previous, signal);
    }
    if (!this.isRecoveryEligible(lifecycle)) return null;
    if (candidate.role !== 'ingress'
      || (candidate.process_instance_id === previous.process_instance_id && candidate.boot_nonce === previous.boot_nonce)) {
      return null;
    }
    if (!this.isRecoveryEligible(lifecycle)) return null;
    const client = new IngressControllerClient({ baseUrl: this.baseUrl(), credential: this.credential(candidate), fetch: this.fetch });
    await client.identity(signal);
    if (!this.isRecoveryEligible(lifecycle)) return null;
    const challenge = await client.challenge(this.authority, randomUUID(), 1, signal);
    if (!this.isRecoveryEligible(lifecycle)) return null;
    await client.attach(challenge, this.authority, this.nextSequence(signal), randomUUID(), signal);
    if (!this.isRecoveryEligible(lifecycle)) return null;
    const attachedStatus = await client.status(this.authority, this.nextSequence(signal), signal);
    if (!this.isRecoveryEligible(lifecycle)) return null;
    return this.acceptNewBoot(previous, candidate, client, attachedStatus, 'adopted');
  }

  private acceptNewBoot(
    previous: ProcessIdentity,
    current: ProcessIdentity,
    client = this.client!,
    attachedStatus = this.trustedStatus!,
    origin: MasterIngressControllerOrigin,
  ): Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }> {
    this.resetForNewBoot();
    this.client = client;
    if (origin === 'adopted') {
      this.child = null;
      this.ingressOrigin = 'adopted';
    } else {
      this.ingressOrigin = 'spawned';
    }
    this.authenticatedIngressIdentity = current;
    this.connectionGeneration += 1;
    this.sessionPublicationAllowed = true;
    const event = { kind: 'new_boot' as const, previous, current, token: this.bootGeneration };
    this.recoveryTokenActive = true;
    // The recovery gate must observe the authenticated session before any state/trust observers run.
    this.options.onNewBootAccepted?.(event);
    this.trustStatus(attachedStatus);
    this.setState('attached');
    this.queueRecoveryEvent(event);
    return event;
  }

  private resetForNewBoot(): void {
    // A fresh ingress registry is not evidence about commands sent to the old boot.
    this.pendingAdmission = null;
    this.uncertainAdmission = null;
    this.pendingRetiredRelease = null;
    this.bootGeneration += 1;
  }

  private assertCurrentRecoveryToken(token: IngressBootRecoveryToken): void {
    if (!this.recoveryTokenActive || token !== this.bootGeneration) {
      throw new MasterIngressControllerError('stale_boot', 'ingress boot recovery token is stale');
    }
  }

  private queueRecoveryEvent(event: MasterIngressRecoveryEvent): void {
    if (event.kind === 'new_boot') {
      const merge = (first: Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }>, latest: typeof first) => ({
        kind: 'new_boot' as const, previous: first.previous, current: latest.current, token: latest.token,
      });
      if (this.recoveryCallbackRunning) {
        this.pendingNewBootEvent = this.pendingNewBootEvent === null
          ? event : merge(this.pendingNewBootEvent, event);
        this.recoveryCallbackPending = true;
        return;
      }
      if (this.recoveryEvent?.kind === 'new_boot') {
        this.recoveryEvent = merge(this.recoveryEvent, event);
        return;
      }
      if (this.recoveryEvent === null && this.retryRecoveryEvent?.kind === 'new_boot') {
        this.retryRecoveryEvent = merge(this.retryRecoveryEvent, event);
        return;
      }
      if (this.recoveryEvent === null && this.retryRecoveryEvent === null) {
        this.recoveryEvent = event;
        return;
      }
      this.pendingNewBootEvent = this.pendingNewBootEvent === null
        ? event : merge(this.pendingNewBootEvent, event);
      this.recoveryCallbackPending = true;
      return;
    }
    if (this.recoveryCallbackRunning || this.recoveryEvent !== null || this.retryRecoveryEvent !== null) {
      this.pendingSameBoot = event.token ?? this.bootGeneration;
      this.recoveryCallbackPending = true;
      return;
    }
    this.recoveryEvent = event;
  }

  private takeNextRecoveryEvent(includeRetry = true): MasterIngressRecoveryEvent | null {
    if (this.pendingNewBootEvent !== null) {
      const event = this.pendingNewBootEvent;
      this.pendingNewBootEvent = null;
      return event;
    }
    if (includeRetry && this.retryRecoveryEvent?.kind === 'new_boot'
      && this.retryRecoveryEvent.token === this.bootGeneration) {
      const event = this.retryRecoveryEvent;
      this.retryRecoveryEvent = null;
      return event;
    }
    if (this.pendingSameBoot) {
      const token = this.pendingSameBoot;
      this.pendingSameBoot = null;
      return { kind: 'same_boot', token };
    }
    if (!includeRetry) return null;
    const retry = this.retryRecoveryEvent;
    this.retryRecoveryEvent = null;
    if (retry?.kind === 'new_boot' && retry.token !== this.bootGeneration) return null;
    return retry;
  }

  private markControlRecovering(_cause: unknown): void {
    this.clearFreshness();
    if (this.disconnected || this.client === null) return;
    this.setState('control_recovering');
    this.scheduleRecovery();
  }

  private async invokeRecovered(): Promise<void> {
    if (this.options.onRecovered === undefined || this.disconnected) return;
    if (this.recoveryCallbackRunning) {
      this.recoveryCallbackPending = true;
      return;
    }
    this.recoveryCallbackRunning = true;
    try {
      do {
        this.recoveryCallbackPending = false;
        let event = this.recoveryEvent ?? this.takeNextRecoveryEvent();
        if (event === null) {
          event = { kind: 'same_boot', token: this.bootGeneration };
          this.recoveryEvent = event;
        }
        const result = await this.options.onRecovered(event);
        const currentToken = event.token === this.bootGeneration;
        if (!currentToken) {
          if (this.recoveryEvent === event) this.recoveryEvent = null;
          const next = this.takeNextRecoveryEvent();
          if (next === null) return;
          this.recoveryEvent = next;
          continue;
        }
        if (result === 'retryable') {
          if (this.recoveryEvent === event) {
            this.recoveryEvent = null;
            this.retryRecoveryEvent = event;
          }
          const next = this.takeNextRecoveryEvent(false);
          if (next !== null) {
            this.recoveryEvent = next;
            continue;
          }
          this.markControlRecovering(new MasterIngressControllerError('control_recovering', 'recovery task is retryable'));
          return;
        }
        if (result === 'fatal') {
          this.clearFreshness();
          this.cancelTimer();
          this.sessionPublicationAllowed = false;
          this.recoveryTokenActive = false;
          this.setState('control_recovering');
          return;
        }
        if (this.recoveryEvent === event) this.recoveryEvent = null;
        if (event.kind === 'new_boot' && this.pendingNewBootEvent === null) this.recoveryTokenActive = false;
        const next = this.takeNextRecoveryEvent();
        if (next !== null) this.recoveryEvent = next;
      } while (this.recoveryCallbackPending && !this.disconnected);
    } catch (cause) {
      this.recoveryCallbackPending = false;
      this.markControlRecovering(cause);
      throw cause;
    } finally {
      this.recoveryCallbackRunning = false;
    }
  }

  private async resolvePendingAdmission(signal?: AbortSignal): Promise<void> {
    const uncertain = this.uncertainAdmission;
    if (uncertain?.pendingResolution !== null && uncertain?.pendingResolution !== undefined) {
      await this.resolveAdmission(uncertain.target, uncertain.pendingResolution, undefined, signal);
    }
  }

  private cancelTimer(): void {
    if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.recoveryTimerScheduled = false;
  }

  private requireMutation(): void {
    if (this.client === null || this.state !== 'attached') {
      throw new MasterIngressControllerError(this.state === 'control_recovering' ? 'control_recovering' : 'not_attached', 'ingress mutation is unavailable');
    }
    if (this.uncertainAdmission !== null
      || this.pendingPrepareRecovery?.recovering === true
      || this.pendingRetiredRelease !== null
      || (this.trustedStatus !== null && this.trustedStatus.registry.retired.length !== 0)) {
      throw new MasterIngressControllerError('control_recovering', 'retired ingress admission release is pending');
    }
  }

  private nextSequence(signal?: AbortSignal): number {
    throwIfAborted(signal);
    const next = this.sequence;
    this.sequence += 1;
    return next;
  }

  private rotateQueueGeneration(reason: unknown): void {
    const oldGeneration = this.queueGenerationController;
    oldGeneration.abort(reason);
    this.queueGeneration += 1;
    this.queueGenerationController = new AbortController();
    this.queue = Promise.resolve();
  }

  private enqueueTask<Result>(operation: (signal: AbortSignal) => Promise<Result>, parentSignal?: AbortSignal, executionDeadlineMs?: number): QueueTask<Result> {
    const generation = this.queueGeneration;
    const generationSignal = this.queueGenerationController.signal;
    const itemController = new AbortController();
    const signals = [generationSignal, itemController.signal, parentSignal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    const signalController = new AbortController();
    const forward = (signal: AbortSignal): void => {
      if (!signalController.signal.aborted) signalController.abort(signal.reason);
    };
    const listeners = signals.map((signal) => {
      const listener = () => forward(signal);
      if (signal.aborted) listener();
      else signal.addEventListener('abort', listener, { once: true });
      return { signal, listener };
    });
    const deadlineAt = Date.now() + this.startupTimeoutMs;
    const deadlineReason = new MasterIngressControllerError('control_recovering', 'ingress control queue deadline expired');
    const abortGeneration = (): void => {
      itemController.abort(deadlineReason);
      if (generation === this.queueGeneration) {
        this.rotateQueueGeneration(deadlineReason);
        this.markControlRecovering(deadlineReason);
      }
    };
    let started = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let executionTimer: ReturnType<typeof setTimeout> | null = null;
    deadlineTimer = setTimeout(() => {
      if (started) return;
      abortGeneration();
    }, Math.max(0, deadlineAt - Date.now()));
    const pending = this.queue.then(() => {
      started = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (executionDeadlineMs !== undefined) executionTimer = setTimeout(abortGeneration, executionDeadlineMs);
      throwIfAborted(signalController.signal);
      return operation(signalController.signal);
    }, () => {
      started = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (executionDeadlineMs !== undefined) executionTimer = setTimeout(abortGeneration, executionDeadlineMs);
      throwIfAborted(signalController.signal);
      return operation(signalController.signal);
    });
    const quiesced = pending.then(() => undefined, () => undefined);
    this.queue = quiesced;
    void quiesced.then(() => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (executionTimer !== null) clearTimeout(executionTimer);
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    });
    let rejectPublic!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectPublic = reject; });
    const onAbort = (): void => rejectPublic(signalController.signal.reason);
    if (signalController.signal.aborted) onAbort();
    else signalController.signal.addEventListener('abort', onAbort, { once: true });
    const result = Promise.race([pending, cancelled]) as Promise<Result>;
    const publicResult = result.finally(() => {
      signalController.signal.removeEventListener('abort', onAbort);
    });
    return { result: publicResult, quiesced, signal: signalController.signal };
  }

  private enqueue<Result>(operation: (signal: AbortSignal) => Promise<Result>, parentSignal?: AbortSignal): Promise<Result> {
    return this.enqueueTask(operation, parentSignal).result;
  }

  private async command(path: string, body: unknown, scope?: AdmissionHandleScope, signal?: AbortSignal): Promise<unknown> {
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    throwIfAborted(signal);
    if (this.client === null) throw new MasterIngressControllerError('not_attached', 'ingress controller is not connected');
    const resolvingPreparedAdmission = path === '/commit' && this.uncertainAdmission !== null;
    if (path !== '/shutdown' && path !== '/release-retired' && path !== '/admission/fence'
      && !resolvingPreparedAdmission && this.state !== 'attached') {
      throw new MasterIngressControllerError('control_recovering', 'ingress mutations are paused');
    }
    try {
      const client = this.client;
      const result = await client.command(this.authority, this.nextSequence(signal), path, body, undefined, signal);
      throwIfAborted(signal);
      if (scope !== undefined) this.assertAdmissionHandleScope(scope);
      return result;
    } catch (error) {
      this.clearFreshness();
      this.markControlRecovering(error);
      throw error;
    }
  }

  private clearFreshness(): void {
    this.trustedStatus = null;
    this.trustedStatusAt = -1;
    this.trustedStatusAuthority = null;
    this.leaseDeadline = 0;
    this.notifyEligibilityChange();
  }

  private beginUncertainAdmission(set: AdmissionSet): void {
    const identity = admissionSetIdentity(set);
    if (this.uncertainAdmission !== null) {
      if (this.uncertainAdmission.identity !== identity) {
        throw new MasterIngressControllerError('outcome_unknown', 'a different uncertain admission is already being resolved');
      }
      return;
    }
    this.uncertainAdmission = {
      target: set,
      identity,
      previousActive: this.trustedStatus?.registry.active ?? null,
      pendingResolution: null,
      resolutionPromise: null,
    };
  }

  private beginPrepareRecovery(set: AdmissionSet): void {
    const identity = admissionSetIdentity(set);
    if (this.pendingPrepareRecovery !== null) {
      if (this.pendingPrepareRecovery.identity !== identity) {
        throw new MasterIngressControllerError('outcome_unknown', 'a different prepare admission is already recovering');
      }
      return;
    }
    this.pendingPrepareRecovery = { target: set, identity, outcome: null, recovering: false };
  }

  private async commitAdmission(set: AdmissionSet, scope?: AdmissionHandleScope, signal?: AbortSignal): Promise<'committed' | 'not_committed'> {
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    this.beginUncertainAdmission(set);
    let status: IngressStatusPayload;
    try {
      await this.command('/commit', set, scope, signal);
      status = await this.statusNow(scope, signal);
    } catch (cause) {
      throwIfAborted(signal);
      status = await this.statusAfterFailure(cause, scope, signal);
    }
    throwIfAborted(signal);
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    const outcome = await this.resolveUncertain(status, scope, signal);
    if (outcome !== null) return outcome;
    this.admissionOutcomeUnknown('ingress commit was not confirmed active', status);
  }

  private async resolveAdmission(target: AdmissionSet, outcome: 'committed' | 'not_committed', scope?: AdmissionHandleScope, signal?: AbortSignal): Promise<void> {
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    throwIfAborted(signal);
    const uncertain = this.uncertainAdmission;
    if (uncertain === null || uncertain.identity !== admissionSetIdentity(target)) {
      throw new MasterIngressControllerError('outcome_unknown', 'admission resolution identity is no longer current');
    }
    if (uncertain.pendingResolution !== null && uncertain.pendingResolution !== outcome) {
      throw new MasterIngressControllerError('outcome_unknown', 'admission resolution conflicts with pending resolution');
    }
    uncertain.pendingResolution = outcome;
    if (uncertain.resolutionPromise !== null) return uncertain.resolutionPromise;
    const resolution = (async () => {
      if (scope !== undefined) this.assertAdmissionHandleScope(scope);
      await this.options.onAdmissionResolved?.({ target: uncertain.target, outcome });
      throwIfAborted(signal);
      if (scope !== undefined) this.assertAdmissionHandleScope(scope);
      if (this.uncertainAdmission === uncertain) this.uncertainAdmission = null;
    })();
    uncertain.resolutionPromise = resolution;
    try { await resolution; throwIfAborted(signal); }
    catch (cause) {
      uncertain.resolutionPromise = null;
      this.markControlRecovering(cause);
      throw cause;
    }
  }

  private async resolveUncertain(status: IngressStatusPayload, scope?: AdmissionHandleScope, signal?: AbortSignal, fenceFirst = false, alreadyFenced = false): Promise<'committed' | 'not_committed' | null> {
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    throwIfAborted(signal);
    const uncertain = this.uncertainAdmission;
    if (uncertain === null || this.resolvingUncertain) return null;
    const targetIdentity = uncertain.identity;
    this.resolvingUncertain = true;
    try {
      if (fenceFirst) {
        if (this.client === null) this.admissionOutcomeUnknown('ingress fence client is unavailable', status);
        const fenced = await this.client!.fence(this.authority, this.nextSequence(signal), undefined, signal);
        throwIfAborted(signal);
        this.trustStatus(fenced);
        status = fenced;
      }
      if (status.registry.active !== null && admissionSetIdentity(status.registry.active) === targetIdentity) {
        uncertain.pendingResolution = 'committed';
        return 'committed';
      }
      if (status.registry.prepared !== null && admissionSetIdentity(status.registry.prepared) === targetIdentity) {
        try { await this.command('/commit', uncertain.target, scope, signal); }
        catch (cause) { throwIfAborted(signal); await this.statusAfterFailure(cause, scope, signal); }
        throwIfAborted(signal);
        const confirmed = await this.statusNow(scope, signal);
        if (confirmed.registry.active !== null && admissionSetIdentity(confirmed.registry.active) === targetIdentity) {
          uncertain.pendingResolution = 'committed';
          return 'committed';
        }
        if (confirmed.registry.prepared !== null && admissionSetIdentity(confirmed.registry.prepared) === targetIdentity) {
          this.admissionOutcomeUnknown('prepared ingress commit remains unresolved', confirmed);
        }
        if (confirmed.registry.prepared === null && (confirmed.registry.active === null
          || admissionSetIdentity(confirmed.registry.active) !== targetIdentity)) {
          uncertain.pendingResolution = 'not_committed';
          return 'not_committed';
        }
      }
      if ((fenceFirst || alreadyFenced) && status.registry.prepared === null && (status.registry.active === null
        || admissionSetIdentity(status.registry.active) !== targetIdentity)) {
        uncertain.pendingResolution = 'not_committed';
        return 'not_committed';
      }
      if (this.client === null) this.admissionOutcomeUnknown('ingress fence client is unavailable', status);
      try {
        const client = this.client;
        await client.fence(this.authority, this.nextSequence(signal), undefined, signal);
        throwIfAborted(signal);
        if (scope !== undefined) this.assertAdmissionHandleScope(scope);
        const fenced = await this.statusNow(scope, signal);
        if (fenced.registry.active !== null && admissionSetIdentity(fenced.registry.active) === targetIdentity) {
          uncertain.pendingResolution = 'committed';
          return 'committed';
        }
        if (fenced.registry.prepared !== null && admissionSetIdentity(fenced.registry.prepared) === targetIdentity) {
          await this.command('/commit', uncertain.target, scope, signal);
          throwIfAborted(signal);
          const committed = await this.statusNow(scope, signal);
          if (committed.registry.active !== null && admissionSetIdentity(committed.registry.active) === targetIdentity) {
            uncertain.pendingResolution = 'committed';
            return 'committed';
          }
          this.admissionOutcomeUnknown('prepared ingress commit remains unresolved after fence', committed);
        }
        if (fenced.registry.prepared === null && (fenced.registry.active === null
          || admissionSetIdentity(fenced.registry.active) !== targetIdentity)) {
          uncertain.pendingResolution = 'not_committed';
          return 'not_committed';
        }
        this.admissionOutcomeUnknown('conflicting ingress admission state after fence', fenced);
      } catch (cause) {
        this.admissionOutcomeUnknown('ingress admission fence outcome is unknown', cause);
      }
      this.admissionOutcomeUnknown('conflicting ingress admission state', status);
    } finally {
      this.resolvingUncertain = false;
    }
  }

  private async resolvePrepareRecovery(signal?: AbortSignal): Promise<'active' | 'prepared' | 'absent'> {
    const pending = this.pendingPrepareRecovery;
    if (pending === null || this.client === null) throw new MasterIngressControllerError('outcome_unknown', 'prepare recovery identity is unavailable');
    const fenced = await this.client.fence(this.authority, this.nextSequence(signal), undefined, signal);
    throwIfAborted(signal);
    this.trustStatus(fenced);
    if (fenced.registry.active !== null && admissionSetIdentity(fenced.registry.active) === pending.identity) return 'active';
    if (fenced.registry.prepared !== null && admissionSetIdentity(fenced.registry.prepared) === pending.identity) return 'prepared';
    if (fenced.registry.prepared === null
      && (fenced.registry.active === null || admissionSetIdentity(fenced.registry.active) !== pending.identity)) return 'absent';
    this.admissionOutcomeUnknown('prepare recovery status has a conflicting identity', fenced);
  }

  private async releaseRetiredAfterExitProof(previousActive: AdmissionSet | null, scope?: AdmissionHandleScope, signal?: AbortSignal): Promise<void> {
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    throwIfAborted(signal);
    const pending = this.pendingRetiredRelease;
    const set = previousActive ?? pending?.set ?? null;
    if (set === null) return;
    const identity = admissionSetIdentity(set);
    if (pending !== null && pending.identity !== identity) {
      throw new MasterIngressControllerError('invalid_options', 'a different retired admission release is pending');
    }
    this.pendingRetiredRelease = { identity, set };
    try {
      let status = await this.releaseRetiredAttempt(set, scope, signal);
      throwIfAborted(signal);
      if (status.registry.retired.some((candidate) => admissionSetIdentity(candidate) === identity)) {
        status = await this.releaseRetiredAttempt(set, scope, signal);
        throwIfAborted(signal);
        if (status.registry.retired.some((candidate) => admissionSetIdentity(candidate) === identity)) {
          this.admissionOutcomeUnknown('retired admission release was not confirmed', status);
        }
      }
      this.pendingRetiredRelease = null;
      this.trustStatus(status);
      if (status.state === 'attached' && !this.disconnected && this.client !== null) {
        this.setState('attached');
        this.recoveryAttempt = 0;
        this.startLeaseRenewal();
      }
    } catch (error) {
      if (error instanceof SupervisionProtocolError) {
        this.pendingRetiredRelease = null;
        throw error;
      }
      if (error instanceof MasterIngressControllerError && error.code === 'outcome_unknown') throw error;
      this.admissionOutcomeUnknown('retired admission release outcome is unknown', error);
    }
  }

  private async releaseRetiredAttempt(set: AdmissionSet, scope?: AdmissionHandleScope, signal?: AbortSignal): Promise<IngressStatusPayload> {
    try {
      await this.command('/release-retired', set, scope, signal);
      return await this.statusNow(scope, signal);
    } catch (cause) {
      throwIfAborted(signal);
      if (cause instanceof SupervisionProtocolError) throw cause;
      try {
        return await this.statusNow(scope, signal);
      } catch (statusError) {
        throwIfAborted(signal);
        if (statusError instanceof SupervisionProtocolError) throw statusError;
        this.markControlRecovering(statusError);
        throw new MasterIngressControllerError('outcome_unknown', 'retired admission release status is unknown', {
          cause: new AggregateError([cause, statusError], 'retired admission release and status failed'),
        });
      }
    }
  }

  private admissionOutcomeUnknown(message: string, cause?: unknown): never {
    this.markControlRecovering(cause);
    throw new MasterIngressControllerError('outcome_unknown', message, { cause });
  }

  private safeToAbort(status: IngressStatusPayload, targetIdentity: string): boolean {
    return status.registry.prepared === null
      && status.registry.active !== null
      && admissionSetIdentity(status.registry.active) !== targetIdentity;
  }

  private async abortAdmission(set: AdmissionSet, scope?: AdmissionHandleScope, parentSignal?: AbortSignal): Promise<void> {
    await this.enqueue(async (signal) => {
      try {
        await this.command('/abort', set, scope, signal);
      } catch (cause) {
        throwIfAborted(signal);
        const status = await this.statusAfterFailure(cause, scope, signal);
        throwIfAborted(signal);
        if (!this.safeToAbort(status, admissionSetIdentity(set))) throw cause;
      }
    }, parentSignal);
  }

  private async statusAfterFailure(cause: unknown, scope?: AdmissionHandleScope, signal?: AbortSignal): Promise<IngressStatusPayload> {
    if (scope !== undefined) this.assertAdmissionHandleScope(scope);
    throwIfAborted(signal);
    try {
      if (this.client === null) throw new MasterIngressControllerError('not_attached', 'ingress controller is not connected');
      const client = this.client;
      const status = await client.status(this.authority, this.nextSequence(signal), signal);
      throwIfAborted(signal);
      if (scope !== undefined) this.assertAdmissionHandleScope(scope);
      this.trustStatus(status);
      return status;
    }
    catch (statusError) {
      this.markControlRecovering(statusError);
      throw new MasterIngressControllerError('outcome_unknown', 'ingress status could not resolve a command outcome', {
        cause: new AggregateError([cause, statusError], 'ingress command and status failed'),
      });
    }
  }

  private trustStatus(status: IngressStatusPayload): void {
    this.admissionSequence = Math.max(this.admissionSequence,
      status.registry.active?.admission_sequence ?? 0,
      status.registry.prepared?.admission_sequence ?? 0,
      ...status.registry.retired.map((set) => set.admission_sequence));
    this.trustedStatus = status;
    this.trustedStatusAt = this.monotonicNow();
    this.trustedStatusAuthority = { ...this.authority };
    this.notifyEligibilityChange();
  }

  private setState(state: MasterIngressControllerState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.stateListeners]) {
      try { listener(state); } catch { /* state observers must not affect ingress control */ }
    }
    this.notifyEligibilityChange();
  }

  private notifyEligibilityChange(): void {
    for (const listener of [...this.eligibilityListeners]) {
      try { listener(); } catch { /* eligibility observers must not affect ingress control */ }
    }
  }

  private toAdmissionSet(workers: readonly ServingConfigWorker[]): AdmissionSet {
    if (workers.length === 0) throw new MasterIngressControllerError('invalid_options', 'cannot admit an empty worker set');
    const first = workers[0]!;
    if (!validateDigest(first.content_hash) || !validateDigest(first.plugin_catalog_hash)) {
      throw new MasterIngressControllerError('invalid_options', 'worker admission digest is invalid');
    }
    const masterGeneration = first.process.identity.master_generation;
    const normalized = workers.map((worker) => {
      if (worker.process.identity.master_generation !== masterGeneration
        || worker.revision !== first.revision || worker.content_hash !== first.content_hash
        || worker.plugin_catalog_hash !== first.plugin_catalog_hash
        || worker.process.slot !== worker.process.identity.worker_slot
        || typeof worker.boot_nonce !== 'string' || !isLowercaseUuid(worker.boot_nonce)
        || !Number.isSafeInteger(worker.private_port) || worker.private_port <= 0 || worker.private_port > 65_535) {
        throw new MasterIngressControllerError('invalid_options', 'worker admission evidence is mixed');
      }
      return {
        master_generation: masterGeneration,
        worker_instance_id: worker.process.identity.worker_instance_id,
        boot_nonce: worker.boot_nonce,
        worker_slot: worker.process.identity.worker_slot,
        private_port: worker.private_port,
      };
    }).sort((left, right) => left.worker_slot - right.worker_slot);
    const ordered = normalized;
    const slots = new Set(ordered.map(({ worker_slot }) => worker_slot));
    const ports = new Set(ordered.map(({ private_port }) => private_port));
    const workerIds = new Set(ordered.map(({ worker_instance_id }) => worker_instance_id));
    if (slots.size !== ordered.length || ports.size !== ordered.length || workerIds.size !== ordered.length
      || ordered.some((worker, index) => worker.worker_slot !== index)) {
      throw new MasterIngressControllerError('invalid_options', 'worker admission slots or ports are not unique');
    }
    this.admissionSequence += 1;
    return {
      master_generation: masterGeneration,
      admission_sequence: this.admissionSequence,
      revision: first.revision,
      content_hash: first.content_hash as Sha256Digest,
      plugin_catalog_hash: first.plugin_catalog_hash as Sha256Digest,
      workers: ordered,
    };
  }
}
