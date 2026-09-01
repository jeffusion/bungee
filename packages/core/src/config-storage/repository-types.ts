import type {
  CommittedConfigurationSnapshotV2,
  ConfigurationAggregateV2,
  Sha256Digest,
} from '@jeffusion/bungee-types';
import type { ConfigurationCompileOptions } from './plugin-schema';

type ConfigurationOperationBase = {
  readonly mutation_id: string;
  readonly request_hash: Sha256Digest;
  readonly expected_revision: number;
  readonly committed_revision: number;
  readonly kind: 'config' | 'admin_state';
  readonly target_worker_count: number;
  readonly drain_recovery_generation: number;
  readonly last_drain_recovery_previous_generation: number | null;
  readonly created_at: number;
  readonly updated_at: number;
};

export type ConfigurationOperation = ConfigurationOperationBase & (
  | { readonly state: 'committed' | 'publishing' | 'draining'; readonly result_status: null;
      readonly error_code: null; readonly error_detail: null }
  | { readonly state: 'converged'; readonly result_status: 200; readonly error_code: null; readonly error_detail: null }
  | { readonly state: 'degraded'; readonly result_status: 202;
      readonly error_code: 'replacement_convergence_failed' | 'old_worker_drain_failed'; readonly error_detail: string }
);

type ConfigurationOperationWorkerBase = {
  readonly mutation_id: string;
  readonly worker_slot: number;
  readonly target_revision: number;
  readonly drain_recovery_generation: number;
  readonly attempt_no: number;
  readonly last_begin_previous_attempt_no: number | null;
  readonly last_begin_reason: WorkerAttemptReason | null;
  readonly updated_at: number;
};

export type ConfigurationOperationWorker = ConfigurationOperationWorkerBase & (
  | { readonly state: 'pending'; readonly applied_revision: null; readonly last_error: null }
  | { readonly state: 'converged'; readonly applied_revision: number; readonly last_error: null }
  | { readonly state: 'failed'; readonly applied_revision: number | null; readonly last_error: string }
);

export type ConfigurationOperationState = {
  readonly operation: ConfigurationOperation;
  readonly workers: readonly ConfigurationOperationWorker[];
};

export type WorkerPublicationResult =
  | { readonly kind: 'converged'; readonly attempt_no: number; readonly applied_revision: number }
  | { readonly kind: 'failed'; readonly attempt_no: number; readonly error: string; readonly applied_revision?: number };

export type WorkerAttemptReason = 'initial' | 'retry' | 'master_recovery';

export type BeginWorkerAttemptCommand = {
  readonly mutation_id: string;
  readonly worker_slot: number;
  readonly previous_attempt_no: number;
  readonly reason: WorkerAttemptReason;
  readonly updated_at: number;
};

export type BeginWorkerAttemptResult = ConfigurationOperationWorker;

export type FinalizePublicationOutcome =
  | { readonly outcome: 'degraded'; readonly error_code: 'replacement_convergence_failed'; readonly error_detail: string }
  | { readonly outcome: 'converged'; readonly old_workers_exited: true }
  | { readonly outcome: 'degraded'; readonly error_code: 'old_worker_drain_failed'; readonly error_detail: string;
      readonly old_workers_exited: true }
  | { readonly outcome: 'degraded'; readonly error_code: 'old_worker_drain_failed'; readonly error_detail: string;
      readonly master_recovery_without_exit_proof: true };

export type RepositorySnapshot = CommittedConfigurationSnapshotV2;

export type ActiveConfigurationPublication = {
  readonly operation: Extract<ConfigurationOperation, { readonly result_status: null }>;
  readonly snapshot: RepositorySnapshot;
  readonly targets: readonly ConfigurationOperationWorker[];
};

export type CommitConfigurationCommandV1 = {
  readonly mutation_id: string;
  readonly expected_revision: number;
  readonly aggregate: ConfigurationAggregateV2;
  readonly kind: 'config' | 'admin_state';
  readonly created_at: number;
  readonly target_worker_slots: readonly number[];
};

export type CommitConfigurationResult =
  | { readonly kind: 'committed'; readonly snapshot: RepositorySnapshot; readonly operation: ConfigurationOperation }
  | { readonly kind: 'duplicate'; readonly operation: ConfigurationOperation }
  | { readonly kind: 'stale_revision'; readonly expected_revision: number; readonly active_revision: number }
  | { readonly kind: 'idempotency_key_reused'; readonly mutation_id: string }
  | { readonly kind: 'operation_in_progress'; readonly mutation_id: string; readonly committed_revision: number;
      readonly state: 'committed' | 'publishing' | 'draining' };

export type ConfigRepositoryErrorCode =
  | 'connection_invariant'
  | 'invalid_command'
  | 'invalid_configuration'
  | 'invalid_operation'
  | 'migration_failed'
  | 'repository_failure'
  | 'schema_corrupt';

export class ConfigRepositoryError extends Error {
  readonly name = 'ConfigRepositoryError';

  constructor(
    readonly code: ConfigRepositoryErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export type ConfigRepositoryOptions = {
  readonly compileOptions?: ConfigurationCompileOptions;
  readonly faultInjection?: (stage: 'after_materialization' | 'after_targets') => void;
};
