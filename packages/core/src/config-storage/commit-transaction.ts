import { readManagementProtection, writeManagementProtection } from './management-protection';
import type { Database } from 'bun:sqlite';
import { replaceActiveMaterialization } from './materialize';
import { operationFromRow, type OperationRow } from './operation-store';
import type { PreparedCommitCommand } from './prepared-command';
import { readActiveRevision } from './current-revision';
import type { CommitConfigurationResult, ConfigurationOperation, ConfigRepositoryOptions, RepositorySnapshot } from './repository-types';
import { readActivePublication } from './active-publication';
import { readOperationWorkers } from './operation-records';
import { validateOperationIdentity } from './operation-relations';
import { ConfigRepositoryError } from './repository-types';
import { sqliteGet } from './sqlite-query';
import { CURRENT_RUNTIME_EPOCH } from './runtime-cutover';

export type CommitDecision =
  | { readonly kind: 'committed'; readonly operation: ConfigurationOperation }
  | { readonly kind: 'duplicate'; readonly operation: ConfigurationOperation }
  | Exclude<CommitConfigurationResult, { readonly kind: 'committed' | 'duplicate' }>;

export function commitTransaction(
  db: Database,
  prepared: PreparedCommitCommand,
  options: ConfigRepositoryOptions,
  snapshot: RepositorySnapshot,
  offlineManagement = false,
): CommitDecision {
  const existing = sqliteGet<OperationRow, [string]>(db, `SELECT mutation_id,request_hash,expected_revision,
    committed_revision,kind,target_worker_count,state,result_status,error_code,error_detail,
    drain_recovery_generation,last_drain_recovery_previous_generation,plugin_catalog_hash,cancel_requested,
    prepare_started,created_at,updated_at
    FROM configuration_operations WHERE mutation_id=?`, prepared.mutationId);
  if (existing !== null) {
    const operation = operationFromRow(existing);
    if (operation.request_hash !== prepared.requestHash) {
      return { kind: 'idempotency_key_reused', mutation_id: prepared.mutationId };
    }
    return { kind: 'duplicate', operation };
  }
  const activeRevision = readActiveRevision(db);
  if (activeRevision !== prepared.expectedRevision) {
    return { kind: 'stale_revision', expected_revision: prepared.expectedRevision, active_revision: activeRevision };
  }
  if (activeRevision === Number.MAX_SAFE_INTEGER) {
    throw new ConfigRepositoryError('repository_failure', 'configuration revision limit reached');
  }
  const protection = readManagementProtection(db);
  if (!offlineManagement && protection.required && prepared.managementProvider !== protection.selectedProvider) {
    throw new ConfigRepositoryError('invalid_configuration', 'selected management provider can only be changed offline');
  }
  if (prepared.managementProvider !== null && !prepared.aggregate.plugin_activations.some(a => a.plugin_name === prepared.managementProvider)) {
    throw new ConfigRepositoryError('invalid_configuration', 'selected management provider activation is missing');
  }
  // The latest and running projections must stay self-consistent; neither blocks newer expectations.
  const latestRow = sqliteGet<OperationRow, [number]>(db, `SELECT mutation_id,request_hash,expected_revision,
    committed_revision,kind,target_worker_count,state,result_status,error_code,error_detail,
    drain_recovery_generation,last_drain_recovery_previous_generation,plugin_catalog_hash,cancel_requested,
    prepare_started,created_at,updated_at
    FROM configuration_operations WHERE committed_revision=?`, activeRevision);
  if (latestRow !== null) {
    if (snapshot.revision !== activeRevision) {
      throw new ConfigRepositoryError('schema_corrupt', 'repository snapshot disagrees with the latest revision');
    }
    const latest = operationFromRow(latestRow);
    validateOperationIdentity(db, latest, readOperationWorkers(db, latest.mutation_id), snapshot);
  }
  if (!offlineManagement) readActivePublication(db);
  const committedRevision = activeRevision + 1;
  replaceActiveMaterialization(db, prepared.aggregate);
  options.faultInjection?.('after_materialization');
  db.run(`INSERT INTO configuration_revisions (revision,content_hash,kind,created_at) VALUES (?,?,?,?)`,
    [committedRevision, prepared.contentHash, prepared.kind, prepared.createdAt]);
  db.run(`INSERT INTO configuration_operations
    (mutation_id,request_hash,expected_revision,committed_revision,kind,state,result_status,error_code,error_detail,
     drain_recovery_generation,last_drain_recovery_previous_generation,plugin_catalog_hash,cancel_requested,
     prepare_started,target_worker_count,created_at,updated_at,runtime_epoch)
    VALUES (?,?,?,?,?,'pending',NULL,NULL,NULL,0,NULL,NULL,0,0,?,?,?,${CURRENT_RUNTIME_EPOCH})`, [
    prepared.mutationId, prepared.requestHash, prepared.expectedRevision, committedRevision,
    prepared.kind, prepared.targetSlots.length, prepared.createdAt, prepared.createdAt,
  ]);
  db.run('UPDATE configuration_operations SET management_provider=?,offline_management=? WHERE mutation_id=?',
    [prepared.managementProvider, offlineManagement ? 1 : 0, prepared.mutationId]);
  writeManagementProtection(db, protection, prepared.managementProvider);
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
  return { kind: 'committed', operation: {
    mutation_id: prepared.mutationId, request_hash: prepared.requestHash,
    expected_revision: prepared.expectedRevision, committed_revision: committedRevision,
    kind: prepared.kind, target_worker_count: prepared.targetSlots.length,
    drain_recovery_generation: 0, last_drain_recovery_previous_generation: null,
    plugin_catalog_hash: null, cancel_requested: false, prepare_started: false,
    state: 'pending', result_status: null, error_code: null, error_detail: null,
    created_at: prepared.createdAt, updated_at: prepared.createdAt,
  } };
}
