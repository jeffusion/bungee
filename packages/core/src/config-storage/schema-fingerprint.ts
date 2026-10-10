import { Database } from 'bun:sqlite';
import { databaseSchemaDescriptor } from '../database-schema';
import { CONFIG_MIGRATIONS, CONFIG_SCHEMA_VERSION, type ConfigMigration } from './migrations/plan';
import { ConfigRepositoryError } from './repository-types';
import { canonicalJson } from './content-hash';
import { sqliteAll } from './sqlite-query';

/** Bounded mutation guard: schema objects only, without table contents or page scans. */
export function readSchemaObjectFingerprint(db: Database): string {
  return canonicalJson(sqliteAll<Record<string, unknown>, []>(db, `SELECT type,name,tbl_name,sql
    FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`));
}

const expectedDescriptors = new Map<number, string>();

export function verifySchemaFingerprint(
  db: Database,
  version = CONFIG_SCHEMA_VERSION,
  plan: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
): void {
  if (!plan.some(migration => migration.version === version)) {
    throw new ConfigRepositoryError('schema_corrupt', 'unsupported configuration schema version');
  }
  let expected = plan === CONFIG_MIGRATIONS ? expectedDescriptors.get(version) : undefined;
  if (expected === undefined) {
    const reference = new Database(':memory:', { strict: true });
    try {
      for (const migration of plan.filter(migration => migration.version <= version)) migration.up(reference);
      expected = databaseSchemaDescriptor(reference);
    } finally {
      reference.close(true);
    }
    if (plan === CONFIG_MIGRATIONS) expectedDescriptors.set(version, expected);
  }
  if (databaseSchemaDescriptor(db) !== expected) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration schema fingerprint is invalid');
  }
}
