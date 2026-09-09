import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationManager } from '../../src/migrations';
import { AccessLogWriter } from '../../src/logger/access-log-writer';

describe('AccessLogWriter', () => {
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
