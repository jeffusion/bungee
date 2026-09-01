import type { Database } from 'bun:sqlite';
import { operationFromRow, type OperationRow } from './operation-store';
import { readOperationWorkers } from './operation-records';
import { readRepositorySnapshot } from './repository-snapshot';
import type { ActiveConfigurationPublication, ConfigurationOperation } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll } from './sqlite-query';

type ActiveOperation = Extract<ConfigurationOperation, { readonly result_status: null }>;

function requireActiveOperation(row: OperationRow): ActiveOperation {
  const operation = operationFromRow(row);
  switch (operation.state) {
    case 'committed':
    case 'publishing':
    case 'draining':
      return operation;
    case 'converged':
    case 'degraded':
      throw new ConfigRepositoryError('schema_corrupt', 'terminal operation matched active publication query');
  }
}

export function readActivePublication(db: Database): ActiveConfigurationPublication | null {
  const snapshot = readRepositorySnapshot(db);
  const rows = sqliteAll<OperationRow, []>(db, `SELECT mutation_id,request_hash,expected_revision,
    committed_revision,kind,state,target_worker_count,result_status,error_code,error_detail,
    drain_recovery_generation,last_drain_recovery_previous_generation,created_at,updated_at
    FROM configuration_operations WHERE state IN ('committed','publishing','draining') ORDER BY committed_revision`);
  const row = rows[0];
  if (rows.length > 1) throw new ConfigRepositoryError('schema_corrupt', 'multiple active publications exist');
  if (row === undefined) return null;

  const operation = requireActiveOperation(row);
  const targets = readOperationWorkers(db, operation.mutation_id);
  const uniqueSlots = new Set(targets.map(({ worker_slot }) => worker_slot));
  if (targets.length !== operation.target_worker_count || uniqueSlots.size !== targets.length) {
    throw new ConfigRepositoryError('schema_corrupt', 'active publication target cardinality is incoherent');
  }
  if (snapshot.revision !== operation.committed_revision ||
      targets.some(({ target_revision }) => target_revision !== snapshot.revision)) {
    throw new ConfigRepositoryError('schema_corrupt', 'active publication revision is incoherent');
  }
  return { operation, snapshot, targets };
}
