import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { startMasterComposition, type MasterProcessDependencies } from '../../src/master-runtime/composition';
import { serializeErrorChain } from '../../src/master-runtime/error-chain';
import { createPluginControlHttpClient, createPluginControlRpcCredential } from '../../src/plugin-control';
import type { ConfigurationRecovery, RepositorySnapshot } from '../../src/config-storage';
import type { ConfigPublicationWorkerProcess, ServingConfigWorker, WorkerAdmissionController } from '../../src/config-publication';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../../src/config-publication/types';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed } from '../../src/supervision';
import { MasterRuntime } from '../../src/master-runtime/runtime';
import type { ConfigurationRecoveryScheduler } from '../../src/master-runtime/configuration-recovery';
import type { SupervisedConfigWorkerFactoryOptions } from '../../src/master-runtime/supervised-worker-factory';
import {
  MASTER_COMPOSITION_CONTROL_A,
  MASTER_COMPOSITION_CONTROL_B,
  writeMasterCompositionControls,
} from '../fixtures/master-composition-controls';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const MASTER_GENERATION = '10000000-0000-4000-8000-000000000001';

function identity(slot: number): ConfigProcessIdentity {
  return {
    master_generation: MASTER_GENERATION,
    worker_instance_id: `${slot === 0 ? '200' : '300'}00000-0000-4000-8000-000000000001`,
    worker_slot: slot,
  };
}

function snapshot(revision: number, disabled = false, accountRef = 'serving'): RepositorySnapshot {
  return {
    revision,
    content_hash: HASH,
    aggregate: {
      logical_configuration: {
        services: [{ id: 'service-1', position: 1, name: 'service', endpoints: [{
          id: 'endpoint-1', position: 1, target: 'http://127.0.0.1:1', is_disabled: disabled,
          managedBy: { plugin: 'fake-control', contributionId: 'source', bindingId: 'binding-1' },
          plugins: [{ id: 'binding-1', name: 'fake-control', enabled: true, options: { accountRef } }],
        }] }],
        routes: [], plugins: [],
      },
      plugin_activations: [{ plugin_name: 'fake-control' }],
    },
  } as unknown as RepositorySnapshot;
}

function evidence(process: ConfigPublicationWorkerProcess, current: ReturnType<typeof snapshot>, catalogHash: string): ServingConfigWorker {
  return {
    process,
    boot_nonce: (process as ConfigPublicationWorkerProcess & { readonly boot_nonce: string }).boot_nonce,
    revision: current.revision, content_hash: current.content_hash,
    plugin_catalog_hash: catalogHash as never, publication: null, private_port: 41_234 + process.slot,
  };
}

function createProcess(slot: number) {
  const exits = new Set<(value: { exited: true; pid: number }) => void>();
  const sent: ConfigMasterMessage[] = [];
  const process = {
    slot, identity: identity(slot), pid: 50_000 + slot,
    boot_nonce: `${slot === 0 ? '400' : '500'}00000-0000-4000-8000-000000000001`,
    send: async (message) => { sent.push(message); },
    subscribeMessage() { return () => undefined; },
    subscribeExit(listener) { exits.add(listener); return () => { exits.delete(listener); }; },
    terminate: async () => undefined,
  } as ConfigPublicationWorkerProcess & { readonly boot_nonce: string };
  return {
    process, sent,
    exit() { for (const listener of exits) listener({ exited: true, pid: process.pid }); },
  };
}

test('composition binds control RPC to ACKed serving/draining snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-composition-control-'));
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let configDatabase: Database | undefined;
  let accessDatabase: Database | undefined;
  try {
    const pluginRoot = join(root, 'fake-control');
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, 'manifest.json'), JSON.stringify({
      name: 'fake-control', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'main.ts',
      control: { entry: 'control.ts', rpc: [{ name: 'refresh', access: 'bound-attempt' }] },
      capabilities: ['hooks', 'controlPlane', 'dynamicRuntimeLoad'], uiExtensionMode: 'none', engines: { bungee: '^4.3.0' }, configSchema: [],
    }));
    await writeFile(join(pluginRoot, 'main.ts'), 'export default {};\n');
    (globalThis as any).__bungeeCompositionControlInvokes = 0;
    await writeFile(join(pluginRoot, 'control.ts'), 'export function createControl(context) { return { api: [], rpc: [{ name: "refresh", handler: "refresh", invoke: async (payload, context) => { globalThis.__bungeeCompositionControlInvokes += 1; return { payload, accountRef: context.binding.bindingOptions.accountRef }; } }], async start() { await context.secretStore.compareAndSet("db-marker", null, "config-db"); await context.storage.set("db-marker", "access-db"); }, dispose() {} }; }\n');
    const catalog = await PluginManifestCatalog.build({ scanDirectories: [root] });
    let current = snapshot(6, false, 'serving-6');
    configDatabase = new Database(':memory:');
    configDatabase!.run('CREATE TABLE secret_store_namespaces (namespace TEXT PRIMARY KEY, namespace_epoch INTEGER NOT NULL)');
    configDatabase!.run('CREATE TABLE secret_store_objects (namespace TEXT NOT NULL, key TEXT NOT NULL, namespace_epoch INTEGER NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, envelope BLOB, PRIMARY KEY(namespace,key))');
    accessDatabase = new Database(':memory:');
    accessDatabase!.run('CREATE TABLE plugin_storage (plugin_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ttl INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (plugin_name, key))');
    const first = createProcess(0);
    const second = createProcess(1);
    const owned = new Set<ConfigPublicationWorkerProcess>([first.process]);
    const committed = new Set<ConfigPublicationWorkerProcess>();
    const factoryEligibility = new Set<() => void>();
    const controlLookupOrder: string[] = [];
    const publicationOrder: string[] = [];
    const ingressEligibility = new Set<() => void>();
    let activeAdmission: any = null;
    let admissionSequence = 0;
    let blockRuntimeSnapshot = false;
    let snapshotStarted: (() => void) | undefined;
    let releaseRuntimeSnapshot: (() => void) | undefined;
    let blockRuntimeShutdown = false;
    let releaseRuntimeShutdown!: () => void;
    const pendingRuntimeShutdown = new Promise<void>((resolve) => { releaseRuntimeShutdown = resolve; });
    let authority = { controller_epoch: 1, controller_id: '00000000-0000-4000-8000-000000000001' };
    let managementOptions: any;
    let coordinator: { startCurrent: (value: unknown, existing?: readonly ServingConfigWorker[]) => Promise<unknown>; publish: (active: unknown, old: readonly ServingConfigWorker[]) => Promise<unknown> } | undefined;
    let composedCoordinator: { startCurrent(value: unknown): Promise<unknown>; publish(active: unknown, old: readonly ServingConfigWorker[]): Promise<unknown> } | undefined;
    let initialServing: readonly ServingConfigWorker[] = [];
    let adoptionAttempts = 0;
    const repository = {
      getSnapshot: () => current,
      appendServingSnapshot: () => { publicationOrder.push('append'); },
      getServingSnapshot: () => null,
      getActivePublication: () => null,
      getOperationState: () => null,
      getCurrentOperationState: () => null,
      getDatabase: () => configDatabase,
      beginPublication: () => null,
      beginWorkerAttempt: () => null,
      beginDrainingRecovery: () => null,
      recordWorkerResult: () => null,
      markDraining: () => null,
      finalizePublication: () => null,
      commit: () => null,
      claimControllerWithCapability: (_capability: unknown, controllerId: string) => {
        authority = { controller_epoch: 1, controller_id: controllerId };
        return { instance_id: '11111111-1111-4111-8111-111111111111', controller_epoch: 1,
          current_controller_id: controllerId, updated_at: Date.now() };
      },
      close: () => undefined,
    };
    const notify = (listeners: Set<() => void>): void => { for (const listener of [...listeners]) listener(); };
    const workerStatus = (worker: ServingConfigWorker) => {
      const admissionWorker = activeAdmission?.workers[0];
      const requestId = '70000000-0000-4000-8000-000000000001';
      const statusWorker = admissionWorker ?? {
        ...worker.process.identity, boot_nonce: worker.boot_nonce, private_port: worker.private_port,
      };
      return {
        schema: 'bungee-worker-status-v1', role: 'worker', ...statusWorker, pid: worker.process.pid,
        control_port: 44_000, phase: 'serving', frozen: false, revision: worker.revision,
        content_hash: worker.content_hash, plugin_catalog_hash: worker.plugin_catalog_hash, started_at: 1,
        snapshot_hash: worker.content_hash, authority, request_correlation: requestId,
        replay: { sequence: 1, request_id: requestId },
        evidence: { kind: 'ready', message: {
          status: 'config-ready', ...statusWorker, pid: worker.process.pid, revision: worker.revision,
          content_hash: worker.content_hash, plugin_catalog_hash: worker.plugin_catalog_hash,
          plugin_runtime_generation: 1, required_plugins: ['fake-control'], serving_plugins: ['fake-control'], publication: null,
        } },
      };
    };
    const strictFactory = {
      committed,
      lookupExactControlSession(identity: any) {
        const process = [...this.committed].find((candidate) => candidate.identity.worker_instance_id === identity.worker_instance_id);
        controlLookupOrder.push(process === undefined ? 'before-markCommitted' : 'after-markCommitted');
        const activeWorker = activeAdmission?.workers.find((candidate: any) => candidate.worker_instance_id === identity.worker_instance_id);
        if (process === undefined || activeWorker === undefined
          || process.identity.worker_instance_id !== identity.worker_instance_id
          || activeWorker.boot_nonce !== identity.boot_nonce || activeWorker.private_port !== identity.private_port
          || activeAdmission.revision !== identity.revision || activeAdmission.content_hash !== identity.content_hash
          || activeAdmission.plugin_catalog_hash !== identity.plugin_catalog_hash) return null;
        const credential = deriveWorkerSupervisionCredential(
          deriveWorkerSupervisionSeed(new Uint8Array(32).fill(9), identity.master_generation, identity.worker_instance_id, identity.worker_slot),
          identity.boot_nonce,
        );
        return {
          process, credential, controlState: 'attached' as const,
          status: async () => workerStatus(evidence(process,
            process === first.process ? snapshot(6, false, 'serving-6') : current,
            activeAdmission.plugin_catalog_hash)),
          runtimeSnapshot: async () => {
            if (blockRuntimeSnapshot) {
              snapshotStarted?.();
              await new Promise<void>((resolve) => { releaseRuntimeSnapshot = resolve; });
            }
            return {
              schema: 'bungee-worker-runtime-snapshot-v1', ...activeWorker, pid: process.pid,
              revision: activeAdmission.revision, content_hash: activeAdmission.content_hash,
              plugin_catalog_hash: activeAdmission.plugin_catalog_hash, captured_at: 1,
              result: { kind: 'complete', records: [{ state_key: 'composition-state', upstream_id: 'composition-upstream',
                circuit_state: 'HEALTHY', active_request_count: 1, last_used_time: 1, last_failure_time: null,
                consecutive_failures: 0, consecutive_successes: 1, health_check_successes: 0,
                health_check_failures: 0, recovery_attempt_count: 0 }] },
            };
          },
        };
      },
      subscribeEligibilityChange(listener: () => void) { factoryEligibility.add(listener); return () => { factoryEligibility.delete(listener); }; },
    };
    const dependencies = {
      context: { cwd: root, moduleDirectory: root, executable: process.execPath, entry: join(root, 'worker.ts'), pid: process.pid, accessLogDbPath: join(root, 'access.db') },
      clock: { now: () => Date.now() },
      createMasterStats: () => ({
        getDatabase: () => accessDatabase,
        matches: () => false,
        handle: async () => new Response(null, { status: 404 }),
        close: async () => { accessDatabase?.close(true); },
      }),
      readOptions: () => ({ configDbPath: join(root, 'config.db'), configDbLockPath: join(root, 'config.lock'), workerCount: 1, host: '127.0.0.1', port: 0, startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
      acquireInstanceLock: async () => ({ release: async () => undefined }), migrateAccessDatabase: async () => undefined,
      createPluginPathResolver: () => ({}), buildPluginCatalog: async () => catalog, openRepository: () => repository,
      createAdmission: () => ({ prepare: () => { publicationOrder.push('local-prepare'); return { commit: () => { publicationOrder.push('local-commit'); } }; }, adoptCommitted: () => undefined, snapshot: () => [], select: () => null, clear: () => undefined }),
      resolveWorkerLaunch: () => ({ source: 'source', executable: process.execPath, args: [] }),
      createWorkerFactory: (options: SupervisedConfigWorkerFactoryOptions) => {
        return {
          ...strictFactory,
          spawn: () => first.process, pids: () => [], owns: (process: ConfigPublicationWorkerProcess) => owned.has(process),
          subscribeExit: () => () => undefined, subscribeUnavailable: () => () => undefined,
          disconnectAll: () => undefined, markCommitted(processes: readonly ConfigPublicationWorkerProcess[]) {
            for (const process of processes) { committed.add(process); }
            notify(factoryEligibility);
          }, shutdownAll: async () => [], setRateLimitSession: () => undefined, retireForIngressBootChange: async () => ({ exited: [], exitUnknown: [] }),
          discoverAndAdopt: async () => {
            adoptionAttempts += 1;
            return activeAdmission === null
              ? { kind: 'recovering' as const, code: 'admission_mismatch' as const, workers: [], issues: [] }
              : { kind: 'adopted' as const, serving: [evidence(first.process, current, catalog.hash)], issues: [] };
          },
        };
      },
      createMasterGeneration: () => MASTER_GENERATION,
      createCoordinator: (options: { admission: WorkerAdmissionController }) => {
        coordinator = {
            startCurrent: async (_value: unknown) => {
            initialServing = [evidence(first.process, current, catalog.hash)];
            await (await options.admission.prepare(initialServing)).commit();
            return { kind: 'startup_ready', serving: initialServing };
          },
          publish: async (_active: unknown, _old: readonly ServingConfigWorker[]) => {
            const serving = [evidence(second.process, current, catalog.hash)];
            await (await options.admission.prepare(serving)).commit();
            return { kind: 'converged', http_status: 200, operation: {} as never, serving };
          },
        };
        return { recoverAndPublish: async () => null, startCurrent: async (value: unknown, existing?: readonly ServingConfigWorker[]) => coordinator!.startCurrent(value, existing), publish: async (active: unknown, old: readonly ServingConfigWorker[]) => coordinator!.publish(active, old) };
      },
      createManagementListener: (options: any) => {
        managementOptions = options;
        return { port: 41_000, start: () => undefined, stop: async () => undefined };
      },
      createControllerClaim: () => ({ consume<Result>(claim: () => Result): Result { return claim(); } }),
      deriveTransportSecret: () => Buffer.alloc(32, 8).toString('base64url'),
      createIngressController: () => ({
        controlPort: 30_10, publicPort: 41_001,
        authenticatedRateLimitSession: () => ({ supervisionPort: 30_10, expectedIngress: {
          process_instance_id: '70000000-0000-4000-8000-000000000001',
          boot_nonce: '70000000-0000-4000-8000-000000000002',
        } }),
        connect: async () => undefined, stop: async () => undefined, disconnect: async () => undefined,
        shutdownDataPlane: async () => undefined,
        trustedActiveAdmission: () => activeAdmission,
        trustedActiveAdmissionIfFresh: () => activeAdmission,
        currentControllerAuthority: () => authority,
        hasTrustedActiveAdmission: () => activeAdmission !== null,
        subscribeEligibilityChange(listener: () => void) { ingressEligibility.add(listener); return () => { ingressEligibility.delete(listener); }; },
        prepare: async (workers: readonly ServingConfigWorker[]) => {
          publicationOrder.push('ingress-prepare');
          return {
          commit: async () => {
            publicationOrder.push('ingress-commit');
            const firstWorker = workers[0]!;
            activeAdmission = {
              master_generation: firstWorker.process.identity.master_generation, admission_sequence: ++admissionSequence,
              revision: firstWorker.revision, content_hash: firstWorker.content_hash,
              plugin_catalog_hash: firstWorker.plugin_catalog_hash,
              workers: workers.map((worker) => ({ ...worker.process.identity, boot_nonce: worker.boot_nonce, private_port: worker.private_port })),
            };
            notify(ingressEligibility);
          }, abort: async () => undefined,
          };
        },
        status: async () => ({ state: 'attached', registry: { active: activeAdmission, prepared: null, retired: [] } }),
      } as unknown as import('../../src/ingress/master-controller').MasterIngressController),
      createRuntime: (options: { coordinator: { startCurrent(value: unknown): Promise<unknown>; publish(active: unknown, old: readonly ServingConfigWorker[]): Promise<unknown> } }) => {
        composedCoordinator = options.coordinator;
        return {
          start: async () => { await options.coordinator.startCurrent(current); },
          shutdown: async () => {
            if (blockRuntimeShutdown) await pendingRuntimeShutdown;
          },
          reportAsynchronousFailure: () => undefined,
        };
      },
      installSignalHandlers: (runtime: { shutdown(): Promise<void> }) => ({ shutdown: runtime.shutdown, remove: () => undefined }),
      resolveAuthToken: () => undefined,
    } as unknown as MasterProcessDependencies;
    activeAdmission = {
      master_generation: first.process.identity.master_generation, admission_sequence: 1,
      revision: current.revision, content_hash: current.content_hash, plugin_catalog_hash: catalog.hash,
      workers: [{ ...first.process.identity, boot_nonce: first.process.boot_nonce, private_port: 41_234 }],
    };
    const handle = await startMasterComposition(dependencies);
    expect(configDatabase!.prepare('SELECT key FROM secret_store_objects WHERE key = ?').get('db-marker')).toBeTruthy();
    expect(accessDatabase!.prepare('SELECT value FROM plugin_storage WHERE key = ?').get('db-marker')).toEqual({ value: '"access-db"' });
    expect(configDatabase!.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'plugin_storage'").get()).toEqual({ count: 0 });
    expect(managementOptions.internalPluginControl.handle).toBeFunction();
    expect(adoptionAttempts).toBe(1);
    expect(controlLookupOrder.slice(-2)).toEqual(['after-markCommitted', 'after-markCommitted']);
    expect(publicationOrder.indexOf('append')).toBeGreaterThanOrEqual(0);
    expect(publicationOrder.indexOf('append')).toBeLessThan(publicationOrder.indexOf('local-prepare'));
    expect(publicationOrder.indexOf('local-prepare')).toBeLessThan(publicationOrder.indexOf('ingress-prepare'));
    expect(publicationOrder.indexOf('ingress-prepare')).toBeLessThan(publicationOrder.indexOf('ingress-commit'));
    const runtimeResponse = await managementOptions.controlApi.handle(new Request('http://localhost/api/runtime/upstreams'));
    expect(await runtimeResponse.json()).toMatchObject({ availability: 'complete', upstreams: [{
      state_key: 'composition-state', upstream_id: 'composition-upstream', active_request_count: 1,
    }] });
    const servingWorker = initialServing[0]!;
    const rawCredential = deriveWorkerSupervisionCredential(
      deriveWorkerSupervisionSeed(new Uint8Array(32).fill(9), servingWorker.process.identity.master_generation,
        servingWorker.process.identity.worker_instance_id, servingWorker.process.identity.worker_slot),
      servingWorker.boot_nonce!,
    );
    const client = createPluginControlHttpClient({
      baseUrl: 'http://127.0.0.1:1',
      session: () => ({ credential: createPluginControlRpcCredential(rawCredential, {
        ...servingWorker.process.identity, boot_nonce: servingWorker.boot_nonce!,
      }), authority }),
      fetchImpl: (_input, init) => managementOptions.internalPluginControl.handle(
        new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1', init),
      ),
    });
    await expect(client.call({ revision: servingWorker.revision, endpoint_id: 'endpoint-1',
      attempt_id: crypto.randomUUID(), method: 'refresh', payload: {} }, new AbortController().signal)).resolves.toEqual({ payload: {}, accountRef: 'serving-6' });
    expect((globalThis as any).__bungeeCompositionControlInvokes).toBe(1);
    const unknownIdentity = {
      ...servingWorker.process.identity,
      worker_instance_id: '90000000-0000-4000-8000-000000000001',
    };
    const unknownCredential = deriveWorkerSupervisionCredential(
      deriveWorkerSupervisionSeed(new Uint8Array(32).fill(9), unknownIdentity.master_generation,
        unknownIdentity.worker_instance_id, unknownIdentity.worker_slot),
      servingWorker.boot_nonce!,
    );
    const unknownClient = createPluginControlHttpClient({
      baseUrl: 'http://127.0.0.1:1',
      session: () => ({ credential: createPluginControlRpcCredential(unknownCredential, {
        ...unknownIdentity, boot_nonce: servingWorker.boot_nonce!,
      }), authority }),
      fetchImpl: (_input, init) => managementOptions.internalPluginControl.handle(
        new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1', init),
      ),
    });
    await expect(unknownClient.call({ revision: servingWorker.revision, endpoint_id: 'endpoint-1',
      attempt_id: crypto.randomUUID(), method: 'refresh', payload: {} }, new AbortController().signal)).rejects.toBeDefined();
    unknownClient.dispose();
    const binding = { plugin: 'fake-control', contributionId: 'source', bindingId: 'binding-1', bindingOptions: { accountRef: 'forged' } } as const;
    owned.add(second.process);
    // The repository advances to revision 7 while the admitted worker still serves revision 6.
    current = snapshot(7, false, 'current-7');
    await expect(client.call({ revision: servingWorker.revision, endpoint_id: 'endpoint-1',
      attempt_id: crypto.randomUUID(), method: 'refresh', payload: {} }, new AbortController().signal)).resolves.toEqual({ payload: {}, accountRef: 'serving-6' });
    expect((globalThis as any).__bungeeCompositionControlInvokes).toBe(2);
    current = snapshot(7, true, 'current-7');
    await expect(client.call({ revision: servingWorker.revision, endpoint_id: 'endpoint-1',
      attempt_id: crypto.randomUUID(), method: 'refresh', payload: {} }, new AbortController().signal)).rejects.toBeDefined();
    expect((globalThis as any).__bungeeCompositionControlInvokes).toBe(2);
    current = snapshot(7, false, 'current-7');
    committed.delete(first.process);
    notify(factoryEligibility);
    await expect(client.call({ revision: servingWorker.revision, endpoint_id: 'endpoint-1',
      attempt_id: crypto.randomUUID(), method: 'refresh', payload: {} }, new AbortController().signal)).rejects.toBeDefined();
    expect((globalThis as any).__bungeeCompositionControlInvokes).toBe(2);
    client.dispose();
    const active = { snapshot: current, operation: {} } as never;
    const old = initialServing;
    await composedCoordinator!.publish(active, old);
    current = snapshot(7, true, 'current-7');
    current = snapshot(7);
    blockRuntimeSnapshot = true;
    const inFlightRuntimeResponse = managementOptions.controlApi.handle(new Request('http://localhost/api/runtime/upstreams'));
    await new Promise<void>((resolve) => { snapshotStarted = resolve; });
    blockRuntimeShutdown = true;
    const shutdown = handle.shutdown();
    const stoppedRuntimeResponse = await managementOptions.controlApi.handle(new Request('http://localhost/api/runtime/upstreams'));
    expect(await stoppedRuntimeResponse.json()).toMatchObject({ availability: 'unknown', reason: 'runtime_unavailable' });
    expect(await (await inFlightRuntimeResponse).json()).toMatchObject({ availability: 'unknown', reason: 'runtime_unavailable' });
    let shutdownSettled = false;
    void shutdown.then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    releaseRuntimeSnapshot?.();
    releaseRuntimeShutdown();
    first.exit();
    await shutdown;
  } finally {
    delete (globalThis as any).__bungeeCompositionControlInvokes;
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed plugin secret keys fail the composition boundary instead of becoming unauthenticated storage', async () => {
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = 'not-canonical-base64';
  const events: string[] = [];
  const repository = {
    getSnapshot: () => { throw new Error('unreachable'); }, getActivePublication: () => null,
    getOperationState: () => null, getCurrentOperationState: () => null, commit: () => null, beginPublication: () => null,
    beginWorkerAttempt: () => null, beginDrainingRecovery: () => null, recordWorkerResult: () => null,
    markDraining: () => null, finalizePublication: () => null,
    close: () => { events.push('repository.close'); },
  };
  try {
    const dependencies = {
      context: { cwd: '/tmp', moduleDirectory: '/tmp', executable: process.execPath, entry: '/tmp/worker.ts', pid: process.pid, accessLogDbPath: '/tmp/access.db' },
      clock: { now: () => 1 },
      readOptions: () => ({ configDbPath: '/tmp/config.db', configDbLockPath: '/tmp/config.lock', workerCount: 1, host: '127.0.0.1', port: 0, startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
      acquireInstanceLock: async (path: string) => ({ release: async () => { events.push(`release:${path}`); } }),
      migrateAccessDatabase: async () => { events.push('migration'); }, createPluginPathResolver: () => ({}),
      buildPluginCatalog: async () => ({ hash: HASH, toCompileOptions: () => ({ pluginSchemas: new Map(), availablePlugins: new Set(), pluginCatalogHash: HASH }) }),
      openRepository: () => { events.push('repository'); return repository; },
    } as unknown as MasterProcessDependencies;
    await expect(startMasterComposition(dependencies)).rejects.toThrow('BUNGEE_PLUGIN_SECRETS_KEY');
    expect(events).toEqual(['migration', 'repository', 'repository.close', 'release:/tmp/access.db.lock', 'release:/tmp/config.lock']);
  } finally {
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('serializes a bounded error chain as a useful structured object without secret payloads', () => {
  const cause = new Error('access_token=token-secret api_key=key-secret password=aggregate-secret');
  const failure = Object.assign(new AggregateError(
    Array.from({ length: 20 }, () => cause), 'control failed', { cause },
  ), { code: 'start_failed' });
  const serialized = serializeErrorChain(failure);
  expect(serialized).toMatchObject({ name: 'AggregateError', message: 'control failed', code: 'start_failed', cause: { name: 'Error' } });
  expect(serialized.errors).toHaveLength(8);
  expect(JSON.stringify(serialized)).not.toContain('token-secret');
  expect(JSON.stringify(serialized)).not.toContain('key-secret');
  expect(JSON.stringify(serialized)).not.toContain('aggregate-secret');
});

function useCompositionRecoveryScheduler() {
  const pending = new Map<number, { readonly due: number; readonly delay: number; readonly callback: () => void }>();
  let now = 0;
  let nextId = 1;
  const scheduler: ConfigurationRecoveryScheduler = {
    schedule(delayMs, callback) {
      const id = nextId++;
      pending.set(id, { due: now + delayMs, delay: delayMs, callback });
      return { cancel: () => { pending.delete(id); } };
    },
  };
  return {
    scheduler,
    pending: () => pending.size,
    active: () => [...pending.values()],
    async advance(milliseconds: number): Promise<void> {
      now += milliseconds;
      while (true) {
        const due = [...pending.entries()].filter(([, timer]) => timer.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        due[1].callback();
        // Admission prepare/commit crosses both local and ingress async boundaries.
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
      }
    },
  };
}

test('does not create an in-memory retry loop without a durable recovery row', async () => {
  const timers = useCompositionRecoveryScheduler();
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  const first = createProcess(0);
  const current = snapshot(7);
  let activeAdmission: any = null;
  let startCalls = 0;
  const recoverySignals: AbortSignal[] = [];
  const recoverySignalAbortedAtEntry: boolean[] = [];
  let capturedGateSignal!: AbortSignal;
  let runtimeFailure = 0;
  const admission = {
    prepare: async (workers: readonly ServingConfigWorker[]) => ({
      commit: async () => { activeAdmission = { workers, revision: current.revision, content_hash: current.content_hash, plugin_catalog_hash: HASH, master_generation: MASTER_GENERATION, admission_sequence: 1 }; },
      abort: async () => undefined,
      releaseRetiredAfterExitProof: async () => undefined,
    }),
    adoptCommitted: () => undefined,
    snapshot: () => activeAdmission === null ? [] : [evidence(first.process, current, HASH)],
    select: () => null,
    clear: () => { activeAdmission = null; },
  };
  const repository = {
    getSnapshot: () => current,
    getActivePublication: () => null,
    appendServingSnapshot: () => undefined,
    getServingSnapshot: () => null,
    getOperationState: () => null,
    getCurrentOperationState: () => null,
    beginPublication: () => null,
    beginWorkerAttempt: () => null,
    beginDrainingRecovery: () => null,
    recordWorkerResult: () => null,
    markDraining: () => null,
    finalizePublication: () => null,
    commit: () => null,
    close: () => undefined,
    claimControllerWithCapability: () => ({ instance_id: '11111111-1111-4111-8111-111111111111', controller_epoch: 1, current_controller_id: '00000000-0000-4000-8000-000000000001', updated_at: 1 }),
  };
  const workerFactory = {
    spawn: () => first.process,
    pids: () => [],
    owns: (process: ConfigPublicationWorkerProcess) => process === first.process,
    subscribeExit: () => () => undefined,
    subscribeUnavailable: () => () => undefined,
    subscribeEligibilityChange: () => () => undefined,
    disconnectAll: () => undefined,
    markCommitted: () => undefined,
    setRateLimitSession: () => undefined,
    retireForIngressBootChange: async () => ({ exited: [], exitUnknown: [] }),
    disconnectProcesses: () => undefined,
    discardConfirmedUncommitted: async () => undefined,
    shutdownAll: async () => [],
    discoverAndAdopt: async () => ({ kind: 'recovering', code: 'admission_mismatch', workers: [], issues: [] }),
  };
  const dependencies = {
    context: { cwd: '/work', moduleDirectory: '/work', executable: process.execPath, entry: '/work/worker.ts', pid: process.pid, accessLogDbPath: '/work/access.db' },
    clock: { now: () => 1 },
    readOptions: () => ({ configDbPath: '/work/config.db', configDbLockPath: '/work/config.lock', workerCount: 1, host: '127.0.0.1', port: 8088, managementHost: '127.0.0.1', managementPort: 8089, ingressControlPort: 3010, ingressInstanceLockPath: '/work/ingress.lock', startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
    acquireInstanceLock: async () => ({ release: async () => undefined }),
    migrateAccessDatabase: async () => undefined,
    createPluginPathResolver: () => ({}),
    buildPluginCatalog: async () => ({ hash: HASH, toCompileOptions: () => ({ pluginSchemas: new Map(), availablePlugins: new Set(), pluginCatalogHash: HASH }) }),
    resolveAuthToken: () => undefined,
    openRepository: () => repository,
    createAdmission: () => admission,
    resolveWorkerLaunch: () => ({ source: 'source', executable: process.execPath, args: [] }),
    createWorkerFactory: () => workerFactory,
    createMasterGeneration: () => MASTER_GENERATION,
    createCoordinator: (options: { admission: typeof admission }) => ({
      recoverAndPublish: async () => null,
      startCurrent: async (_snapshot: unknown, _existing?: readonly ServingConfigWorker[], _retire?: readonly ServingConfigWorker[], signal?: AbortSignal) => {
        startCalls += 1;
        if (signal !== undefined) {
          recoverySignals.push(signal);
          recoverySignalAbortedAtEntry.push(signal.aborted);
        }
        if (startCalls < 6) return { kind: 'startup_failed', failures: [], serving: [] };
        const prepared = await options.admission.prepare([evidence(first.process, current, HASH)]);
        await prepared.commit();
        return { kind: 'startup_ready', serving: [evidence(first.process, current, HASH)] };
      },
      publish: async () => ({ kind: 'converged', http_status: 200, operation: {} as never, serving: [evidence(first.process, current, HASH)] }),
    }),
    createManagementListener: () => ({ port: 8089, start: () => undefined, stop: async () => undefined }),
    createControllerClaim: () => ({ consume<Result>(claim: () => Result): Result { return claim(); } }),
    deriveTransportSecret: () => Buffer.alloc(32, 9).toString('base64url'),
    createIngressController: () => ({
      controlPort: 3010, publicPort: 8088,
      authenticatedRateLimitSession: () => ({ supervisionPort: 3010, expectedIngress: {
        process_instance_id: '70000000-0000-4000-8000-000000000001',
        boot_nonce: '70000000-0000-4000-8000-000000000002',
      } }),
      connect: async () => undefined, stop: async () => undefined,
      disconnect: async () => undefined, shutdownDataPlane: async () => undefined,
      trustedActiveAdmission: () => null, hasTrustedActiveAdmission: () => false,
      isMutationReady: () => true, subscribeEligibilityChange: () => () => undefined,
      prepare: async () => ({ commit: async () => undefined, abort: async () => undefined }),
      status: async () => ({ state: 'attached', registry: { active: null, prepared: null, retired: [] } }),
    }),
    createRuntime: (options: any) => {
      capturedGateSignal = options.ingressBootRecoveryGate.signal;
      return new MasterRuntime({ ...options, onFatal: () => { runtimeFailure += 1; } });
    },
    configurationRecoveryScheduler: timers.scheduler,
    installSignalHandlers: (runtime: { shutdown(): Promise<void> }) => ({ shutdown: () => runtime.shutdown(), remove: () => undefined }),
  } as unknown as MasterProcessDependencies;
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(dependencies);
    for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000]) await timers.advance(delay);
    expect(startCalls).toBe(1);
    expect(timers.pending()).toBe(0);
    expect(runtimeFailure).toBe(0);
    expect(recoverySignals).toEqual([capturedGateSignal]);
    expect(new Set(recoverySignals).size).toBe(1);
    expect(recoverySignalAbortedAtEntry).toEqual([false]);
    expect(activeAdmission).toBeNull();
    await timers.advance(8_000);
    expect(startCalls).toBe(1);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test.each(['scheduled', 'running', 'stopped'] as const)(
  'adopts the old serving control before recovery claim for %s state; stopped recovery never spawns',
  async (recoveryState) => {
    const timers = useCompositionRecoveryScheduler();
    let root: string | undefined;
    let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
    let database: Database | undefined;
    try {
      root = await mkdtemp(join(tmpdir(), 'bungee-composition-recovery-controls-'));
      const auditPath = join(root, 'control-audit.txt');
      await writeFile(auditPath, '', 'utf8');
      const pluginsPath = await writeMasterCompositionControls(root, auditPath);
      const catalog = await PluginManifestCatalog.build({ scanDirectories: [pluginsPath] });
      const oldSnapshot = {
        revision: 1,
        content_hash: `sha256:${'1'.repeat(64)}`,
        aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [{ plugin_name: MASTER_COMPOSITION_CONTROL_A }] },
      } as unknown as RepositorySnapshot;
      const targetSnapshot = {
        revision: 2,
        content_hash: `sha256:${'2'.repeat(64)}`,
        aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [{ plugin_name: MASTER_COMPOSITION_CONTROL_B }] },
      } as unknown as RepositorySnapshot;
      const old = createProcess(0);
      const oldServing = evidence(old.process, oldSnapshot, catalog.hash);
      const remoteAdmission = {
        master_generation: old.process.identity.master_generation,
        admission_sequence: 1,
        revision: oldServing.revision,
        content_hash: oldServing.content_hash,
        plugin_catalog_hash: catalog.hash,
        workers: [{ ...old.process.identity, boot_nonce: oldServing.boot_nonce, private_port: oldServing.private_port }],
      };
      const recovery = {
        recovery_id: '60000000-0000-4000-8000-000000000001',
        source_mutation_id: '61000000-0000-4000-8000-000000000001',
        target_revision: targetSnapshot.revision,
        trigger: 'automatic' as const,
        state: recoveryState,
        attempt_count: recoveryState === 'running' || recoveryState === 'stopped' ? 1 : 0,
        max_attempts: 6 as const,
        next_retry_at: recoveryState === 'scheduled' ? 100 : null,
        final_reason_code: recoveryState === 'stopped' ? 'fatal_source_failure' as const : null,
        final_reason_detail: recoveryState === 'stopped' ? 'fixture stopped' : null,
        created_at: 1,
        updated_at: 1,
      };
      let currentRecovery: ConfigurationRecovery = recovery;
      let clockNow = 0;
      let startupClaims = 0;
      let recoveryClaims = 0;
      let spawnCalls = 0;
      let baseStartCalls = 0;
      let admitted: readonly ServingConfigWorker[] = [oldServing];
      const auditAtStartupClaim: string[] = [];
      const auditAtRecoveryClaim: string[][] = [];
      const readAudit = (): string[] => {
        const text = readFileSync(auditPath, 'utf8').trim();
        return text === '' ? [] : text.split('\n');
      };
      const updateRecovery = (next: typeof currentRecovery): typeof currentRecovery => {
        currentRecovery = next;
        return next;
      };
      const repository = {
        getSnapshot: () => targetSnapshot,
        getServingSnapshot: (key: { revision: number; content_hash: string; plugin_catalog_hash: string }) =>
          key.revision === oldSnapshot.revision && key.content_hash === oldSnapshot.content_hash
            && key.plugin_catalog_hash === catalog.hash ? oldSnapshot : null,
        appendServingSnapshot: () => undefined,
        getActivePublication: () => null,
        getOperationState: () => null,
        getCurrentOperationState: () => null,
        getCurrentRecovery: () => currentRecovery,
        createManualRecovery: () => currentRecovery,
        claimRecoveryAttempt: (recoveryId: string, previousAttemptCount: number, now: number) => {
          recoveryClaims += 1;
          auditAtRecoveryClaim.push(readAudit());
          return updateRecovery({ ...currentRecovery, recovery_id: recoveryId, state: 'running',
            attempt_count: previousAttemptCount + 1, next_retry_at: null, updated_at: now });
        },
        scheduleRecoveryRetry: (recoveryId: string, attemptCount: number, nextRetryAt: number, now: number) => updateRecovery({
          ...currentRecovery, recovery_id: recoveryId, state: 'scheduled', attempt_count: attemptCount,
          next_retry_at: nextRetryAt, updated_at: now,
        }),
        succeedRecovery: () => updateRecovery({ ...currentRecovery, state: 'succeeded', next_retry_at: null }),
        stopRecovery: () => updateRecovery({ ...currentRecovery, state: 'stopped', next_retry_at: null }),
        requeueRecovery: (recoveryId: string, attemptCount: number, now: number) => updateRecovery({
          ...currentRecovery, recovery_id: recoveryId, state: 'scheduled', attempt_count: attemptCount,
          next_retry_at: null, updated_at: now,
        }),
        beginPublication: () => null,
        beginWorkerAttempt: () => null,
        beginDrainingRecovery: () => null,
        recordWorkerResult: () => null,
        markDraining: () => null,
        finalizePublication: () => null,
        commit: () => null,
        close: () => undefined,
        getDatabase: () => database,
        claimControllerWithCapability: (_capability: unknown, controllerId: string, updatedAt: number) => {
          startupClaims += 1;
          auditAtStartupClaim.push(...readAudit());
          return { instance_id: '62000000-0000-4000-8000-000000000001', controller_epoch: 1,
            current_controller_id: controllerId, updated_at: updatedAt };
        },
      };
      database = new Database(':memory:');
      database.run('CREATE TABLE secret_store_namespaces (namespace TEXT PRIMARY KEY, namespace_epoch INTEGER NOT NULL)');
      database.run('CREATE TABLE secret_store_objects (namespace TEXT NOT NULL, key TEXT NOT NULL, namespace_epoch INTEGER NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, envelope BLOB, PRIMARY KEY(namespace,key))');
      const admission = {
        prepare: async () => ({ commit: async () => undefined, abort: async () => undefined, releaseRetiredAfterExitProof: async () => undefined }),
        adoptCommitted: (workers: readonly ServingConfigWorker[]) => { admitted = workers; },
        snapshot: () => admitted,
        select: () => null,
        clear: () => { admitted = []; },
      };
      const workerFactory = {
        spawn: () => { spawnCalls += 1; return old.process; },
        pids: () => [],
        owns: (process: ConfigPublicationWorkerProcess) => process === old.process,
        subscribeExit: () => () => undefined,
        subscribeUnavailable: () => () => undefined,
        subscribeEligibilityChange: () => () => undefined,
        disconnectAll: () => undefined,
        markCommitted: () => undefined,
        setRateLimitSession: () => undefined,
        retireForIngressBootChange: async () => ({ exited: [], exitUnknown: [] }),
        disconnectProcesses: () => undefined,
        discardConfirmedUncommitted: async () => undefined,
        shutdownAll: async () => [],
        discoverAndAdopt: async () => ({ kind: 'adopted' as const, serving: [oldServing], issues: [] }),
        lookupExactControlSession: () => null,
      };
      const ingressEligibility = new Set<() => void>();
      const ingress = {
        controlPort: 30_10, publicPort: 41_001,
        authenticatedRateLimitSession: () => ({ supervisionPort: 30_10, expectedIngress: {
          process_instance_id: '63000000-0000-4000-8000-000000000001', boot_nonce: '64000000-0000-4000-8000-000000000001',
        } }),
        connect: async () => undefined,
        stop: async () => undefined,
        disconnect: async () => undefined,
        shutdownDataPlane: async () => undefined,
        stopRecovery: () => undefined,
        trustedActiveAdmission: () => remoteAdmission,
        trustedActiveAdmissionIfFresh: () => remoteAdmission,
        hasTrustedActiveAdmission: () => true,
        currentControllerAuthority: () => ({ controller_epoch: 1, controller_id: '65000000-0000-4000-8000-000000000001' }),
        subscribeEligibilityChange: (listener: () => void) => { ingressEligibility.add(listener); return () => ingressEligibility.delete(listener); },
        prepare: async () => ({ commit: async () => undefined, abort: async () => undefined }),
      };
      const dependencies = {
        context: { cwd: root, moduleDirectory: root, executable: process.execPath, entry: join(root, 'worker.ts'), pid: process.pid, accessLogDbPath: join(root, 'access.db') },
        clock: { now: () => clockNow },
        readOptions: () => ({ configDbPath: join(root!, 'config.db'), configDbLockPath: join(root!, 'config.lock'), workerCount: 1, host: '127.0.0.1', port: 0, managementHost: '127.0.0.1', managementPort: 0, ingressControlPort: 3010, ingressInstanceLockPath: join(root!, 'ingress.lock'), startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
        createMasterStats: () => ({
          getDatabase: () => database!,
          matches: () => false,
          handle: async () => new Response(null, { status: 404 }),
          close: async () => undefined,
        }),
        acquireInstanceLock: async () => ({ release: async () => undefined }),
        migrateAccessDatabase: async () => undefined,
        createPluginPathResolver: () => ({}),
        buildPluginCatalog: async () => catalog,
        openRepository: () => repository,
        createAdmission: () => admission,
        resolveWorkerLaunch: () => ({ source: 'source' as const, executable: process.execPath, args: [] }),
        createWorkerFactory: () => workerFactory,
        createMasterGeneration: () => MASTER_GENERATION,
        createCoordinator: (options: { admission: WorkerAdmissionController }) => ({
          recoverAndPublish: async () => null,
          startCurrent: async () => { baseStartCalls += 1; return { kind: 'startup_failed' as const, failures: [], serving: [] }; },
          publish: async () => ({ kind: 'converged' as const, http_status: 200 as const, operation: {} as never, serving: [] }),
        }),
        createManagementListener: () => ({ port: 41_002, start: () => undefined, stop: async () => undefined }),
        createControllerClaim: () => ({ consume<Result>(claim: () => Result): Result { return claim(); } }),
        deriveTransportSecret: () => Buffer.alloc(32, 8).toString('base64url'),
        createIngressController: () => ingress,
        createRuntime: (options: { coordinator: { startCurrent(value: unknown): Promise<unknown> } }) => ({
          start: async () => { await options.coordinator.startCurrent(targetSnapshot); },
          shutdown: async () => undefined,
          reportAsynchronousFailure: () => undefined,
        }),
        configurationRecoveryScheduler: timers.scheduler,
        installSignalHandlers: (runtime: { shutdown(): Promise<void> }) => ({ shutdown: runtime.shutdown, remove: () => undefined }),
        resolveAuthToken: () => undefined,
      } as unknown as MasterProcessDependencies;
      const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
      try {
        handle = await startMasterComposition(dependencies);
      } finally {
        if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
        else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
      }

      expect(startupClaims).toBe(1);
      expect(auditAtStartupClaim).toEqual([]);
      expect(readAudit()).toContain(MASTER_COMPOSITION_CONTROL_A);
      expect(recoveryClaims).toBe(recoveryState === 'running' ? 1 : 0);
      expect(auditAtRecoveryClaim.every((audit) => audit.includes(MASTER_COMPOSITION_CONTROL_A)
        && !audit.includes(MASTER_COMPOSITION_CONTROL_B))).toBe(true);
      if (recoveryState === 'stopped') {
        expect(spawnCalls).toBe(0);
        expect(baseStartCalls).toBe(0);
        expect(readAudit()).toEqual([MASTER_COMPOSITION_CONTROL_A]);
      }
      const activeTimers = timers.active().map(({ delay }) => ({ delay }));
      if (recoveryState !== 'stopped') {
        const expectedActiveTimers = [{
          delay: recoveryState === 'scheduled' ? 100 : 1_000,
        }];
        expect(activeTimers, `active timers: ${JSON.stringify(activeTimers)}`).toHaveLength(1);
        expect(activeTimers).toEqual(expectedActiveTimers);
        expect(auditAtRecoveryClaim).toHaveLength(recoveryState === 'running' ? 1 : 0);
        expect(auditAtRecoveryClaim.every((audit) => audit.includes(MASTER_COMPOSITION_CONTROL_A)
          && !audit.includes(MASTER_COMPOSITION_CONTROL_B))).toBe(true);
        expect(recoveryClaims).toBe(recoveryState === 'running' ? 1 : 0);
      } else expect(activeTimers).toEqual([]);
    } finally {
      await handle?.shutdown().catch(() => undefined);
      database?.close(true);
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    }
  },
);
