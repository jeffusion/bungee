import { ConfigRepositoryError } from './repository-types';

type SqliteError = Error & { readonly code?: string; readonly errno?: number };

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as SqliteError;
  const errno = sqliteError.errno;
  if (typeof errno === 'number' && ((errno & 0xff) === 5 || (errno & 0xff) === 6)) return true;
  const code = sqliteError.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || code?.startsWith('SQLITE_BUSY_') === true
    || code?.startsWith('SQLITE_LOCKED_') === true;
}

export function repositoryFailure(message: string, cause: unknown): ConfigRepositoryError {
  return new ConfigRepositoryError('repository_failure', message, cause);
}
