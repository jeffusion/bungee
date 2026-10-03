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
  test('factory does not migrate and capability does not expose database or namespace selection', () => {
    const db = new Database(':memory:'); databases.push(db);
    const capability = new PluginDurableStateStore(db).forNamespace('one');
    expect(Object.keys(capability).sort()).toEqual(['execute', 'get', 'list']);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(() => capability.get('key')).toThrow();
  });
  test('isolates namespaces and detaches JSON values from callers', () => {
    const { store } = setup();
    const one = store.forNamespace('one'); const two = store.forNamespace('two');
    const value = { count: 1 };
    const result = one.execute({ commandId: 'create', mutations: [{ key: 'record', expectedVersion: 0, value }] });
    value.count = 999;
    (result[0]!.value as { count: number }).count = 123;
    expect(one.get('record')?.value).toEqual({ count: 1 });
    expect(two.get('record')).toBeNull();
    expect(two.list()).toEqual([]);
    two.execute({ commandId: 'create', mutations: [{ key: 'record', expectedVersion: 0, value: false }] });
    expect(one.list()).toHaveLength(1);
  });
  test('CAS conflicts roll back every write and do not consume command IDs', () => {
    const { store } = setup(); const state = store.forNamespace('one');
    state.execute({ commandId: 'initial', mutations: [{ key: 'existing', expectedVersion: 0, value: 1 }] });
    expect(() => state.execute({ commandId: 'multi', mutations: [
      { key: 'new', expectedVersion: 0, value: true }, { key: 'existing', expectedVersion: 0, value: 2 },
    ] })).toThrow(DurableStateConflictError);
    expect(state.get('new')).toBeNull();
    expect(state.get('existing')?.version).toBe(1);
    state.execute({ commandId: 'multi', mutations: [{ key: 'new', expectedVersion: 0, value: true }, { key: 'existing', expectedVersion: 1, value: 2 }] });
    expect(state.get('existing')?.version).toBe(2);
  });
  test('reopening preserves command results and rejects command ID reuse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bungee-durable-')); directories.push(dir);
    const path = join(dir, 'bungee.db'); const { db, store } = setup(path);
    const state = store.forNamespace('one');
    const command = { commandId: 'first', mutations: [{ key: 'record', expectedVersion: 0, value: { count: 1 } }] };
    const first = state.execute(command);
    state.execute({ commandId: 'second', mutations: [{ key: 'record', expectedVersion: 1, value: null }] });
    db.close();
    const reopened = new Database(path); databases.push(reopened);
    const recovered = new PluginDurableStateStore(reopened).forNamespace('one');
    expect(recovered.execute(command)).toEqual(first);
    expect(recovered.get('record')).toEqual({ key: 'record', version: 2, value: null });
    expect(() => recovered.execute({ ...command, mutations: [{ key: 'record', expectedVersion: 2, value: 2 }] })).toThrow('already used');
    expect(() => recovered.execute({ commandId: 'third', mutations: [{ key: 'record', expectedVersion: 0, value: 3 }] })).toThrow(DurableStateConflictError);
  });
  test('outer transaction abort rolls back records and idempotency result', () => {
    const { db, store } = setup(); const state = store.forNamespace('one');
    const command = { commandId: 'first', mutations: [{ key: 'record', expectedVersion: 0, value: 1 }] };
    expect(() => db.transaction(() => { state.execute(command); throw new Error('abort'); })()).toThrow('abort');
    expect(state.get('record')).toBeNull();
    expect(state.execute(command)[0]?.version).toBe(1);
  });
  test('rejects non-JSON, excessive sizes, duplicate keys and unsafe versions', () => {
    const { store } = setup(); const state = store.forNamespace('one');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const sparseWithExtra = Object.assign(Array(1), { extra: true });
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('getter evaluated'); } });
    for (const value of [undefined, NaN, Infinity, new Date(), { toJSON() { return {}; } }, cyclic, getter, [undefined], Array(1), sparseWithExtra, 1n, 'x'.repeat(1024 * 1024 + 1)]) {
      expect(() => state.execute({ commandId: 'bad', mutations: [{ key: 'record', expectedVersion: 0, value: value as DurableJson }] })).toThrow();
    }
    expect(() => store.forNamespace('../other')).toThrow();
    // Slashes in a key remain literal identifiers inside the fixed namespace.
    state.execute({ commandId: 'ok', mutations: [{ key: 'nested/item', expectedVersion: 0, value: {} }] });
    expect(() => state.execute({ commandId: 'bad', mutations: [{ key: 'a', expectedVersion: 0, value: 1 }, { key: 'a', expectedVersion: 0, value: 2 }] })).toThrow();
    expect(() => state.execute({ commandId: 'bad', mutations: [{ key: 'a', expectedVersion: Number.MAX_SAFE_INTEGER, value: 1 }] })).toThrow();
  });
});
