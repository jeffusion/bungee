import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { startMasterComposition, type MasterProcessDependencies } from '../../src/master-runtime/composition';
import type { RepositorySnapshot } from '../../src/config-storage';
import type { ConfigPublicationWorkerProcess, ServingConfigWorker, WorkerAdmissionController } from '../../src/config-publication';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../../src/config-publication/types';
import type { ControlIpcMessage } from '../../src/plugin-control/ipc';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const MASTER_GENERATION = '10000000-0000-4000-8000-000000000001';

function identity(slot: number): ConfigProcessIdentity {
  return {
    master_generation: MASTER_GENERATION,
    worker_instance_id: `${slot === 0 ? '200' : '300'}00000-0000-4000-8000-000000000001`,
    worker_slot: slot,
  };
}

function snapshot(revision: number, disabled = false): RepositorySnapshot {
  return {
    revision,
    content_hash: HASH,
    aggregate: {
      logical_configuration: {
        services: [{ id: 'service-1', position: 1, name: 'service', endpoints: [{
          id: 'endpoint-1', position: 1, target: 'http://127.0.0.1:1', is_disabled: disabled,
          managedBy: { plugin: 'fake-control', contributionId: 'source', bindingId: 'binding-1' },
          plugins: [{ id: 'binding-1', name: 'fake-control', enabled: true, options: { accountRef: 'account-1' } }],
        }] }],
        routes: [], plugins: [],
      },
      plugin_activations: [{ plugin_name: 'fake-control' }],
    },
  } as unknown as RepositorySnapshot;
}

function evidence(process: ConfigPublicationWorkerProcess, current: ReturnType<typeof snapshot>, catalogHash: string): ServingConfigWorker {
  return {
    process, revision: current.revision, content_hash: current.content_hash,
    plugin_catalog_hash: catalogHash as never, publication: null, private_port: 41_234 + process.slot,
  };
}

function createProcess(slot: number) {
  const messages = new Set<(message: unknown) => void>();
  const exits = new Set<(value: { exited: true; pid: number }) => void>();
  const sent: ConfigMasterMessage[] = [];
  const process: ConfigPublicationWorkerProcess = {
    slot, identity: identity(slot), pid: 50_000 + slot,
    send: async (message) => { sent.push(message); },
    subscribeMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
    subscribeExit(listener) { exits.add(listener); return () => { exits.delete(listener); }; },
    terminate: async () => undefined,
  };
  return {
    process, sent,
    accept(message: ControlIpcMessage) { for (const listener of messages) listener(message); },
    exit() { for (const listener of exits) listener({ exited: true, pid: process.pid }); },
  };
}

test('composition binds control RPC to ACKed serving/draining snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-composition-control-'));
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  try {
    const pluginRoot = join(root, 'fake-control');
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, 'manifest.json'), JSON.stringify({
      name: 'fake-control', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'main.ts',
      control: { entry: 'control.ts', rpc: [{ name: 'refresh', access: 'bound-attempt' }] },
      capabilities: ['hooks', 'controlPlane', 'dynamicRuntimeLoad'], uiExtensionMode: 'none', engines: { bungee: '^4.3.0' }, configSchema: [],
    }));
    await writeFile(join(pluginRoot, 'main.ts'), 'export default {};\n');
    await writeFile(join(pluginRoot, 'control.ts'), 'export function createControl() { return { api: [], rpc: [{ name: "refresh", handler: "refresh", invoke: async () => ({ ok: true }) }], start() {}, dispose() {} }; }\n');
    const catalog = await PluginManifestCatalog.build({ scanDirectories: [root] });
    let current = snapshot(6);
    const database = new Database(':memory:');
    database.run('CREATE TABLE secret_store_namespaces (namespace TEXT PRIMARY KEY, namespace_epoch INTEGER NOT NULL)');
    database.run('CREATE TABLE secret_store_objects (namespace TEXT NOT NULL, key TEXT NOT NULL, namespace_epoch INTEGER NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, envelope BLOB, PRIMARY KEY(namespace,key))');
    const first = createProcess(0);
    const second = createProcess(1);
    const owned = new Set<ConfigPublicationWorkerProcess>([first.process]);
    let workerFactoryOptions: { onSpawn?: (process: ConfigPublicationWorkerProcess) => void } | undefined;
    let coordinator: { startCurrent: (value: unknown, existing?: readonly ServingConfigWorker[]) => Promise<unknown>; publish: (active: unknown, old: readonly ServingConfigWorker[]) => Promise<unknown> } | undefined;
    let composedCoordinator: { startCurrent(value: unknown): Promise<unknown>; publish(active: unknown, old: readonly ServingConfigWorker[]): Promise<unknown> } | undefined;
    let initialServing: readonly ServingConfigWorker[] = [];
    const repository = {
      getSnapshot: () => current,
      getActivePublication: () => null,
      getOperationState: () => null,
      getDatabase: () => database,
      beginPublication: () => null,
      beginWorkerAttempt: () => null,
      beginDrainingRecovery: () => null,
      recordWorkerResult: () => null,
      markDraining: () => null,
      finalizePublication: () => null,
      commit: () => null,
      close: () => database.close(),
    };
    const dependencies = {
      context: { cwd: root, moduleDirectory: root, executable: process.execPath, entry: join(root, 'worker.ts'), pid: process.pid, accessLogDbPath: join(root, 'access.db') },
      clock: { now: () => Date.now() }, readOptions: () => ({ configDbPath: join(root, 'config.db'), configDbLockPath: join(root, 'config.lock'), workerCount: 1, host: '127.0.0.1', port: 0, startupApplyTimeoutMs: 100, drainTimeoutMs: 100, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1_000, shutdownTimeoutMs: 100 }),
      acquireInstanceLock: async () => ({ release: async () => undefined }), migrateAccessDatabase: async () => undefined,
      createPluginPathResolver: () => ({}), buildPluginCatalog: async () => catalog, openRepository: () => repository,
      createAdmission: () => ({ prepare: () => ({ commit: () => undefined }), snapshot: () => [], select: () => null, clear: () => undefined }),
      generateTransportSecret: () => 'A'.repeat(43), resolveWorkerLaunch: () => ({ source: 'source', executable: process.execPath, args: [] }),
      createWorkerFactory: (options: { onSpawn?: (process: ConfigPublicationWorkerProcess) => void }) => {
        workerFactoryOptions = options;
        options.onSpawn?.(first.process);
        return { spawn: () => first.process, pids: () => [], owns: (process: ConfigPublicationWorkerProcess) => owned.has(process), subscribeExit: () => () => undefined, shutdownAll: async () => [] };
      },
      createMasterGeneration: () => MASTER_GENERATION,
      createCoordinator: (options: { admission: WorkerAdmissionController }) => {
        coordinator = {
            startCurrent: async (_value: unknown) => {
            initialServing = [evidence(first.process, current, catalog.hash)];
            options.admission.prepare(initialServing).commit();
            return { kind: 'startup_ready', serving: initialServing };
          },
          publish: async (_active: unknown, _old: readonly ServingConfigWorker[]) => {
            const serving = [evidence(second.process, current, catalog.hash)];
            options.admission.prepare(serving).commit();
            return { kind: 'converged', http_status: 200, operation: {} as never, serving };
          },
        };
        return { recoverAndPublish: async () => null, startCurrent: async (value: unknown, existing?: readonly ServingConfigWorker[]) => coordinator!.startCurrent(value, existing), publish: async (active: unknown, old: readonly ServingConfigWorker[]) => coordinator!.publish(active, old) };
      },
      createPublicListener: () => ({ port: 41_000, start: () => undefined, stop: async () => undefined }),
      createRuntime: (options: { coordinator: { startCurrent(value: unknown): Promise<unknown>; publish(active: unknown, old: readonly ServingConfigWorker[]): Promise<unknown> } }) => {
        composedCoordinator = options.coordinator;
        return { start: async () => { await options.coordinator.startCurrent(current); }, shutdown: async () => undefined };
      },
      installSignalHandlers: (runtime: { shutdown(): Promise<void> }) => ({ shutdown: runtime.shutdown, remove: () => undefined }),
      resolveAuthToken: () => undefined,
    } as unknown as MasterProcessDependencies;
    const handle = await startMasterComposition(dependencies);
    const binding = { plugin: 'fake-control', contributionId: 'source', bindingId: 'binding-1', bindingOptions: { accountRef: 'forged' } } as const;
    const call = async (worker: ReturnType<typeof createProcess>, revision: number): Promise<readonly ConfigMasterMessage[]> => {
      const before = worker.sent.length;
      worker.accept({ kind: 'plugin-control-call', requestId: crypto.randomUUID(), identity: { ...worker.process.identity, revision, endpointId: 'endpoint-1', attemptId: crypto.randomUUID() }, binding, method: 'refresh', payload: {}, deadlineAt: Date.now() + 1_000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return worker.sent.slice(before);
    };
    owned.add(second.process);
    workerFactoryOptions?.onSpawn?.(second.process);
    expect(await call(second, 7)).toHaveLength(0); // spawned, but not ACKed/admitted
    current = snapshot(7);
    const active = { snapshot: current, operation: {} } as never;
    const old = initialServing;
    await composedCoordinator!.publish(active, old);
    expect(await call(first, 6)).toHaveLength(1); // old worker is still draining with its real snapshot
    expect(await call(second, 99)).toHaveLength(0); // self-reported revision is not evidence
    current = snapshot(7, true);
    expect(await call(first, 6)).toHaveLength(0); // authoritative disable applies immediately
    current = snapshot(7);
    first.exit();
    expect(await call(first, 6)).toHaveLength(0); // exit prunes the historical snapshot
    await handle.shutdown();
  } finally {
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});
