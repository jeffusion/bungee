import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';
import {
  createDatabaseSecretStoreFactory,
  createDatabasePluginStorageFactory,
  createPluginControlHost,
  type SecretStoreFactory,
  type PluginStorageFactory,
} from '../../src/plugin-control';
import type { BoundAttemptContext, ControlApiHandlerContext, ControlHostContext, ControlPlugin, ControlRpcContext, SecretStore } from '../../src/plugin-control/contracts';
import type { PluginStorage } from '../../src/plugin.types';
import { SQLitePluginStorage } from '../../src/plugin-storage';
import { withTimeout, type BoundControlInvocation } from '../../src/plugin-control/host';
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

function storages(): PluginStorageFactory {
  return {
    create() {
      const values = new Map<string, unknown>();
      return {
        get: async <T = unknown>(key: string) => (values.get(key) as T | undefined) ?? null,
        set: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => { values.delete(key); },
        keys: async (prefix?: string) => [...values.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)),
        clear: async () => { values.clear(); },
        increment: async () => 0,
        compareAndSet: async () => false,
      } satisfies PluginStorage;
    },
    revoke: () => undefined,
  };
}

function pluginStorageDatabase(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE plugin_storage (
    plugin_name TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    ttl INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_name, key)
  )`);
  return db;
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
const timeoutRestorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of timeoutRestorers.splice(0)) restore();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function useTimeoutProbe() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Map<number, () => void>();
  let nextId = 1;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    const id = nextId++;
    pending.set(id, callback as () => void);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number | ReturnType<typeof setTimeout>) => {
    pending.delete(Number(id));
  }) as typeof clearTimeout;
  timeoutRestorers.push(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  return {
    pending: () => pending.size,
    fire(): void {
      const entry = pending.entries().next().value as [number, () => void] | undefined;
      if (entry === undefined) throw new Error('no pending timeout');
      pending.delete(entry[0]);
      entry[1]();
      entry[1]();
    },
  };
}

test('withTimeout preserves immediate success and rejection with a zero timeout', async () => {
  const timers = useTimeoutProbe();
  await expect(withTimeout(Promise.resolve('ok'), 0, 'timeout')).resolves.toBe('ok');
  expect(timers.pending()).toBe(0);
  const original = new Error('original');
  await expect(withTimeout(Promise.reject(original), 0, 'timeout')).rejects.toBe(original);
  expect(timers.pending()).toBe(0);
});

test('withTimeout settles a timeout once and consumes late completion', async () => {
  const timers = useTimeoutProbe();
  let resolveLate!: (value: string) => void;
  const lateResolve = new Promise<string>((resolve) => { resolveLate = resolve; });
  const timedOutResolve = withTimeout(lateResolve, 0, 'timeout');
  expect(timers.pending()).toBe(1);
  timers.fire();
  await expect(timedOutResolve).rejects.toMatchObject({ code: 'timeout' });
  resolveLate('late');
  await expect(lateResolve).resolves.toBe('late');
  expect(timers.pending()).toBe(0);

  let rejectLate!: (reason: unknown) => void;
  const lateReject = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
  const timedOutReject = withTimeout(lateReject, 0, 'timeout');
  expect(timers.pending()).toBe(1);
  timers.fire();
  await expect(timedOutReject).rejects.toMatchObject({ code: 'timeout' });
  const lateError = new Error('late rejection');
  rejectLate(lateError);
  expect(timers.pending()).toBe(0);
});

describe('plugin control host integration', () => {
  test('imports inert artifact, reuses one instance, and only revokes before disposal', async () => {
    const events: string[] = [];
    const host = createPluginControlHost({ records: [record()], secretStores: stores(events), storage: storages(), loadControl: async () => control(events) });
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
      storage: storages(),
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
    expect((await host.api.handle(new Request('http://localhost/api/plugins/fake-control/control/health')))?.status).toBe(503);
    const afterFailure = factory.create('fake-control');
    expect(await afterFailure.get('marker')).toEqual({ version: 1, value: 'kept' });
    factory.revoke(afterFailure);
    await host.dispose();
    failStart = false;
    const restartedHost = createPluginControlHost({
      records: [recordWithPaths], secretStores: factory, storage: storages(),
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

  test('injects one persistent, plugin-scoped storage into control, API, and RPC', async () => {
    const db = pluginStorageDatabase();
    const storageFactory = createDatabasePluginStorageFactory(db);
    const contexts: ControlHostContext[] = [];
    const makeControl = () => ({
      createControl(context: ControlHostContext) {
        contexts.push(context);
        return {
          api: [{ handler: 'health', path: '/health', methods: ['GET'], invoke: async (apiContext: ControlApiHandlerContext) => {
            expect(apiContext.storage).toBe(context.storage);
            await apiContext.storage.set('api', 'seen');
            return Response.json({ ok: true });
          } }],
          rpc: [{ name: 'refresh', handler: 'refresh', invoke: async (_payload: unknown, rpcContext: ControlRpcContext) => {
            expect(rpcContext.storage).toBe(context.storage);
            return rpcContext.storage.get('marker');
          } }],
          start: async () => { await context.storage.set('marker', 'kept'); },
          dispose: () => undefined,
        };
      },
    });
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]), storage: storageFactory,
      loadControl: async () => makeControl(),
    });

    const handle = await host.activate('fake-control');
    const response = await host.api.handle(new Request('http://localhost/api/plugins/fake-control/control/health'));
    expect(response?.status).toBe(200);
    const attempt: BoundAttemptContext = {
      attemptId: 'attempt', clientStreaming: false, signal: new AbortController().signal,
      boundClient: { call: async <T>() => undefined as T },
    };
    expect((await host.invokeRpc('fake-control', 'refresh', {}, {
      pluginName: 'fake-control',
      binding: { plugin: 'fake-control', contributionId: 'source', bindingId: 'binding', bindingOptions: {} },
      attempt,
    })) as unknown).toBe('kept');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.storage).toBe(handle.storage);
    expect(db.query<{ plugin_name: string; key: string }, []>(
      'SELECT plugin_name, key FROM plugin_storage ORDER BY key',
    ).all()).toEqual([
      { plugin_name: 'fake-control', key: 'api' },
      { plugin_name: 'fake-control', key: 'marker' },
    ]);

    await host.dispose();
    expect((await host.api.handle(new Request('http://localhost/api/plugins/fake-control/control/health')))?.status).toBe(503);
    await expect(host.invokeRpc('fake-control', 'refresh', {}, {
      pluginName: 'fake-control',
      binding: { plugin: 'fake-control', contributionId: 'source', bindingId: 'binding', bindingOptions: {} },
      attempt,
    })).rejects.toMatchObject({ code: 'inactive' });
    const restartedContexts: ControlHostContext[] = [];
    const restartedHost = createPluginControlHost({
      records: [record()], secretStores: stores([]), storage: storageFactory,
      loadControl: async () => ({
        createControl(context) {
          restartedContexts.push(context);
          return { api: [], rpc: [], start: async () => {
            expect(await context.storage.get<string>('marker')).toBe('kept');
          }, dispose: () => undefined };
        },
      }),
    });
    const restartedHandle = await restartedHost.activate('fake-control');
    expect(restartedContexts[0]?.storage).toBe(restartedHandle.storage);
    await restartedHost.dispose();
    db.close();
  });

  test('isolates two plugin storage namespaces', async () => {
    const db = pluginStorageDatabase();
    const factory = createDatabasePluginStorageFactory(db);
    const first = factory.create('plugin-a');
    const second = factory.create('plugin-b');
    await first.set('shared', 'a');
    await second.set('shared', 'b');

    expect(await first.get<string>('shared')).toBe('a');
    expect(await second.get<string>('shared')).toBe('b');
    expect(db.query<{ plugin_name: string }, []>(
      'SELECT plugin_name FROM plugin_storage ORDER BY plugin_name',
    ).all()).toEqual([{ plugin_name: 'plugin-a' }, { plugin_name: 'plugin-b' }]);
    db.close();
  });

  test('keeps database and namespace out of the storage capability and revokes every method', async () => {
    const db = pluginStorageDatabase();
    const factory = createDatabasePluginStorageFactory(db);
    const storage = factory.create('plugin-a');
    await storage.set('marker', 'kept');

    expect(Object.getOwnPropertyNames(storage)).not.toContain('db');
    expect(Object.getOwnPropertyNames(storage)).not.toContain('pluginName');
    expect(Reflect.get(storage, 'pluginName')).toBeUndefined();
    expect(Reflect.set(storage, 'pluginName', 'plugin-b')).toBe(false);
    factory.revoke(storage);

    await expect(storage.get('marker')).rejects.toThrow();
    await expect(storage.set('late', 'bad')).rejects.toThrow();
    await expect(storage.delete('marker')).rejects.toThrow();
    await expect(storage.keys()).rejects.toThrow();
    await expect(storage.clear()).rejects.toThrow();
    await expect(storage.increment('counter', 'value')).rejects.toThrow();
    await expect(storage.compareAndSet('counter', 'value', null, 1)).rejects.toThrow();
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM plugin_storage').get()?.count).toBe(1);
    db.close();
  });

  test('disposes a start-failed control once and blocks late storage writes', async () => {
    const db = pluginStorageDatabase();
    const factory = createDatabasePluginStorageFactory(db);
    let disposeCount = 0;
    let lateWriteRejected = false;
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]), storage: factory, startTimeoutMs: 5,
      loadControl: async () => ({ createControl: (context) => ({
        api: [], rpc: [],
        start: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          try { await context.storage.set('late', 'bad'); }
          catch { lateWriteRejected = true; throw new Error('revoked'); }
        },
        dispose: () => { disposeCount++; },
      }) }),
    });

    await expect(host.activate('fake-control')).rejects.toMatchObject({ code: 'timeout' });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(lateWriteRejected).toBe(true);
    expect(disposeCount).toBe(1);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM plugin_storage').get()?.count).toBe(0);
    await host.dispose();
    expect(disposeCount).toBe(1);
    db.close();
  });

  test('waits for an invocation task that ignores caller abort before disposing control', async () => {
    const db = pluginStorageDatabase();
    const factory = createDatabasePluginStorageFactory(db);
    let release!: () => void;
    let started!: () => void;
    let disposed = false;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]), storage: factory,
      loadControl: async () => ({ createControl: () => ({
        api: [{ handler: 'health', path: '/health', methods: ['GET'], invoke: async (context) => {
          started();
          await gate;
          await context.storage.set('late', 'blocked');
          return Response.json({ ok: true });
        } }],
        rpc: [], start() {}, dispose: () => { disposed = true; },
      }) }),
    });
    await host.activate('fake-control');
    const requestController = new AbortController();
    const request = host.api.handle(new Request('http://localhost/api/plugins/fake-control/control/health', { signal: requestController.signal }));
    await startedPromise;
    requestController.abort();
    expect((await request)?.status).toBe(504);

    const shutdown = host.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    release();
    await shutdown;
    expect(disposed).toBe(true);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM plugin_storage').get()?.count).toBe(0);
    db.close();
  });

  test('binds JSON paths and rejects injected storage fields', async () => {
    const db = pluginStorageDatabase();
    const storage = new SQLitePluginStorage(db, 'plugin-a');
    expect(await storage.increment('counter', 'value')).toBe(1);
    expect(await storage.increment('counter', 'value', 2)).toBe(3);
    expect(await storage.compareAndSet('counter', 'value', 3, 4)).toBe(true);
    const injected = "value'); DROP TABLE plugin_storage; --";
    await expect(storage.increment('counter', injected)).rejects.toThrow();
    await expect(storage.compareAndSet('counter', injected, 4, 5)).rejects.toThrow();
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM plugin_storage').get()?.count).toBe(1);
    db.close();
  });

  test('does not create storage or import control for inactive or unknown plugins', async () => {
    let storageCreates = 0;
    let imports = 0;
    const storage: PluginStorageFactory = {
      create: () => {
        storageCreates++;
        return storages().create('fake-control');
      },
      revoke: () => undefined,
    };
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]), storage,
      loadControl: async () => { imports++; return control([]); },
    });

    await host.reconcile([]);
    await expect(host.activate('unknown')).rejects.toMatchObject({ code: 'not_declared' });
    expect(storageCreates).toBe(0);
    expect(imports).toBe(0);
    await host.dispose();
  });

  test('rejects a second instance while the first dispose is unconfirmed', async () => {
    let release!: () => void;
    const disposing = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    let disposeCalls = 0;
    let signalDisposeStarted!: () => void;
    const disposeStarted = new Promise<void>((resolve) => { signalDisposeStarted = resolve; });
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]), storage: storages(), startTimeoutMs: 10,
      loadControl: async () => ({ createControl: () => ({ api: [], rpc: [], start: () => { starts++; }, dispose: () => { disposeCalls += 1; signalDisposeStarted(); return disposing; } }) }),
    });
    let stopping: Promise<void> | undefined;
    const phase = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); }
      catch (error) { throw new Error(`second-instance lifecycle phase failed: ${name}: ${String(error)}`, { cause: error }); }
    };
    // Bun 1.4.2 on Windows stalls `.rejects` matchers on unsettled promises and starves
    // the host's 10ms start timer; capture rejections with plain awaits instead.
    const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
      try { await promise; } catch (error) { return error; }
      throw new Error('expected the promise to reject');
    };
    try {
      await phase('activate first control', () => host.activate('fake-control').then(() => undefined));
      stopping = host.deactivate('fake-control');
      void stopping.catch(() => undefined);
      await phase('allow dispose to become pending', () => disposeStarted);
      expect(host.status('fake-control')).toBe('stopping');
      expect(starts).toBe(1);
      const replacementError = await phase('reject replacement while dispose is pending', () => captureRejection(host.activate('fake-control')));
      expect(replacementError).toMatchObject({ code: 'timeout' });
      release();
      const stoppingError = await phase('confirm first dispose timeout', () => captureRejection(stopping!));
      expect(stoppingError).toMatchObject({ code: 'timeout' });
    } finally {
      release();
      await stopping?.catch(() => undefined);
      await host.dispose().catch(() => undefined);
    }
    expect(disposeCalls).toBe(1);
  }, 5_000);

  test('does not replace a live instance when the artifact identity changes', async () => {
    const events: string[] = [];
    const first = record();
    const host = createPluginControlHost({ records: [first], secretStores: stores(events), storage: storages(), loadControl: async () => control(events) });
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
    const host = createPluginControlHost({ records: [artifact], secretStores: stores([]), storage: storages() });
    expect((globalThis as Record<string, unknown>).__inertControlImport).toBeUndefined();
    await host.activate('fake-control');
    expect((globalThis as Record<string, unknown>).__inertControlImport).toBe(1);
    writeFileSync(helperPath, 'export const marker = 2;\n');
    const changedHost = createPluginControlHost({ records: [artifact], secretStores: stores([]), storage: storages() });
    await expect(changedHost.activate('fake-control')).rejects.toMatchObject({ code: 'start_failed' });
    expect(changedHost.status('fake-control')).toBe('degraded');
  });

  test('fails closed before reading a non-unique control entry output', async () => {
    for (const entryPointCount of [0, 2]) {
      const root = mkdtempSync(join(tmpdir(), `bungee-control-output-${entryPointCount}-`));
      tempRoots.push(root);
      const mainPath = join(root, 'main.ts');
      const controlPath = join(root, 'control.ts');
      writeFileSync(mainPath, 'export default {};\n');
      writeFileSync(controlPath, 'export default { createControl() { return { api: [], rpc: [], start() {}, dispose() {} }; } };\n');
      const base = record();
      const artifact = await finalizePluginManifestRecord({
        ...base, pluginPath: root, pluginDir: root, mainPath, controlPath,
        manifest: { ...base.manifest, control: { entry: 'control.ts', rpc: [] } },
      });
      const originalBuild = Bun.build;
      let buildCount = 0;
      const build = originalBuild as unknown as (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
      (Bun as unknown as { build: typeof build }).build = async (options) => {
        expect(options.absWorkingDirectory).toBe(root);
        const result = await build(options);
        buildCount += 1;
        if (buildCount !== 2) return result;
        const output = { kind: 'entry-point' as const, path: 'unread-output', text: async () => { throw new Error('output was read'); } };
        return { ...result, outputs: entryPointCount === 0 ? [] : [output, output] };
      };
      try {
        await expect(loadImmutableControlArtifact(artifact)).rejects.toThrow('output is not unique');
      } finally {
        (Bun as unknown as { build: typeof originalBuild }).build = originalBuild;
      }
    }
  });

  test('does not apply control load restrictions to the separately cataloged main artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-control-main-external-'));
    tempRoots.push(root);
    const mainPath = join(root, 'main.ts');
    const controlPath = join(root, 'control.ts');
    writeFileSync(join(root, 'helper.cjs'), 'module.exports = { marker: 1 };\n');
    writeFileSync(mainPath, `const load = require; load('./helper.cjs'); export default {};\n`);
    writeFileSync(controlPath, `export default { createControl() { return { api: [], rpc: [], start() {}, dispose() {} }; } };\n`);
    const base = record();
    const artifact = await finalizePluginManifestRecord({
      ...base, pluginPath: root, pluginDir: root, mainPath, controlPath,
      manifest: { ...base.manifest, control: { entry: 'control.ts', rpc: [] } },
    });
    const host = createPluginControlHost({ records: [artifact], secretStores: stores([]), storage: storages() });

    await host.activate('fake-control');
    expect(host.status('fake-control')).toBe('ready');
    await host.dispose();
  });

  test('enforces one per-control invocation budget for RPC calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = createPluginControlHost({
      records: [record()], secretStores: stores([]), storage: storages(),
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
      records: [record()], secretStores: factory, storage: storages(),
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
      records: [bad, good], secretStores: stores([]), storage: storages(),
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
      const host = createPluginControlHost({ records: [item], secretStores: stores([]), storage: storages() });
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
    const host = createPluginControlHost({ records: [item], secretStores: stores([]), storage: storages() });
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
      records: [a, b], secretStores: stores([]), storage: storages(),
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
