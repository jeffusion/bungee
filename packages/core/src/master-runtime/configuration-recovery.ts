import type { Sha256Digest } from '@jeffusion/bungee-types';
import type {
  ConfigurationRecovery,
  ConfigurationRecoveryReasonCode,
  RepositorySnapshot,
} from '../config-storage/repository-types';
import type {
  ServingConfigWorker,
} from '../config-publication/coordinator-types';
import { classifyRecoveryError, classifyStartupOutcome } from '../config-publication/recovery-disposition';
import { isPublicationCancelled, type PublicationCancellationSignal } from '../config-publication/publication-runner';
import type { MasterProcessCoordinator } from './composition';
import type { PublicationTaskLifecycle, RecoveryTaskResult } from './publication-task-manager';

const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

type RecoveryRepository = {
  getSnapshot(): RepositorySnapshot;
  getCurrentRecovery(): ConfigurationRecovery | null;
  createManualRecovery(
    recoveryId: string, sourceMutationId: string, expectedRevision: number, now: number,
  ): ConfigurationRecovery;
  claimRecoveryAttempt(recoveryId: string, previousAttemptCount: number, now: number): ConfigurationRecovery;
  scheduleRecoveryRetry(
    recoveryId: string, attemptCount: number, nextRetryAt: number, now: number,
  ): ConfigurationRecovery;
  succeedRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): ConfigurationRecovery;
  stopRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): ConfigurationRecovery;
  requeueRecovery(recoveryId: string, attemptCount: number, now: number): ConfigurationRecovery;
};

type RecoveryTimer = { cancel(): void };

export type ConfigurationRecoveryScheduler = {
  schedule(delayMs: number, callback: () => void): RecoveryTimer;
};

export type ConfigurationRecoveryRunnerOptions = {
  readonly repository: RecoveryRepository;
  readonly publicationTasks: PublicationTaskLifecycle;
  readonly coordinator: Pick<MasterProcessCoordinator, 'startCurrent'>;
  readonly admission: { snapshot(): readonly ServingConfigWorker[] };
  readonly workerCount: number;
  readonly pluginCatalogHash: Sha256Digest;
  readonly now: () => number;
  readonly scheduler?: ConfigurationRecoveryScheduler;
  readonly onFatal: (error: Error) => void;
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

  constructor(private readonly options: ConfigurationRecoveryRunnerOptions) {
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  async start(): Promise<void> {
    await this.wake();
  }

  wake(): Promise<RecoveryTaskResult> | undefined {
    if (this.stopped || this.task !== null) return this.task ?? undefined;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const queued = this.options.publicationTasks.enqueueRecovery(() => this.execute(generation, controller.signal));
    const task = queued.then((result) => {
      if (result.kind === 'fatal') this.reportFatal(result.error);
      return result;
    }).finally(() => {
      if (this.task === task) this.task = null;
    });
    this.task = task;
    return task;
  }

  async requestManualRecovery(
    recoveryId: string, sourceMutationId: string, expectedRevision: number,
  ): Promise<ConfigurationRecovery> {
    if (this.stopped) throw new Error('configuration recovery runner is stopped');
    const recovery = this.options.repository.createManualRecovery(
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
  }

  async stop(): Promise<void> {
    this.stopAccepting();
    await this.task;
  }

  private arm(recovery: ConfigurationRecovery): void {
    if (this.stopped || recovery.state !== 'scheduled' || recovery.next_retry_at === null) return;
    this.timer?.cancel();
    const generation = this.generation;
    const delay = Math.max(0, recovery.next_retry_at - this.options.now());
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
    if (typeof this.options.repository.getCurrentRecovery !== 'function') return { kind: 'complete' };
    let recovery = this.options.repository.getCurrentRecovery();
    if (recovery === null || recovery.state === 'succeeded' || recovery.state === 'stopped') return { kind: 'complete' };
    const current = this.options.repository.getSnapshot();
    if (recovery.target_revision !== current.revision) {
      this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
        'revision_superseded', 'recovery target revision was superseded', this.options.now());
      return { kind: 'complete' };
    }
    if (recovery.state === 'running') {
      if (recovery.attempt_count >= recovery.max_attempts) {
        this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
          'retry_exhausted', 'recovery attempt limit reached', this.options.now());
        return { kind: 'complete' };
      }
      recovery = this.options.repository.requeueRecovery(recovery.recovery_id, recovery.attempt_count, this.options.now());
    }
    if (recovery.next_retry_at !== null && recovery.next_retry_at > this.options.now()) {
      this.arm(recovery);
      return { kind: 'complete' };
    }
    const preClaimAdmission = this.options.admission.snapshot();
    if (identityMatches(preClaimAdmission, current, this.options.pluginCatalogHash, this.options.workerCount)) {
      const reason = recovery.attempt_count === 0 ? 'already_serving' : 'target_serving';
      this.options.repository.succeedRecovery(recovery.recovery_id, recovery.attempt_count,
        reason, 'target admission already serves the recovery revision', this.options.now());
      return { kind: 'complete' };
    }
    const claimed = this.options.repository.claimRecoveryAttempt(
      recovery.recovery_id, recovery.attempt_count, this.options.now(),
    );
    const snapshot = this.options.repository.getSnapshot();
    if (snapshot.revision !== claimed.target_revision) {
      this.options.repository.stopRecovery(claimed.recovery_id, claimed.attempt_count,
        'revision_superseded', 'recovery target revision was superseded', this.options.now());
      return { kind: 'complete' };
    }
    const oldWorkers = this.options.admission.snapshot();
    if (identityMatches(oldWorkers, snapshot, this.options.pluginCatalogHash, this.options.workerCount)) {
      this.options.repository.succeedRecovery(claimed.recovery_id, claimed.attempt_count,
        'target_serving', 'target admission already serves the recovery revision', this.options.now());
      return { kind: 'complete' };
    }
    try {
      const outcome = await this.options.coordinator.startCurrent(snapshot, [], oldWorkers, signal);
      const exactTarget = 'serving' in outcome
        && identityMatches(outcome.serving, snapshot, this.options.pluginCatalogHash, this.options.workerCount);
      const classification = classifyStartupOutcome(outcome, exactTarget);
      if (classification.kind === 'fatal') {
        return this.stopFatal(claimed, 'safety_outcome_unknown', 'startup outcome is unknown', classification.error);
      }
      if (!this.isCurrent(generation)) {
        if (classification.kind === 'success') {
          this.options.repository.succeedRecovery(claimed.recovery_id, claimed.attempt_count,
            classification.reason, 'target revision is serving', this.options.now());
        } else if (classification.kind === 'deterministic') {
          this.options.repository.stopRecovery(claimed.recovery_id, claimed.attempt_count,
            classification.reason, detail(outcome), this.options.now());
        } else if (this.stopped) {
          return this.requeueOrExhaust(claimed, 'recovery cancelled during shutdown');
        }
        return { kind: 'complete' };
      }
      switch (classification.kind) {
        case 'success':
          this.options.repository.succeedRecovery(claimed.recovery_id, claimed.attempt_count,
            classification.reason, 'target revision is serving', this.options.now());
          return { kind: 'complete' };
        case 'deterministic':
          this.options.repository.stopRecovery(claimed.recovery_id, claimed.attempt_count,
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

  private async execute(generation: number, signal: PublicationCancellationSignal): Promise<RecoveryTaskResult> {
    try {
      return await this.run(generation, signal);
    } catch (error) {
      try {
        const active = this.options.repository.getCurrentRecovery();
        if (active !== null && active.state === 'running' && active.attempt_count > 0) {
          return this.stopFatal(active, 'safety_outcome_unknown', 'recovery runner failed with an unknown outcome', error);
        }
      } catch {
        // Preserve the original fatal when recovery storage itself is unavailable.
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      return { kind: 'fatal', error: failure };
    }
  }

  private retryOrExhaust(recovery: ConfigurationRecovery, reason: string): RecoveryTaskResult {
    if (recovery.attempt_count >= recovery.max_attempts) {
      this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
        'retry_exhausted', reason, this.options.now());
      return { kind: 'complete' };
    }
    const delay = BACKOFF_MS[recovery.attempt_count] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    const now = this.options.now();
    if (now > Number.MAX_SAFE_INTEGER - delay) {
      return this.stopFatal(recovery, 'safety_outcome_unknown', 'recovery retry timestamp would overflow', new Error('recovery retry timestamp would overflow'));
    }
    const scheduled = this.options.repository.scheduleRecoveryRetry(
      recovery.recovery_id, recovery.attempt_count, now + delay, now,
    );
    this.arm(scheduled);
    return { kind: 'complete' };
  }

  private requeueOrExhaust(recovery: ConfigurationRecovery, reason: string): RecoveryTaskResult {
    if (recovery.attempt_count >= recovery.max_attempts) {
      this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count,
        'retry_exhausted', reason, this.options.now());
      return { kind: 'complete' };
    }
    this.options.repository.requeueRecovery(recovery.recovery_id, recovery.attempt_count, this.options.now());
    return { kind: 'complete' };
  }

  private stopFatal(
    recovery: ConfigurationRecovery, code: 'safety_outcome_unknown', reason: string, error: unknown,
  ): RecoveryTaskResult {
    this.options.repository.stopRecovery(recovery.recovery_id, recovery.attempt_count, code, reason, this.options.now());
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
