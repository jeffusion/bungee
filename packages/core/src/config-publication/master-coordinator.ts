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
  type WorkerAdmissionController,
} from './coordinator-types';
import { OwnedProcessCollection } from './process-cleanup';
import { runPublication } from './publication-runner';
import { publicationIdentity, snapshotMessage } from './message-fields';
import { ProcessIdentityAllocator, validateProcessSet } from './process-identity';
import { runCurrentStartup } from './current-startup';

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
  ): Promise<StartupPublicationOutcome> {
    this.acquire();
    try {
      this.validateServingWorkers(existingWorkers);
      this.identities.register(existingWorkers);
      return await runCurrentStartup({ workerFactory: this.options.workerFactory,
        workerCount: this.options.workerCount,
        scheduler: this.scheduler, applyTimeoutMs: this.options.startupApplyTimeoutMs,
        drainTimeoutMs: this.options.drainTimeoutMs, identities: this.identities,
        pluginCatalogHash: this.options.pluginCatalogHash, admission: this.options.admission },
      snapshot, existingWorkers);
    } finally {
      this.release();
    }
  }

  async publish(
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
  ): Promise<MasterPublicationOutcome> {
    this.acquire();
    try {
      this.validateServingWorkers(oldWorkers);
      return await this.runPublish(active, oldWorkers);
    } finally {
      this.release();
    }
  }

  private runPublish(
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
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
      recoveringMaster: false }, active, oldWorkers);
  }

  async recoverAndPublish(): Promise<MasterPublicationOutcome | null> {
    this.acquire();
    try {
      let active: ActiveConfigurationPublication | null;
      try { active = this.options.repository.getActivePublication(); }
      catch (error) {
        return { kind: 'outcome_unknown', fatal: true, code: 'repository_failure', error,
          serving: [], pending: [] };
      }
      if (active === null) return null;
      if (!exactTargets(active, this.options.workerCount)) {
        throw new MasterConfigPublicationError(
          'target_set_mismatch', 'durable target worker slots do not match coordinator slots',
        );
      }
      const oldWorkers: readonly ServingConfigWorker[] = [];
      return await runPublication({ repository: this.options.repository,
        workerFactory: this.options.workerFactory, clock: this.options.clock, scheduler: this.scheduler,
        applyTimeoutMs: this.options.startupApplyTimeoutMs, drainTimeoutMs: this.options.drainTimeoutMs,
        identities: this.identities, oldWorkers, owned: new OwnedProcessCollection(),
        pluginCatalogHash: this.options.pluginCatalogHash, admission: this.options.admission,
        recoveringMaster: true }, active, oldWorkers);
    } finally {
      this.release();
    }
  }
}
