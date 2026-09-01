import { Database } from 'bun:sqlite';

export class SqliteVersionError extends Error {
  readonly name = 'SqliteVersionError';
  constructor(readonly version: string) {
    super(`Unsupported SQLite version ${version}`);
  }
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isSupported(major: number, minor: number, patch: number): boolean {
  if (major !== 3) return false;
  if (minor === 51) return patch >= 3;
  if (minor === 50) return patch >= 7;
  if (minor === 44) return patch >= 6;
  return minor >= 52;
}

export function assertSupportedSqliteVersion(version: string): void {
  const [major, minor, patch] = parseVersion(version);
  if (!isSupported(major, minor, patch)) {
    throw new SqliteVersionError(version);
  }
}

export function readSqliteVersion(db: Database): string {
  const row = db.query<{ v: string }, []>('SELECT sqlite_version() AS v').get();
  if (row === null || row === undefined || typeof row.v !== 'string' || row.v.length === 0) {
    throw new SqliteVersionError('unknown');
  }
  return row.v;
}
