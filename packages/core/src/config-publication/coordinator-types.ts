import type { Sha256Digest } from '@jeffusion/bungee-types';
import type {
  ActiveConfigurationPublication,
  ConfigurationOperation,
  ConfigurationOperationWorker,
  ConfigurationRecoveryDisposition,
  FinalizePublicationOutcome,
  RepositorySnapshot,
  WorkerAttemptReason,
  WorkerPublicationResult,
} from '../config-storage/repository-types';
import type { ConfigMasterMessage, ConfigProcessIdentity, ConfigPublicationIdentity, WorkerDrainedMessage, WorkerDrainFailedMessage, WorkerDrainStartedMessage, WorkerExitDeadlineEvidence } from './types';

export type WorkerExitEvidence = {
  readonly exited: true;
  readonly pid: number;
  readonly terminalDrain?: WorkerDrainedMessage | WorkerDrainFailedMessage;
};

export type WorkerHandoffStatus = Readonly<{
  retired_id: string;
  pending: number;
  complete: boolean;
  remaining_ms: number;
}>;

export interface ConfigPublicationWorkerProcess {
  readonly slot: number;
  readonly identity: ConfigProcessIdentity;
  readonly pid: number;
  readonly kernelBootId?: string;
  send(message: ConfigMasterMessage): Promise<void>;
  drainStatus?(timeoutMs?: number): Promise<WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null>;
  subscribeMessage(listener: (message: unknown) => void): () => void;
  subscribeExit(listener: (evidence: WorkerExitEvidence) => void): () => void;
  terminate(mode: 'graceful' | 'force', timeoutMs?: number, exitDeadline?: WorkerExitDeadlineEvidence): Promise<void>;
  /**
   * OS-level exact exit proof for processes that never emit a child exit event
   * (adopted workers). Optional so bare coordinator fakes need no change; evidence
   * is per process object and must never be shared across processes by PID.
   */
  verifyExactExit?(): Promise<WorkerExitEvidence | null>;
}

export interface ConfigPublicationWorkerFactory {
  spawn(identity: ConfigProcessIdentity): ConfigPublicationWorkerProcess;
  markCommitted(processes: readonly ConfigPublicationWorkerProcess[]): void;
  disconnectProcesses(processes: readonly ConfigPublicationWorkerProcess[]): void;
  discardConfirmedUncommitted(target: import('../ingress/admission-set').AdmissionSet): Promise<void>;
}

export type PendingConfigWorker = {
  readonly process: ConfigPublicationWorkerProcess;
  readonly boot_nonce?: string | null;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly publication: ConfigPublicationIdentity | null;
};

export type ServingConfigWorker = PendingConfigWorker & {
  readonly boot_nonce?: string;
  readonly private_port: number;
};

export interface PreparedWorkerAdmission {
  commit(): Promise<void>;
  abort(): Promise<void>;
  releaseRetiredAfterExitProof(): Promise<void>;
  handoffStatus?(): Promise<WorkerHandoffStatus | null>;
}

export interface WorkerAdmissionController {
  prepare(workers: readonly ServingConfigWorker[], signal?: AbortSignal, handoffTimeoutMs?: number): Promise<PreparedWorkerAdmission>;
}

export interface ConfigPublicationRepository {
  getSnapshot(): RepositorySnapshot;
  getActivePublication(): Promise<ActiveConfigurationPublication | null>;
  beginPublication(mutationId: string, updatedAt: number): Promise<ConfigurationOperation>;
  beginWorkerAttempt(
    mutationId: string,
    workerSlot: number,
    previousAttemptNo: number,
    reason: WorkerAttemptReason,
    updatedAt: number,
  ): Promise<ConfigurationOperationWorker>;
  beginDrainingRecovery(mutationId: string, previousGeneration: number, updatedAt: number): Promise<ConfigurationOperation>;
  recordWorkerResult(
    mutationId: string,
    workerSlot: number,
    result: WorkerPublicationResult,
    updatedAt: number,
  ): Promise<ConfigurationOperationWorker>;
  markDraining(mutationId: string, updatedAt: number): Promise<ConfigurationOperation>;
  finalizePublication(
    mutationId: string,
    outcome: FinalizePublicationOutcome,
    updatedAt: number,
  ): Promise<ConfigurationOperation>;
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

export type PublicationRecoveryDisposition = ConfigurationRecoveryDisposition;

export type PublicationFailure = {
  readonly slot: number;
  readonly code: 'apply_failed' | 'early_exit' | 'invalid_message' | 'mismatched_message' | 'timeout';
  readonly detail: string;
  readonly recovery_disposition: PublicationRecoveryDisposition;
};

export type StartupPublicationOutcome =
  | { readonly kind: 'startup_ready'; readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'startup_degraded'; readonly http_status: 202; readonly error_code: 'old_worker_drain_failed' | 'control_readiness_failed' | 'admission_outcome_unknown';
      readonly recovery_disposition: PublicationRecoveryDisposition;
      readonly failures: readonly PublicationFailure[]; readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'startup_failed'; readonly failures: readonly PublicationFailure[];
      readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'startup_outcome_unknown'; readonly fatal: true;
      readonly code: 'worker_exit_unconfirmed' | 'startup_failure' | 'outcome_unknown'; readonly error: unknown;
      readonly failures: readonly PublicationFailure[]; readonly serving: readonly ServingConfigWorker[];
      readonly pending: readonly PendingConfigWorker[] };

export type MasterPublicationOutcome =
  | { readonly kind: 'converged'; readonly http_status: 200; readonly operation: ConfigurationOperation;
      readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'degraded'; readonly http_status: 202;
      readonly error_code: 'replacement_convergence_failed' | 'old_worker_drain_failed' | 'control_readiness_failed';
      readonly recovery_disposition: PublicationRecoveryDisposition;
      readonly failures: readonly PublicationFailure[]; readonly operation: ConfigurationOperation;
      readonly serving: readonly ServingConfigWorker[] }
  | { readonly kind: 'outcome_unknown'; readonly fatal: true;
      readonly code: 'admission_outcome_unknown' | 'repository_failure' | 'worker_exit_unconfirmed'; readonly error: unknown;
      readonly serving: readonly ServingConfigWorker[]; readonly pending: readonly PendingConfigWorker[] }
  | { readonly kind: 'outcome_unknown'; readonly fatal: false;
      readonly code: 'recovery_replacements_failed' | 'control_recovering'; readonly error: unknown;
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
