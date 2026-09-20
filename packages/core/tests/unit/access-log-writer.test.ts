import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MigrationManager } from '../../src/migrations';
import { AccessLogWriter, type AccessLogEntry } from '../../src/logger/access-log-writer';
import { readSqliteVersion, selectAccessJournalMode } from '../../src/config-storage/sqlite-version';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

const sqliteProbe = new Database(':memory:');
const sqliteVersion = readSqliteVersion(sqliteProbe);
const accessJournalMode = selectAccessJournalMode(sqliteVersion);
sqliteProbe.close(true);

describe('AccessLogWriter', () => {
  test('skips duplicate request IDs without blocking later batches', async () => {
    const root = makeCanonicalTempDir('bungee-access-writer');
    const dbPath = join(root, 'access.db');
    let writer: AccessLogWriter | null = null;
    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
      writer = new AccessLogWriter(dbPath);
      const entry = (requestId: string, path: string) => ({
        requestId, timestamp: Date.now(), method: 'GET', path, status: 200, duration: 1,
      });

      writer.write(entry('duplicate', '/first'));
      await writer.flush();
      writer.write(entry('duplicate', '/duplicate'));
      writer.write(entry('innocent', '/innocent'));
      await writer.flush();

      const rows = writer.getDatabase().query<{ readonly request_id: string }, []>(
        'SELECT request_id FROM access_logs ORDER BY request_id',
      ).all();
      expect(rows).toEqual([{ request_id: 'duplicate' }, { request_id: 'innocent' }]);
    } finally {
      if (writer !== null) await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('waits for an active flush and drains entries queued during it', async () => {
    const root = makeCanonicalTempDir('bungee-access-writer');
    const dbPath = join(root, 'access.db');
    let writer: AccessLogWriter | null = null;
    let firstFlush: Promise<void> | null = null;
    let closePromise: Promise<void> | null = null;
    let dbClosed = false;
    // 门闩在 try 外创建：构造函数同步执行，任何失败路径下 finally 都能放行。
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
      writer = new AccessLogWriter(dbPath);
      const entry = (requestId: string, path: string) => ({
        requestId, timestamp: Date.now(), method: 'GET', path, status: 200, duration: 1,
      });

      // 显式信号：started（首批 flushBatch 进入）/ release（放行首批）/
      // settled+error（首批完成或失败），任何断言失败后 finally 仍能释放并 await。
      let signalFirstStarted!: () => void;
      let signalFirstBatchSettled!: () => void;
      let firstBatchError: unknown;
      const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
      const firstBatchSettled = new Promise<void>((resolve) => { signalFirstBatchSettled = resolve; });
      let flushCount = 0;
      const testWriter = writer as unknown as {
        flushBatch(batch: AccessLogEntry[]): Promise<void>;
      };
      const originalFlushBatch = testWriter.flushBatch.bind(writer);
      testWriter.flushBatch = async (batch) => {
        flushCount += 1;
        const gateFirst = flushCount === 1;
        if (gateFirst) signalFirstStarted();
        try {
          if (gateFirst) await firstReleased;
          await originalFlushBatch(batch);
        } catch (error) {
          if (gateFirst) firstBatchError = error;
          throw error;
        } finally {
          if (gateFirst) signalFirstBatchSettled();
        }
      };

      writer.write(entry('first', '/first'));
      firstFlush = writer.flush();
      await firstStarted;

      // active flush 期间入队：应被同一 drain 循环吸收。
      writer.write(entry('second', '/second'));
      writer.updateResponseBodyId('second', 'body-second');

      // close() 是并发等待方：首批被门住时它绝不能落定。
      let closeSettled = false;
      closePromise = writer.close().then(() => { dbClosed = true; });
      void closePromise.then(() => { closeSettled = true; }, () => { closeSettled = true; });
      await Promise.resolve();
      expect(closeSettled).toBeFalse();

      releaseFirst();
      await firstBatchSettled;
      expect(firstBatchError).toBeUndefined();
      // 首批已完成，但 'second' 尚在排空，close 仍在等待整个 drain。
      expect(closeSettled).toBeFalse();

      await Promise.all([firstFlush, closePromise]);
      expect(dbClosed).toBeTrue();
      expect(flushCount).toBe(2);

      const reader = new Database(dbPath, { readonly: true, strict: true });
      try {
        expect(reader.query<{ readonly request_id: string }, [string]>(
          'SELECT request_id FROM access_logs WHERE request_id = ?',
        ).get('first')).toEqual({ request_id: 'first' });
        expect(reader.query<{ readonly request_id: string; readonly resp_body_id: string }, [string]>(
          'SELECT request_id, resp_body_id FROM access_logs WHERE request_id = ?',
        ).get('second')).toEqual({
          request_id: 'second',
          resp_body_id: 'body-second',
        });
      } finally {
        reader.close(true);
      }
    } finally {
      releaseFirst();
      if (firstFlush !== null) await firstFlush.then(() => {}, () => {});
      if (closePromise !== null) await closePromise.then(() => {}, () => {});
      if (writer !== null && !dbClosed) await writer.close().then(() => { dbClosed = true; }, () => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  test('retries a transient flush failure without losing its batch', async () => {
    const root = makeCanonicalTempDir('bungee-access-writer');
    const dbPath = join(root, 'access.db');
    let writer: AccessLogWriter | null = null;
    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
      writer = new AccessLogWriter(dbPath);
      writer.write({ requestId: 'retry', timestamp: Date.now(), method: 'GET', path: '/retry', status: 200, duration: 1 });
      const db = writer.getDatabase();
      const originalRun = (db as unknown as { run: (...args: any[]) => unknown }).run.bind(db);
      let fail = true;
      (db as unknown as { run: (...args: any[]) => unknown }).run = (...args) => {
        if (fail && args[0] === 'BEGIN TRANSACTION') {
          fail = false;
          throw new Error('database is locked');
        }
        return originalRun(...args);
      };

      let flushError: unknown;
      try {
        await writer.flush();
      } catch (error) {
        flushError = error;
      }
      expect(flushError).toBeInstanceOf(Error);
      expect((flushError as Error).message).toContain('database is locked');
      await writer.flush();
      expect(writer.getDatabase().query<{ readonly count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM access_logs WHERE request_id = ?',
      ).get('retry')?.count).toBe(1);
    } finally {
      if (writer !== null) await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports close failure instead of dropping an unflushed queue', async () => {
    const root = makeCanonicalTempDir('bungee-access-writer');
    const dbPath = join(root, 'access.db');
    let writer: AccessLogWriter | null = null;
    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
      writer = new AccessLogWriter(dbPath);
      writer.write({ requestId: 'close-retry', timestamp: Date.now(), method: 'GET', path: '/close-retry', status: 200, duration: 1 });
      const db = writer.getDatabase();
      const originalRun = (db as unknown as { run: (...args: any[]) => unknown }).run.bind(db);
      let fail = true;
      (db as unknown as { run: (...args: any[]) => unknown }).run = (...args) => {
        if (fail && args[0] === 'BEGIN TRANSACTION') {
          fail = false;
          throw new Error('database is locked');
        }
        return originalRun(...args);
      };

      let closeError: unknown;
      try {
        await writer.close();
      } catch (error) {
        closeError = error;
      }
      expect(closeError).toBeInstanceOf(Error);
      expect((closeError as Error).message).toContain('database is locked');
      await writer.flush();
      await writer.close();
      writer = null;
    } finally {
      if (writer !== null) await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not transition the journal mode on a migrated access database', async () => {
    const root = makeCanonicalTempDir('bungee-access-writer');
    const dbPath = join(root, 'access.db');
    let reader: Database | null = null;
    let writer: AccessLogWriter | null = null;
    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();

      reader = new Database(dbPath, { readonly: true, strict: true });
      reader.run('BEGIN');
      expect(reader.query<{ readonly count: number }, []>('SELECT COUNT(*) AS count FROM access_logs').get()?.count).toBe(0);
      expect(reader.query<{ readonly journal_mode: unknown }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');

      writer = new AccessLogWriter(dbPath);
      expect(writer.getDatabase().query<{ readonly journal_mode: unknown }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
      expect(writer.getDatabase().query<{ readonly synchronous: unknown }, []>('PRAGMA synchronous').get()?.synchronous).toBe(2);
    } finally {
      if (writer !== null) await writer.close();
      if (reader !== null) {
        if (reader.inTransaction) reader.run('ROLLBACK');
        reader.close(true);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(accessJournalMode !== 'wal')('preserves a safe WAL database and applies NORMAL synchronous mode', async () => {
    const root = makeCanonicalTempDir('bungee-access-writer');
    const dbPath = join(root, 'access.db');
    let writer: AccessLogWriter | null = null;
    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
      const setup = new Database(dbPath);
      expect(setup.query<{ readonly journal_mode: string }, []>('PRAGMA journal_mode = WAL').get()?.journal_mode).toBe('wal');
      setup.close(true);

      writer = new AccessLogWriter(dbPath);
      expect(writer.getDatabase().query<{ readonly journal_mode: unknown }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(writer.getDatabase().query<{ readonly synchronous: unknown }, []>('PRAGMA synchronous').get()?.synchronous).toBe(1);
    } finally {
      if (writer !== null) await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
