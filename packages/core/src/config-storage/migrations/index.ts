import type { Database } from 'bun:sqlite';
import { requireSafeInteger } from '../persisted-validation';
import { ConfigRepositoryError } from '../repository-types';
import { verifySchemaFingerprint } from '../schema-fingerprint';
import { sqliteAll, sqliteGet } from '../sqlite-query';
import { isSqliteBusyError, repositoryFailure } from '../sqlite-errors';
import { CONFIG_MIGRATION_V1 } from './v1';
import { CONFIG_MIGRATION_V2 } from './v2';
import { CONFIG_MIGRATION_V3 } from './v3';
import { CONFIG_MIGRATION_V4 } from './v4';
import { CONFIG_MIGRATION_V5 } from './v5';
import { CONFIG_MIGRATION_V6 } from './v6';
import { CONFIG_MIGRATION_V7 } from './v7';
import { CONFIG_MIGRATION_V8 } from './v8';
import { CONFIG_MIGRATION_V9 } from './v9';
import { CONFIG_MIGRATION_V10 } from './v10';
import { CONFIG_MIGRATION_V11 } from './v11';
import { CONFIG_MIGRATION_V12 } from './v12';
import { CONFIG_MIGRATION_V13 } from './v13';
import { CONFIG_MIGRATION_V14 } from './v14';

import { CONFIG_MIGRATION_V15 } from './v15';
import type { DirectionalMigrationWarning } from '../directional-migration';
import { logger } from '../../logger';

type TableRow = { readonly name: string };
type MigrationRow = { readonly version: number; readonly name: string };
export const CONFIG_MIGRATIONS = [
  CONFIG_MIGRATION_V1,
  CONFIG_MIGRATION_V2,
  CONFIG_MIGRATION_V3,
  CONFIG_MIGRATION_V4,
  CONFIG_MIGRATION_V5,
  CONFIG_MIGRATION_V6,
  CONFIG_MIGRATION_V7,
  CONFIG_MIGRATION_V8,
  CONFIG_MIGRATION_V9,
  CONFIG_MIGRATION_V10,
  CONFIG_MIGRATION_V11,
  CONFIG_MIGRATION_V12,
  CONFIG_MIGRATION_V13,
  CONFIG_MIGRATION_V14,
  CONFIG_MIGRATION_V15,
] as const;

const REQUIRED_TABLES_BEFORE_V5 = [
  'configuration_operation_workers',
  'configuration_operations',
  'configuration_revisions',
  'configuration_state',
  'plugin_activations',
  'plugin_bindings',
  'routes',
  'schema_migrations',
  'services',
  'settings',
  'upstreams',
] as const;

const REQUIRED_TABLES_BEFORE_V8 = [
  'configuration_operation_workers',
  'configuration_operations',
  'configuration_revisions',
  'configuration_state',
  'plugin_activations',
  'plugin_bindings',
  'routes',
  'schema_migrations',
  'secret_store_namespaces',
  'secret_store_objects',
  'services',
  'settings',
  'supervision_state',
  'upstreams',
] as const;

const REQUIRED_TABLES_BEFORE_V13 = [
  'configuration_operation_workers',
  'configuration_operations',
  'configuration_recoveries',
  'configuration_revisions',
  'configuration_serving_snapshots',
  'configuration_state',
  'plugin_activations',
  'plugin_bindings',
  'routes',
  'schema_migrations',
  'secret_store_namespaces',
  'secret_store_objects',
  'services',
  'settings',
  'supervision_state',
  'upstreams',
] as const;

const REQUIRED_TABLES_BEFORE_V14 = [...REQUIRED_TABLES_BEFORE_V13,
  'api_keys', 'plugin_durable_records', 'plugin_durable_commands'].sort();
const REQUIRED_TABLES = [...REQUIRED_TABLES_BEFORE_V14,
  'plugin_communication_reservations', 'plugin_communication_records',
  'plugin_communication_receipts', 'plugin_communication_tombstones',
  'plugin_command_journal_retention'].sort();

const REQUIRED_TABLES_BEFORE_V7 = REQUIRED_TABLES_BEFORE_V8.filter((name) => name !== 'supervision_state');
const REQUIRED_TABLES_BEFORE_V9 = REQUIRED_TABLES_BEFORE_V13.filter((name) => name !== 'configuration_recoveries');

function readMigrationPrefix(db: Database): readonly MigrationRow[] {
  const migrations = sqliteAll<MigrationRow, []>(db, 'SELECT version,name FROM schema_migrations ORDER BY version');
  if (migrations.length === 0 || migrations.length > CONFIG_MIGRATIONS.length) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration migration version is unsupported');
  }
  for (const [index, migration] of migrations.entries()) {
    requireSafeInteger(migration.version, 'schema_migrations.version', 1);
    const expected = CONFIG_MIGRATIONS[index];
    if (expected === undefined || migration.version !== expected.version || migration.name !== expected.name) {
      throw new ConfigRepositoryError('schema_corrupt', 'configuration migration history is not an exact prefix');
    }
  }
  return migrations;
}

function verifyInitializedSchema(db: Database, expectedVersion: number = CONFIG_MIGRATIONS.length): void {
  verifySchemaFingerprint(db, expectedVersion);
  const tables = sqliteAll<TableRow, []>(db, `SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(({ name }) => name);
  const requiredTables = expectedVersion < 5
    ? REQUIRED_TABLES_BEFORE_V5
    : expectedVersion < 7 ? REQUIRED_TABLES_BEFORE_V7
      : expectedVersion < 8 ? REQUIRED_TABLES_BEFORE_V8
        : expectedVersion < 9 ? REQUIRED_TABLES_BEFORE_V9
          : expectedVersion < 13 ? REQUIRED_TABLES_BEFORE_V13
            : expectedVersion < 14 ? REQUIRED_TABLES_BEFORE_V14 : REQUIRED_TABLES;
  if (tables.length !== requiredTables.length || requiredTables.some((name, index) => tables[index] !== name)) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration schema table set is invalid');
  }
  const migrations = readMigrationPrefix(db);
  if (migrations.length !== expectedVersion) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration migration version is unsupported');
  }
}

export function migrateConfigurationDatabase(
  db: Database,
  workerCount?: number,
  faultInjection?: (stage: 'during_v11_after_materialization' | 'during_v12_after_schema_change') => void,
): void {
  let transactionStarted = false;
  const ignoredRules: DirectionalMigrationWarning[] = [];
  try {
    db.run('BEGIN IMMEDIATE');
    transactionStarted = true;
    const count = sqliteGet<{ readonly count: number }, []>(db, `SELECT count(*) AS count FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'`)?.count;
    let unpublishedMigrationRevision: number | undefined;
    const applyMigration = (migration: typeof CONFIG_MIGRATIONS[number]): void => {
      if (migration.version === 11) {
        const before = sqliteGet<{active_revision:number}, []>(db, 'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
        migration.up(db, workerCount,
          faultInjection === undefined ? undefined : () => faultInjection('during_v11_after_materialization'));
        const after = sqliteGet<{active_revision:number}, []>(db, 'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
        if (before !== undefined && after === before + 1) unpublishedMigrationRevision = after;
      } else if (migration.version === 12) migration.up(db,
        faultInjection === undefined ? undefined : () => faultInjection('during_v12_after_schema_change'));
      else if (migration.version === 13 || migration.version === 15) {
        const before = sqliteGet<{active_revision:number}, []>(db, 'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
        if (migration.version === 15) migration.up(db, workerCount, unpublishedMigrationRevision, ignoredRules);
        else migration.up(db, workerCount, unpublishedMigrationRevision);
        const after = sqliteGet<{active_revision:number}, []>(db, 'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
        if (before !== undefined && after === before + 1) unpublishedMigrationRevision = after;
      }
      else migration.up(db);
    };
    if (count === 0) {
      for (const migration of CONFIG_MIGRATIONS) {
        applyMigration(migration);
      }
    } else {
      const applied = readMigrationPrefix(db);
      verifyInitializedSchema(db, applied.length);
      for (const migration of CONFIG_MIGRATIONS.slice(applied.length)) {
        applyMigration(migration);
      }
    }
    verifyInitializedSchema(db);
    db.run('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted && db.inTransaction) db.run('ROLLBACK');
    if (error instanceof ConfigRepositoryError) throw error;
    if (isSqliteBusyError(error)) throw repositoryFailure('configuration migration was blocked by SQLite', error);
    throw new ConfigRepositoryError('migration_failed', 'configuration migration failed', error);
  }
  // Report only committed changes; rollback and a later reopen produce no misleading summary.
  if (ignoredRules.length) logger.warn({ version: 15, ignored_rules: ignoredRules }, 'Incompatible configuration modification rules were ignored during upgrade');
}
