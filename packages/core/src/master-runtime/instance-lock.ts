import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { constants as sqliteConstants, Database } from 'bun:sqlite';

const SQLITE_HEADER = 'SQLite format 3\0';
const APPLICATION_ID = 0x42554e47;
const USER_VERSION = 1;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_OPEN_READWRITE_NOFOLLOW = sqliteConstants.SQLITE_OPEN_READWRITE
  | sqliteConstants.SQLITE_OPEN_NOFOLLOW;
const SQLITE_OPEN_READWRITE_CREATE_NOFOLLOW = SQLITE_OPEN_READWRITE_NOFOLLOW
  | sqliteConstants.SQLITE_OPEN_CREATE;

type DatabaseError = Error & {
  readonly code?: string;
  readonly errno?: number;
};

export type MasterInstanceLock = {
  readonly path: string;
  readonly release: () => Promise<void>;
};

export type MasterInstanceLockErrorCode = 'held' | 'invalid' | 'io';

type InternalInstanceLockOperations = {
  readonly afterPublish?: (temporaryPath: string) => void | Promise<void>;
};

export class MasterInstanceLockError extends Error {
  readonly name = 'MasterInstanceLockError';

  constructor(
    readonly code: MasterInstanceLockErrorCode,
    readonly path: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

function errno(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return typeof descriptor?.value === 'string' ? descriptor.value : undefined;
}

function sqliteCode(error: unknown): string | undefined {
  return error instanceof Error && typeof (error as DatabaseError).code === 'string'
    ? (error as DatabaseError).code
    : undefined;
}

function sqliteErrno(error: unknown): number | undefined {
  return error instanceof Error && typeof (error as DatabaseError).errno === 'number'
    ? (error as DatabaseError).errno
    : undefined;
}

function isBusy(error: unknown): boolean {
  const code = sqliteErrno(error);
  if (code !== undefined) return (code & 0xff) === 5 || (code & 0xff) === 6;
  const name = sqliteCode(error);
  return name === 'SQLITE_BUSY' || name === 'SQLITE_LOCKED'
    || name?.startsWith('SQLITE_BUSY_') === true
    || name?.startsWith('SQLITE_LOCKED_') === true;
}

function invalidDatabaseError(path: string, message: string, cause?: unknown): MasterInstanceLockError {
  return new MasterInstanceLockError('invalid', path, message, cause);
}

async function validateParent(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    const status = await lstat(parent);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw invalidDatabaseError(path, 'lock parent must be a non-symlink directory');
    }
  } catch (error) {
    if (error instanceof MasterInstanceLockError) throw error;
    if (errno(error) === 'ENOENT') {
      try {
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const status = await lstat(parent);
        if (status.isSymbolicLink() || !status.isDirectory()) {
          throw invalidDatabaseError(path, 'lock parent must be a non-symlink directory');
        }
        return;
      } catch (createError) {
        if (createError instanceof MasterInstanceLockError) throw createError;
        throw new MasterInstanceLockError('io', path, 'failed to create lock parent', createError);
      }
    }
    throw new MasterInstanceLockError('io', path, 'failed to inspect lock parent', error);
  }
}

async function isMissing(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw invalidDatabaseError(path, 'instance lock must be a non-symlink regular file');
    }
    return false;
  } catch (error) {
    if (error instanceof MasterInstanceLockError) throw error;
    if (errno(error) === 'ENOENT') return true;
    throw new MasterInstanceLockError('io', path, 'failed to inspect instance lock', error);
  }
}

async function readSqliteHeader(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (errno(error) === 'ELOOP' || errno(error) === 'ENOENT') {
      throw invalidDatabaseError(path, 'instance lock is not a stable regular file', error);
    }
    throw new MasterInstanceLockError('io', path, 'failed to open instance lock', error);
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) throw invalidDatabaseError(path, 'instance lock must be a regular file');
    const buffer = Buffer.alloc(SQLITE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (before.ino !== after.ino || bytesRead < SQLITE_HEADER_BYTES
      || buffer.subarray(0, SQLITE_HEADER.length).toString('latin1') !== SQLITE_HEADER) {
      throw invalidDatabaseError(path, 'instance lock does not contain a SQLite database');
    }
  } catch (error) {
    if (error instanceof MasterInstanceLockError) throw error;
    throw new MasterInstanceLockError('io', path, 'failed to read instance lock header', error);
  } finally {
    await handle.close();
  }
}

function inspectMetadata(db: Database, path: string): void {
  let applicationId: unknown;
  let userVersion: unknown;
  let journalMode: unknown;
  try {
    applicationId = db.query('PRAGMA application_id').get();
    userVersion = db.query('PRAGMA user_version').get();
    journalMode = db.query('PRAGMA journal_mode').get();
  } catch (error) {
    if (isBusy(error)) throw new MasterInstanceLockError('held', path, 'instance lock is busy', error);
    throw invalidDatabaseError(path, 'failed to inspect instance lock SQLite metadata', error);
  }

  const application = applicationId !== null && typeof applicationId === 'object'
    ? Reflect.get(applicationId, 'application_id')
    : undefined;
  const version = userVersion !== null && typeof userVersion === 'object'
    ? Reflect.get(userVersion, 'user_version')
    : undefined;
  const journal = journalMode !== null && typeof journalMode === 'object'
    ? Reflect.get(journalMode, 'journal_mode')
    : undefined;
  if (application !== APPLICATION_ID || version !== USER_VERSION || journal !== 'delete') {
    throw invalidDatabaseError(path, 'instance lock SQLite metadata is not recognized');
  }
}

function initializeMetadata(db: Database, path: string): void {
  try {
    db.exec(
      `PRAGMA application_id=${APPLICATION_ID}; ` +
      `PRAGMA user_version=${USER_VERSION}; ` +
      'PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0;',
    );
    inspectMetadata(db, path);
    const timeout = db.query('PRAGMA busy_timeout').get();
    if (timeout === null || typeof timeout !== 'object' || Reflect.get(timeout, 'timeout') !== 0) {
      throw invalidDatabaseError(path, 'instance lock SQLite busy timeout is not zero');
    }
  } catch (error) {
    if (error instanceof MasterInstanceLockError) throw error;
    if (isBusy(error)) throw new MasterInstanceLockError('held', path, 'instance lock is busy', error);
    throw new MasterInstanceLockError('io', path, 'failed to initialize instance lock SQLite metadata', error);
  }
}

function openExisting(path: string): Database {
  try {
    const db = new Database(path, SQLITE_OPEN_READWRITE_NOFOLLOW);
    try {
      db.exec('PRAGMA busy_timeout=0');
      inspectMetadata(db, path);
      return db;
    } catch (error) {
      db.close(true);
      throw error;
    }
  } catch (error) {
    if (error instanceof MasterInstanceLockError) throw error;
    if (isBusy(error)) throw new MasterInstanceLockError('held', path, 'instance lock is busy', error);
    if (sqliteCode(error) === 'SQLITE_NOTADB' || sqliteCode(error) === 'SQLITE_CORRUPT') {
      throw invalidDatabaseError(path, 'instance lock is not a valid SQLite database', error);
    }
    throw new MasterInstanceLockError('io', path, 'failed to open instance lock database', error);
  }
}

async function publish(path: string, temporaryPath: string): Promise<boolean> {
  try {
    await link(temporaryPath, path);
    return true;
  } catch (error) {
    if (errno(error) === 'EEXIST') return false;
    throw new MasterInstanceLockError('io', path, 'failed to publish instance lock', error);
  }
}

function beginExclusive(db: Database, path: string): void {
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    if (isBusy(error)) throw new MasterInstanceLockError('held', path, 'instance lock is held', error);
    throw new MasterInstanceLockError('io', path, 'failed to begin instance lock transaction', error);
  }
}

async function closeDatabase(db: Database, rollback: boolean): Promise<void> {
  try {
    if (rollback && db.inTransaction) db.exec('ROLLBACK');
  } finally {
    db.close(true);
  }
}

async function unlinkTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
    throw new MasterInstanceLockError('io', path, 'failed to remove temporary instance lock', error);
  }
}

async function releaseDatabase(db: Database): Promise<void> {
  let rollbackError: unknown;
  try {
    if (db.inTransaction) db.exec('ROLLBACK');
  } catch (error) {
    rollbackError = error;
  }

  let closeError: unknown;
  try {
    db.close(true);
  } catch (error) {
    closeError = error;
  }

  if (rollbackError !== undefined && closeError !== undefined) {
    throw new AggregateError([rollbackError, closeError], 'failed to release instance lock');
  }
  if (rollbackError !== undefined) throw rollbackError;
  if (closeError !== undefined) throw closeError;
}

export async function acquireMasterInstanceLock(
  path: string,
  operations: InternalInstanceLockOperations = {},
): Promise<MasterInstanceLock> {
  await validateParent(path);
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`);
  let db: Database | null = null;
  let temporaryCleanupPending = false;
  let failure: unknown;
  try {
    if (await isMissing(path)) {
      const temporary = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      temporaryCleanupPending = true;
      await temporary.close();
      let temporaryDb: Database | null = null;
      try {
        temporaryDb = new Database(temporaryPath, SQLITE_OPEN_READWRITE_CREATE_NOFOLLOW);
        initializeMetadata(temporaryDb, path);
      } finally {
        if (temporaryDb !== null) await closeDatabase(temporaryDb, false);
      }
      await publish(path, temporaryPath);
      if (operations.afterPublish !== undefined) await operations.afterPublish(temporaryPath);
      try {
        await unlinkTemporary(temporaryPath);
      } finally {
        temporaryCleanupPending = false;
      }
    }

    await readSqliteHeader(path);
    db = openExisting(path);
    if (db === null) throw new MasterInstanceLockError('io', path, 'instance lock database was not opened');
    beginExclusive(db, path);
    const connection = db;
    let releasePromise: Promise<void> | null = null;
    return Object.freeze({
      path,
      async release() {
        if (releasePromise === null) releasePromise = releaseDatabase(connection);
        await releasePromise;
      },
    });
  } catch (error) {
    if (db !== null) {
      try { await closeDatabase(db, true); } catch { /* preserve the acquisition error */ }
      db = null;
    }
    const acquisitionError = error instanceof MasterInstanceLockError
      ? error
      : new MasterInstanceLockError('io', path, 'failed to acquire instance lock', error);
    failure = acquisitionError;
    throw acquisitionError;
  } finally {
    if (temporaryCleanupPending) {
      try {
        await unlinkTemporary(temporaryPath);
      } catch (cleanupError) {
        if (failure !== undefined) {
          throw new AggregateError([failure, cleanupError], 'failed to clean up temporary instance lock');
        }
        throw cleanupError;
      }
    }
  }
}
