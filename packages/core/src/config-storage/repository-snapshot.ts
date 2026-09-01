import type { Database } from 'bun:sqlite';
import { hashConfigurationContent } from './content-hash';
import { auditConfigurationTables, verifyActiveRequestIdentity } from './cross-table-audit';
import { readActiveAggregate } from './read-materialization';
import { verifySchemaFingerprint } from './schema-fingerprint';
import type { RepositorySnapshot } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll, sqliteGet } from './sqlite-query';

function verifyIntegrity(db: Database): void {
  verifySchemaFingerprint(db);
  const integrity = sqliteGet<{ readonly integrity_check: string }, []>(db, 'PRAGMA integrity_check')?.integrity_check;
  const foreignKeyFailures = sqliteAll<Record<string, string | number | null>, []>(db, 'PRAGMA foreign_key_check');
  if (integrity !== 'ok' || foreignKeyFailures.length > 0) {
    throw new ConfigRepositoryError('schema_corrupt', 'SQLite integrity checks failed');
  }
}

export function readRepositorySnapshot(db: Database): RepositorySnapshot {
  try {
    verifyIntegrity(db);
    const audited = auditConfigurationTables(db);
    const revision = audited.activeRevisionRow;
    const aggregate = readActiveAggregate(db);
    verifyActiveRequestIdentity(audited, aggregate);
    if (hashConfigurationContent(aggregate) !== revision.content_hash) {
      throw new ConfigRepositoryError('schema_corrupt', 'active configuration content hash does not match');
    }
    return {
      revision: revision.revision,
      content_hash: revision.content_hash,
      aggregate,
    };
  } catch (error) {
    if (error instanceof ConfigRepositoryError) throw error;
    throw new ConfigRepositoryError('schema_corrupt', 'configuration snapshot reconstruction failed', error);
  }
}

export function verifyRepositoryIntegrity(db: Database): void {
  verifyIntegrity(db);
  auditConfigurationTables(db);
}
