import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

/** Configuration migration owns this DDL; constructors never modify schema. */
export const PLUGIN_DURABLE_STATE_SCHEMA_SQL = `
CREATE TABLE plugin_durable_records (
  namespace TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
  value_json TEXT NOT NULL, PRIMARY KEY(namespace, key)
) STRICT;
CREATE TABLE plugin_durable_commands (
  namespace TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL, PRIMARY KEY(namespace, command_id)
) STRICT;
`;
export type DurableJson = null | boolean | number | string | DurableJson[] | { [key: string]: DurableJson };
export interface DurableRecord { readonly key: string; readonly version: number; readonly value: DurableJson }
export interface DurableMutation { key: string; expectedVersion: number; value: DurableJson }
export interface DurableCommand { commandId: string; mutations: readonly DurableMutation[] }
export interface PluginDurableState {
  get(key: string): DurableRecord | null;
  list(): readonly DurableRecord[];
  execute(command: DurableCommand): readonly DurableRecord[];
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
type Row = { key: string; version: number; value_json: string };
function record(row: Row): DurableRecord {
  return Object.freeze({ key: row.key, version: row.version, value: JSON.parse(row.value_json) as DurableJson });
}

/** Host-only factory. Inject only the returned namespace capability into trusted plugins.
 * Consumers validate their own record schema. expectedVersion=0 requires absence.
 * Null values are retained records, so versions and historical command IDs never reset.
 */
export class PluginDurableStateStore {
  constructor(private readonly db: Database) {}
  forNamespace(namespace: string): PluginDurableState {
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
      execute: (command: DurableCommand): readonly DurableRecord[] => {
        identifier(command.commandId);
        if (!Array.isArray(command.mutations) || command.mutations.length === 0 || command.mutations.length > 256) throw new Error('Invalid durable state command');
        const keys = new Set<string>();
        const mutations = command.mutations.map(mutation => {
          identifier(mutation.key);
          if (keys.has(mutation.key) || !Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion < 0 || mutation.expectedVersion >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid durable state mutation');
          keys.add(mutation.key);
          return { key: mutation.key, expectedVersion: mutation.expectedVersion, json: encode(mutation.value) };
        });
        const commandJson = JSON.stringify(mutations);
        if (Buffer.byteLength(commandJson) > MAX_BYTES) throw new Error('Durable state command size limit exceeded');
        const fingerprint = createHash('sha256').update(commandJson).digest('hex');
        return db.transaction(() => {
          const prior = db.query<{ fingerprint: string; result_json: string }, [string, string]>('SELECT fingerprint,result_json FROM plugin_durable_commands WHERE namespace = ? AND command_id = ?').get(namespace, command.commandId);
          if (prior) {
            if (prior.fingerprint !== fingerprint) throw new Error('Durable state command ID already used');
            return Object.freeze((JSON.parse(prior.result_json) as DurableRecord[]).map(item => Object.freeze(item)));
          }
          const results: DurableRecord[] = [];
          for (const mutation of mutations) {
            const current = get(mutation.key);
            if ((current?.version ?? 0) !== mutation.expectedVersion) throw new DurableStateConflictError();
            const version = mutation.expectedVersion + 1;
            db.query(`INSERT INTO plugin_durable_records(namespace,key,version,value_json) VALUES (?,?,?,?)
              ON CONFLICT(namespace,key) DO UPDATE SET version=excluded.version,value_json=excluded.value_json`).run(namespace, mutation.key, version, mutation.json);
            results.push(record({ key: mutation.key, version, value_json: mutation.json }));
          }
          db.query('INSERT INTO plugin_durable_commands(namespace,command_id,fingerprint,result_json) VALUES (?,?,?,?)').run(namespace, command.commandId, fingerprint, JSON.stringify(results));
          return Object.freeze(results);
        }).immediate();
      },
    });
  }
}
