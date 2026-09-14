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
import type { AdmissionSet } from '../ingress/admission-set';
import type { WorkerUnavailableEvidence } from './supervised-worker-process-adapter';
import type { PublicationCancellationSignal } from '../config-publication/publication-runner';
import type { MasterIngressStartupFailureDisposition } from '../ingress/master-controller';

export interface MasterRuntimeRepository {
  getSnapshot(): RepositorySnapshot;
  close(): void;
}

export interface MasterRuntimeCoordinator {
  recoverAndPublish(): Promise<MasterPublicationOutcome | null>;
  startCurrent(
    snapshot: RepositorySnapshot,
    existingWorkers?: readonly ServingConfigWorker[],
    retireWorkers?: readonly ServingConfigWorker[],
    signal?: PublicationCancellationSignal,
  ): Promise<StartupPublicationOutcome>;
}

export interface MasterRuntimeAdmission {
  prepare(workers: readonly ServingConfigWorker[], signal?: AbortSignal): Promise<PreparedWorkerAdmission>;
  adoptCommitted(workers: readonly ServingConfigWorker[], remote: AdmissionSet): void;
  snapshot(): readonly ServingConfigWorker[];
  clear(): void;
}

export interface MasterRuntimePublicListener {
  readonly port: number | null;
  readonly hostname?: string | null;
  start(): void;
  stopAccepting?(): void;
  stop(): Promise<void>;
}

export type MasterRuntimeWorkerExitListener = (
  process: ConfigPublicationWorkerProcess,
  evidence: WorkerExitEvidence,
) => void;

export type MasterRuntimeWorkerUnavailableListener = (
  process: ConfigPublicationWorkerProcess,
  evidence: WorkerUnavailableEvidence,
) => void;

export interface MasterRuntimeWorkerPool {
  pids(): readonly number[];
  owns(process: ConfigPublicationWorkerProcess): boolean;
  subscribeExit(listener: MasterRuntimeWorkerExitListener): () => void;
  subscribeUnavailable(listener: MasterRuntimeWorkerUnavailableListener): () => void;
  readonly subscribeEligibilityChange?: (listener: () => void) => () => void;
  markCommitted(processes: readonly ConfigPublicationWorkerProcess[]): void;
  disconnectAll(): void;
  shutdownAll(): Promise<readonly ProcessCleanupResult[]>;
}

export type MasterRuntimeIngressBootRecoveryGate = {
  readonly generation: number;
  readonly isCurrent: (generation: number) => boolean;
  readonly signal: AbortSignal;
  readonly subscribeReleased: (generation: number, listener: () => void) => () => void;
};

export interface MasterRuntimeInstanceLock {
  release(): Promise<void>;
}

export interface MasterRuntimeAncillary {
  /** Stops recovery/publication work before any asynchronous cleanup begins. */
  beforeCleanup?(): void | Promise<void>;
  beforeStop?(): void | Promise<void>;
  cleanupAfterStartupFailure?(): MasterIngressStartupFailureDisposition
    | Promise<MasterIngressStartupFailureDisposition>;
  closeForNormalShutdown?(): void | Promise<void>;
}

export type MasterRuntimeReadOnlyRecovery = () => boolean;

export type MasterRuntimeOptions = {
  readonly workerCount: number;
  readonly expectedPluginCatalogHash: string;
  readonly repository: MasterRuntimeRepository;
  readonly coordinator: MasterRuntimeCoordinator;
  readonly publicationTasks: PublicationTaskLifecycle;
  readonly admission: MasterRuntimeAdmission;
  readonly publicListener: MasterRuntimePublicListener;
  readonly workerPool: MasterRuntimeWorkerPool;
  readonly ingressBootRecoveryGate?: MasterRuntimeIngressBootRecoveryGate;
  /** Synchronously cancels startup recovery before an asynchronous failure can unblock startup. */
  readonly stopAcceptingRecovery?: () => void;
  readonly startupServing?: () => readonly ServingConfigWorker[] | null;
  readonly canReconcileStartup?: () => boolean;
  readonly onWorkerUnavailable: MasterRuntimeWorkerUnavailableListener;
  readonly instanceLock: MasterRuntimeInstanceLock;
  /** Resources that must close after the management listener drains, even on startup failure. */
  readonly alwaysClose?: () => void | Promise<void>;
  /** Cleans only this master's uncommitted workers after startup failure. */
  readonly cleanupWorkersAfterStartupFailure?: (disposition?: MasterIngressStartupFailureDisposition) => void | Promise<void>;
  readonly ancillary?: MasterRuntimeAncillary;
  readonly allowReadOnlyRecovery?: MasterRuntimeReadOnlyRecovery;
  readonly pluginControlBridge?: { dispose(): void };
  readonly pluginControlSubscriptions?: () => void;
  readonly pluginControl?: {
    reconcile(activeNames: readonly string[]): Promise<void>;
    dispose(): Promise<void>;
  };
  readonly onFatal?: (error: Error) => void | Promise<void>;
};

export type MasterRuntimeErrorCode =
  | 'invalid_options'
  | 'invalid_state'
  | 'startup_incomplete'
  | 'startup_cancelled'
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
