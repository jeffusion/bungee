import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';
import {
  createDatabaseSecretStoreFactory,
  createPluginControlHost,
  type SecretStoreFactory,
} from '../../src/plugin-control';
import type { BoundAttemptContext, ControlPlugin, SecretStore } from '../../src/plugin-control/contracts';
import type { BoundControlInvocation } from '../../src/plugin-control/host';
import { finalizePluginManifestRecord } from '../../src/plugin-manifest-catalog/manifest-filesystem';
import { loadImmutableControlArtifact } from '../../src/plugin-control/artifact-loader';

function record(runtimeHash = 'sha256:' + 'a'.repeat(64), name = 'fake-control'): PluginManifestRecord {
  return {
    name, rootPath: '/tmp', pluginPath: `/tmp/${name}`, pluginDir: `/tmp/${name}`,
    manifestPath: `/tmp/${name}/manifest.json`, mainPath: `/tmp/${name}/main.ts`, controlPath: `/tmp/${name}/control.ts`,
    runtimeHash: runtimeHash as `sha256:${string}`,
    configSchema: [],
    manifest: {
      name, version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'main.ts',
      capabilities: ['api', 'dynamicRuntimeLoad', 'controlPlane'], uiExtensionMode: 'none', engines: { bungee: '^4.3.0' },
      control: { entry: 'control.ts', rpc: [{ name: 'refresh', access: 'bound-attempt' }] },
      contributes: { api: [{ path: '/health', methods: ['GET'], handler: 'health', execution: 'control' }] }, configSchema: [],
    },
  };
}

function stores(events: string[]): SecretStoreFactory {
  return {
    create(namespace) {
      const store = {
        namespace,
        get: async () => null,
        compareAndSet: async () => 1,
        delete: async () => undefined,
      } satisfies SecretStore;
      events.push(`create:${namespace}`);
      return store;
    },
    revoke: () => { events.push('revoke'); },
    clear: () => { events.push('clear'); },
  };
}

function control(events: string[]): ControlPlugin {
  return {
    createControl(context) {
      expect(context.secretStore.namespace).toBe('fake-control');
      return {
        api: [{ handler: 'health', path: '/health', methods: ['GET'], invoke: async () => Response.json({ ok: true }) }],
        rpc: [{ name: 'refresh', handler: 'refresh', invoke: async () => 'ok' }],
        start: () => { events.push('start'); },
        dispose: () => { events.push('dispose'); },
      };
    },
  };
}

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('plugin control host integration', () => {
  test('imports inert artifact, reuses one instance, and only revokes before disposal', async () => {
    const events: string[] = [];
    const host = createPluginControlHost({ records: [record()], secretStores: stores(events), loadControl: async () => control(events) });
    await host.reconcile(['fake-control']);
    await host.reconcile(['fake-control']);
    expect(events).toEqual(['create:fake-control', 'start']);
    const response = await host.api.handle(new Request('http://localhost/api/plugins/fake-control/control/health'));
    expect(response?.status).toBe(200);
    await host.reconcile([]);
    expect(events).toEqual(['create:fake-control', 'start', 'revoke', 'dispose']);
  });

  test('keeps persistent secrets across deactivate, shutdown, and start failure', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE secret_store_namespaces (namespace TEXT PRIMARY KEY, namespace_epoch INTEGER NOT NULL)');
    db.run('CREATE TABLE secret_store_objects (namespace TEXT NOT NULL, key TEXT NOT NULL, namespace_epoch INTEGER NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, envelope BLOB, PRIMARY KEY(namespace,key))');
    const material = { keyId: 'test', key: new Uint8Array(32).fill(7) };
    const factory = createDatabaseSecretStoreFactory(db, material);
    const first = factory.create('fake-control');
    await first.compareAndSet('marker', null, 'kept');
    factory.revoke(first);

    const recordWithPaths = record();
    let failStart = false;
    const host = createPluginControlHost({
      records: [recordWithPaths],
      secretStores: factory,
      loadControl: async () => ({ createControl: (context) => ({
        api: [], rpc: [],
        start: async () => { expect(await context.secretStore.get('marker')).toEqual({ version: 1, value: 'kept' }); if (failStart) throw new Error('nope'); },
        dispose: () => undefined,
      }) }),
    });
    await host.activate('fake-control');
    await host.deactivate('fake-control');
    const afterDeactivate = factory.create('fake-control');
    expect(await afterDeactivate.get('marker')).toEqual({ version: 1, value: 'kept' });
    factory.revoke(afterDeactivate);
    await host.activate('fake-control');
    failStart = true;
    await host.deactivate('fake-control');
    await expect(host.activate('fake-control')).rejects.toMatchObject({ code: 'start_failed' });
    expect(host.status('fake-control')).toBe('degraded');
    const afterFailure = factory.create('fake-control');
    expect(await afterFailure.get('marker')).toEqual({ version: 1, value: 'kept' });
    factory.revoke(afterFailure);
    await host.dispose();
    failStart = false;
    const restartedHost = createPluginControlHost({
      records: [recordWithPaths], secretStores: factory,
      loadControl: async () => ({ createControl: (context) => ({
        api: [], rpc: [], start: async () => {
          expect(await context.secretStore.get('marker')).toEqual({ version: 1, value: 'kept' });
        }, dispose: () => undefined,
      }) }),
    });
    await restartedHost.activate('fake-control');
    await restartedHost.dispose();
    const afterShutdown = factory.create('fake-control');
    expect(await afterShutdown.get('marker')).toEqual({ version: 1, value: 'kept' });
    factory.revoke(afterShutdown);
    db.close();
  });

  test('does not activate worker-only records during reconcile and retains failure status', async () => {
    const events: string[] = [];
    const worker = { ...record(), manifest: { ...record().manifest, control: undefined, contributes: { api: [{ path: '/health', methods: ['GET'], handler: 'health', execution: 'worker' as const }] } } } as PluginManifestRecord;
    const host = createPluginControlHost({ records: [worker], secretStores: stores(events), loadControl: async () => control(events) });
    await host.reconcile(['fake-control']);
    expect(events).toEqual([]);
    expect(host.status('fake-control')).toBe('inactive');
  });

  test('rejects a second instance while the first dispose is unconfirmed', async () => {
    let release!: () => void;
    const disposing = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]), startTimeoutMs: 10,
      loadControl: async () => ({ createControl: () => ({ api: [], rpc: [], start: () => { starts++; }, dispose: () => disposing }) }),
    });
    await host.activate('fake-control');
    const stopping = host.deactivate('fake-control').catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(host.activate('fake-control')).rejects.toMatchObject({ code: 'timeout' });
    expect(starts).toBe(1);
    release();
    await stopping;
  });

  test('does not replace a live instance when the artifact identity changes', async () => {
    const events: string[] = [];
    const first = record();
    const host = createPluginControlHost({ records: [first], secretStores: stores(events), loadControl: async () => control(events) });
    await host.activate('fake-control');
    expect(host.status('fake-control')).toBe('ready');
    (first as { runtimeHash: string }).runtimeHash = 'sha256:' + 'b'.repeat(64);
    await expect(host.activate('fake-control')).rejects.toMatchObject({ code: 'restart_required' });
    expect(events).toEqual(['create:fake-control', 'start']);
  });

  test('loads a bundled immutable control artifact without running it during import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-control-artifact-'));
    tempRoots.push(root);
    const controlPath = join(root, 'control.ts');
    const mainPath = join(root, 'main.ts');
    writeFileSync(mainPath, 'export default {};\n');
    const helperPath = join(root, 'helper.ts');
    writeFileSync(helperPath, 'export const marker = 1;\n');
    writeFileSync(controlPath, `
      import { marker } from './helper.ts';
      globalThis.__inertControlImport = (globalThis.__inertControlImport || 0) + marker;
      export default { createControl(context) {
        return { api: [], rpc: [], start() { void context.secretStore.get('unused'); }, dispose() {} };
      } };
    `);
    const base = record();
    const artifact = await finalizePluginManifestRecord({
      ...base, pluginPath: root, pluginDir: root, mainPath, controlPath,
      manifest: { ...base.manifest, control: { entry: 'control.ts', rpc: [] } },
    });
    const host = createPluginControlHost({ records: [artifact], secretStores: stores([]) });
    expect((globalThis as Record<string, unknown>).__inertControlImport).toBeUndefined();
    await host.activate('fake-control');
    expect((globalThis as Record<string, unknown>).__inertControlImport).toBe(1);
    writeFileSync(helperPath, 'export const marker = 2;\n');
    const changedHost = createPluginControlHost({ records: [artifact], secretStores: stores([]) });
    await expect(changedHost.activate('fake-control')).rejects.toMatchObject({ code: 'start_failed' });
    expect(changedHost.status('fake-control')).toBe('degraded');
  });

  test('enforces one per-control invocation budget for RPC calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]),
      loadControl: async () => ({ createControl: () => ({
        api: [], rpc: [{ name: 'refresh', handler: 'refresh', invoke: async () => { await gate; return 'ok'; } }],
        start() {}, dispose() {},
      }) }),
    });
    await host.activate('fake-control');
    const attempt: BoundAttemptContext = { attemptId: 'attempt', clientStreaming: false, signal: new AbortController().signal, boundClient: { call: async <T>() => undefined as T } };
    const invocation: BoundControlInvocation = { pluginName: 'fake-control', binding: { plugin: 'fake-control', contributionId: 'source', bindingId: 'binding', bindingOptions: {} }, attempt };
    const pending = Array.from({ length: 64 }, () => host.invokeRpc('fake-control', 'refresh', {}, invocation));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(host.invokeRpc('fake-control', 'refresh', {}, invocation)).rejects.toMatchObject({ code: 'overloaded' });
    release();
    await expect(Promise.all(pending)).resolves.toHaveLength(64);
  });

  test('cancels pending activation before load resolves and preserves the secret marker', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE secret_store_namespaces (namespace TEXT PRIMARY KEY, namespace_epoch INTEGER NOT NULL)');
    db.run('CREATE TABLE secret_store_objects (namespace TEXT NOT NULL, key TEXT NOT NULL, namespace_epoch INTEGER NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, envelope BLOB, PRIMARY KEY(namespace,key))');
    const factory = createDatabaseSecretStoreFactory(db, { keyId: 'test', key: new Uint8Array(32).fill(8) });
    const seed = factory.create('fake-control');
    await seed.compareAndSet('marker', null, 'kept');
    factory.revoke(seed);
    let release!: () => void;
    let loading!: () => void;
    const loadStarted = new Promise<void>((resolve) => { loading = resolve; });
    const loadRelease = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    const host = createPluginControlHost({
      records: [record()], secretStores: factory,
      loadControl: async () => { loading(); await loadRelease; return { createControl: () => ({ api: [], rpc: [], start() { starts++; }, dispose() {} }) }; },
    });
    const activation = host.activate('fake-control');
    await loadStarted;
    const deactivation = host.deactivate('fake-control');
    const shutdown = host.dispose();
    release();
    await expect(activation).rejects.toMatchObject({ code: 'disposed' });
    await deactivation;
    await shutdown;
    expect(starts).toBe(0);
    expect((await host.api.handle(new Request('http://localhost/api/plugins/fake-control/control/health')))?.status).toBe(503);
    const marker = factory.create('fake-control');
    expect(await marker.get('marker')).toEqual({ version: 1, value: 'kept' });
    factory.revoke(marker);
    db.close();
  });

  test('aggregates reconcile failures while initializing the remaining controls', async () => {
    const bad = record('sha256:' + 'b'.repeat(64), 'bad-control');
    const good = record('sha256:' + 'c'.repeat(64), 'good-control');
    const host = createPluginControlHost({
      records: [bad, good], secretStores: stores([]),
      loadControl: async (item) => {
        if (item.name === 'bad-control') throw new Error('bad start');
        return { createControl: () => ({ api: [], rpc: [], start() {}, dispose() {} }) };
      },
    });
    await expect(host.reconcile(['bad-control', 'good-control'])).rejects.toThrow();
    expect(host.status('bad-control')).toBe('degraded');
    expect(host.status('good-control')).toBe('ready');
  });

  test('rejects variable dynamic import and require artifacts, while allowing a static builtin', async () => {
    const sources = [
      `const path = './helper.ts'; export default { createControl() { return { api: [], rpc: [], start() { void import(path); }, dispose() {} }; } };`,
      `const path = './helper.ts'; export default { createControl() { return { api: [], rpc: [], start() { require(path); }, dispose() {} }; } };`,
    ];
    for (const [index, source] of sources.entries()) {
      const root = mkdtempSync(join(tmpdir(), `bungee-control-dynamic-${index}-`));
      tempRoots.push(root);
      const mainPath = join(root, 'main.ts');
      const controlPath = join(root, 'control.ts');
      writeFileSync(mainPath, 'export default {};\n');
      writeFileSync(join(root, 'helper.ts'), 'export const value = 1;\n');
      writeFileSync(controlPath, source);
      const name = `dynamic-${index}`;
      const item = { ...record(undefined, name), pluginPath: root, pluginDir: root, mainPath, controlPath, manifest: { ...record(undefined, name).manifest, control: { entry: 'control.ts', rpc: [] } } } as PluginManifestRecord;
      const host = createPluginControlHost({ records: [item], secretStores: stores([]) });
      await expect(host.activate(name)).rejects.toMatchObject({ code: 'start_failed' });
    }
    const root = mkdtempSync(join(tmpdir(), 'bungee-control-builtin-'));
    tempRoots.push(root);
    const mainPath = join(root, 'main.ts');
    const controlPath = join(root, 'control.ts');
    writeFileSync(mainPath, 'export default {};\n');
    writeFileSync(controlPath, `import { randomUUID } from 'node:crypto'; export default { createControl() { randomUUID(); return { api: [], rpc: [], start() {}, dispose() {} }; } };\n`);
    const base = record(undefined, 'builtin-control');
    const item = await finalizePluginManifestRecord({ ...base, pluginPath: root, pluginDir: root, mainPath, controlPath, manifest: { ...base.manifest, control: { entry: 'control.ts', rpc: [] } } });
    const host = createPluginControlHost({ records: [item], secretStores: stores([]) });
    await host.activate('builtin-control');
    expect(host.status('builtin-control')).toBe('ready');
  });

  test('rejects literal calls through require aliases and property aliases', async () => {
    const sources = [
      `const load = require; export default { createControl() { load('/absolute/helper.cjs'); return { api: [], rpc: [], start() {}, dispose() {} }; } };`,
      `const load = globalThis.require; export default { createControl() { load('/absolute/helper.cjs'); return { api: [], rpc: [], start() {}, dispose() {} }; } };`,
    ];
    for (const [index, source] of sources.entries()) {
      const root = mkdtempSync(join(tmpdir(), `bungee-control-require-alias-${index}-`));
      tempRoots.push(root);
      const mainPath = join(root, 'main.ts');
      const controlPath = join(root, 'control.ts');
      writeFileSync(mainPath, 'export default {};\n');
      writeFileSync(join(root, 'helper.cjs'), 'module.exports = { value: 1 };\n');
      writeFileSync(controlPath, source);
      const base = record(undefined, `require-alias-${index}`);
      const item = await finalizePluginManifestRecord({ ...base, pluginPath: root, pluginDir: root, mainPath, controlPath, manifest: { ...base.manifest, control: { entry: 'control.ts', rpc: [] } } });
      await expect(loadImmutableControlArtifact(item)).rejects.toThrow();
    }
    const staticRoot = mkdtempSync(join(tmpdir(), 'bungee-control-require-static-'));
    tempRoots.push(staticRoot);
    const staticMainPath = join(staticRoot, 'main.ts');
    const staticControlPath = join(staticRoot, 'control.ts');
    writeFileSync(staticMainPath, 'export default {};\n');
    writeFileSync(join(staticRoot, 'helper.cjs'), 'module.exports = { value: 1 };\n');
    writeFileSync(staticControlPath, `const helper = require('./helper.cjs'); export default { createControl() { void helper; return { api: [], rpc: [], start() {}, dispose() {} }; } };\n`);
    const staticBase = record(undefined, 'require-static');
    const staticItem = await finalizePluginManifestRecord({ ...staticBase, pluginPath: staticRoot, pluginDir: staticRoot, mainPath: staticMainPath, controlPath: staticControlPath, manifest: { ...staticBase.manifest, control: { entry: 'control.ts', rpc: [] } } });
    await expect(loadImmutableControlArtifact(staticItem)).resolves.toBeDefined();
  });

  test('isolates invocation budgets per control instance and retains cancelled work slots', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = record(undefined, 'control-a');
    const b = record(undefined, 'control-b');
    const host = createPluginControlHost({
      records: [a, b], secretStores: stores([]),
      loadControl: async (item) => item.name === 'control-a'
        ? { createControl: () => ({ api: [], rpc: [{ name: 'refresh', handler: 'refresh', invoke: async () => { await gate; return 'ok'; } }], start() {}, dispose() {} }) }
        : { createControl: () => ({ api: [{ handler: 'health', path: '/health', methods: ['GET'], invoke: async () => Response.json({ ok: true }) }], rpc: [], start() {}, dispose() {} }) },
    });
    await host.reconcile(['control-a', 'control-b']);
    const invocation = (name: string, signal = new AbortController().signal): BoundControlInvocation => ({
      pluginName: name,
      binding: { plugin: name, contributionId: 'source', bindingId: 'binding', bindingOptions: {} },
      attempt: { attemptId: name, clientStreaming: false, signal, boundClient: { call: async <T>() => undefined as T } },
    });
    const cancelled = new AbortController();
    const cancelledCall = host.invokeRpc('control-a', 'refresh', {}, invocation('control-a', cancelled.signal));
    cancelled.abort();
    await expect(cancelledCall).rejects.toMatchObject({ code: 'deadline' });
    const pending = Array.from({ length: 63 }, () => host.invokeRpc('control-a', 'refresh', {}, invocation('control-a')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(host.invokeRpc('control-a', 'refresh', {}, invocation('control-a'))).rejects.toMatchObject({ code: 'overloaded' });
    expect((await host.api.handle(new Request('http://localhost/api/plugins/control-b/control/health')))?.status).toBe(200);
    release();
    await Promise.all(pending);
  });
});
