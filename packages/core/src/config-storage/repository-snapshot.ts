import type { Database } from 'bun:sqlite';
import { hashConfigurationContent } from './content-hash';
import { auditConfigurationTables, verifyActiveRequestIdentity } from './cross-table-audit';
import { readActiveAggregate } from './read-materialization';
import { verifySchemaFingerprint } from './schema-fingerprint';
import type { RepositorySnapshot } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll, sqliteGet } from './sqlite-query';
import { verifyRecoveryIntegrity } from './recovery-store';
import { withConsistentRead } from './consistent-read';
import { isSqliteBusyError, repositoryFailure } from './sqlite-errors';

function verifyIntegrity(db: Database, allowActiveRecoveryDrift = false): void {
  verifySchemaFingerprint(db);
  verifyRecoveryIntegrity(db, allowActiveRecoveryDrift);
  const integrity = sqliteGet<{ readonly integrity_check: string }, []>(db, 'PRAGMA integrity_check')?.integrity_check;
  const foreignKeyFailures = sqliteAll<Record<string, string | number | null>, []>(db, 'PRAGMA foreign_key_check');
  if (integrity !== 'ok' || foreignKeyFailures.length > 0) {
    throw new ConfigRepositoryError('schema_corrupt', 'SQLite integrity checks failed');
  }
}

export function readRepositorySnapshot(db: Database, allowActiveRecoveryDrift = false): RepositorySnapshot {
  try {
    return withConsistentRead(db, () => {
      verifyIntegrity(db, allowActiveRecoveryDrift);
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
