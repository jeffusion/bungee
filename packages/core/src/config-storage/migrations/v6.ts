import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from '../repository-types';
import { sqliteGet } from '../sqlite-query';

type SchemaRow = { readonly sql: string | null };

const CONTROL_READINESS_ERROR_CODES = "error_code IN ('replacement_convergence_failed','old_worker_drain_failed','control_readiness_failed')";
const CONTROL_READINESS_GENERATION_CHECK = "(error_code <> 'replacement_convergence_failed' OR drain_recovery_generation=0)";
const LEGACY_ERROR_CODES = "error_code IN ('replacement_convergence_failed','old_worker_drain_failed')";
const LEGACY_GENERATION_CHECK = "(error_code='old_worker_drain_failed' OR drain_recovery_generation=0)";

function tableSql(db: Database, table: string): string {
  const row = sqliteGet<SchemaRow, [string]>(db,
    'SELECT sql FROM sqlite_schema WHERE type=\'table\' AND name=?', table);
  if (row?.sql === null || row?.sql === undefined) {
    throw new ConfigRepositoryError('schema_corrupt', `configuration table ${table} is missing`);
  }
  return row.sql;
}

export const CONFIG_MIGRATION_V6 = {
  version: 6,
  name: 'control_readiness_terminal_operations',
  up(db: Database): void {
    const operationsSql = tableSql(db, 'configuration_operations');
    const workersSql = tableSql(db, 'configuration_operation_workers');
    if (!operationsSql.includes(LEGACY_ERROR_CODES) || !operationsSql.includes(LEGACY_GENERATION_CHECK)) {
      throw new ConfigRepositoryError('schema_corrupt', 'configuration operation CHECK constraint is missing');
    }
    const updatedOperationsSql = operationsSql
      .replace(LEGACY_ERROR_CODES, CONTROL_READINESS_ERROR_CODES)
      .replace(LEGACY_GENERATION_CHECK, CONTROL_READINESS_GENERATION_CHECK);
    if (updatedOperationsSql === operationsSql) {
      throw new ConfigRepositoryError('schema_corrupt', 'configuration operation CHECK constraint is missing');
    }

    db.run('ALTER TABLE configuration_operation_workers RENAME TO configuration_operation_workers_v5');
    db.run('ALTER TABLE configuration_operations RENAME TO configuration_operations_v5');
    db.run(updatedOperationsSql);
    db.run('INSERT INTO configuration_operations SELECT * FROM configuration_operations_v5');
    db.run(workersSql);
    db.run('INSERT INTO configuration_operation_workers SELECT * FROM configuration_operation_workers_v5');
    db.run('DROP TABLE configuration_operation_workers_v5');
    db.run('DROP TABLE configuration_operations_v5');
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
