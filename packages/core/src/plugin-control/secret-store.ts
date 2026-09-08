import type { Database } from 'bun:sqlite';
import type { SecretStore } from './contracts';
import {
  decryptSecret,
  encryptSecret,
  SecretCryptoError,
  validateKeyMaterial,
  type SecretKeyMaterial,
} from './secret-crypto';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type { SecretKeyMaterial } from './secret-crypto';

export type SecretStoreErrorCode =
  | 'invalid_handle'
  | 'invalid_input'
  | 'key_unavailable'
  | 'invalid_key'
  | 'handle_revoked'
  | 'namespace_invalidated'
  | 'version_conflict'
  | 'version_exhausted'
  | 'secret_corrupt'
  | 'storage_failure';

const ERROR_MESSAGES: Record<SecretStoreErrorCode, string> = {
  invalid_handle: 'secret store handle is invalid',
  invalid_input: 'secret store input is invalid',
  key_unavailable: 'secret store key is unavailable',
  invalid_key: 'secret store key is invalid',
  handle_revoked: 'secret store handle is revoked',
  namespace_invalidated: 'secret store namespace was invalidated',
  version_conflict: 'secret store version conflict',
  version_exhausted: 'secret store version space is exhausted',
  secret_corrupt: 'secret store object is corrupt',
  storage_failure: 'secret store database operation failed',
};

export class SecretStoreError extends Error {
  readonly name = 'SecretStoreError';

  constructor(readonly code: SecretStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

type NamespaceRow = { readonly namespace_epoch: number };
type ObjectRow = {
  readonly namespace_epoch: number;
  readonly version: number;
  readonly deleted: number;
  readonly envelope: Uint8Array | null;
};

type StoreState = {
  readonly db: Database;
  readonly namespace: string;
  readonly material: SecretKeyMaterial;
  readonly epoch: number;
  revoked: boolean;
};

const states = new WeakMap<SecretStore, StoreState>();

function validateText(value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new SecretStoreError('invalid_input');
  }
}

function validateVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_INTEGER) {
    throw new SecretStoreError('invalid_input');
  }
}

function readNamespaceEpoch(db: Database, namespace: string): number {
  const row = db.query<NamespaceRow, [string]>(
    'SELECT namespace_epoch FROM secret_store_namespaces WHERE namespace=?',
  ).get(namespace);
  if (row === null || !Number.isSafeInteger(row.namespace_epoch) || row.namespace_epoch < 1) {
    throw new SecretStoreError('namespace_invalidated');
  }
  return row.namespace_epoch;
}

function assertCurrent(state: StoreState): void {
  if (state.revoked) throw new SecretStoreError('handle_revoked');
  if (readNamespaceEpoch(state.db, state.namespace) !== state.epoch) {
    throw new SecretStoreError('namespace_invalidated');
  }
}

function readObject(db: Database, namespace: string, key: string): ObjectRow | null {
  return db.query<ObjectRow, [string, string]>(
    `SELECT namespace_epoch,version,deleted,envelope
     FROM secret_store_objects WHERE namespace=? AND key=?`,
  ).get(namespace, key);
}

function validateObject(row: ObjectRow, epoch: number): void {
  if (
    row.namespace_epoch !== epoch ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    row.version > MAX_SAFE_INTEGER ||
    (row.deleted !== 0 && row.deleted !== 1) ||
    (row.deleted === 0 && row.envelope === null) ||
    (row.deleted === 1 && row.envelope !== null)
  ) {
    throw new SecretStoreError('secret_corrupt');
  }
}

function nextVersion(current: number | null): number {
  if (current === MAX_SAFE_INTEGER) throw new SecretStoreError('version_exhausted');
  return (current ?? 0) + 1;
}

function runDatabase<Result>(action: () => Result): Result {
  try {
    return action();
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    throw new SecretStoreError('storage_failure');
  }
}

function mapCryptoError(error: unknown): never {
  if (error instanceof SecretCryptoError) throw new SecretStoreError('secret_corrupt');
  throw new SecretStoreError('storage_failure');
}

function requireState(store: SecretStore): StoreState {
  const state = states.get(store);
  if (state === undefined) throw new SecretStoreError('invalid_handle');
  return state;
}

export function createSecretStore(
  db: Database,
  namespace: string,
  material: SecretKeyMaterial | null | undefined,
): SecretStore {
  validateText(namespace, 256);
  if (material === null || material === undefined) throw new SecretStoreError('key_unavailable');
  try {
    validateKeyMaterial(material);
  } catch {
    throw new SecretStoreError('invalid_key');
  }
  try {
    const epoch = runDatabase(() => db.transaction(() => {
      db.run(
        'INSERT OR IGNORE INTO secret_store_namespaces(namespace,namespace_epoch) VALUES (?,1)',
        [namespace],
      );
      return readNamespaceEpoch(db, namespace);
    }).immediate());
    const state: StoreState = {
      db,
      namespace,
      material: { keyId: material.keyId, key: new Uint8Array(material.key) },
      epoch,
      revoked: false,
    };
    const store: SecretStore = {
      namespace,
      get: async (key: string) => {
        validateText(key, 1024);
        return runDatabase(() => db.transaction(() => {
          assertCurrent(state);
          const row = readObject(db, namespace, key);
          if (row === null) return null;
          validateObject(row, state.epoch);
          if (row.deleted === 1) return null;
          try {
            return {
              version: row.version,
              value: decryptSecret(row.envelope as Uint8Array, namespace, key, row.version, state.epoch, state.material),
            };
          } catch (error) {
            return mapCryptoError(error);
          }
        }).immediate());
      },
      compareAndSet: async (key: string, expectedVersion: number | null, value: string) => {
        validateText(key, 1024);
        if (expectedVersion !== null) validateVersion(expectedVersion);
        if (typeof value !== 'string') throw new SecretStoreError('invalid_input');
        return runDatabase(() => db.transaction(() => {
          assertCurrent(state);
          const row = readObject(db, namespace, key);
          if (row !== null) validateObject(row, state.epoch);
          const visibleVersion = row !== null && row.deleted === 0 ? row.version : null;
          if (visibleVersion !== expectedVersion) throw new SecretStoreError('version_conflict');
          if (row !== null && row.deleted === 0) {
            try {
              decryptSecret(row.envelope as Uint8Array, namespace, key, row.version, state.epoch, state.material);
            } catch (error) {
              return mapCryptoError(error);
            }
          }
          const version = nextVersion(row?.version ?? null);
          const envelope = encryptSecret(value, namespace, key, version, state.epoch, state.material);
          db.run(`INSERT INTO secret_store_objects
            (namespace,key,namespace_epoch,version,deleted,envelope) VALUES (?,?,?,?,0,?)
            ON CONFLICT(namespace,key) DO UPDATE SET
              namespace_epoch=excluded.namespace_epoch,
              version=excluded.version,
              deleted=excluded.deleted,
              envelope=excluded.envelope`,
          [namespace, key, state.epoch, version, envelope]);
          return version;
        }).immediate());
      },
      delete: async (key: string, expectedVersion: number) => {
        validateText(key, 1024);
        validateVersion(expectedVersion);
        runDatabase(() => db.transaction(() => {
          assertCurrent(state);
          const row = readObject(db, namespace, key);
          if (row !== null) validateObject(row, state.epoch);
          if (row === null || row.deleted === 1 || row.version !== expectedVersion) {
            throw new SecretStoreError('version_conflict');
          }
          try {
            decryptSecret(row.envelope as Uint8Array, namespace, key, row.version, state.epoch, state.material);
          } catch (error) {
            return mapCryptoError(error);
          }
          db.run(
            'UPDATE secret_store_objects SET deleted=1,envelope=NULL WHERE namespace=? AND key=? AND version=? AND deleted=0',
            [namespace, key, expectedVersion],
          );
        }).immediate());
      },
    };
    states.set(store, state);
    return store;
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    if (error instanceof SecretCryptoError) throw new SecretStoreError('invalid_key');
    throw new SecretStoreError('storage_failure');
  }
}

/** Revokes only this host handle; it does not delete the namespace. */
export function revokeSecretStore(store: SecretStore): void {
  const state = requireState(store);
  state.revoked = true;
}

/** Atomically deletes a namespace and advances its epoch, invalidating all old handles. */
export function clearSecretStore(store: SecretStore): void {
  const state = requireState(store);
  runDatabase(() => dbClear(state));
}

function dbClear(state: StoreState): void {
  dbTransaction(state, () => {
    const nextEpoch = nextVersion(state.epoch);
    dbDeleteObjects(state.db, state.namespace);
    const result = state.db.run(
      'UPDATE secret_store_namespaces SET namespace_epoch=? WHERE namespace=? AND namespace_epoch=?',
      [nextEpoch, state.namespace, state.epoch],
    );
    if (result.changes !== 1) throw new SecretStoreError('namespace_invalidated');
  });
  state.revoked = true;
}

function dbTransaction(state: StoreState, action: () => void): void {
  state.db.transaction(() => {
    assertCurrent(state);
    action();
  }).immediate();
}

function dbDeleteObjects(db: Database, namespace: string): void {
  db.run('DELETE FROM secret_store_objects WHERE namespace=?', [namespace]);
}
