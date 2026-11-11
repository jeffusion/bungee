import type { ActiveConfigurationPublication, RepositorySnapshot } from '../config-storage/repository-types';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { randomUUID } from 'node:crypto';
import { validateDigest } from '../config-storage/repository-validation';
import {
  MasterConfigPublicationError,
  type ConfigPublicationRepository,
  type ConfigPublicationWorkerFactory,
  type MasterPublicationOutcome,
  type PublicationClock,
  type PublicationScheduler,
  type ServingConfigWorker,
  type StartupPublicationOutcome,
  type PreparedWorkerAdmission,
  type WorkerAdmissionController,
} from './coordinator-types';
import { OwnedProcessCollection } from './process-cleanup';
import { isPublicationCancelled, runPublication } from './publication-runner';
import { publicationIdentity, snapshotMessage } from './message-fields';
import { ProcessIdentityAllocator, validateProcessSet } from './process-identity';
import { runCurrentStartup } from './current-startup';
import type { PublicationCancellationSignal } from './publication-runner';

const DEFAULT_SCHEDULER: PublicationScheduler = {
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => { clearTimeout(handle); } };
  },
};
const SERVING_WORKER_FIELDS = [
  'process', 'revision', 'content_hash', 'plugin_catalog_hash', 'private_port', 'publication',
] as const;

export type MasterConfigPublicationCoordinatorOptions = {
  readonly repository: ConfigPublicationRepository;
  readonly workerFactory: ConfigPublicationWorkerFactory;
  readonly workerCount: number;
  readonly clock: PublicationClock;
  readonly scheduler?: PublicationScheduler;
  readonly startupApplyTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly pluginCatalogHash: Sha256Digest;
  readonly admission: WorkerAdmissionController;
  readonly masterGeneration?: string;
  readonly createWorkerInstanceId?: () => string;
  readonly recoverPreviousServingWorkers?: (active: ActiveConfigurationPublication) => Promise<readonly ServingConfigWorker[]>;
  readonly recoverRetiredWorkers?: (active: ActiveConfigurationPublication) => Promise<readonly ServingConfigWorker[]>;
  readonly recoverActiveServingWorkers?: (active: ActiveConfigurationPublication) => Promise<{
    readonly workers: readonly ServingConfigWorker[]; readonly admission: import('./coordinator-types').PreparedWorkerAdmission;
  } | null>;
  readonly confirmPreviousWorkersExited?: (replacements: readonly ServingConfigWorker[]) => Promise<boolean>;
  /**
   * Shared creation gate for every real fork. It runs inside the serialized
   * publication/recovery queue, settles debt-only, re-reads fresh authority and
   * returns false without creating anything when capacity or proof is unknown.
   */
  readonly ensureCreationPermitted: () => Promise<import('./coordinator-types').CreationPermit>;
};

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MasterConfigPublicationError('invalid_options', `${name} must be a positive safe integer`);
  }
}

function exactTargets(active: ActiveConfigurationPublication, workerCount: number): boolean {
  return active.targets.length === workerCount
    && active.targets.every(({ worker_slot }, index) => worker_slot === index);
}

export class MasterConfigPublicationCoordinator {
  private readonly scheduler: PublicationScheduler;
  private readonly identities: ProcessIdentityAllocator;
  private leased = false;

  constructor(private readonly options: MasterConfigPublicationCoordinatorOptions) {
    requirePositiveSafeInteger(options.workerCount, 'workerCount');
    requirePositiveSafeInteger(options.startupApplyTimeoutMs, 'startupApplyTimeoutMs');
    requirePositiveSafeInteger(options.drainTimeoutMs, 'drainTimeoutMs');
    if (!validateDigest(options.pluginCatalogHash)) {
      throw new MasterConfigPublicationError('invalid_options', 'pluginCatalogHash must be a SHA-256 digest');
    }
    this.identities = new ProcessIdentityAllocator(
      options.masterGeneration ?? randomUUID(),
      options.workerCount,
      options.createWorkerInstanceId ?? randomUUID,
    );
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  private acquire(): void {
    if (this.leased) {
      throw new MasterConfigPublicationError('concurrent_publication', 'a coordinator call is already running');
    }
    this.leased = true;
  }

  private release(): void {
    this.leased = false;
  }

  private validateServingWorkers(workers: readonly ServingConfigWorker[]): void {
    try {
      if (!Array.isArray(workers)) {
        throw new MasterConfigPublicationError('invalid_options', 'serving worker evidence must be an array');
      }
      for (const worker of workers) {
        const descriptors = Object.getOwnPropertyDescriptors(worker);
        for (const field of SERVING_WORKER_FIELDS) {
          const descriptor = descriptors[field];
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new MasterConfigPublicationError('invalid_options', 'serving worker evidence is invalid');
          }
        }
        if (!Number.isSafeInteger(worker.revision) || worker.revision <= 0
          || typeof worker.content_hash !== 'string' || !validateDigest(worker.content_hash)
          || typeof worker.plugin_catalog_hash !== 'string' || !validateDigest(worker.plugin_catalog_hash)
          || worker.plugin_catalog_hash !== this.options.pluginCatalogHash
          || !Number.isSafeInteger(worker.private_port)
          || worker.private_port <= 0 || worker.private_port > 65_535) {
          throw new MasterConfigPublicationError('invalid_options', 'serving worker evidence is invalid');
        }
        if (worker.publication !== null) {
          const root = snapshotMessage({ publication: worker.publication });
          publicationIdentity(root.publication, 'publication');
        }
      }
      validateProcessSet(workers, this.identities.masterGeneration, this.options.workerCount);
    } catch (error) {
      if (error instanceof MasterConfigPublicationError) throw error;
      throw new MasterConfigPublicationError('invalid_options', 'serving worker evidence is invalid');
    }
  }

  async startCurrent(
    snapshot: RepositorySnapshot,
    existingWorkers: readonly ServingConfigWorker[] = [],
    retireWorkers: readonly ServingConfigWorker[] = [],
    signal?: PublicationCancellationSignal,
  ): Promise<StartupPublicationOutcome> {
    this.acquire();
    try {
      this.validateServingWorkers(existingWorkers);
      this.validateServingWorkers(retireWorkers);
      this.identities.register(existingWorkers);
      this.identities.register(retireWorkers);
      return await runCurrentStartup({ workerFactory: this.options.workerFactory,
        workerCount: this.options.workerCount,
        scheduler: this.scheduler, applyTimeoutMs: this.options.startupApplyTimeoutMs,
        drainTimeoutMs: this.options.drainTimeoutMs, identities: this.identities,
        pluginCatalogHash: this.options.pluginCatalogHash, admission: this.options.admission, retireWorkers, signal,
        ensureCreationPermitted: this.options.ensureCreationPermitted },
      snapshot, existingWorkers);
    } finally {
      this.release();
    }
  }

  async publish(
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
    signal?: PublicationCancellationSignal,
    updateSignal?: AbortSignal,
  ): Promise<MasterPublicationOutcome> {
    this.acquire();
    try {
      this.validateServingWorkers(oldWorkers);
      return await this.runPublish(active, oldWorkers, signal, updateSignal);
    } finally {
      this.release();
    }
  }

  async publishPrepared(
    snapshot: RepositorySnapshot, mutationId: string, oldWorkers: readonly ServingConfigWorker[],
    commit: (workers: readonly ServingConfigWorker[]) => Promise<ActiveConfigurationPublication | null>,
    signal?: PublicationCancellationSignal,
  ): Promise<StartupPublicationOutcome | MasterPublicationOutcome> {
    this.acquire();
    try {
      this.validateServingWorkers(oldWorkers);
      this.identities.register(oldWorkers);
      let outcome: MasterPublicationOutcome | null = null;
      const startup = await runCurrentStartup({
        workerFactory: this.options.workerFactory, workerCount: this.options.workerCount, scheduler: this.scheduler,
        applyTimeoutMs: this.options.startupApplyTimeoutMs, drainTimeoutMs: this.options.drainTimeoutMs,
        identities: this.identities, pluginCatalogHash: this.options.pluginCatalogHash, admission: this.options.admission,
        retireWorkers: oldWorkers, signal, ensureCreationPermitted: this.options.ensureCreationPermitted,
        prospective: {
          publication: { mutation_id: mutationId, attempt_no: 1, drain_recovery_generation: 0 },
          publish: async (workers, admission) => {
            const active = await commit(workers);
            if (active === null) return false;
            try {
              outcome = await this.runPublish(active, oldWorkers, signal, undefined, { workers, admission });
            } catch (error) {
              if (!isPublicationCancelled(error)) throw error;
              // The publication runner owns the cohort from here, including uncertain cutover.
              outcome = { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
                error, serving: oldWorkers, pending: [] };
            }
            return true;
          },
        },
      }, snapshot, []);
      return outcome ?? startup;
    } finally {
      this.release();
    }
  }

  private runPublish(
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
    signal?: PublicationCancellationSignal,
    updateSignal?: AbortSignal,
    preparedCandidate?: { readonly workers: readonly ServingConfigWorker[]; readonly admission: PreparedWorkerAdmission },
  ): Promise<MasterPublicationOutcome> {
    if (!exactTargets(active, this.options.workerCount)) {
      return Promise.reject(new MasterConfigPublicationError(
        'target_set_mismatch', 'durable target worker slots do not match coordinator slots',
      ));
    }
    this.identities.register(oldWorkers);
    return runPublication({ repository: this.options.repository, workerFactory: this.options.workerFactory,
      clock: this.options.clock, scheduler: this.scheduler,
      applyTimeoutMs: this.options.startupApplyTimeoutMs, drainTimeoutMs: this.options.drainTimeoutMs,
      identities: this.identities, oldWorkers, owned: new OwnedProcessCollection(),
      pluginCatalogHash: this.options.pluginCatalogHash, admission: this.options.admission,
      latestRevision: () => this.options.repository.getSnapshot().revision,
      recoveringMaster: false, signal, updateSignal, preparedCandidate,
      ensureCreationPermitted: this.options.ensureCreationPermitted }, active, oldWorkers);
  }

  async recoverAndPublish(signal?: PublicationCancellationSignal): Promise<MasterPublicationOutcome | null> {
    this.acquire();
    try {
      let active: ActiveConfigurationPublication | null;
      try {
        active = this.options.repository.claimPublicationTarget === undefined
          ? await this.options.repository.getActivePublication()
          : await this.options.repository.claimPublicationTarget(this.options.pluginCatalogHash, this.options.clock.now());
      }
      catch (error) {
        const code = (error as { readonly code?: unknown }).code;
        if (code === 'recovery_in_progress' || code === 'invalid_operation') {
          return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
            error, serving: [], pending: [] };
        }
        return { kind: 'outcome_unknown', fatal: true, code: 'repository_failure', error,
          serving: [], pending: [] };
      }
      if (active === null) return null;
      if (!exactTargets(active, this.options.workerCount)) {
        throw new MasterConfigPublicationError(
          'target_set_mismatch', 'durable target worker slots do not match coordinator slots',
        );
      }
      // A crash before prepare may leave only pre-ready attempt allocations with no
      // frozen serving set. They still occupy candidates and must be settled first.
      const outstanding = await (this.options.repository as typeof this.options.repository & {
        getOutstandingPublicationCandidates?: () => Promise<readonly { readonly mutation_id: string; readonly attempt_no: number }[]>;
      }).getOutstandingPublicationCandidates?.() ?? [];
      const hasPriorAttempts = outstanding.some(item =>
        item.mutation_id === active!.operation.mutation_id && item.attempt_no > 0);
      if (active.operation.cancel_requested) {
        // Recovery only settles the already-requested cancellation; it never starts a
        // new attempt or resumes publication.
        let exited: boolean;
        try { exited = await this.options.workerFactory.confirmActivePublicationExited?.(active) === true; }
        catch { exited = false; }
        if (!exited) {
          return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
            error: new Error('cancelled publication candidates are not settled'), serving: [], pending: [] };
        }
        try {
          const confirmed = await this.options.repository.confirmPublicationCandidateExited?.(
            active.operation.mutation_id, active.operation.committed_revision, this.options.clock.now());
          if (confirmed === undefined) {
            return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
              error: new Error('cancelled publication confirmation is unavailable'), serving: [], pending: [] };
          }
          return { kind: 'superseded', operation: confirmed, serving: [] };
        } catch (error) {
          return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
            error, serving: [], pending: [] };
        }
      }
      const recoveredActive = await this.options.recoverActiveServingWorkers?.(active) ?? undefined;
      if (recoveredActive !== undefined && (recoveredActive.workers.length !== this.options.workerCount
        || recoveredActive.workers.some(worker => worker.revision !== active.snapshot.revision
          || worker.content_hash !== active.snapshot.content_hash || worker.plugin_catalog_hash !== this.options.pluginCatalogHash
          || worker.publication?.mutation_id !== active.operation.mutation_id
          || worker.publication.attempt_no !== active.targets.find(target => target.worker_slot === worker.process.slot)?.attempt_no
          || worker.publication.drain_recovery_generation !== active.operation.drain_recovery_generation))) {
        return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
          error: new Error('recovered active serving does not match the durable publication attempts'), serving: [], pending: [] };
      }
      const authority = recoveredActive === undefined
        ? await this.options.repository.getPublicationServingSet?.(active.operation.mutation_id, active.operation.drain_recovery_generation) ?? null : null;
      const requiresPriorExit = active.operation.state === 'draining' || authority !== null || hasPriorAttempts;
      const priorAttemptExited = recoveredActive === undefined && requiresPriorExit
        && await this.options.workerFactory.confirmActivePublicationExited?.(active) === true;
      const oldWorkers = recoveredActive !== undefined || active.operation.state === 'draining'
        ? await this.options.recoverRetiredWorkers?.(active) ?? []
        : await this.options.recoverPreviousServingWorkers?.(active) ?? [];
      if (recoveredActive === undefined && requiresPriorExit && !priorAttemptExited) {
        return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
          error: new Error('prior publication attempt lifetime proof remains stopped'), serving: oldWorkers, pending: [] };
      }
      return await runPublication({ repository: this.options.repository,
        workerFactory: this.options.workerFactory, clock: this.options.clock, scheduler: this.scheduler,
        applyTimeoutMs: this.options.startupApplyTimeoutMs, drainTimeoutMs: this.options.drainTimeoutMs,
        identities: this.identities, oldWorkers, owned: new OwnedProcessCollection(),
        pluginCatalogHash: this.options.pluginCatalogHash, admission: this.options.admission,
        latestRevision: () => this.options.repository.getSnapshot().revision,
        recoveringMaster: true, recoveredActive, priorAttemptExited, confirmPreviousWorkersExited: this.options.confirmPreviousWorkersExited, signal,
        ensureCreationPermitted: this.options.ensureCreationPermitted }, active, oldWorkers);
    } finally {
      this.release();
    }
  }
}
