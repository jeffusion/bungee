import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccessDatabaseJournalModeError,
  initializeAccessDatabaseForMasterConnection,
  initializeAccessDatabaseConnection,
  selectAccessDatabaseJournalMode,
} from '../../src/access-database';
import { readSqliteVersion, selectAccessJournalMode } from '../../src/config-storage/sqlite-version';
import { MigrationManager } from '../../src/migrations/migration-manager';

describe('access database SQLite contract', () => {
  test('selects and verifies the runtime-safe WAL mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-database-'));
    const dbPath = join(root, 'access.db');
    try {
      const probe = new Database(dbPath);
      const version = readSqliteVersion(probe);
      probe.close();

      const selected = selectAccessDatabaseJournalMode(dbPath);
      expect(selected.journalMode).toBe(selectAccessJournalMode(version));
      expect(selected.synchronous).toBe(selected.journalMode === 'wal' ? 'NORMAL' : 'FULL');

      const db = new Database(dbPath);
      expect(initializeAccessDatabaseConnection(db)).toEqual(selected);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('switches an existing database to the selected mode before migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-database-'));
    const dbPath = join(root, 'access.db');
    try {
      const db = new Database(dbPath);
      db.run('PRAGMA journal_mode = DELETE');
      db.close();
      const selected = selectAccessDatabaseJournalMode(dbPath);
      const check = new Database(dbPath);
      expect(check.query<{ readonly journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode)
        .toBe(selected.journalMode);
      check.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed for an unknown current journal mode', () => {
    const fake = {
      query(sql: string) {
        return { get: () => sql.includes('sqlite_version') ? { v: '3.53.0' } : { journal_mode: 'truncate' } };
      },
      run() {},
    } as unknown as Database;
    expect(() => initializeAccessDatabaseConnection(fake)).toThrow(/journal mode/);
  });

  test('initializer validates without converting journal mode', () => {
    const statements: string[] = [];
    const fake = {
      query(sql: string) {
        return { get: () => sql.includes('sqlite_version') ? { v: '3.53.0' }
          : sql.includes('journal_mode') ? { journal_mode: 'delete' }
            : sql.includes('synchronous') ? { synchronous: 2 }
              : sql.includes('foreign_keys') ? { foreign_keys: 1 } : { timeout: 5000 } };
      },
      run(sql: string) { statements.push(sql); },
    } as unknown as Database;
    expect(initializeAccessDatabaseConnection(fake).journalMode).toBe('delete');
    expect(statements.some(sql => /journal_mode\s*=/.test(sql))).toBeFalse();
  });

  test('does not reset WAL when an unsafe runtime requires DELETE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-database-hostile-'));
    const dbPath = join(root, 'access.db');
    let writer: Database | null = null;
    let reader: Database | null = null;
    try {
      const setup = new Database(dbPath);
      setup.run('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
      setup.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES ('001', 'fixture', 1)");
      setup.run('CREATE TABLE business (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      setup.run("INSERT INTO business (value) VALUES ('before')");
      setup.run('PRAGMA journal_mode = WAL');
      setup.close(true);

      writer = new Database(dbPath);
      writer.run('BEGIN IMMEDIATE');
      writer.run("INSERT INTO business (value) VALUES ('uncommitted')");
      reader = new Database(dbPath, { readonly: true, strict: true });
      const before = await readFile(dbPath);
      const assignments: string[] = [];
      const unsafeVersion = new Proxy(reader, {
        get(target, property) {
          if (property === 'query') {
            return (sql: string) => sql.includes('sqlite_version')
              ? { get: () => ({ v: '3.51.0' }) }
              : target.query(sql);
          }
          if (property === 'run') {
            return (sql: string, ...args: unknown[]) => {
              assignments.push(sql);
              return (target.run as unknown as (sql: string, ...args: unknown[]) => unknown)(sql, ...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      expect(() => initializeAccessDatabaseForMasterConnection(unsafeVersion)).toThrow(AccessDatabaseJournalModeError);
      expect(assignments).toEqual([]);
      expect(await readFile(dbPath)).toEqual(before);
      expect(reader.query<{ readonly count: number }, []>('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count).toBe(1);
      expect(reader.query<{ readonly count: number }, []>('SELECT COUNT(*) AS count FROM business').get()?.count).toBe(1);
      expect(reader.query<{ readonly user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(0);
      expect(reader.query<{ readonly journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    } finally {
      if (writer?.inTransaction) writer.run('ROLLBACK');
      writer?.close(true);
      reader?.close(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('real connections fail closed when each pragma assignment is swallowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-access-database-proxy-'));
    try {
      for (const swallowed of ['busy_timeout', 'foreign_keys', 'synchronous']) {
        const dbPath = join(root, `${swallowed}.db`);
        const db = new Database(dbPath);
        if (swallowed === 'synchronous') db.run('PRAGMA synchronous = NORMAL');
        const proxy = new Proxy(db, {
          get(target, property) {
            if (property === 'run') {
              return (sql: string, ...args: unknown[]) => sql.toLowerCase().includes(`pragma ${swallowed}`)
                ? undefined
                : (target.run as unknown as (sql: string, ...args: unknown[]) => unknown)(sql, ...args);
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        expect(() => initializeAccessDatabaseConnection(proxy)).toThrow(/invariants/);
        db.close(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('MigrationManager migrate and status reject an unknown journal mode', async () => {
    expect((await new MigrationManager(':memory:').migrate()).success).toBeFalse();
    expect(await new MigrationManager(':memory:').status()).toEqual([]);
  });
});
