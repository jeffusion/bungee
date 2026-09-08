import type { Database } from 'bun:sqlite';
import { requireSafeInteger } from '../persisted-validation';
import { ConfigRepositoryError } from '../repository-types';
import { verifySchemaFingerprint } from '../schema-fingerprint';
import { sqliteAll, sqliteGet } from '../sqlite-query';
import { CONFIG_MIGRATION_V1 } from './v1';
import { CONFIG_MIGRATION_V2 } from './v2';
import { CONFIG_MIGRATION_V3 } from './v3';
import { CONFIG_MIGRATION_V4 } from './v4';
import { CONFIG_MIGRATION_V5 } from './v5';

type TableRow = { readonly name: string };
type MigrationRow = { readonly version: number; readonly name: string };
const CONFIG_MIGRATIONS = [
  CONFIG_MIGRATION_V1,
  CONFIG_MIGRATION_V2,
  CONFIG_MIGRATION_V3,
  CONFIG_MIGRATION_V4,
  CONFIG_MIGRATION_V5,
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

const REQUIRED_TABLES = [
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
  'upstreams',
] as const;

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
  const requiredTables = expectedVersion < 5 ? REQUIRED_TABLES_BEFORE_V5 : REQUIRED_TABLES;
  if (tables.length !== requiredTables.length || requiredTables.some((name, index) => tables[index] !== name)) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration schema table set is invalid');
  }
  const migrations = readMigrationPrefix(db);
  if (migrations.length !== expectedVersion) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration migration version is unsupported');
  }
}

export function migrateConfigurationDatabase(db: Database): void {
  const count = sqliteGet<{ readonly count: number }, []>(db, `SELECT count(*) AS count FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'`)?.count;
  if (count === 0) {
    try {
      db.transaction(() => {
        for (const migration of CONFIG_MIGRATIONS) migration.up(db);
      }).immediate();
    } catch (error) {
      if (error instanceof ConfigRepositoryError) throw error;
      throw new ConfigRepositoryError('migration_failed', 'configuration initialization migration failed', error);
    }
    verifyInitializedSchema(db);
    return;
  }
  const applied = readMigrationPrefix(db);
  verifyInitializedSchema(db, applied.length);
  if (applied.length < CONFIG_MIGRATIONS.length) {
    try {
      db.transaction(() => {
        for (const migration of CONFIG_MIGRATIONS.slice(applied.length)) migration.up(db);
      }).immediate();
    } catch (error) {
      if (error instanceof ConfigRepositoryError) throw error;
      throw new ConfigRepositoryError('migration_failed', 'configuration upgrade migration failed', error);
    }
  }
  verifyInitializedSchema(db);
}
