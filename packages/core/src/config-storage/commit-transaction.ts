import type { Database } from 'bun:sqlite';
import { replaceActiveMaterialization } from './materialize';
import { operationFromRow, type OperationRow } from './operation-store';
import type { PreparedCommitCommand } from './prepared-command';
import { readRepositorySnapshot, verifyRepositoryIntegrity } from './repository-snapshot';
import type { CommitConfigurationResult, ConfigurationOperation, ConfigRepositoryOptions } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll, sqliteGet } from './sqlite-query';

type StateRow = {
  readonly active_revision: number;
};
export type CommitDecision =
  | { readonly kind: 'committed'; readonly operation: ConfigurationOperation }
  | { readonly kind: 'duplicate'; readonly operation: ConfigurationOperation }
  | Exclude<CommitConfigurationResult, { readonly kind: 'committed' | 'duplicate' }>;

export function commitTransaction(
  db: Database,
  prepared: PreparedCommitCommand,
  options: ConfigRepositoryOptions,
): CommitDecision {
  readRepositorySnapshot(db);
  const existing = sqliteGet<OperationRow, [string]>(db, `SELECT mutation_id,request_hash,expected_revision,
    committed_revision,kind,target_worker_count,state,result_status,error_code,error_detail,
    drain_recovery_generation,last_drain_recovery_previous_generation,created_at,updated_at
    FROM configuration_operations WHERE mutation_id=?`, prepared.mutationId);
  if (existing !== null) {
    const operation = operationFromRow(existing);
    if (operation.request_hash !== prepared.requestHash) {
      return { kind: 'idempotency_key_reused', mutation_id: prepared.mutationId };
    }
    return { kind: 'duplicate', operation };
  }
  const state = sqliteAll<StateRow, []>(db, `SELECT active_revision FROM configuration_state WHERE id=1`)[0];
  if (state === undefined) throw new ConfigRepositoryError('schema_corrupt', 'configuration state is missing');
  if (state.active_revision !== prepared.expectedRevision) {
    return { kind: 'stale_revision', expected_revision: prepared.expectedRevision, active_revision: state.active_revision };
  }
  const activeRow = sqliteGet<OperationRow, [number]>(db, `SELECT mutation_id,request_hash,expected_revision,
    committed_revision,kind,target_worker_count,state,result_status,error_code,error_detail,
    drain_recovery_generation,last_drain_recovery_previous_generation,created_at,updated_at
    FROM configuration_operations WHERE committed_revision=?`, state.active_revision);
  if (activeRow !== null) {
    const active = operationFromRow(activeRow);
    if (active.state === 'committed' || active.state === 'publishing' || active.state === 'draining') {
      return { kind: 'operation_in_progress', mutation_id: active.mutation_id,
        committed_revision: active.committed_revision, state: active.state };
    }
  }
  if (state.active_revision === Number.MAX_SAFE_INTEGER) {
    throw new ConfigRepositoryError('repository_failure', 'configuration revision limit reached');
  }
  const committedRevision = state.active_revision + 1;
  replaceActiveMaterialization(db, prepared.aggregate);
  options.faultInjection?.('after_materialization');
  db.run(`INSERT INTO configuration_revisions (revision,content_hash,kind,created_at) VALUES (?,?,?,?)`,
    [committedRevision, prepared.contentHash, prepared.kind, prepared.createdAt]);
  db.run(`INSERT INTO configuration_operations
    (mutation_id,request_hash,expected_revision,committed_revision,kind,state,result_status,error_code,error_detail,
     drain_recovery_generation,last_drain_recovery_previous_generation,target_worker_count,created_at,updated_at)
    VALUES (?,?,?,?,?,'committed',NULL,NULL,NULL,0,NULL,?,?,?)`, [
    prepared.mutationId, prepared.requestHash, prepared.expectedRevision, committedRevision,
    prepared.kind, prepared.targetSlots.length, prepared.createdAt, prepared.createdAt,
  ]);
  for (const workerSlot of prepared.targetSlots) {
    db.run(`INSERT INTO configuration_operation_workers
      (mutation_id,worker_slot,target_revision,drain_recovery_generation,
       attempt_no,last_begin_previous_attempt_no,last_begin_reason,
       state,applied_revision,last_error,updated_at) VALUES (?,?,?,0,0,NULL,NULL,'pending',NULL,NULL,?)`,
    [prepared.mutationId, workerSlot, committedRevision, prepared.createdAt]);
  }
  options.faultInjection?.('after_targets');
  const changed = db.run(`UPDATE configuration_state
    SET active_revision=?,updated_at=? WHERE id=1 AND active_revision=?`, [
    committedRevision, prepared.createdAt, prepared.expectedRevision,
  ]).changes;
  if (changed !== 1) throw new ConfigRepositoryError('repository_failure', 'configuration state CAS update failed');
  verifyRepositoryIntegrity(db);
  return { kind: 'committed', operation: {
    mutation_id: prepared.mutationId, request_hash: prepared.requestHash,
    expected_revision: prepared.expectedRevision, committed_revision: committedRevision,
    kind: prepared.kind, target_worker_count: prepared.targetSlots.length,
    drain_recovery_generation: 0, last_drain_recovery_previous_generation: null,
    state: 'committed', result_status: null, error_code: null, error_detail: null,
    created_at: prepared.createdAt, updated_at: prepared.createdAt,
  } };
}
