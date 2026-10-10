import type { Database } from 'bun:sqlite';

/** Plugin state initialization owns this DDL; constructors never modify schema. */
export const PLUGIN_DURABLE_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_durable_records (
  namespace TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
  value_json TEXT NOT NULL, PRIMARY KEY(namespace, key)
) STRICT;
`;
export type DurableJson = null | boolean | number | string | DurableJson[] | { [key: string]: DurableJson };
export interface DurableRecord { readonly key: string; readonly version: number; readonly value: DurableJson }
export interface DurableMutation { key: string; expectedVersion: number; value: DurableJson }
/** Pure data outbox request; callbacks and command identifiers are never accepted. */
export interface DurableTransactionOptions {
  readonly outbox: { readonly topic: string; readonly major: number;
    readonly maxEvents: number; readonly payload: Uint8Array };
}
export interface PluginDurableState {
  get(key: string): Promise<DurableRecord | null>;
  list(): Promise<readonly DurableRecord[]>;
  transact(mutations: readonly DurableMutation[], options?: DurableTransactionOptions): Promise<readonly DurableRecord[]>;
}
/** Synchronous leaf, usable only by storage workers and offline tooling. */
export interface StorageDurableState {
  get(key: string): DurableRecord | null;
  list(): readonly DurableRecord[];
  transact(mutations: readonly DurableMutation[], extend?: () => void): readonly DurableRecord[];
}
export class DurableStateConflictError extends Error {
  readonly code = 'durable_state_conflict';
  constructor() { super('Durable state version conflict'); this.name = 'DurableStateConflictError'; }
}
/** Plugins load as independent bundles, so the host's error has a different constructor. */
export function isDurableStateConflictError(error: unknown): error is DurableStateConflictError {
  return error instanceof Error && 'code' in error && error.code === 'durable_state_conflict';
}
const MAX_BYTES = 1024 * 1024;
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) throw new Error('Invalid durable state identifier');
}
/** Reject objects with behavior, lossy JSON values and cycles before JSON.stringify. */
function encode(value: unknown): string {
  const ancestors = new Set<object>();
  function check(current: unknown, depth: number): void {
    if (depth > 64) throw new Error('Durable state nesting limit exceeded');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object' || current === null || ancestors.has(current)) throw new Error('Durable state must be pure JSON');
    const array = Array.isArray(current);
    if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) throw new Error('Durable state must be pure JSON');
    ancestors.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(current).some(key => typeof key === 'symbol')) throw new Error('Durable state must be pure JSON');
    if (array) {
      const length = (current as unknown[]).length;
      const indices = Object.keys(descriptors).filter(key => key !== 'length');
      if (indices.length !== length || indices.some((key, index) => key !== String(index))) throw new Error('Durable state must be pure JSON');
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Durable state must be pure JSON');
      check(descriptor.value, depth + 1);
    }
    ancestors.delete(current);
  }
  check(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Durable state size limit exceeded');
  return json;
}
/** Validate data before IPC structured cloning can erase prototypes or evaluate getters. */
export function validateDurableJson(value: unknown): void { encode(value); }
type Row = { key: string; version: number; value_json: string };
function record(row: Row): DurableRecord {
  return Object.freeze({ key: row.key, version: row.version, value: JSON.parse(row.value_json) as DurableJson });
}

/** Host-only factory. Inject only the returned namespace capability into trusted plugins.
 * Consumers validate their own record schema. expectedVersion=0 requires absence.
 * Null values are retained records, so versions never reset.
 */
export class PluginDurableStateStore {
  constructor(private readonly db: Database) {}
  /**
   * Host-only: the shared database this store's records live in, so a host-owned
   * durable journal can run its own atomic planner/reader against exactly the
   * same `plugin_durable_records` rows the plugin sees. Never exposed through
   * `PluginServices` and never handed to a plugin.
   */
  get database(): Database { return this.db; }
  /** Async SDK shape for offline tools and leaf fixtures; production uses PluginStateClient. */
  forNamespace(namespace: string): PluginDurableState {
    const leaf = this.forStorageNamespace(namespace);
    return Object.freeze({get: async (key: string) => leaf.get(key), list: async () => leaf.list(),
      transact: async (mutations: readonly DurableMutation[], options?: DurableTransactionOptions) => {
        if (options !== undefined) throw new Error('Outbox requires the storage worker');
        return leaf.transact(mutations);
      }});
  }
  forStorageNamespace(namespace: string): StorageDurableState {
    identifier(namespace);
    const db = this.db;
    const get = (key: string): DurableRecord | null => {
      identifier(key);
      const row = db.query<Row, [string, string]>('SELECT key,version,value_json FROM plugin_durable_records WHERE namespace = ? AND key = ?').get(namespace, key);
      return row ? record(row) : null;
    };
    return Object.freeze({
      get,
      list: () => Object.freeze(db.query<Row, [string]>('SELECT key,version,value_json FROM plugin_durable_records WHERE namespace = ? ORDER BY key').all(namespace).map(record)),
      transact: (input: readonly DurableMutation[], extend?: () => void): readonly DurableRecord[] => {
        if (!Array.isArray(input) || input.length === 0 || input.length > 256) throw new Error('Invalid durable state command');
        const keys = new Set<string>();
        const mutations = input.map(mutation => {
          identifier(mutation.key);
          if (keys.has(mutation.key) || !Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion < 0 || mutation.expectedVersion >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid durable state mutation');
          keys.add(mutation.key);
          return { key: mutation.key, expectedVersion: mutation.expectedVersion, json: encode(mutation.value) };
        });
        const commandJson = JSON.stringify(mutations);
        if (Buffer.byteLength(commandJson) > MAX_BYTES) throw new Error('Durable state command size limit exceeded');
        return db.transaction(() => {
          const results: DurableRecord[] = [];
          for (const mutation of mutations) {
            const current = get(mutation.key);
            if ((current?.version ?? 0) !== mutation.expectedVersion) throw new DurableStateConflictError();
            const version = mutation.expectedVersion + 1;
            db.query(`INSERT INTO plugin_durable_records(namespace,key,version,value_json) VALUES (?,?,?,?)
              ON CONFLICT(namespace,key) DO UPDATE SET version=excluded.version,value_json=excluded.value_json`).run(namespace, mutation.key, version, mutation.json);
            results.push(record({ key: mutation.key, version, value_json: mutation.json }));
          }
          extend?.();
          return Object.freeze(results);
        }).immediate();
      },
    });
  }
}
