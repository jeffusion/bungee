import type { Database } from 'bun:sqlite';
import { hashConfigurationContent } from './content-hash';
import { auditConfigurationTables, verifyActiveRequestIdentity } from './cross-table-audit';
import { readActiveAggregate, readRawActiveAggregate } from './read-materialization';
import { validatePreDirectionalAggregate } from './directional-migration';
import { verifySchemaFingerprint } from './schema-fingerprint';
import type { RepositorySnapshot } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll, sqliteGet } from './sqlite-query';
import { verifyRecoveryIntegrity } from './recovery-store';
import { withConsistentRead } from './consistent-read';
import { isSqliteBusyError, repositoryFailure } from './sqlite-errors';

function verifyIntegrity(db: Database, allowActiveRecoveryDrift = false, schemaVersion?: number): void {
  verifySchemaFingerprint(db, schemaVersion);
  verifyRecoveryIntegrity(db, allowActiveRecoveryDrift);
  const integrity = sqliteGet<{ readonly integrity_check: string }, []>(db, 'PRAGMA integrity_check')?.integrity_check;
  const foreignKeyFailures = sqliteAll<Record<string, string | number | null>, []>(db, 'PRAGMA foreign_key_check');
  if (integrity !== 'ok' || foreignKeyFailures.length > 0) {
    throw new ConfigRepositoryError('schema_corrupt', 'SQLite integrity checks failed');
  }
}

export function readRepositorySnapshot(
  db: Database,
  allowActiveRecoveryDrift = false,
  schemaVersion?: number,
): RepositorySnapshot {
  try {
    return withConsistentRead(db, () => {
      verifyIntegrity(db, allowActiveRecoveryDrift, schemaVersion);
      const audited = auditConfigurationTables(db);
      const revision = audited.activeRevisionRow;
      // Explicit earlier-migration audits retain the old aggregate/hash. Normal reads
      // and new workers always use the strict directional compiler.
      const historical = schemaVersion !== undefined && schemaVersion < 15
        ? validatePreDirectionalAggregate(readRawActiveAggregate(db)) : undefined;
      if (historical && !historical.ok) throw new ConfigRepositoryError('schema_corrupt', 'historical configuration is invalid', historical.errors);
      const aggregate = historical?.ok ? historical.value : readActiveAggregate(db);
      verifyActiveRequestIdentity(audited, aggregate);
      if (hashConfigurationContent(aggregate) !== revision.content_hash) {
        throw new ConfigRepositoryError('schema_corrupt', 'active configuration content hash does not match');
      }
      return {
        revision: revision.revision,
        content_hash: revision.content_hash,
        aggregate,
      };
    });
  } catch (error) {
    if (error instanceof ConfigRepositoryError) throw error;
    if (isSqliteBusyError(error)) throw repositoryFailure('configuration snapshot read was blocked by SQLite', error);
    throw new ConfigRepositoryError('schema_corrupt', 'configuration snapshot reconstruction failed', error);
  }
}

export function verifyRepositoryIntegrity(db: Database): void {
  try {
    withConsistentRead(db, () => {
      verifyIntegrity(db);
      auditConfigurationTables(db);
    });
  } catch (error) {
    if (error instanceof ConfigRepositoryError) throw error;
    if (isSqliteBusyError(error)) throw repositoryFailure('configuration integrity check was blocked by SQLite', error);
    throw error;
  }
}
