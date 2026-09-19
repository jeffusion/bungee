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

type TableRow = { readonly name: string };
type MigrationRow = { readonly version: number; readonly name: string };
const CONFIG_MIGRATIONS = [
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

const REQUIRED_TABLES = [
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

const REQUIRED_TABLES_BEFORE_V7 = REQUIRED_TABLES_BEFORE_V8.filter((name) => name !== 'supervision_state');
const REQUIRED_TABLES_BEFORE_V9 = REQUIRED_TABLES.filter((name) => name !== 'configuration_recoveries');

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
        : expectedVersion < 9 ? REQUIRED_TABLES_BEFORE_V9 : REQUIRED_TABLES;
  if (tables.length !== requiredTables.length || requiredTables.some((name, index) => tables[index] !== name)) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration schema table set is invalid');
  }
  const migrations = readMigrationPrefix(db);
  if (migrations.length !== expectedVersion) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration migration version is unsupported');
  }
}

export function migrateConfigurationDatabase(db: Database): void {
  let transactionStarted = false;
  try {
    db.run('BEGIN IMMEDIATE');
    transactionStarted = true;
    const count = sqliteGet<{ readonly count: number }, []>(db, `SELECT count(*) AS count FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'`)?.count;
    if (count === 0) {
      for (const migration of CONFIG_MIGRATIONS) migration.up(db);
    } else {
      const applied = readMigrationPrefix(db);
      verifyInitializedSchema(db, applied.length);
      for (const migration of CONFIG_MIGRATIONS.slice(applied.length)) migration.up(db);
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
}
