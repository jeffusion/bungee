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
      readonly error_code: 'replacement_convergence_failed' | 'old_worker_drain_failed' | 'control_readiness_failed'; readonly error_detail: string }
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

export type ConfigurationRecoveryTrigger = 'automatic' | 'manual';
export type ConfigurationRecoveryState = 'scheduled' | 'running' | 'succeeded' | 'stopped';
export type ConfigurationRecoveryReasonCode =
  | 'target_serving'
  | 'already_serving'
  | 'deterministic_worker_rejection'
  | 'deterministic_protocol_failure'
  | 'deterministic_control_failure'
  | 'retry_exhausted'
  | 'revision_superseded'
  | 'safety_outcome_unknown'
  | 'fatal_source_failure';

export type ConfigurationRecoveryDisposition =
  | 'retryable'
  | 'deterministic_worker_rejection'
  | 'deterministic_protocol_failure'
  | 'deterministic_control_failure'
  | 'fatal';

export type ConfigurationRecovery = {
  readonly recovery_id: string;
  readonly source_mutation_id: string;
  readonly target_revision: number;
  readonly trigger: ConfigurationRecoveryTrigger;
  readonly state: ConfigurationRecoveryState;
  readonly attempt_count: number;
  readonly max_attempts: 6;
  readonly next_retry_at: number | null;
  readonly final_reason_code: ConfigurationRecoveryReasonCode | null;
  readonly final_reason_detail: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

export type BeginWorkerAttemptCommand = {
  readonly mutation_id: string;
  readonly worker_slot: number;
  readonly previous_attempt_no: number;
  readonly reason: WorkerAttemptReason;
  readonly updated_at: number;
};

export type BeginWorkerAttemptResult = ConfigurationOperationWorker;

export type FinalizePublicationOutcome =
  | { readonly outcome: 'degraded'; readonly error_code: 'replacement_convergence_failed' | 'control_readiness_failed'; readonly error_detail: string;
      readonly recovery_disposition: ConfigurationRecoveryDisposition }
  | { readonly outcome: 'converged'; readonly old_workers_exited: true }
  | { readonly outcome: 'degraded'; readonly error_code: 'old_worker_drain_failed'; readonly error_detail: string;
      readonly old_workers_exited: true; readonly recovery_disposition: ConfigurationRecoveryDisposition }
  | { readonly outcome: 'degraded'; readonly error_code: 'old_worker_drain_failed'; readonly error_detail: string;
      readonly master_recovery_without_exit_proof: true; readonly recovery_disposition: ConfigurationRecoveryDisposition }
  | { readonly outcome: 'degraded'; readonly error_code: 'old_worker_drain_failed'; readonly error_detail: string;
      readonly retired_without_exit_proof: true; readonly recovery_disposition: ConfigurationRecoveryDisposition };

export type RepositorySnapshot = CommittedConfigurationSnapshotV2;

export type ServingSnapshotKey = {
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
};

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
      readonly state: 'committed' | 'publishing' | 'draining' }
  | { readonly kind: 'recovery_in_progress'; readonly recovery_id: string; readonly target_revision: number;
      readonly state: 'scheduled' | 'running' };

export type ConfigRepositoryErrorCode =
  | 'connection_invariant'
  | 'invalid_command'
  | 'invalid_configuration'
  | 'invalid_operation'
  | 'stale_revision'
  | 'source_not_retryable'
  | 'idempotency_key_reused'
  | 'recovery_in_progress'
  | 'cas_conflict'
  | 'retry_not_due'
  | 'attempts_exhausted'
  | 'migration_failed'
  | 'repository_failure'
  | 'schema_corrupt'
  | 'serving_snapshot_corrupt';

export class ConfigRepositoryError extends Error {
  readonly name = 'ConfigRepositoryError';

  constructor(
    readonly code: ConfigRepositoryErrorCode,
    message: string,
    readonly cause?: unknown,
    readonly recovery?: ConfigurationRecovery,
  ) {
    super(message, { cause });
  }
}

export type ConfigRepositoryOptions = {
  readonly compileOptions?: ConfigurationCompileOptions;
  readonly faultInjection?: (stage: 'after_materialization' | 'after_targets' | 'after_automatic_recovery') => void;
};
