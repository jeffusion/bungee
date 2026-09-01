import type {
  ConfigPublicationWorkerProcess,
  MasterPublicationOutcome,
  PreparedWorkerAdmission,
  ServingConfigWorker,
  StartupPublicationOutcome,
  WorkerExitEvidence,
} from '../config-publication/coordinator-types';
import type { ProcessCleanupResult } from '../config-publication/process-cleanup';
import type { RepositorySnapshot } from '../config-storage/repository-types';
import type { PublicationTaskLifecycle } from './publication-task-manager';

export interface MasterRuntimeRepository {
  getSnapshot(): RepositorySnapshot;
  close(): void;
}

export interface MasterRuntimeCoordinator {
  recoverAndPublish(): Promise<MasterPublicationOutcome | null>;
  startCurrent(
    snapshot: RepositorySnapshot,
    existingWorkers?: readonly ServingConfigWorker[],
  ): Promise<StartupPublicationOutcome>;
}

export interface MasterRuntimeAdmission {
  prepare(workers: readonly ServingConfigWorker[]): PreparedWorkerAdmission;
  snapshot(): readonly ServingConfigWorker[];
  clear(): void;
}

export interface MasterRuntimePublicListener {
  readonly port: number | null;
  start(): void;
  stop(): Promise<void>;
}

export type MasterRuntimeWorkerExitListener = (
  process: ConfigPublicationWorkerProcess,
  evidence: WorkerExitEvidence,
) => void;

export interface MasterRuntimeWorkerPool {
  pids(): readonly number[];
  owns(process: ConfigPublicationWorkerProcess): boolean;
  subscribeExit(listener: MasterRuntimeWorkerExitListener): () => void;
  shutdownAll(): Promise<readonly ProcessCleanupResult[]>;
}

export interface MasterRuntimeInstanceLock {
  release(): Promise<void>;
}

export interface MasterRuntimeAncillary {
  close(): void | Promise<void>;
}

export type MasterRuntimeOptions = {
  readonly workerCount: number;
  readonly repository: MasterRuntimeRepository;
  readonly coordinator: MasterRuntimeCoordinator;
  readonly publicationTasks: PublicationTaskLifecycle;
  readonly admission: MasterRuntimeAdmission;
  readonly publicListener: MasterRuntimePublicListener;
  readonly workerPool: MasterRuntimeWorkerPool;
  readonly instanceLock: MasterRuntimeInstanceLock;
  readonly ancillary?: MasterRuntimeAncillary;
  readonly onFatal?: (error: Error) => void | Promise<void>;
};

export type MasterRuntimeErrorCode =
  | 'invalid_options'
  | 'invalid_state'
  | 'startup_incomplete'
  | 'admission_mismatch'
  | 'listener_port_unavailable'
  | 'repair_failed'
  | 'publication_failed'
  | 'cleanup_failed'
  | 'worker_exit_unconfirmed';

export class MasterRuntimeError extends Error {
  readonly name = 'MasterRuntimeError';

  constructor(
    readonly code: MasterRuntimeErrorCode,
    message: string,
    readonly evidence?: unknown,
  ) {
    super(message);
  }
}
