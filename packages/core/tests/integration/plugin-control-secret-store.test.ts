import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository } from '../../src/config-storage';
import {
  clearSecretStore,
  createSecretStore,
  revokeSecretStore,
  SecretStoreError,
  type SecretKeyMaterial,
} from '../../src/plugin-control/secret-store';
import type { SecretStore } from '../../src/plugin-control/contracts';

const roots: string[] = [];
const repositories: ConfigRepository[] = [];
const MATERIAL: SecretKeyMaterial = { keyId: 'test-key-1', key: new Uint8Array(32).fill(7) };
const OTHER_MATERIAL: SecretKeyMaterial = { keyId: 'test-key-1', key: new Uint8Array(32).fill(8) };

function openDatabase(): Database {
  const root = mkdtempSync(join(tmpdir(), 'bungee-secret-store-'));
  roots.push(root);
  const repository = ConfigRepository.open(join(root, 'bungee.db'));
  repositories.push(repository);
  return (repository as unknown as { db: Database }).db;
}

function expectError(action: () => unknown, code: SecretStoreError['code']): void {
  expect(action).toThrow(SecretStoreError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretStoreError);
    if (error instanceof SecretStoreError) expect(error.code).toBe(code);
  }
}

async function expectAsyncError(action: () => Promise<unknown>, code: SecretStoreError['code']): Promise<void> {
  const promise = action();
  await expect(promise).rejects.toBeInstanceOf(SecretStoreError);
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretStoreError);
    if (error instanceof SecretStoreError) expect(error.code).toBe(code);
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('encrypted plugin control secret store', () => {
  test('encrypts and decrypts values without persisting plaintext', async () => {
    const db = openDatabase();
    const store = createSecretStore(db, 'host-a', MATERIAL);
    const marker = 'secret-marker-do-not-store';

    expect(await store.compareAndSet('token', null, marker)).toBe(1);
    expect(await store.get('token')).toEqual({ version: 1, value: marker });
    const row = db.query<{ envelope: Uint8Array }, [string, string]>(
      'SELECT envelope FROM secret_store_objects WHERE namespace=? AND key=?',
    ).get('host-a', 'token');
    expect(row).not.toBeNull();
    expect(new TextDecoder().decode(row?.envelope)).not.toContain(marker);
  });

  test('rejects wrong keys, tampering, and cross-namespace ciphertext substitution as corruption', async () => {
    const db = openDatabase();
    const store = createSecretStore(db, 'host-a', MATERIAL);
    const wrongKeyStore = createSecretStore(db, 'host-a', OTHER_MATERIAL);
    const otherNamespace = createSecretStore(db, 'host-b', MATERIAL);
    await store.compareAndSet('token', null, 'value');

    await expectAsyncError(() => wrongKeyStore.get('token'), 'secret_corrupt');
    db.run('UPDATE secret_store_objects SET envelope=? WHERE namespace=? AND key=?', [new Uint8Array([1, 2, 3]), 'host-a', 'token']);
    await expectAsyncError(() => store.get('token'), 'secret_corrupt');

    await store.compareAndSet('other-token', null, 'other-value');
    db.run('UPDATE secret_store_objects SET namespace=? WHERE namespace=? AND key=?', ['host-b', 'host-a', 'other-token']);
    await expectAsyncError(() => otherNamespace.get('other-token'), 'secret_corrupt');
  });

  test('performs database CAS and preserves versions across tombstone deletion', async () => {
    const db = openDatabase();
    const first = createSecretStore(db, 'host-a', MATERIAL);
    const second = createSecretStore(db, 'host-a', MATERIAL);

    expect(await first.compareAndSet('token', null, 'one')).toBe(1);
    await expectAsyncError(() => second.compareAndSet('token', null, 'lost'), 'version_conflict');
    expect(await second.compareAndSet('token', 1, 'two')).toBe(2);
    await second.delete('token', 2);
    expect(await first.get('token')).toBeNull();
    expect(await first.compareAndSet('token', null, 'three')).toBe(3);
    expect(await second.get('token')).toEqual({ version: 3, value: 'three' });
  });

  test('rejects writes through revoked handles and atomically clears a namespace', async () => {
    const db = openDatabase();
    const old = createSecretStore(db, 'host-a', MATERIAL);
    const sibling = createSecretStore(db, 'host-a', MATERIAL);
    const stale = createSecretStore(db, 'host-a', MATERIAL);
    await old.compareAndSet('one', null, '1');
    await old.compareAndSet('two', null, '2');

    revokeSecretStore(old);
    await expectAsyncError(() => old.compareAndSet('revoked', null, 'nope'), 'handle_revoked');
    expect(await sibling.get('one')).toEqual({ version: 1, value: '1' });

    clearSecretStore(sibling);
    expect(db.query<{ count: number }, [string]>(
      'SELECT count(*) AS count FROM secret_store_objects WHERE namespace=?',
    ).get('host-a')?.count).toBe(0);
    expect(db.query<{ epoch: number }, [string]>(
      'SELECT namespace_epoch AS epoch FROM secret_store_namespaces WHERE namespace=?',
    ).get('host-a')?.epoch).toBe(2);
    await expectAsyncError(() => old.get('one'), 'handle_revoked');
    await expectAsyncError(() => stale.get('one'), 'namespace_invalidated');
    await expectAsyncError(() => stale.compareAndSet('late', null, 'nope'), 'namespace_invalidated');
    expect(db.query<{ count: number }, [string, string]>(
      'SELECT count(*) AS count FROM secret_store_objects WHERE namespace=? AND key=?',
    ).get('host-a', 'late')?.count).toBe(0);

    const fresh = createSecretStore(db, 'host-a', MATERIAL);
    expect(await fresh.get('one')).toBeNull();
    expect(await fresh.compareAndSet('one', null, 'new')).toBe(1);
  });

  test('does not create a sensitive namespace without external key material', () => {
    const db = openDatabase();
    expectError(() => createSecretStore(db, 'host-a', undefined), 'key_unavailable');
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM secret_store_namespaces').get()?.count).toBe(0);
  });

  test('validates keyId by UTF-8 byte length before creating the namespace', async () => {
    const db = openDatabase();
    const exact = `${'😀'.repeat(16_383)}abc`;
    expect(new TextEncoder().encode(exact).length).toBe(65_535);
    const store = createSecretStore(db, 'host-a', { keyId: exact, key: MATERIAL.key });
    expect(await store.compareAndSet('token', null, 'value')).toBe(1);

    const tooLongAscii = { keyId: 'a'.repeat(65_536), key: MATERIAL.key } satisfies SecretKeyMaterial;
    expectError(() => createSecretStore(db, 'host-b', tooLongAscii), 'invalid_key');
    const tooLongUtf8 = { keyId: '😀'.repeat(16_384), key: MATERIAL.key } satisfies SecretKeyMaterial;
    expectError(() => createSecretStore(db, 'host-c', tooLongUtf8), 'invalid_key');
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM secret_store_namespaces').get()?.count).toBe(1);
  });
});
