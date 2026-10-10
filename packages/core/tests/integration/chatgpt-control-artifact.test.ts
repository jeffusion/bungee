import {createDatabaseSecretStoreFactory,createDatabasePluginStorageFactory} from '../helpers/plugin-storage-backend';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import {initializePluginStateDatabase} from '../../src/plugin-state/schema';
import { ConfigRepository } from '../../src/config-storage';
import { PluginPathResolver } from '../../src/plugin-path-resolver';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog/catalog';
import { loadPluginManifestRecord } from '../../src/plugin-manifest-catalog/manifest-filesystem';
import {
  createPluginControlHost,
  parsePluginSecretsKey,
  type PluginControlHandle,
  type PluginControlHost,
} from '../../src/plugin-control';
import { SecretStoreError, type SecretKeyMaterial } from '../../src/plugin-control/secret-store';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';
import { AccountStore } from '../../../../plugins/chatgpt-oauth/server/accounts';
import { PluginServiceHost } from '../../src/plugin-services';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

setDefaultTimeout(STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

const repositoryRoots: string[] = [];
const artifactRoots: string[] = [];
const repositories: ConfigRepository[] = [];
const pluginDatabases = new Map<ConfigRepository,Database>();
function pluginDatabase(repository:ConfigRepository):Database {return pluginDatabases.get(repository)!;}
const hosts: PluginControlHost[] = [];
const KEY_A: SecretKeyMaterial = { keyId: 'BUNGEE_PLUGIN_SECRETS_KEY:v1', key: new Uint8Array(32).fill(1) };
const KEY_B: SecretKeyMaterial = { keyId: 'BUNGEE_PLUGIN_SECRETS_KEY:v1', key: new Uint8Array(32).fill(2) };
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');

function openRepository(): ConfigRepository {
  const root = mkdtempSync(join(tmpdir(), 'bungee-chatgpt-control-'));
  repositoryRoots.push(root);
  const repository = ConfigRepository.open(join(root, 'config.db'));
  repositories.push(repository);
  const db=new Database(join(root,'plugin-state.db'),{create:true});initializePluginStateDatabase(db);pluginDatabases.set(repository,db);
  return repository;
}

function createTrackedPluginControlHost(options: Parameters<typeof createPluginControlHost>[0]): PluginControlHost {
  const host = createPluginControlHost({
    ...options,
    services: new PluginServiceHost('control', {
      identity: (plugin, scope) => ({ endpoint: `artifact:${plugin}:${scope}`, instance: 'artifact-fixture', generation: 1, catalog: 'artifact-catalog', subject: plugin }),
      resolvePlacement: () => null, resolveJournal: () => null, resolveCallee: () => null,
    }),
  });
  hosts.push(host);
  return host;
}

let recordPromise: Promise<PluginManifestRecord> | undefined;
function chatgptRecord(): Promise<PluginManifestRecord> {
  return recordPromise ??= (async () => {
    const oldIncludeSystemPlugins = process.env.BUNGEE_INCLUDE_SYSTEM_PLUGINS;
    const oldPluginsDir = process.env.PLUGINS_DIR;
    process.env.BUNGEE_INCLUDE_SYSTEM_PLUGINS = 'false';
    process.env.PLUGINS_DIR = join(REPOSITORY_ROOT, 'plugins');
    try {
      const resolver = new PluginPathResolver(join(REPOSITORY_ROOT, 'packages/core/src'), REPOSITORY_ROOT);
      const catalog = await PluginManifestCatalog.build({ pathResolver: resolver });
      const record = catalog.get('chatgpt-oauth');
      if (record === undefined) throw new Error('chatgpt-oauth is missing from the repository plugin catalog');
      return record;
    } finally {
      if (oldIncludeSystemPlugins === undefined) delete process.env.BUNGEE_INCLUDE_SYSTEM_PLUGINS;
      else process.env.BUNGEE_INCLUDE_SYSTEM_PLUGINS = oldIncludeSystemPlugins;
      if (oldPluginsDir === undefined) delete process.env.PLUGINS_DIR;
      else process.env.PLUGINS_DIR = oldPluginsDir;
    }
  })();
}

function keyMaterial(material: SecretKeyMaterial): string {
  return Buffer.from(material.key).toString('base64');
}

async function writeRealAccount(repository: ConfigRepository, material: SecretKeyMaterial): Promise<void> {
  const factory = createDatabaseSecretStoreFactory(pluginDatabase(repository), material);
  const store = factory.create('chatgpt-oauth');
  await new AccountStore(store).create('artifact-test', {
    accessToken: 'artifact-access',
    refreshToken: 'artifact-refresh',
    expiresAt: Date.now() + 3_600_000,
    identity: { accountId: 'artifact-account' },
    identityStatus: 'parsed',
  });
  factory.revoke(store);
}

async function expectSecretError(action: () => Promise<unknown>, code: SecretStoreError['code']): Promise<void> {
  await expect(action()).rejects.toMatchObject({ code });
}

afterEach(async () => {
  const ownedHosts = hosts.splice(0);
  const ownedRepositories = repositories.splice(0);
  const ownedRepositoryRoots = repositoryRoots.splice(0);
  const ownedArtifactRoots = artifactRoots.splice(0);
  for (const host of ownedHosts) await host.dispose();
  for (const repository of ownedRepositories) {pluginDatabases.get(repository)?.close();pluginDatabases.delete(repository);repository.close();}
  for (const root of ownedRepositoryRoots) rmSync(root, { recursive: true, force: true });
  for (const root of ownedArtifactRoots) rmSync(root, { recursive: true, force: true });
});

describe('ChatGPT control artifact readiness lane', () => {
  test('activates the repository ChatGPT artifact with the database SecretStore', async () => {
    const record = await chatgptRecord();
    expect(record.pluginPath).toBe(join(REPOSITORY_ROOT, 'plugins/chatgpt-oauth'));
    expect(record.manifest.control?.entry).toBe('server/control.ts');
    const repository = openRepository();
    const host = createTrackedPluginControlHost({
      records: [record],
      secretStores: createDatabaseSecretStoreFactory(pluginDatabase(repository), parsePluginSecretsKey(keyMaterial(KEY_A))),
      storage: createDatabasePluginStorageFactory(pluginDatabase(repository)),
    });

    await host.activate('chatgpt-oauth');
    expect(host.status('chatgpt-oauth')).toBe('ready');
    await host.dispose();
  });

  test('fails repository artifact activation when the secrets key is missing', async () => {
    const record = await chatgptRecord();
    const repository = openRepository();
    const host = createTrackedPluginControlHost({
      records: [record],
      secretStores: createDatabaseSecretStoreFactory(pluginDatabase(repository), undefined),
      storage: createDatabasePluginStorageFactory(pluginDatabase(repository)),
    });

    await expect(host.activate('chatgpt-oauth')).rejects.toMatchObject({ code: 'start_failed', cause: { code: 'key_unavailable' } });
    await host.dispose();
  });

  test('fails repository artifact activation when key B opens an account envelope written with key A', async () => {
    const record = await chatgptRecord();
    const repository = openRepository();
    await writeRealAccount(repository, KEY_A);
    const host = createTrackedPluginControlHost({
      records: [record], secretStores: createDatabaseSecretStoreFactory(pluginDatabase(repository), KEY_B),
      storage: createDatabasePluginStorageFactory(pluginDatabase(repository)),
    });

    await expect(host.activate('chatgpt-oauth')).rejects.toMatchObject({
      code: 'start_failed', cause: { code: 'secret_corrupt' },
    });
    await host.dispose();
  });

  test('fails repository artifact readiness when the real account envelope is damaged', async () => {
    const record = await chatgptRecord();
    const repository = openRepository();
    await writeRealAccount(repository, KEY_A);
    pluginDatabase(repository).run(
      'UPDATE secret_store_objects SET envelope=? WHERE namespace=? AND key=?',
      [new Uint8Array([1, 2, 3]), 'chatgpt-oauth', 'accounts.v1'],
    );
    const host = createTrackedPluginControlHost({
      records: [record], secretStores: createDatabaseSecretStoreFactory(pluginDatabase(repository), KEY_A),
      storage: createDatabasePluginStorageFactory(pluginDatabase(repository)),
    });

    await expect(host.activate('chatgpt-oauth')).rejects.toMatchObject({
      code: 'start_failed', cause: { code: 'secret_corrupt' },
    });
    await host.dispose();
  });

  test('rejects a real ChatGPT artifact after changing a control dependency byte', async () => {
    const record = await chatgptRecord();
    const copyRoot = mkdtempSync(join(REPOSITORY_ROOT, '.chatgpt-control-artifact-'));
    artifactRoots.push(copyRoot);
    const copyDir = join(copyRoot, 'chatgpt-oauth');
    cpSync(record.pluginPath, copyDir, { recursive: true });
    const dependencyPath = join(copyDir, 'server/oauth.ts');
    writeFileSync(dependencyPath, `${readFileSync(dependencyPath, 'utf8')}\n// artifact dependency mismatch\n`);
    const copiedBase = await loadPluginManifestRecord(copyDir, copyRoot);
    const mismatched: PluginManifestRecord = { ...copiedBase, runtimeHash: record.runtimeHash };
    const repository = openRepository();
    const host = createTrackedPluginControlHost({
      records: [mismatched],
      secretStores: createDatabaseSecretStoreFactory(pluginDatabase(repository), KEY_A),
      storage: createDatabasePluginStorageFactory(pluginDatabase(repository)),
    });

    await expect(host.activate('chatgpt-oauth')).rejects.toMatchObject({
      code: 'start_failed', cause: { message: 'control artifact does not match the catalog runtime identity' },
    });
    await host.dispose();
  });

  test('revokes the real artifact SecretStore handle on dispose without leaking it', async () => {
    const record = await chatgptRecord();
    const repository = openRepository();
    const factory = createDatabaseSecretStoreFactory(pluginDatabase(repository), KEY_A);
    const host = createTrackedPluginControlHost({ records: [record], secretStores: factory, storage: createDatabasePluginStorageFactory(pluginDatabase(repository)) });
    const handle: PluginControlHandle = await host.activate('chatgpt-oauth');

    await host.dispose();
    await expectSecretError(() => handle.secretStore.get('accounts.v1'), 'handle_revoked');
    const fresh = factory.create('chatgpt-oauth');
    expect(await fresh.get('accounts.v1')).toBeNull();
    factory.revoke(fresh);
  });
});
