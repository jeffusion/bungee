import type { Sha256Digest } from '@jeffusion/bungee-types';
import type {
  ActiveConfigurationPublication,
  ConfigurationOperation,
  ConfigurationOperationWorker,
  FinalizePublicationOutcome,
  RepositorySnapshot,
  WorkerAttemptReason,
  WorkerPublicationResult,
} from '../config-storage/repository-types';
import type { ConfigMasterMessage, ConfigProcessIdentity, ConfigPublicationIdentity } from './types';

export type WorkerExitEvidence = {
  readonly exited: true;
  readonly pid: number;
};

export interface ConfigPublicationWorkerProcess {
  readonly slot: number;
  readonly identity: ConfigProcessIdentity;
  readonly pid: number;
  send(message: ConfigMasterMessage): Promise<void>;
  subscribeMessage(listener: (message: unknown) => void): () => void;
  subscribeExit(listener: (evidence: WorkerExitEvidence) => void): () => void;
  terminate(mode: 'graceful' | 'force'): Promise<void>;
}

export interface ConfigPublicationWorkerFactory {
  spawn(identity: ConfigProcessIdentity): ConfigPublicationWorkerProcess;
}

export type PendingConfigWorker = {
  readonly process: ConfigPublicationWorkerProcess;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly publication: ConfigPublicationIdentity | null;
};

export type ServingConfigWorker = PendingConfigWorker & {
  readonly private_port: number;
};

export interface PreparedWorkerAdmission {
  commit(): void;
}

export interface WorkerAdmissionController {
  prepare(workers: readonly ServingConfigWorker[]): PreparedWorkerAdmission;
}

export interface ConfigPublicationRepository {
  getSnapshot(): RepositorySnapshot;
  getActivePublication(): ActiveConfigurationPublication | null;
  beginPublication(mutationId: string, updatedAt: number): ConfigurationOperation;
  beginWorkerAttempt(
    mutationId: string,
    workerSlot: number,
    previousAttemptNo: number,
    reason: WorkerAttemptReason,
    updatedAt: number,
  ): ConfigurationOperationWorker;
  beginDrainingRecovery(mutationId: string, previousGeneration: number, updatedAt: number): ConfigurationOperation;
  recordWorkerResult(
    mutationId: string,
    workerSlot: number,
    result: WorkerPublicationResult,
    updatedAt: number,
  ): ConfigurationOperationWorker;
  markDraining(mutationId: string, updatedAt: number): ConfigurationOperation;
  finalizePublication(
    mutationId: string,
    outcome: FinalizePublicationOutcome,
    updatedAt: number,
  ): ConfigurationOperation;
}

export interface PublicationClock {
  now(): number;
}

export interface ScheduledTimeout {
  cancel(): void;
}

export interface PublicationScheduler {
  schedule(delayMs: number, callback: () => void): ScheduledTimeout;
}

export type PublicationFailure = {
  readonly slot: number;
  readonly code: 'apply_failed' | 'early_exit' | 'invalid_message' | 'mismatched_message' | 'timeout';
  readonly detail: string;
};

export type StartupPublicationOutcome =
  | { readonly kind: 'startup_ready'; readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'startup_failed'; readonly failures: readonly PublicationFailure[];
      readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'startup_outcome_unknown'; readonly fatal: true;
      readonly code: 'worker_exit_unconfirmed' | 'startup_failure'; readonly error: unknown;
      readonly failures: readonly PublicationFailure[]; readonly serving: readonly ServingConfigWorker[];
      readonly pending: readonly PendingConfigWorker[] };

export type MasterPublicationOutcome =
  | { readonly kind: 'converged'; readonly http_status: 200; readonly operation: ConfigurationOperation;
      readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'degraded'; readonly http_status: 202;
      readonly error_code: 'replacement_convergence_failed' | 'old_worker_drain_failed' | 'control_readiness_failed';
      readonly failures: readonly PublicationFailure[]; readonly operation: ConfigurationOperation;
      readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'outcome_unknown'; readonly fatal: true;
      readonly code: 'repository_failure' | 'worker_exit_unconfirmed'; readonly error: unknown;
      readonly serving: readonly ServingConfigWorker[]; readonly pending: readonly PendingConfigWorker[] }
  | { readonly kind: 'outcome_unknown'; readonly fatal: false;
      readonly code: 'recovery_replacements_failed'; readonly error: unknown;
      readonly serving: readonly ServingConfigWorker[]; readonly pending: readonly PendingConfigWorker[] };

export type MasterCoordinatorErrorCode =
  | 'concurrent_publication'
  | 'invalid_options'
  | 'target_set_mismatch';

export class MasterConfigPublicationError extends Error {
  readonly name = 'MasterConfigPublicationError';

  constructor(readonly code: MasterCoordinatorErrorCode, message: string) {
    super(message);
  }
}
