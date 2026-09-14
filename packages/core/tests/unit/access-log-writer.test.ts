import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationManager } from '../../src/migrations';
import { AccessLogWriter } from '../../src/logger/access-log-writer';

describe('AccessLogWriter', () => {
  test('skips duplicate request IDs without blocking later batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-writer-'));
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
  });

  test('retries a transient flush failure without losing its batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-writer-'));
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

      await expect(writer.flush()).rejects.toThrow('database is locked');
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
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-writer-'));
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

      await expect(writer.close()).rejects.toThrow('database is locked');
      await writer.flush();
      await writer.close();
      writer = null;
    } finally {
      if (writer !== null) await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not transition the journal mode on a migrated access database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-writer-'));
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
    } finally {
      if (writer !== null) await writer.close();
      if (reader !== null) {
        if (reader.inTransaction) reader.run('ROLLBACK');
        reader.close(true);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
