import type { Database } from 'bun:sqlite';
import { requireSafeInteger } from './persisted-validation';
import type { ConfigurationOperation, ConfigurationOperationWorker, WorkerAttemptReason } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { validateDigest, validateMutationId } from './repository-validation';
import { sqliteAll, sqliteGet } from './sqlite-query';

export type OperationRow = {
  readonly mutation_id: string; readonly request_hash: string; readonly expected_revision: number;
  readonly committed_revision: number; readonly kind: string; readonly state: string;
  readonly target_worker_count: number; readonly result_status: number | null;
  readonly error_code: string | null; readonly error_detail: string | null;
  readonly drain_recovery_generation: number;
  readonly last_drain_recovery_previous_generation: number | null;
  readonly created_at: number; readonly updated_at: number;
};

export type WorkerRow = {
  readonly mutation_id: string; readonly worker_slot: number; readonly target_revision: number;
  readonly drain_recovery_generation: number;
  readonly attempt_no: number; readonly last_begin_previous_attempt_no: number | null;
  readonly last_begin_reason: string | null; readonly state: string;
  readonly applied_revision: number | null; readonly last_error: string | null; readonly updated_at: number;
};

export const OPERATION_SELECT = `SELECT mutation_id,request_hash,expected_revision,committed_revision,kind,state,
  target_worker_count,result_status,error_code,error_detail,drain_recovery_generation,
  last_drain_recovery_previous_generation,created_at,updated_at
  FROM configuration_operations`;
export const WORKER_SELECT = `SELECT mutation_id,worker_slot,target_revision,drain_recovery_generation,
  attempt_no,last_begin_previous_attempt_no,last_begin_reason,state,applied_revision,last_error,updated_at
  FROM configuration_operation_workers`;

export function operationFromRow(row: OperationRow): ConfigurationOperation {
  if (!validateMutationId(row.mutation_id) || !validateDigest(row.request_hash) ||
      (row.kind !== 'config' && row.kind !== 'admin_state')) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration operation identity is invalid');
  }
  requireSafeInteger(row.expected_revision, 'configuration_operations.expected_revision', 1);
  requireSafeInteger(row.committed_revision, 'configuration_operations.committed_revision', 1);
  requireSafeInteger(row.target_worker_count, 'configuration_operations.target_worker_count');
  requireSafeInteger(row.created_at, 'configuration_operations.created_at');
  requireSafeInteger(row.updated_at, 'configuration_operations.updated_at');
  requireSafeInteger(row.drain_recovery_generation, 'configuration_operations.drain_recovery_generation');
  if (row.last_drain_recovery_previous_generation !== null) {
    requireSafeInteger(row.last_drain_recovery_previous_generation,
      'configuration_operations.last_drain_recovery_previous_generation');
  }
  if ((row.drain_recovery_generation === 0) !== (row.last_drain_recovery_previous_generation === null) ||
      (row.drain_recovery_generation > 0 &&
       row.last_drain_recovery_previous_generation !== row.drain_recovery_generation - 1)) {
    throw new ConfigRepositoryError('schema_corrupt', 'operation drain recovery metadata is invalid');
  }
  if (row.drain_recovery_generation > 0 && row.state !== 'draining' &&
      !(row.state === 'degraded' &&
        (row.error_code === 'old_worker_drain_failed' || row.error_code === 'control_readiness_failed'))) {
    throw new ConfigRepositoryError('schema_corrupt', 'operation drain recovery phase is invalid');
  }
  if (row.updated_at < row.created_at) throw new ConfigRepositoryError('schema_corrupt', 'operation timestamps are invalid');
  const kind: 'config' | 'admin_state' = row.kind === 'config' ? 'config' : 'admin_state';
  const base = {
    mutation_id: row.mutation_id, request_hash: row.request_hash, expected_revision: row.expected_revision,
    committed_revision: row.committed_revision, kind, target_worker_count: row.target_worker_count,
    drain_recovery_generation: row.drain_recovery_generation,
    last_drain_recovery_previous_generation: row.last_drain_recovery_previous_generation,
    created_at: row.created_at, updated_at: row.updated_at,
  };
  switch (row.state) {
    case 'committed':
    case 'publishing':
    case 'draining':
      if (row.result_status === null && row.error_code === null && row.error_detail === null) {
        return { ...base, state: row.state, result_status: null, error_code: null, error_detail: null };
      }
      break;
    case 'converged':
      if (row.drain_recovery_generation === 0 && row.result_status === 200 &&
          row.error_code === null && row.error_detail === null) {
        return { ...base, state: 'converged', result_status: 200, error_code: null, error_detail: null };
      }
      break;
    case 'degraded':
      if (row.result_status === 202 &&
          (row.error_code === 'replacement_convergence_failed' || row.error_code === 'old_worker_drain_failed' ||
           row.error_code === 'control_readiness_failed') &&
          (row.error_code === 'old_worker_drain_failed' || row.error_code === 'control_readiness_failed' ||
           row.drain_recovery_generation === 0) &&
          row.error_detail !== null && row.error_detail.length <= 512 && row.error_detail.trim().length > 0) {
        return { ...base, state: 'degraded', result_status: 202,
          error_code: row.error_code, error_detail: row.error_detail };
      }
  }
  throw new ConfigRepositoryError('schema_corrupt', 'configuration operation state is invalid');
}

function parseBeginReason(value: string | null): WorkerAttemptReason | null {
  if (value === null || value === 'initial' || value === 'retry' || value === 'master_recovery') return value;
  throw new ConfigRepositoryError('schema_corrupt', 'worker begin reason is invalid');
}

export function workerFromRow(row: WorkerRow): ConfigurationOperationWorker {
  if (!validateMutationId(row.mutation_id)) throw new ConfigRepositoryError('schema_corrupt', 'worker mutation ID is invalid');
  requireSafeInteger(row.worker_slot, 'configuration_operation_workers.worker_slot');
  requireSafeInteger(row.target_revision, 'configuration_operation_workers.target_revision', 1);
  requireSafeInteger(row.drain_recovery_generation, 'configuration_operation_workers.drain_recovery_generation');
  requireSafeInteger(row.attempt_no, 'configuration_operation_workers.attempt_no');
  requireSafeInteger(row.updated_at, 'configuration_operation_workers.updated_at');
  if (row.applied_revision !== null) requireSafeInteger(row.applied_revision, 'configuration_operation_workers.applied_revision', 1);
  const reason = parseBeginReason(row.last_begin_reason);
  if (row.last_begin_previous_attempt_no !== null) {
    requireSafeInteger(row.last_begin_previous_attempt_no, 'configuration_operation_workers.last_begin_previous_attempt_no');
  }
  if ((row.attempt_no === 0) !== (row.last_begin_previous_attempt_no === null && reason === null) ||
      (row.attempt_no > 0 && (row.last_begin_previous_attempt_no !== row.attempt_no - 1 || reason === null)) ||
      (reason === 'initial' && row.last_begin_previous_attempt_no !== 0) ||
      (reason === 'retry' && row.last_begin_previous_attempt_no === 0)) {
    throw new ConfigRepositoryError('schema_corrupt', 'worker attempt metadata is invalid');
  }
  const base = {
    mutation_id: row.mutation_id, worker_slot: row.worker_slot, target_revision: row.target_revision,
    drain_recovery_generation: row.drain_recovery_generation,
    attempt_no: row.attempt_no, last_begin_previous_attempt_no: row.last_begin_previous_attempt_no,
    last_begin_reason: reason, updated_at: row.updated_at,
  };
  if (row.state === 'pending' && row.applied_revision === null && row.last_error === null) {
    return { ...base, state: 'pending', applied_revision: null, last_error: null };
  }
  if (row.state === 'converged' && row.attempt_no > 0 &&
      row.applied_revision === row.target_revision && row.last_error === null) {
    return { ...base, state: 'converged', applied_revision: row.target_revision, last_error: null };
  }
  if (row.state === 'failed' && row.attempt_no > 0 && row.last_error !== null &&
      row.last_error.length <= 512 && row.last_error.trim().length > 0) {
    return { ...base, state: 'failed', applied_revision: row.applied_revision, last_error: row.last_error };
  }
  throw new ConfigRepositoryError('schema_corrupt', 'operation worker state is invalid');
}

export function getOperation(db: Database, mutationId: string): ConfigurationOperation | null {
  const row = sqliteGet<OperationRow, [string]>(db, `${OPERATION_SELECT} WHERE mutation_id=?`, mutationId);
  return row === null ? null : operationFromRow(row);
}

export function readOperationWorkers(db: Database, mutationId: string): readonly ConfigurationOperationWorker[] {
  return sqliteAll<WorkerRow, [string]>(db, `${WORKER_SELECT} WHERE mutation_id=? ORDER BY worker_slot`, mutationId).map(workerFromRow);
}

export function readAllOperations(db: Database): readonly ConfigurationOperation[] {
  return sqliteAll<OperationRow, []>(db, `${OPERATION_SELECT} ORDER BY committed_revision`).map(operationFromRow);
}

export function readAllWorkers(db: Database): readonly ConfigurationOperationWorker[] {
  return sqliteAll<WorkerRow, []>(db, `${WORKER_SELECT} ORDER BY mutation_id,worker_slot`).map(workerFromRow);
}
