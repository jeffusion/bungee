import { Database } from 'bun:sqlite';

export type SqliteJournalMode = 'wal' | 'delete';

export class SqliteVersionError extends Error {
  readonly name = 'SqliteVersionError';
  constructor(readonly version: string) {
    super(`Unsupported SQLite version ${version}`);
  }
}

function parseVersion(version: string): [number, number, number] | null {
  if (typeof version !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null || match[0] !== version) return null;
  const result = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return result.every(Number.isSafeInteger) ? result : null;
}

function atLeast(major: number, minor: number, patch: number, required: [number, number, number]): boolean {
  return major === required[0] && (
    minor > required[1] || (minor === required[1] && patch >= required[2])
  );
}

function isSupported(version: string, journalMode: SqliteJournalMode): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  if (journalMode !== 'wal' && journalMode !== 'delete') return false;
  if (journalMode === 'delete') return atLeast(...parsed, [3, 37, 0]);
  const [major, minor, patch] = parsed;
  return major === 3 && (
    minor >= 52 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7)
      || (minor === 44 && patch >= 6)
  );
}

export function assertSupportedSqliteVersion(
  version: string,
  journalMode: SqliteJournalMode = 'wal',
): void {
  if (!isSupported(version, journalMode)) {
    throw new SqliteVersionError(version);
  }
}

export function selectAccessJournalMode(version: string): SqliteJournalMode {
  assertSupportedSqliteVersion(version, 'delete');
  return isSupported(version, 'wal') ? 'wal' : 'delete';
}

export function readSqliteVersion(db: Database): string {
  const row = db.query<{ v: string }, []>('SELECT sqlite_version() AS v').get();
  if (row === null || row === undefined || typeof row.v !== 'string' || parseVersion(row.v) === null) {
    throw new SqliteVersionError('unknown');
  }
  return row.v;
}
