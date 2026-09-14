import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSqliteVersion, selectAccessJournalMode } from '../../src/config-storage/sqlite-version';
import { MigrationManager } from '../../src/migrations/migration-manager';
import { createMasterStats, MasterStatsInitializationError } from '../../src/master-runtime/master-stats';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('queries only the configured access database and closes its read-only connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-master-stats-'));
  directories.push(directory);
  const databasePath = join(directory, 'persisted-access.db');
  expect((await new MigrationManager(databasePath).migrate()).success).toBe(true);

  const database = new Database(databasePath);
  database.prepare(`
    INSERT INTO access_logs (request_id, timestamp, method, path, status, duration, success, created_at, request_type)
    VALUES (?, ?, 'GET', '/completed', 200, 25, 1, ?, 'final')
  `).run('completed', 1_000, 1);
  database.close();

  const stats = createMasterStats(databasePath);
  const snapshot = await stats.handle(new Request('http://localhost/api/stats'));
  expect(snapshot.status).toBe(200);
  expect((await snapshot.json()).totalRequests).toBe(1);
  expect((await stats.handle(new Request('http://localhost/__ui/api/stats'))).status).toBe(200);
  expect((await stats.handle(new Request('http://localhost/api/stats/history?interval=bad'))).status).toBe(400);
  expect((await stats.handle(new Request('http://localhost/api/stats/not-a-route'))).status).toBe(404);

  await stats.close();
  await stats.close();
  expect((await stats.handle(new Request('http://localhost/api/stats'))).status).toBe(404);
});

test('uses the runtime-selected journal and synchronous modes for master stats', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-master-stats-journal-'));
  directories.push(directory);
  const databasePath = join(directory, 'access.db');
  expect((await new MigrationManager(databasePath).migrate()).success).toBe(true);
  const setup = new Database(databasePath);
  const journalMode = selectAccessJournalMode(readSqliteVersion(setup));
  expect(setup.query<{ readonly journal_mode: string }, []>(`PRAGMA journal_mode = ${journalMode}`).get()?.journal_mode).toBe(journalMode);
  setup.close(true);

  const stats = createMasterStats(databasePath);
  expect(stats.getDatabase().query<{ readonly journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe(journalMode);
  expect(stats.getDatabase().query<{ readonly synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(journalMode === 'wal' ? 1 : 2);
  await stats.close();
});

test('closes after an in-flight query and preserves its response when close succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-master-stats-drain-'));
  directories.push(directory);
  const databasePath = join(directory, 'access.db');
  expect((await new MigrationManager(databasePath).migrate()).success).toBe(true);
  const stats = createMasterStats(databasePath);

  const response = stats.handle(new Request('http://localhost/api/stats'));
  const closing = stats.close();
  expect((await response).status).toBe(200);
  await closing;
});

test('closes an initialized database when initialization fails', () => {
  const failure = new Error('pragma failed');
  let closeCalls = 0;
  const database = {
    run() { throw failure; },
    query(sql: string) { return { get: () => sql.includes('sqlite_version') ? { v: '3.53.0' } : { journal_mode: 'delete' } }; },
    close() { closeCalls += 1; },
  } as unknown as Database;

  expect(() => createMasterStats('/unused.db', () => database)).toThrow(failure);
  expect(closeCalls).toBe(1);
});

test('marks the resource unreleased when initialization and close both fail', () => {
  const initializationFailure = new Error('pragma failed');
  const cleanupFailure = new Error('close failed');
  const database = {
    run() { throw initializationFailure; },
    query(sql: string) { return { get: () => sql.includes('sqlite_version') ? { v: '3.53.0' } : { journal_mode: 'delete' } }; },
    close() { throw cleanupFailure; },
  } as unknown as Database;

  const failure = (() => {
    try { createMasterStats('/unused.db', () => database); }
    catch (error) { return error; }
  })();
  expect(failure).toBeInstanceOf(MasterStatsInitializationError);
  expect((failure as AggregateError).errors).toEqual([initializationFailure, cleanupFailure]);
});

test('reports a close failure once without leaving close callers pending', async () => {
  const failure = new Error('close failed');
  let closeCalls = 0;
  const database = {
    run() {},
    query(sql: string) {
      return { get: () => sql.includes('sqlite_version') ? { v: '3.53.0' }
        : sql.includes('journal_mode') ? { journal_mode: 'delete' }
          : sql.includes('synchronous') ? { synchronous: 2 }
            : sql.includes('foreign_keys') ? { foreign_keys: 1 } : { timeout: 5000 } };
    },
    close() { closeCalls += 1; throw failure; },
  } as unknown as Database;
  const stats = createMasterStats('/unused.db', () => database);

  const first = stats.close();
  expect(stats.close()).toBe(first);
  await expect(first).rejects.toBe(failure);
  expect(closeCalls).toBe(1);
});

test('does not turn an in-flight successful stats response into a close failure', async () => {
  const failure = new Error('close failed');
  const database = {
    run() {},
    query(sql: string) {
      return { get: () => sql.includes('sqlite_version') ? { v: '3.53.0' }
        : sql.includes('journal_mode') ? { journal_mode: 'delete' }
          : sql.includes('synchronous') ? { synchronous: 2 }
            : sql.includes('foreign_keys') ? { foreign_keys: 1 } : { timeout: 5000 } };
    },
    close() { throw failure; },
    prepare(sql: string) {
      return {
        get() {
          return sql.includes('WHERE chain_start_ts')
            ? { total_requests: 0 }
            : { total_requests: 1, success_requests: 1, failed_requests: 0, avg_response_time: 10 };
        },
      };
    },
  } as unknown as Database;
  const stats = createMasterStats('/unused.db', () => database);

  const response = stats.handle(new Request('http://localhost/api/stats'));
  const closing = stats.close();
  expect((await response).status).toBe(200);
  await expect(closing).rejects.toBe(failure);
});
