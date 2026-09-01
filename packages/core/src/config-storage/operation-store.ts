import type { Database } from 'bun:sqlite';
import type {
  ConfigurationOperation,
  ConfigurationOperationWorker,
  FinalizePublicationOutcome,
  WorkerAttemptReason,
  WorkerPublicationResult,
} from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll, sqliteGet } from './sqlite-query';
import {
  getOperation, readOperationWorkers, workerFromRow, WORKER_SELECT, type WorkerRow,
} from './operation-records';
export { getOperation, operationFromRow, readAllOperations, readAllWorkers } from './operation-records';
export type { OperationRow } from './operation-records';

function requireTimestamp(updatedAt: number, operation: ConfigurationOperation): void {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < operation.updated_at) {
    throw new ConfigRepositoryError('invalid_operation', 'operation timestamp regressed or is unsafe');
  }
}

function requireOperation(db: Database, mutationId: string): ConfigurationOperation {
  const operation = getOperation(db, mutationId);
  if (operation === null) throw new ConfigRepositoryError('invalid_operation', 'configuration operation was not found');
  return operation;
}

export function beginPublication(db: Database, mutationId: string, updatedAt: number): ConfigurationOperation {
  const operation = requireOperation(db, mutationId);
  requireTimestamp(updatedAt, operation);
  if (operation.state === 'publishing') return operation;
  if (operation.state !== 'committed') throw new ConfigRepositoryError('invalid_operation', 'operation is not committed');
  db.run(`UPDATE configuration_operations SET state='publishing',updated_at=? WHERE mutation_id=?`, [updatedAt, mutationId]);
  return { ...operation, state: 'publishing', result_status: null, error_code: null, error_detail: null, updated_at: updatedAt };
}

export function beginWorkerAttempt(
  db: Database, mutationId: string, workerSlot: number, previousAttemptNo: number,
  reason: WorkerAttemptReason, updatedAt: number,
): ConfigurationOperationWorker {
  const operation = requireOperation(db, mutationId);
  if ((operation.state !== 'publishing' && operation.state !== 'draining') ||
      !Number.isSafeInteger(workerSlot) || workerSlot < 0 ||
      !Number.isSafeInteger(previousAttemptNo) || previousAttemptNo < 0 || previousAttemptNo >= Number.MAX_SAFE_INTEGER) {
    throw new ConfigRepositoryError('invalid_operation', 'worker begin command is invalid');
  }
  const row = sqliteGet<WorkerRow, [string, number]>(db, `${WORKER_SELECT} WHERE mutation_id=? AND worker_slot=?`, mutationId, workerSlot);
  if (row === null) throw new ConfigRepositoryError('invalid_operation', 'worker is not a frozen target');
  const worker = workerFromRow(row);
  if (operation.state === 'draining' && reason === 'master_recovery') {
    throw new ConfigRepositoryError('invalid_operation', 'draining recovery must fence every target atomically');
  }
  if (worker.attempt_no === previousAttemptNo + 1 && worker.last_begin_previous_attempt_no === previousAttemptNo &&
      worker.last_begin_reason === reason) return worker;
  requireTimestamp(updatedAt, operation);
  const valid = worker.attempt_no === previousAttemptNo && (operation.state === 'publishing'
    ? (worker.state === 'pending' && previousAttemptNo === 0 && reason === 'initial') ||
      (worker.state === 'failed' && reason === 'retry') || reason === 'master_recovery'
    : worker.state === 'failed' && reason === 'retry');
  if (!valid) throw new ConfigRepositoryError('invalid_operation', 'worker begin transition is invalid');
  const attemptNo = previousAttemptNo + 1;
  db.run(`UPDATE configuration_operation_workers SET attempt_no=?,last_begin_previous_attempt_no=?,last_begin_reason=?,
    state='pending',applied_revision=NULL,last_error=NULL,updated_at=? WHERE mutation_id=? AND worker_slot=?`,
  [attemptNo, previousAttemptNo, reason, updatedAt, mutationId, workerSlot]);
  db.run('UPDATE configuration_operations SET updated_at=? WHERE mutation_id=?', [updatedAt, mutationId]);
  const updated = sqliteGet<WorkerRow, [string, number]>(db, `${WORKER_SELECT} WHERE mutation_id=? AND worker_slot=?`, mutationId, workerSlot);
  if (updated === null) throw new ConfigRepositoryError('repository_failure', 'worker begin update failed');
  return workerFromRow(updated);
}

export function recordWorkerResult(
  db: Database,
  mutationId: string,
  workerSlot: number,
  result: WorkerPublicationResult,
  updatedAt: number,
): ConfigurationOperationWorker {
  const operation = requireOperation(db, mutationId);
  if (!Number.isSafeInteger(workerSlot) || workerSlot < 0) throw new ConfigRepositoryError('invalid_operation', 'worker slot is invalid');
  const current = sqliteGet<WorkerRow, [string, number]>(db, `${WORKER_SELECT} WHERE mutation_id=? AND worker_slot=?`, mutationId, workerSlot);
  if (current === null) throw new ConfigRepositoryError('invalid_operation', 'worker is not a frozen target');
  const worker = workerFromRow(current);
  if (!Number.isSafeInteger(result.attempt_no) || result.attempt_no <= 0 || result.attempt_no !== worker.attempt_no) {
    throw new ConfigRepositoryError('invalid_operation', 'worker result attempt is stale or future');
  }
  if (worker.state !== 'pending') {
    const duplicate = result.kind === 'converged'
      ? worker.state === 'converged' && worker.applied_revision === result.applied_revision
      : worker.state === 'failed' && worker.applied_revision === (result.applied_revision ?? null) && worker.last_error === result.error;
    if (duplicate) return worker;
    throw new ConfigRepositoryError('invalid_operation', 'worker result conflicts with terminal result');
  }
  if (operation.state !== 'publishing' && operation.state !== 'draining') {
    throw new ConfigRepositoryError('invalid_operation', 'operation is not publishing or draining');
  }
  requireTimestamp(updatedAt, operation);
  if (result.kind === 'converged') {
    if (result.applied_revision !== worker.target_revision) {
      throw new ConfigRepositoryError('invalid_operation', 'worker applied revision does not match target');
    }
    db.run(`UPDATE configuration_operation_workers SET state='converged',applied_revision=?,updated_at=?
      WHERE mutation_id=? AND worker_slot=?`, [result.applied_revision, updatedAt, mutationId, workerSlot]);
  } else {
    if (result.error.trim().length < 1 || result.error.length > 512 ||
        (result.applied_revision !== undefined && (!Number.isSafeInteger(result.applied_revision) || result.applied_revision <= 0))) {
      throw new ConfigRepositoryError('invalid_operation', 'worker failure result is invalid');
    }
    db.run(`UPDATE configuration_operation_workers SET state='failed',applied_revision=?,last_error=?,updated_at=?
      WHERE mutation_id=? AND worker_slot=?`, [result.applied_revision ?? null, result.error, updatedAt, mutationId, workerSlot]);
  }
  db.run('UPDATE configuration_operations SET updated_at=? WHERE mutation_id=?', [updatedAt, mutationId]);
  const updated = sqliteGet<WorkerRow, [string, number]>(db, `${WORKER_SELECT} WHERE mutation_id=? AND worker_slot=?`, mutationId, workerSlot);
  if (updated === null) throw new ConfigRepositoryError('repository_failure', 'worker result update failed');
  return workerFromRow(updated);
}

export function finalizePublication(
  db: Database,
  mutationId: string,
  outcome: FinalizePublicationOutcome,
  updatedAt: number,
): ConfigurationOperation {
  const operation = requireOperation(db, mutationId);
  const recoveryWithoutExitProof = outcome.outcome === 'degraded'
    && outcome.error_code === 'old_worker_drain_failed'
    && 'master_recovery_without_exit_proof' in outcome
    && outcome.master_recovery_without_exit_proof === true;
  if (recoveryWithoutExitProof && 'old_workers_exited' in outcome) {
    throw new ConfigRepositoryError('invalid_operation', 'recovery evidence cannot claim old worker exits');
  }
  if (operation.state === 'converged' || operation.state === 'degraded') {
    if (recoveryWithoutExitProof) {
      throw new ConfigRepositoryError('invalid_operation', 'master recovery evidence is only valid while draining');
    }
    if (outcome.outcome === 'converged' && outcome.old_workers_exited !== true) {
      throw new ConfigRepositoryError('invalid_operation', 'old worker exit proof is required');
    }
    if (outcome.outcome === 'degraded' && outcome.error_code === 'old_worker_drain_failed'
        && !recoveryWithoutExitProof &&
        (!('old_workers_exited' in outcome) || outcome.old_workers_exited !== true)) {
      throw new ConfigRepositoryError('invalid_operation', 'old worker exit proof is required');
    }
    const duplicate = outcome.outcome === operation.state &&
      (outcome.outcome === 'converged' ||
       (outcome.error_code === operation.error_code && outcome.error_detail === operation.error_detail));
    if (duplicate) return operation;
    throw new ConfigRepositoryError('invalid_operation', 'terminal finalization conflicts with durable result');
  }
  requireTimestamp(updatedAt, operation);
  const workers = sqliteAll<WorkerRow, [string]>(db, `${WORKER_SELECT} WHERE mutation_id=?`, mutationId).map(workerFromRow);
  if (operation.state === 'publishing') {
    if (outcome.outcome !== 'degraded' || outcome.error_code !== 'replacement_convergence_failed' ||
        workers.some(({ state }) => state === 'pending') || !workers.some(({ state }) => state === 'failed')) {
      throw new ConfigRepositoryError('invalid_operation', 'replacement failure prerequisites are not met');
    }
  } else if (operation.state === 'draining') {
    const targetsConverged = workers.every(({ state, attempt_no }) => state === 'converged' && attempt_no > 0);
    const recoveryEvidenceValid = recoveryWithoutExitProof && workers.length > 0
      && workers.every(({ last_begin_reason, drain_recovery_generation }) =>
        last_begin_reason === 'master_recovery'
        && drain_recovery_generation === operation.drain_recovery_generation);
    const exitEvidenceValid = !recoveryWithoutExitProof
      && 'old_workers_exited' in outcome && outcome.old_workers_exited === true;
    if (!targetsConverged || (!recoveryEvidenceValid && !exitEvidenceValid) ||
        (operation.drain_recovery_generation > 0 && outcome.outcome !== 'degraded') ||
        (outcome.outcome === 'degraded' && outcome.error_code !== 'old_worker_drain_failed')) {
      throw new ConfigRepositoryError('invalid_operation', 'drain finalization prerequisites are not met');
    }
  } else throw new ConfigRepositoryError('invalid_operation', 'operation cannot be finalized');
  const errorDetail = outcome.outcome === 'degraded' ? outcome.error_detail : null;
  if (errorDetail !== null && (errorDetail.length > 512 || errorDetail.trim().length === 0)) {
    throw new ConfigRepositoryError('invalid_operation', 'terminal error detail is invalid');
  }
  db.run(`UPDATE configuration_operations SET state=?,result_status=?,error_code=?,error_detail=?,updated_at=? WHERE mutation_id=?`,
    [outcome.outcome, outcome.outcome === 'converged' ? 200 : 202,
      outcome.outcome === 'degraded' ? outcome.error_code : null, errorDetail, updatedAt, mutationId]);
  const terminal = getOperation(db, mutationId);
  if (terminal === null) throw new ConfigRepositoryError('repository_failure', 'operation finalization failed');
  return terminal;
}

export function markDraining(db: Database, mutationId: string, updatedAt: number): ConfigurationOperation {
  const operation = requireOperation(db, mutationId);
  if (operation.state === 'draining') return operation;
  requireTimestamp(updatedAt, operation);
  if (operation.state !== 'publishing') throw new ConfigRepositoryError('invalid_operation', 'operation is not publishing');
  const workers = readOperationWorkers(db, mutationId);
  if (workers.some(({ state, attempt_no }) => state !== 'converged' || attempt_no === 0)) {
    throw new ConfigRepositoryError('invalid_operation', 'all frozen targets must converge before draining');
  }
  db.run(`UPDATE configuration_operations SET state='draining',updated_at=? WHERE mutation_id=?`, [updatedAt, mutationId]);
  return { ...operation, state: 'draining', result_status: null, error_code: null, error_detail: null, updated_at: updatedAt };
}

export function beginDrainingRecovery(
  db: Database,
  mutationId: string,
  previousGeneration: number,
  updatedAt: number,
): ConfigurationOperation {
  const operation = requireOperation(db, mutationId);
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0 ||
      previousGeneration >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new ConfigRepositoryError('invalid_operation', 'draining recovery command is invalid');
  }
  if (operation.state !== 'draining') {
    throw new ConfigRepositoryError('invalid_operation', 'operation is not draining');
  }
  if (operation.drain_recovery_generation === previousGeneration + 1 &&
      operation.last_drain_recovery_previous_generation === previousGeneration) return operation;
  requireTimestamp(updatedAt, operation);
  if (operation.drain_recovery_generation !== previousGeneration) {
    throw new ConfigRepositoryError('invalid_operation', 'draining recovery generation is stale or future');
  }
  const workers = readOperationWorkers(db, mutationId);
  if (operation.drain_recovery_generation >= Number.MAX_SAFE_INTEGER ||
      workers.some(({ attempt_no }) => attempt_no >= Number.MAX_SAFE_INTEGER)) {
    throw new ConfigRepositoryError('invalid_operation', 'worker attempt limit reached');
  }
  const nextGeneration = previousGeneration + 1;
  for (const worker of workers) {
    db.run(`UPDATE configuration_operation_workers SET attempt_no=?,last_begin_previous_attempt_no=?,
      last_begin_reason='master_recovery',drain_recovery_generation=?,state='pending',
      applied_revision=NULL,last_error=NULL,updated_at=?
      WHERE mutation_id=? AND worker_slot=?`, [
      worker.attempt_no + 1, worker.attempt_no, nextGeneration, updatedAt, mutationId, worker.worker_slot,
    ]);
  }
  db.run(`UPDATE configuration_operations SET drain_recovery_generation=?,
    last_drain_recovery_previous_generation=?,updated_at=? WHERE mutation_id=?`,
  [nextGeneration, previousGeneration, updatedAt, mutationId]);
  return { ...operation, drain_recovery_generation: nextGeneration,
    last_drain_recovery_previous_generation: previousGeneration, updated_at: updatedAt };
}
