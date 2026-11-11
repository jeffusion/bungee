import type { Sha256Digest } from '@jeffusion/bungee-types';
import type {
  ActiveConfigurationPublication,
  ConfigurationRecovery,
  ConfigurationRecoveryReasonCode,
  RepositorySnapshot,
} from '../config-storage/repository-types';
import type {
  MasterPublicationOutcome,
  ServingConfigWorker,
} from '../config-publication/coordinator-types';
import { classifyRecoveryError, classifyStartupOutcome } from '../config-publication/recovery-disposition';
import { isPublicationCancelled, type PublicationCancellationSignal } from '../config-publication/publication-runner';
import type { MasterRuntimeCoordinator } from './runtime-contracts';
import type { PublicationTaskLifecycle, RecoveryTaskResult } from './publication-task-manager';

const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

type RecoveryRepository = {
  getSnapshot(): RepositorySnapshot;
  getCurrentRecovery(): Promise<ConfigurationRecovery | null>;
  getActivePublication(): Promise<ActiveConfigurationPublication | null>;
  createManualRecovery(
    recoveryId: string, sourceMutationId: string, expectedRevision: number, now: number,
  ): Promise<ConfigurationRecovery>;
  claimRecoveryAttempt(recoveryId: string, previousAttemptCount: number, now: number): Promise<ConfigurationRecovery>;
  scheduleRecoveryRetry(
    recoveryId: string, attemptCount: number, nextRetryAt: number, now: number,
  ): Promise<ConfigurationRecovery>;
  succeedRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): Promise<ConfigurationRecovery>;
  stopRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): Promise<ConfigurationRecovery>;
  requeueRecovery(recoveryId: string, attemptCount: number, now: number): Promise<ConfigurationRecovery>;
  getUnsettledWorkerLaunches(): Promise<readonly unknown[]>;
};

type RecoveryTimer = { cancel(): void };

export type ConfigurationRecoveryScheduler = {
  schedule(delayMs: number, callback: () => void): RecoveryTimer;
};

export type ConfigurationRecoveryRunnerOptions = {
  readonly repository: RecoveryRepository;
  readonly publicationTasks: PublicationTaskLifecycle;
  readonly coordinator: Pick<MasterRuntimeCoordinator, 'startCurrent' | 'recoverAndPublish'>;
  readonly admission: { snapshot(): readonly ServingConfigWorker[] };
  readonly workerCount: number;
  readonly pluginCatalogHash: Sha256Digest;
  readonly now: () => number;
  readonly scheduler?: ConfigurationRecoveryScheduler;
  readonly onFatal: (error: Error) => void;
  /** A completed recovery pass has reconciled the previous unknown publication outcome. */
  readonly onRecovered?: () => void;
};

const DEFAULT_SCHEDULER: ConfigurationRecoveryScheduler = {
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  },
};

function identityMatches(
  workers: readonly ServingConfigWorker[], snapshot: RepositorySnapshot,
  pluginCatalogHash: Sha256Digest, workerCount: number,
): boolean {
  return workers.length === workerCount
    && workers.every((worker, slot) => worker.process.slot === slot
      && worker.revision === snapshot.revision
      && worker.content_hash === snapshot.content_hash
      && worker.plugin_catalog_hash === pluginCatalogHash);
}

function revisionServing(
  workers: readonly ServingConfigWorker[], revision: number, workerCount: number,
): boolean {
  return workers.length === workerCount && workers.every(worker => worker.revision === revision);
}

function detail(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message.slice(0, 512) : String(error).slice(0, 512);
}

export class ConfigurationRecoveryRunner {
  private readonly scheduler: ConfigurationRecoveryScheduler;
  private stopped = false;
  private generation = 0;
  private timer: RecoveryTimer | null = null;
  private task: Promise<RecoveryTaskResult> | null = null;
  private controller: AbortController | null = null;
  private fatalReported = false;
  private reconciled = false;
  private evidenceObservation = false;
  private observationCompleted = false;
  private observationAttempts = 0;
  private wakePending = false;
  private nextRecoveryDeadline: number | null = null;

  constructor(private readonly options: ConfigurationRecoveryRunnerOptions) {
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  async start(): Promise<void> {
    await this.wake();
  }

  wake(observeOwner = false): Promise<RecoveryTaskResult> | undefined {
    if (this.stopped) return this.task ?? undefined;
    if (observeOwner && !this.evidenceObservation) {
      // A new owner-evidence request (or the first one) must run even when a task is
      // in flight. Repeating the same request from the observer pass is not a new one.
      this.evidenceObservation = true;
      this.observationAttempts = 0;
      this.wakePending = true;
    } else if (!observeOwner) {
      this.wakePending = true;
    }
    if (this.task !== null) return this.task;
    return this.queueTask();
  }

  private queueTask(): Promise<RecoveryTaskResult> {
    this.wakePending = false;
    this.timer?.cancel();
    this.timer = null;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const queued = this.options.publicationTasks.enqueueRecovery(() =>
      this.execute(generation, controller.signal));
    const task = queued.then((result) => {
      if (result.kind === 'fatal') this.reportFatal(result.error);
      return result;
    }).finally(() => {
      if (this.task === task) this.task = null;
      if (this.wakePending && !this.stopped) this.queueTask();
    });
    this.task = task;
    return task;
  }

  async requestManualRecovery(
    recoveryId: string, sourceMutationId: string, expectedRevision: number,
  ): Promise<ConfigurationRecovery> {
    if (this.stopped) throw new Error('configuration recovery runner is stopped');
    const recovery = await this.options.repository.createManualRecovery(
      recoveryId, sourceMutationId, expectedRevision, this.options.now(),
    );
    this.wake();
    return recovery;
  }

  stopAccepting(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.controller?.abort('master recovery stopped');
    this.controller = null;
    this.timer?.cancel();
    this.timer = null;
    this.evidenceObservation = false;
    this.wakePending = false;
    this.nextRecoveryDeadline = null;
  }

  async stop(): Promise<void> {
    this.stopAccepting();
    await this.task;
  }

  private scheduleNext(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.stopped || this.wakePending) return;
    const now = this.options.now();
    let delay: number | null = null;
    if (this.evidenceObservation) {
      // Owner evidence is capped and never exhausted. A live normal deadline may run
      // earlier, but an expired normal deadline must not spin while the owner is held.
      const index = Math.min(Math.max(this.observationAttempts - 1, 0), BACKOFF_MS.length - 1);
      delay = BACKOFF_MS[index]!;
      if (this.nextRecoveryDeadline !== null && this.nextRecoveryDeadline > now) {
        delay = Math.min(delay, this.nextRecoveryDeadline - now);
      }
    } else if (this.nextRecoveryDeadline !== null) {
      delay = Math.max(0, this.nextRecoveryDeadline - now);
    }
    if (delay === null) return;
    const generation = this.generation;
    let ownTimer!: RecoveryTimer;
    ownTimer = this.scheduler.schedule(delay, () => {
      if (this.timer !== ownTimer) return;
      this.timer = null;
      if (!this.stopped && generation === this.generation) this.wake();
    });
    this.timer = ownTimer;
  }

  private async run(generation: number, signal: PublicationCancellationSignal): Promise<RecoveryTaskResult> {
    if (this.stopped || generation !== this.generation) return { kind: 'complete' };
    let recovery = await this.options.repository.getCurrentRecovery();
    if (recovery !== null && recovery.state === 'stopped'
      && recovery.final_reason_code === 'safety_outcome_unknown') {
      // The stopped safety-unknown barrier stays closed; observation never bypasses it.
      this.evidenceObservation = false;
      return { kind: 'complete' };
    }
    if (this.evidenceObservation) {
      const observed = await this.observeHeldOwner(generation, signal);
      if (observed !== null) return observed;
      recovery = await this.options.repository.getCurrentRecovery();
      if (recovery !== null && recovery.state === 'stopped'
        && recovery.final_reason_code === 'safety_outcome_unknown') return { kind: 'complete' };
    }
    if (recovery === null) return { kind: 'complete' };
    if (recovery.state === 'succeeded' || recovery.state === 'stopped') return { kind: 'complete' };
    this.reconciled = true;
    const current = this.options.repository.getSnapshot();
    if (recovery.target_revision !== current.revision) {
      if (revisionServing(this.options.admission.snapshot(), recovery.target_revision, this.options.workerCount)) {
        await this.options.repository.succeedRecovery(recovery.recovery_id, recovery.attempt_count,
          'target_serving', 'target revision is serving after a newer save', this.options.now());
      } else if ((await this.options.repository.getUnsettledWorkerLaunches()).length > 0) {
        // A superseded target whose attempt may still be alive must be proven gone
        // before releasing the barrier; keep the real barrier and let a late signed
        // cleanup settle it instead of terminalizing while cleanup is in flight.
        return this.deferSupersededDebt(recovery);
      } else {
        await this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
          'revision_superseded', 'recovery target revision is not serving and was superseded', this.options.now());
      }
      return { kind: 'complete' };
    }
    if (recovery.state === 'running') {
      if (recovery.attempt_count >= recovery.max_attempts) {
        await this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
          'retry_exhausted', 'recovery attempt limit reached', this.options.now());
        return { kind: 'complete' };
      }
      recovery = await this.options.repository.requeueRecovery(recovery.recovery_id, recovery.attempt_count, this.options.now());
    }
    if (recovery.next_retry_at !== null && recovery.next_retry_at > this.options.now()) {
      this.nextRecoveryDeadline = recovery.next_retry_at;
      return { kind: 'complete' };
    }
    const preClaimAdmission = this.options.admission.snapshot();
    if (identityMatches(preClaimAdmission, current, this.options.pluginCatalogHash, this.options.workerCount)) {
      const reason = recovery.attempt_count === 0 ? 'already_serving' : 'target_serving';
      await this.options.repository.succeedRecovery(recovery.recovery_id, recovery.attempt_count,
        reason, 'target admission already serves the recovery revision', this.options.now());
      return { kind: 'complete' };
    }
    const claimed = await this.options.repository.claimRecoveryAttempt(
      recovery.recovery_id, recovery.attempt_count, this.options.now(),
    );
    const snapshot = this.options.repository.getSnapshot();
    if (snapshot.revision !== claimed.target_revision) {
      if (revisionServing(this.options.admission.snapshot(), claimed.target_revision, this.options.workerCount)) {
        await this.options.repository.succeedRecovery(claimed.recovery_id, claimed.attempt_count,
          'target_serving', 'target revision is serving after a newer save', this.options.now());
      } else if ((await this.options.repository.getUnsettledWorkerLaunches()).length > 0) {
        return this.deferSupersededDebt(claimed);
      } else {
        await this.options.repository.stopRecovery(claimed.recovery_id, claimed.attempt_count,
          'revision_superseded', 'recovery target revision is not serving and was superseded', this.options.now());
      }
      return { kind: 'complete' };
    }
    const oldWorkers = this.options.admission.snapshot();
    if (identityMatches(oldWorkers, snapshot, this.options.pluginCatalogHash, this.options.workerCount)) {
      await this.options.repository.succeedRecovery(claimed.recovery_id, claimed.attempt_count,
        'target_serving', 'target admission already serves the recovery revision', this.options.now());
      return { kind: 'complete' };
    }
    try {
      const outcome = await this.options.coordinator.startCurrent(snapshot, [], oldWorkers, signal, claimed.recovery_id);
      const exactTarget = 'serving' in outcome
        && identityMatches(outcome.serving, snapshot, this.options.pluginCatalogHash, this.options.workerCount);
      const classification = classifyStartupOutcome(outcome, exactTarget);
      if (classification.kind === 'fatal') {
        return this.stopFatal(claimed, 'safety_outcome_unknown', 'startup outcome is unknown', classification.error);
      }
      if (!this.isCurrent(generation)) {
        if (classification.kind === 'success') {
          await this.options.repository.succeedRecovery(claimed.recovery_id, claimed.attempt_count,
            classification.reason, 'target revision is serving', this.options.now());
        } else if (classification.kind === 'deterministic') {
          await this.options.repository.stopRecovery(claimed.recovery_id, claimed.attempt_count,
            classification.reason, detail(outcome), this.options.now());
        } else if (this.stopped) {
          return this.requeueOrExhaust(claimed, 'recovery cancelled during shutdown');
        }
        return { kind: 'complete' };
      }
      switch (classification.kind) {
        case 'success':
          await this.options.repository.succeedRecovery(claimed.recovery_id, claimed.attempt_count,
            classification.reason, 'target revision is serving', this.options.now());
          return { kind: 'complete' };
        case 'deterministic':
          await this.options.repository.stopRecovery(claimed.recovery_id, claimed.attempt_count,
            classification.reason, detail(outcome), this.options.now());
          return { kind: 'complete' };
        case 'retryable':
          return this.retryOrExhaust(claimed, detail(outcome));
        default: {
          const unhandled: never = classification;
          return unhandled;
        }
      }
    } catch (error) {
      if (isPublicationCancelled(error)) {
        if ((error as { readonly commitMayHaveBeenSent?: boolean }).commitMayHaveBeenSent === true) {
          return this.stopFatal(claimed, 'safety_outcome_unknown', 'publication outcome is unknown', error);
        }
        if (this.stopped) return this.requeueOrExhaust(claimed, 'recovery cancelled during shutdown');
      }
      const commitMayHaveBeenSent = (error as { readonly commitMayHaveBeenSent?: boolean }).commitMayHaveBeenSent === true;
      if (this.stopped) {
        if (commitMayHaveBeenSent) return this.stopFatal(claimed, 'safety_outcome_unknown', 'publication outcome is unknown', error);
        return this.requeueOrExhaust(claimed, 'recovery cancelled during shutdown');
      }
      if (classifyRecoveryError(error) === 'fatal') {
        return this.stopFatal(claimed, 'safety_outcome_unknown', 'recovery failed before outcome was known', error);
      }
      return this.retryOrExhaust(claimed, detail(error));
    }
  }

  private async execute(
    generation: number, signal: PublicationCancellationSignal,
  ): Promise<RecoveryTaskResult> {
    this.reconciled = false;
    this.observationCompleted = false;
    this.nextRecoveryDeadline = null;
    let result: RecoveryTaskResult;
    try {
      result = await this.run(generation, signal);
    } catch (error) {
      try {
        const active = await this.options.repository.getCurrentRecovery();
        if (active !== null && active.state === 'running' && active.attempt_count > 0) {
          result = await this.stopFatal(active, 'safety_outcome_unknown',
            'recovery runner failed with an unknown outcome', error);
        } else {
          result = { kind: 'fatal', error: error instanceof Error ? error : new Error(String(error)) };
        }
      } catch {
        // Preserve the original fatal when recovery storage itself is unavailable.
        result = { kind: 'fatal', error: error instanceof Error ? error : new Error(String(error)) };
      }
    }
    if (result.kind === 'complete' && (this.reconciled || this.observationCompleted) && !this.stopped) {
      this.options.onRecovered?.();
      this.options.publicationTasks.wake();
    }
    this.scheduleNext();
    return result;
  }

  /**
   * Keep a held cancelled pre-prepare or draining owner progressing even without a
   * recovery row; reuse the coordinator's evidence checks and permitted recovery.
   */
  private async observeHeldOwner(
    generation: number, signal: PublicationCancellationSignal,
  ): Promise<RecoveryTaskResult | null> {
    if (!this.isCurrent(generation)) return { kind: 'complete' };
    let active: ActiveConfigurationPublication | null;
    try { active = await this.options.repository.getActivePublication(); }
    catch (error) {
      this.evidenceObservation = false;
      return { kind: 'fatal', error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (!this.isCurrent(generation)) return { kind: 'complete' };
    const heldOwner = active !== null && (
      (active.operation.cancel_requested === true && active.operation.prepare_started === false)
      || active.operation.prepare_started || active.operation.state === 'draining');
    if (!heldOwner) {
      this.evidenceObservation = false;
      if (active === null) this.observationCompleted = true;
      return null;
    }
    let outcome: MasterPublicationOutcome | null;
    try { outcome = await this.options.coordinator.recoverAndPublish(signal); }
    catch (error) {
      if (isPublicationCancelled(error)) return { kind: 'complete' };
      this.evidenceObservation = false;
      return { kind: 'fatal', error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (!this.isCurrent(generation)) return { kind: 'complete' };
    if (outcome === null) {
      this.evidenceObservation = false;
      this.observationCompleted = true;
      return null;
    }
    if (outcome.kind === 'outcome_unknown') {
      if (outcome.fatal) {
        this.evidenceObservation = false;
        return { kind: 'fatal', error: outcome.error instanceof Error ? outcome.error : new Error(outcome.code) };
      }
      if (outcome.code === 'control_recovering') {
        this.observationAttempts += 1;
        return { kind: 'complete' };
      }
      this.evidenceObservation = false;
      return null;
    }
    if (outcome.kind === 'degraded' && outcome.recovery_disposition === 'fatal') {
      this.evidenceObservation = false;
      return { kind: 'fatal', error: new Error('held publication owner reported a fatal degraded outcome') };
    }
    this.evidenceObservation = false;
    this.observationCompleted = true;
    return null;
  }

  /**
   * Keeps the global barrier while a superseded recovery's old launch debt is still
   * unproven. Reuses the existing backoff; never terminalizes into a fake release.
   */
  private async deferSupersededDebt(recovery: ConfigurationRecovery): Promise<RecoveryTaskResult> {
    if (recovery.state === 'scheduled') {
      this.nextRecoveryDeadline = recovery.next_retry_at;
      return { kind: 'complete' };
    }
    if (recovery.state !== 'running') return { kind: 'complete' };
    if (recovery.attempt_count >= recovery.max_attempts) {
      return this.stopFatal(recovery, 'safety_outcome_unknown',
        'superseded recovery target has unproven candidate exit',
        new Error('recovery target was superseded with unsettled worker launches'));
    }
    const delay = BACKOFF_MS[recovery.attempt_count] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    const now = this.options.now();
    if (now > Number.MAX_SAFE_INTEGER - delay) {
      return this.stopFatal(recovery, 'safety_outcome_unknown',
        'superseded recovery retry timestamp would overflow',
        new Error('recovery retry timestamp would overflow'));
    }
    const scheduled = await this.options.repository.scheduleRecoveryRetry(
      recovery.recovery_id, recovery.attempt_count, now + delay, now,
    );
    this.nextRecoveryDeadline = scheduled.next_retry_at;
    return { kind: 'complete' };
  }

  private async retryOrExhaust(recovery: ConfigurationRecovery, reason: string): Promise<RecoveryTaskResult> {
    if (recovery.attempt_count >= recovery.max_attempts) {
      await this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
        'retry_exhausted', reason, this.options.now());
      return { kind: 'complete' };
    }
    const delay = BACKOFF_MS[recovery.attempt_count] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    const now = this.options.now();
    if (now > Number.MAX_SAFE_INTEGER - delay) {
      return this.stopFatal(recovery, 'safety_outcome_unknown', 'recovery retry timestamp would overflow', new Error('recovery retry timestamp would overflow'));
    }
    const scheduled = await this.options.repository.scheduleRecoveryRetry(
      recovery.recovery_id, recovery.attempt_count, now + delay, now,
    );
    this.nextRecoveryDeadline = scheduled.next_retry_at;
    return { kind: 'complete' };
  }

  private async requeueOrExhaust(recovery: ConfigurationRecovery, reason: string): Promise<RecoveryTaskResult> {
    if (recovery.attempt_count >= recovery.max_attempts) {
      await this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
        'retry_exhausted', reason, this.options.now());
      return { kind: 'complete' };
    }
    await this.options.repository.requeueRecovery(recovery.recovery_id, recovery.attempt_count, this.options.now());
    return { kind: 'complete' };
  }

  private async stopFatal(
    recovery: ConfigurationRecovery, code: 'safety_outcome_unknown', reason: string, error: unknown,
  ): Promise<RecoveryTaskResult> {
    await this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count, code, reason, this.options.now());
    return { kind: 'fatal', error: error instanceof Error ? error : new Error(reason) };
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private reportFatal(error: Error): void {
    if (this.fatalReported) return;
    this.fatalReported = true;
    this.stopAccepting();
    this.options.onFatal(error);
  }
}
