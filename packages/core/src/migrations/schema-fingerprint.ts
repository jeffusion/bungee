import { Database } from 'bun:sqlite';
import { databaseSchemaDescriptor } from '../database-schema';
import { migrations } from './index';
import type { Migration } from './migration.types';

const descriptors = new Map<string, string>();

export function verifyAccessSchema(
  db: Database,
  version = migrations.at(-1)!.version,
  plan: readonly Migration[] = migrations,
): void {
  if (!plan.some(migration => migration.version === version)) throw new Error('access_schema_version_unsupported');
  let expected = plan === migrations ? descriptors.get(version) : undefined;
  if (expected === undefined) {
    const reference = new Database(':memory:');
    try {
      for (const migration of plan.filter(migration => migration.version <= version)) migration.up(reference);
      expected = databaseSchemaDescriptor(reference);
    } finally {
      reference.close();
    }
    if (plan === migrations) descriptors.set(version, expected);
  }
  if (databaseSchemaDescriptor(db) !== expected) throw new Error('access_schema_corrupt');
}
