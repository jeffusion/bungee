import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore, DurableStateConflictError, type DurableJson } from '../../packages/core/src/plugin-durable-state';

const databases: Database[] = [];
const directories: string[] = [];
function setup(path = ':memory:') {
  const db = new Database(path); databases.push(db); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  return { db, store: new PluginDurableStateStore(db) };
}
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch {} }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('plugin durable state', () => {
  test('factory does not migrate and async capability exposes only get/list/transact', async () => {
    const db = new Database(':memory:'); databases.push(db);
    const capability = new PluginDurableStateStore(db).forNamespace('one');
    expect(Object.keys(capability).sort()).toEqual(['get', 'list', 'transact']);
    expect(Object.isFrozen(capability)).toBe(true);
    await expect(capability.get('key')).rejects.toThrow();
  });
  test('isolates namespaces and detaches JSON values from callers', async () => {
    const { store } = setup();
    const one = store.forNamespace('one'); const two = store.forNamespace('two');
    const value = { count: 1 };
    const result = await one.transact([{ key: 'record', expectedVersion: 0, value }]);
    value.count = 999;
    (result[0]!.value as { count: number }).count = 123;
    expect((await one.get('record'))?.value).toEqual({ count: 1 });
    expect(await two.get('record')).toBeNull();
    expect(await two.list()).toEqual([]);
    await two.transact([{ key: 'record', expectedVersion: 0, value: false }]);
    expect(await one.list()).toHaveLength(1);
  });
  test('CAS conflicts roll back every write and allow retry with current versions', async () => {
    const { store } = setup(); const state = store.forNamespace('one');
    await state.transact([{ key: 'existing', expectedVersion: 0, value: 1 }]);
    await expect(state.transact([
      { key: 'new', expectedVersion: 0, value: true }, { key: 'existing', expectedVersion: 0, value: 2 },
    ])).rejects.toThrow(DurableStateConflictError);
    expect(await state.get('new')).toBeNull();
    expect((await state.get('existing'))?.version).toBe(1);
    await state.transact([{ key: 'new', expectedVersion: 0, value: true }, { key: 'existing', expectedVersion: 1, value: 2 }]);
    expect((await state.get('existing'))?.version).toBe(2);
  });
  test('reopening preserves current records and null tombstones without command history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bungee-durable-')); directories.push(dir);
    const path = join(dir, 'plugin-state.db'); const { db, store } = setup(path);
    const state = store.forNamespace('one');
    const create = [{ key: 'record', expectedVersion: 0, value: { count: 1 } }];
    await state.transact(create);
    await state.transact([{ key: 'record', expectedVersion: 1, value: null }]);
    db.close();
    const reopened = new Database(path); databases.push(reopened);
    const recovered = new PluginDurableStateStore(reopened).forNamespace('one');
    expect(await recovered.get('record')).toEqual({ key: 'record', version: 2, value: null });
    await expect(recovered.transact(create)).rejects.toThrow(DurableStateConflictError);
    expect(await recovered.transact([{ key: 'record', expectedVersion: 2, value: 2 }])).toEqual([{key: 'record', version: 3, value: 2}]);
    expect(reopened.query<{name: string}, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{name: 'plugin_durable_records'}]);
  });
  test('storage leaf outer transaction abort rolls back all records', () => {
    const { db, store } = setup(); const state = store.forStorageNamespace('one');
    const mutations = [{ key: 'record', expectedVersion: 0, value: 1 }];
    expect(() => db.transaction(() => { state.transact(mutations); throw new Error('abort'); })()).toThrow('abort');
    expect(state.get('record')).toBeNull();
    expect(state.transact(mutations)[0]?.version).toBe(1);
  });
  test('rejects non-JSON, excessive sizes, duplicate keys and unsafe versions', async () => {
    const { store } = setup(); const state = store.forNamespace('one');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const sparseWithExtra = Object.assign(Array(1), { extra: true });
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('getter evaluated'); } });
    for (const value of [undefined, NaN, Infinity, new Date(), { toJSON() { return {}; } }, cyclic, getter, [undefined], Array(1), sparseWithExtra, 1n, 'x'.repeat(1024 * 1024 + 1)]) {
      await expect(state.transact([{ key: 'record', expectedVersion: 0, value: value as DurableJson }])).rejects.toThrow();
    }
    expect(() => store.forNamespace('../other')).toThrow();
    await state.transact([{ key: 'nested/item', expectedVersion: 0, value: {} }]);
    await expect(state.transact([{ key: 'a', expectedVersion: 0, value: 1 }, { key: 'a', expectedVersion: 0, value: 2 }])).rejects.toThrow();
    await expect(state.transact([{ key: 'a', expectedVersion: Number.MAX_SAFE_INTEGER, value: 1 }])).rejects.toThrow();
  });
});
