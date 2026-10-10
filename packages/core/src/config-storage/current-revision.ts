import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from './repository-types';
import { sqliteGet } from './sqlite-query';

export function readActiveRevision(db: Database): number {
  const revision = sqliteGet<{ active_revision: number }, []>(db,
    'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
  if (revision === undefined || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration state revision is invalid');
  }
  return revision;
}
