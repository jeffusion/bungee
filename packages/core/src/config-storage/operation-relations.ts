import type { Database } from 'bun:sqlite';
import type { ConfigurationOperation, ConfigurationOperationWorker, RepositorySnapshot } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { hashConfigurationRequest } from './content-hash';
import { sqliteGet } from './sqlite-query';

/** Current revision identity is checked against the startup/confirmed-commit projection. */
export function validateActiveOperationIdentity(
  db: Database, operation: ConfigurationOperation, workers: readonly ConfigurationOperationWorker[], snapshot: RepositorySnapshot,
): void {
  validateOperationRelations(operation, workers);
  const revision = sqliteGet<{ content_hash: string; kind: string; created_at: number }, [number]>(db,
    'SELECT content_hash,kind,created_at FROM configuration_revisions WHERE revision=?', snapshot.revision);
  if (operation.committed_revision !== snapshot.revision || operation.expected_revision !== snapshot.revision - 1 ||
      revision === null || revision.content_hash !== snapshot.content_hash || revision.kind !== operation.kind ||
      revision.created_at !== operation.created_at || operation.request_hash !== hashConfigurationRequest({
        kind: operation.kind, expected_revision: operation.expected_revision, aggregate: snapshot.aggregate,
        target_worker_slots: workers.map(worker => worker.worker_slot).sort((left, right) => left - right),
      })) {
    throw new ConfigRepositoryError('schema_corrupt', 'active operation identity is incoherent');
  }
}

/** Validates only the operation and its frozen targets, without touching history. */
export function validateOperationRelations(operation: ConfigurationOperation, workers: readonly ConfigurationOperationWorker[]): void {
  if (workers.some(worker => worker.mutation_id !== operation.mutation_id || worker.target_revision !== operation.committed_revision
    || worker.updated_at < operation.created_at || worker.updated_at > operation.updated_at)) {
    throw new ConfigRepositoryError('schema_corrupt', 'operation worker metadata is incoherent');
  }
  if (workers.length !== operation.target_worker_count) {
    throw new ConfigRepositoryError('schema_corrupt', 'operation target cardinality is incoherent');
  }
  if (workers.some(({ drain_recovery_generation }) =>
    drain_recovery_generation !== operation.drain_recovery_generation)) {
    throw new ConfigRepositoryError('schema_corrupt', 'operation recovery generation is incoherent');
  }
  if (operation.state === 'committed' && workers.some(({ state: workerState, attempt_no }) =>
    workerState !== 'pending' || attempt_no !== 0)) {
    throw new ConfigRepositoryError('schema_corrupt', 'committed operation has terminal worker state');
  }
  if (operation.state === 'draining' &&
      workers.some(({ state: workerState, attempt_no }) => workerState !== 'converged' || attempt_no === 0)) {
    const invalidRecovery = workers.some(({ state: workerState, attempt_no, last_begin_reason }) =>
      attempt_no === 0 || (workerState !== 'converged' &&
        last_begin_reason !== 'master_recovery' && last_begin_reason !== 'retry'));
    if (invalidRecovery) {
      throw new ConfigRepositoryError('schema_corrupt', 'draining operation targets are incoherent');
    }
  }
  if (operation.state === 'draining' && operation.drain_recovery_generation > 0 &&
      workers.some(({ last_begin_reason }) =>
        last_begin_reason !== 'master_recovery' && last_begin_reason !== 'retry')) {
    throw new ConfigRepositoryError('schema_corrupt', 'draining recovery targets are not fully fenced');
  }
  if (operation.state === 'draining' && operation.drain_recovery_generation === 0 &&
      workers.some(({ state: workerState }) => workerState !== 'converged')) {
    throw new ConfigRepositoryError('schema_corrupt', 'unfenced draining operation has active recovery targets');
  }
  if (operation.state === 'converged' &&
      workers.some(({ state: workerState }) => workerState !== 'converged')) {
    throw new ConfigRepositoryError('schema_corrupt', 'converged operation targets are incoherent');
  }
  if (operation.state === 'degraded') {
    if (operation.error_code === 'replacement_convergence_failed' &&
        (workers.some(({ state: workerState }) => workerState === 'pending') ||
         !workers.some(({ state: workerState }) => workerState === 'failed'))) {
      throw new ConfigRepositoryError('schema_corrupt', 'replacement failure targets are incoherent');
    }
    if (operation.error_code === 'old_worker_drain_failed' &&
        workers.some(({ state: workerState, attempt_no }) => workerState !== 'converged' || attempt_no === 0)) {
      throw new ConfigRepositoryError('schema_corrupt', 'drain failure targets are incoherent');
    }
    if (operation.drain_recovery_generation > 0 && operation.error_code !== 'old_worker_drain_failed'
        && operation.error_code !== 'control_readiness_failed') {
      throw new ConfigRepositoryError('schema_corrupt', 'drain recovery terminal result is incoherent');
    }
    if (operation.drain_recovery_generation > 0 && workers.some(({ last_begin_reason }) =>
      last_begin_reason !== 'master_recovery' && last_begin_reason !== 'retry')) {
      throw new ConfigRepositoryError('schema_corrupt', 'drain recovery terminal targets are not fully fenced');
    }
  }
}
