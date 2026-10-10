import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginStorageCapability, SQLitePluginStorage } from '../../src/plugin-storage';
import {initializePluginStateDatabase} from '../../src/plugin-state/schema';

const databases: Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try { db.close(); } catch { /* already closed by a test */ }
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function applyMigrations(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');
  initializePluginStateDatabase(db);
}

function memoryDb(): Database {
  const db = new Database(':memory:');
  applyMigrations(db);
  databases.push(db);
  return db;
}

function fileDb(file: string): Database {
  const db = new Database(file, { create: true, readwrite: true });
  applyMigrations(db);
  databases.push(db);
  return db;
}

function newFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-storage-'));
  directories.push(directory);
  return path.join(directory, 'plugin-state.db');
}

function insertRaw(db: Database, pluginName: string, key: string, value: string, ttl: number | null = null): void {
  db.run(
    `INSERT OR REPLACE INTO plugin_storage (plugin_name, key, value, ttl, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [pluginName, key, value, ttl, Date.now()]
  );
}

function rowCount(db: Database, pluginName: string, key: string): number {
  const row = db.query<{ count: number }, [string, string]>(
    `SELECT COUNT(*) as count FROM plugin_storage WHERE plugin_name = ? AND key = ?`
  ).get(pluginName, key);
  return row?.count ?? 0;
}

describe('SQLitePluginStorage.readStrict', () => {
  test('missing key reports not found', async () => {
    const storage = new SQLitePluginStorage(memoryDb(), 'plugin');
    expect(await storage.readStrict('nope')).toEqual({ found: false });
  });

  test('valid JSON null is found with a null value', async () => {
    const storage = new SQLitePluginStorage(memoryDb(), 'plugin');
    await storage.set('nil', null);
    expect(await storage.readStrict('nil')).toEqual({ found: true, value: null });
  });

  test('committed values round-trip', async () => {
    const storage = new SQLitePluginStorage(memoryDb(), 'plugin');
    await storage.set('obj', { a: 1, b: ['x'] });
    expect(await storage.readStrict<{ a: number; b: string[] }>('obj'))
      .toEqual({ found: true, value: { a: 1, b: ['x'] } });
  });

  test('expired entries report not found without deleting the row', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin');
    insertRaw(db, 'plugin', 'stale', '"v"', Math.floor(Date.now() / 1000) - 60);
    expect(await storage.readStrict('stale')).toEqual({ found: false });
    expect(rowCount(db, 'plugin', 'stale')).toBe(1);
  });

  test('unexpired TTL still resolves the value', async () => {
    const storage = new SQLitePluginStorage(memoryDb(), 'plugin');
    await storage.set('fresh', 'v', 60);
    expect(await storage.readStrict('fresh')).toEqual({ found: true, value: 'v' });
  });

  test('TTL equal to the current second remains valid, then expires without deletion', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin');
    const original = Date.now;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    try {
      insertRaw(db, 'plugin', 'boundary', 'null', now / 1000);
      expect(await storage.readStrict('boundary')).toEqual({ found: true, value: null });
      now += 1000;
      expect(await storage.readStrict('boundary')).toEqual({ found: false });
      expect(rowCount(db, 'plugin', 'boundary')).toBe(1);
    } finally { Date.now = original; }
  });

  test('strict read does not flush or replace an uncommitted dirty cached value', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin', { maxSize: 10, writeDelay: 60_000 });
    insertRaw(db, 'plugin', 'k', '"committed"');
    await storage.set('k', 'pending');
    expect(await storage.readStrict('k')).toEqual({ found: true, value: 'committed' });
    expect(await storage.get<string>('k')).toBe('pending');
    expect(storage.getCacheStats()!.writes).toBe(0);
    await storage.flush();
    expect(await storage.readStrict('k')).toEqual({ found: true, value: 'pending' });
  });

  test('legacy get still lazily deletes expired rows', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin');
    insertRaw(db, 'plugin', 'stale', '"v"', Math.floor(Date.now() / 1000) - 60);
    expect(await storage.get('stale')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rowCount(db, 'plugin', 'stale')).toBe(0);
  });

  test('corrupt JSON rejects instead of swallowing the error', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin');
    insertRaw(db, 'plugin', 'bad', '{not json');
    await expect(storage.readStrict('bad')).rejects.toThrow();
  });

  test('closed connection rejects while best-effort get returns null', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin');
    await storage.set('k', 1);
    db.close();
    await expect(storage.readStrict('k')).rejects.toThrow();
    expect(await storage.get('k')).toBeNull();
  });

  test('namespaces are isolated', async () => {
    const db = memoryDb();
    const first = new SQLitePluginStorage(db, 'first');
    const second = new SQLitePluginStorage(db, 'second');
    await first.set('k', 'first-value');
    expect(await first.readStrict('k')).toEqual({ found: true, value: 'first-value' });
    expect(await second.readStrict('k')).toEqual({ found: false });
  });

  test('strict read bypasses a stale LRU value on the same connection', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin', { maxSize: 10, writeDelay: 60_000 });
    insertRaw(db, 'plugin', 'k', '"old"');
    expect(await storage.get<string>('k')).toBe('old'); // clean hydration
    insertRaw(db, 'plugin', 'k', '"new"');      // external writer changes committed value
    expect(await storage.get<string>('k')).toBe('old'); // cache still holds the stale read
    expect(await storage.readStrict('k')).toEqual({ found: true, value: 'new' });
    await storage.flush();
  });

  test('strict read neither populates nor writes through the LRU cache', async () => {
    const db = memoryDb();
    const storage = new SQLitePluginStorage(db, 'plugin', { maxSize: 10, writeDelay: 60_000 });
    insertRaw(db, 'plugin', 'k', '"v"');
    expect(await storage.readStrict('k')).toEqual({ found: true, value: 'v' });
    expect(storage.getCacheStats()!.size).toBe(0);
    await storage.flush();
  });

  test('strict read observes the latest committed value from another connection', async () => {
    const file = newFile();
    const first = fileDb(file);
    const second = new Database(file, { create: true, readwrite: true });
    databases.push(second);

    const storage = new SQLitePluginStorage(first, 'plugin', { maxSize: 10, writeDelay: 60_000 });
    insertRaw(first, 'plugin', 'k', '"old"');
    expect(await storage.get<string>('k')).toBe('old');
    insertRaw(second, 'plugin', 'k', '"new"');
    expect(await storage.readStrict('k')).toEqual({ found: true, value: 'new' });
    await storage.flush();
  });
});

describe('cached plugin storage does not overwrite other writers', () => {
  test('get backfill plus flush does not resurrect a stale value', async () => {
    const db = memoryDb();
    const cached = new SQLitePluginStorage(db, 'plugin', { maxSize: 10, writeDelay: 60_000 });
    const writer = cached.uncached();
    await writer.set('k', 'old');
    expect(await cached.get<string>('k')).toBe('old'); // hydration must stay clean
    await writer.set('k', 'new');
    await cached.flush();
    expect(await writer.readStrict!('k')).toEqual({ found: true, value: 'new' });
  });

  test('eviction after a cached read does not overwrite another writer', async () => {
    const db = memoryDb();
    const cached = new SQLitePluginStorage(db, 'plugin', { maxSize: 2, writeDelay: 60_000 });
    const writer = cached.uncached();
    await writer.set('k', 'old');
    expect(await cached.get<string>('k')).toBe('old');
    await writer.set('k', 'new');
    await cached.set('x', 1);
    await cached.set('y', 2); // exceeds maxSize and evicts the clean 'k'
    await cached.flush();
    expect(await writer.readStrict!('k')).toEqual({ found: true, value: 'new' });
  });

  test('genuine set still uses write-behind and flush', async () => {
    const db = memoryDb();
    const cached = new SQLitePluginStorage(db, 'plugin', { maxSize: 10, writeDelay: 60_000 });
    const writer = cached.uncached();
    await cached.set('k', 'pending');
    expect(await writer.readStrict!('k')).toEqual({ found: false }); // not yet flushed
    await cached.flush();
    expect(await writer.readStrict!('k')).toEqual({ found: true, value: 'pending' });
  });
});

describe('plugin storage capability strict read', () => {
  test('readStrict works and is revoked with the capability', async () => {
    const db = memoryDb();
    const capability = createPluginStorageCapability(db, 'report', { maxSize: 10, writeDelay: 60_000 });
    await capability.storage.set('k', { n: 1 });
    await capability.storage.flush!();

    const read = capability.storage.readStrict!;
    const view = capability.storage.uncached!();
    const readView = view.readStrict!;

    expect(await read<{ n: number }>('k')).toEqual({ found: true, value: { n: 1 } });
    expect(await readView('k')).toEqual({ found: true, value: { n: 1 } });

    capability.revoke();
    await expect(read('k')).rejects.toThrow('revoked');
    await expect(readView('k')).rejects.toThrow('revoked');
  });
});
