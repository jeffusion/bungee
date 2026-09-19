import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertSupportedSqliteVersion,
  readSqliteVersion,
  selectAccessJournalMode,
  type SqliteJournalMode,
} from './config-storage/sqlite-version';

export type AccessDatabaseSettings = {
  readonly version: string;
  readonly journalMode: SqliteJournalMode;
  readonly synchronous: 'FULL' | 'NORMAL';
};

export class AccessDatabaseJournalModeError extends Error {
  readonly name = 'AccessDatabaseJournalModeError';
  readonly code = 'access_database_journal_mode_conflict';
  readonly action = 'stop-all-bungee-processes-and-convert-offline';

  constructor(
    readonly sqliteVersion: string,
    readonly currentMode: SqliteJournalMode,
    readonly targetMode: SqliteJournalMode,
  ) {
    super(
      `access database journal mode conflict: SQLite ${sqliteVersion} requires ${targetMode}, `
      + `but the database is ${currentMode}; stop all Bungee processes and convert the database offline with a safe SQLite tool`,
    );
  }
}

function pragma<Row>(db: Database, sql: string): Row | null {
  return db.query<Row, []>(sql).get();
}

function readJournalMode(db: Database): SqliteJournalMode {
  const value = pragma<{ readonly journal_mode: unknown }>(db, 'PRAGMA journal_mode')?.journal_mode;
  if (value !== 'wal' && value !== 'delete') {
    throw new Error(`unsupported access database journal mode: ${String(value)}`);
  }
  return value;
}

function synchronousFor(journalMode: SqliteJournalMode): 'FULL' | 'NORMAL' {
  return journalMode === 'wal' ? 'NORMAL' : 'FULL';
}

/** Validate and configure an already selected access-database connection. */
export function initializeAccessDatabaseConnection(db: Database): AccessDatabaseSettings {
  const version = readSqliteVersion(db);
  const journalMode = readJournalMode(db);
  assertSupportedSqliteVersion(version, journalMode);
  const synchronous = synchronousFor(journalMode);

  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`PRAGMA synchronous = ${synchronous}`);

  const actualSynchronous = pragma<{ readonly synchronous: unknown }>(db, 'PRAGMA synchronous')?.synchronous;
  const foreignKeys = pragma<{ readonly foreign_keys: unknown }>(db, 'PRAGMA foreign_keys')?.foreign_keys;
  const busyTimeout = pragma<{ readonly timeout: unknown }>(db, 'PRAGMA busy_timeout')?.timeout;
  if (actualSynchronous !== (synchronous === 'NORMAL' ? 1 : 2) || foreignKeys !== 1 || busyTimeout !== 5000) {
    throw new Error('access database connection invariants were not applied');
  }
  return { version, journalMode, synchronous };
}

export function initializeAccessDatabaseForMasterConnection(db: Database): AccessDatabaseSettings {
  const version = readSqliteVersion(db);
  const targetMode = selectAccessJournalMode(version);
  const currentMode = readJournalMode(db);
  if (targetMode === 'delete' && currentMode === 'wal') {
    throw new AccessDatabaseJournalModeError(version, currentMode, targetMode);
  }
  db.run('PRAGMA busy_timeout = 5000');
  if (currentMode !== targetMode) {
    const selected = pragma<{ readonly journal_mode: unknown }>(db, `PRAGMA journal_mode = ${targetMode}`)?.journal_mode;
    if (selected !== targetMode) {
      throw new Error(`access database journal mode is ${String(selected)}, expected ${targetMode}`);
    }
  }
  return initializeAccessDatabaseConnection(db);
}

/** Select and persist the access journal mode before migrations or schema writes. */
export function selectAccessDatabaseJournalMode(dbPath: string): AccessDatabaseSettings {
  mkdirSync(dirname(dbPath), { recursive: true });
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { create: true, readwrite: true, strict: true });
    return initializeAccessDatabaseForMasterConnection(db);
  } finally {
    db?.close(true);
  }
}

export function initializeAccessDatabaseForMaster(dbPath: string): AccessDatabaseSettings {
  return selectAccessDatabaseJournalMode(dbPath);
}
