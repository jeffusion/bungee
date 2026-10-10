import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PluginStateClient } from '../../src/plugin-state/client';
import { runtimePluginState } from '../helpers/runtime-plugin-state';
import { createSignedWorkerRpcClient, PLUGIN_STORAGE_RPC_PATH } from '../../src/data-admission/rpc';
import { PLUGIN_DURABLE_STATE_SCHEMA_SQL } from '../../src/plugin-durable-state';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { startMasterComposition, type MasterProcessDependencies, type MasterProcessCoordinator } from '../../src/master-runtime/composition';
import { serializeErrorChain } from '../../src/master-runtime/error-chain';
import { createAsyncMasterStats, migrateAccessDatabaseAsync } from '../../src/master-runtime/observability-client';
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

test('composition retains ACKed serving/draining snapshots and installs the peer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-composition-control-'));
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let configDatabase: Database | undefined;
  let accessDatabase: Database | undefined;
  try {
    const pluginRoot = join(root, 'fake-control');
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, 'manifest.json'), JSON.stringify({
      name: 'fake-control', version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin', main: 'main.ts',
      control: { entry: 'control.ts', rpc: [{ name: 'refresh', access: 'bound-attempt' }] },
      capabilities: ['hooks', 'controlPlane', 'dynamicRuntimeLoad'], uiExtensionMode: 'none', engines: { bungee: '^4.3.0 || ^5.0.0' }, configSchema: [],
    }));
    await writeFile(join(pluginRoot, 'main.ts'), 'export default {};\n');
    (globalThis as any).__bungeeCompositionControlInvokes = 0;
    await writeFile(join(pluginRoot, 'control.ts'), 'export function createControl(context) { return { api: [], rpc: [{ name: "refresh", handler: "refresh", invoke: async (payload, context) => { globalThis.__bungeeCompositionControlInvokes += 1; return { payload, accountRef: context.binding.bindingOptions.accountRef }; } }], async start() { await context.secretStore.compareAndSet("db-marker", null, "config-db"); await context.storage.set("db-marker", "access-db"); }, dispose() {} }; }\n');
    const catalog = await PluginManifestCatalog.build({ scanDirectories: [root] });
    let current = snapshot(6, false, 'serving-6');
    configDatabase = new Database(':memory:');
    configDatabase.run(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
    configDatabase!.run('CREATE TABLE secret_store_namespaces (namespace TEXT PRIMARY KEY, namespace_epoch INTEGER NOT NULL)');
    configDatabase!.run('CREATE TABLE secret_store_objects (namespace TEXT NOT NULL, key TEXT NOT NULL, namespace_epoch INTEGER NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, envelope BLOB, PRIMARY KEY(namespace,key))');
    accessDatabase = new Database(':memory:');
    accessDatabase!.run('CREATE TABLE plugin_storage (plugin_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ttl INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (plugin_name, key))');
    const first = createProcess(0);
    const second = createProcess(1);
    const owned = new Set<ConfigPublicationWorkerProcess>([first.process]);
    const committed = new Set<ConfigPublicationWorkerProcess>();
    const factoryEligibility = new Set<() => void>();
    const factoryUnavailable = new Set<(process: ConfigPublicationWorkerProcess, evidence: { kind: 'unavailable'; pid: number }) => void>();
    let runtimeUnavailable!: (process: ConfigPublicationWorkerProcess, evidence: { kind: 'unavailable'; pid: number }) => void;
    const mutationCommits: string[] = [];
    const controlLookupOrder: string[] = [];
    const publicationOrder: string[] = [];
    const ingressEligibility = new Set<() => void>();
    let activeAdmission: any = null;
    let preparedAdmission: any = null;
    let publishedVersion = 0;
    let admissionSequence = 0;
    let blockRuntimeSnapshot = false;
    let snapshotStarted: (() => void) | undefined;
    let releaseRuntimeSnapshot: (() => void) | undefined;
    let blockRuntimeShutdown = false;
    let releaseRuntimeShutdown!: () => void;
    const pendingRuntimeShutdown = new Promise<void>((resolve) => { releaseRuntimeShutdown = resolve; });
    let authority = { controller_epoch: 1, controller_id: '00000000-0000-4000-8000-000000000001' };
    let managementOptions: any;
    let publicManagementOptions: any;
    let coordinator: { startCurrent: (value: unknown, existing?: readonly ServingConfigWorker[]) => Promise<unknown>; publish: (active: unknown, old: readonly ServingConfigWorker[]) => Promise<unknown> } | undefined;
    let composedCoordinator: { startCurrent(value: unknown): Promise<unknown>; publish(active: unknown, old: readonly ServingConfigWorker[]): Promise<unknown> } | undefined;
    let initialServing: readonly ServingConfigWorker[] = [];
    let stoppedPhysicalWorker = false;
    let adoptionAttempts = 0;
    const repository = {
      getSnapshot: () => current,
      appendServingSnapshot: async () => { publicationOrder.push('append'); },
      getServingSnapshot: async () => null,
      getActivePublication: async () => null,
      getOperationState: async (mutationId: string) => mutationCommits.includes(mutationId)
        ? { operation: { mutation_id: mutationId, state: 'converged', committed_revision: current.revision }, workers: [] } : null,
      getCurrentOperationState: async () => null,
    getCurrentRecovery: async () => null,

      beginPublication: () => null,
      beginWorkerAttempt: () => null,
      beginDrainingRecovery: () => null,
      recordWorkerResult: () => null,
      markDraining: () => null,
      finalizePublication: () => null,
      commit: async (command: { mutation_id: string }) => {
        mutationCommits.push(command.mutation_id);
        // Keep the fixture snapshot stable while proving the write reached commit.
        return { kind: 'duplicate', operation: { mutation_id: command.mutation_id, committed_revision: current.revision } };
      },
      claimControllerWithCapability: async (_capability: unknown, controllerId: string) => {
        authority = { controller_epoch: 1, controller_id: controllerId };
        return { instance_id: '11111111-1111-4111-8111-111111111111', controller_epoch: 1,
          current_controller_id: controllerId, updated_at: Date.now() };
      },
      close: async () => undefined,
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
      lookupPhysicalSession(input: any) {
        const candidate = [...owned].find(value => value.identity.worker_instance_id === input.worker_instance_id);
        if (!candidate || candidate.identity.master_generation !== input.master_generation
          || candidate.slot !== input.worker_slot || (candidate as any).boot_nonce !== input.boot_nonce) return null;
        const saved = candidate === first.process ? snapshot(6, false, 'serving-6') : current;
        return {process: candidate, status: {...workerStatus(evidence(candidate,saved,catalog.hash)),
          phase: stoppedPhysicalWorker ? 'stopped' : 'serving'}, configurationTarget: saved};
      },
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

        matches: () => false,
        handle: async () => new Response(null, { status: 404 }),
        close: async () => { accessDatabase?.close(true); },
      }),
      readOptions: () => ({ configDbPath: join(root, 'config.db'), configDbLockPath: join(root, 'config.lock'), workerCount: 1, host: '127.0.0.1', port: 0, startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
      acquireInstanceLock: async () => ({ release: async () => undefined }), migrateAccessDatabase: async () => undefined,
      createPluginPathResolver: () => ({}), buildPluginCatalog: async () => catalog, openRepository: async () => repository,
      openPluginState: async (path: string, options: import('../../src/plugin-state/client').PluginStateOpenOptions) => PluginStateClient.open(path, { ...options, initialize: true }),
      createAdmission: () => ({ prepare: () => { publicationOrder.push('local-prepare'); return { commit: () => { publicationOrder.push('local-commit'); } }; }, adoptCommitted: () => undefined, snapshot: () => [], acquire: () => ({ worker: null, release: () => undefined }), clear: () => undefined }),
      resolveWorkerLaunch: () => ({ source: 'source', executable: process.execPath, args: [] }),
      createWorkerFactory: (options: SupervisedConfigWorkerFactoryOptions) => {
        return {
          ...strictFactory,
          spawn: () => first.process, pids: () => [], owns: (process: ConfigPublicationWorkerProcess) => owned.has(process),
          subscribeExit: () => () => undefined,
          subscribeUnavailable(listener: typeof runtimeUnavailable) { factoryUnavailable.add(listener); return () => { factoryUnavailable.delete(listener); }; },
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
        if (options.profile === 'master-control') managementOptions = options;
        else publicManagementOptions = options;
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
        trustedAdmissionRegistryIfFresh: () => ({active:activeAdmission,prepared:preparedAdmission,retired:[]}),
        mutationReadiness: () => ({ ready: true }),
        queryRuntimeState: async () => ({version:publishedVersion}),
        publishRuntimeState: async (state: {version:number}) => { publishedVersion=state.version; },
        currentControllerAuthority: () => authority,
        hasTrustedActiveAdmission: () => activeAdmission !== null,
        subscribeEligibilityChange(listener: () => void) { ingressEligibility.add(listener); return () => { ingressEligibility.delete(listener); }; },
        prepare: async (workers: readonly ServingConfigWorker[]) => {
          publicationOrder.push('ingress-prepare');
          preparedAdmission = {admission_sequence:admissionSequence+1};
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
      createRuntime: (options: { coordinator: { startCurrent(value: unknown): Promise<unknown>; publish(active: unknown, old: readonly ServingConfigWorker[]): Promise<unknown> }; onWorkerUnavailable: typeof runtimeUnavailable }) => {
        composedCoordinator = options.coordinator;
        runtimeUnavailable = options.onWorkerUnavailable;
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
    const stateDatabase = new Database(join(root, 'plugin-state.db'), { readonly: true });
    expect(stateDatabase.query('SELECT key FROM secret_store_objects WHERE key = ?').get('db-marker')).toBeTruthy();
    expect(stateDatabase.query('SELECT value FROM plugin_storage WHERE key = ?').get('db-marker')).toEqual({ value: '"access-db"' });
    stateDatabase.close();
    expect(configDatabase!.query('SELECT COUNT(*) AS count FROM secret_store_objects').get()).toEqual({count: 0});
    expect(accessDatabase!.query('SELECT COUNT(*) AS count FROM plugin_storage').get()).toEqual({count: 0});
    expect(configDatabase!.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'plugin_storage'").get()).toEqual({ count: 0 });
    expect(managementOptions.internalPluginPeer).toBeDefined();
    expect(adoptionAttempts).toBe(1);
    expect(controlLookupOrder.slice(-2)).toEqual(['after-markCommitted', 'after-markCommitted']);
    expect(publicationOrder.indexOf('append')).toBeGreaterThanOrEqual(0);
    expect(publicationOrder.indexOf('append')).toBeLessThan(publicationOrder.indexOf('local-prepare'));
    expect(publicationOrder.indexOf('local-prepare')).toBeLessThan(publicationOrder.indexOf('ingress-prepare'));
    expect(publicationOrder.indexOf('ingress-prepare')).toBeLessThan(publicationOrder.indexOf('ingress-commit'));
    const storageRpc = (bootNonce = first.process.boot_nonce, workerId = first.process.identity.worker_instance_id) => createSignedWorkerRpcClient({
      transportSecret: Buffer.alloc(32,8).toString('base64url'),
      worker: {role:'worker',master_generation:MASTER_GENERATION,process_instance_id:workerId,boot_nonce:bootNonce,worker_slot:0},
      expectedServer: {role:'ingress',process_instance_id:MASTER_GENERATION,boot_nonce:MASTER_GENERATION},
      url: `http://localhost${PLUGIN_STORAGE_RPC_PATH}`, retry:false,
      fetch: async (input, init) => managementOptions.controlApi.handle(new Request(input as string,init)),
    });
    await storageRpc()('storage',{namespace:'fake-control',operation:'set',args:['bridge-marker',17]});
    expect(await storageRpc()('storage',{namespace:'fake-control',operation:'get',args:['bridge-marker']})).toBe(17);
    const deniedNamespace = await storageRpc()('storage',{namespace:'undeclared',operation:'set',args:['bridge-marker',99]}).catch(error=>error);
    expect(deniedNamespace).toMatchObject({status:400});
    const wrongBoot = await storageRpc(crypto.randomUUID())('storage',{namespace:'fake-control',operation:'get',args:['bridge-marker']}).catch(error=>error);
    expect(wrongBoot).toMatchObject({status:403});
    const foreignWorker = await storageRpc(first.process.boot_nonce,crypto.randomUUID())('storage',{namespace:'fake-control',operation:'get',args:['bridge-marker']}).catch(error=>error);
    expect(foreignWorker).toMatchObject({status:403});
    stoppedPhysicalWorker = true;
    const stoppedWorker = await storageRpc()('storage',{namespace:'fake-control',operation:'get',args:['bridge-marker']}).catch(error=>error);
    expect(stoppedWorker).toMatchObject({status:403}); stoppedPhysicalWorker = false;
    const runtimeResponse = await publicManagementOptions.controlApi.handle(new Request('http://localhost/api/runtime/upstreams'));
    expect(await runtimeResponse.json()).toMatchObject({ availability: 'complete', upstreams: [{
      state_key: 'composition-state', upstream_id: 'composition-upstream', active_request_count: 1,
    }] });
    // Bound identity checks now live in the canonical projector/peer tests.
    owned.add(second.process);
    current = snapshot(7, false, 'current-7');
    committed.delete(first.process);
    notify(factoryEligibility);
    const active = { snapshot: current, operation: {} } as never;
    const old = initialServing;
    await composedCoordinator!.publish(active, old);
    const mutation = () => publicManagementOptions.controlApi.handle(new Request('http://localhost/api/plugins/fake-control/disable', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: current.revision, mutation_id: crypto.randomUUID() }),
    }));
    expect((await mutation()).status).toBe(202);
    // Both composition notification paths must ignore retired identities, while
    // unavailable active workers still close the gate until admission recommits.
    for (const notifyUnavailable of [
      (process: ConfigPublicationWorkerProcess) => {
        for (const listener of factoryUnavailable) listener(process, { kind: 'unavailable', pid: process.pid });
      },
      (process: ConfigPublicationWorkerProcess) => runtimeUnavailable(process, { kind: 'unavailable', pid: process.pid }),
    ]) {
      notifyUnavailable(first.process);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      const beforeCommit = mutationCommits.length;
      expect((await mutation()).status).toBe(202);
      expect(mutationCommits).toHaveLength(beforeCommit + 1);
      notifyUnavailable(second.process);
      const blocked = await mutation();
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toEqual({ error: 'control_recovering', reason: 'admission_recovering' });
      expect(mutationCommits).toHaveLength(beforeCommit + 1);
      await composedCoordinator!.publish(active, []);
      expect((await mutation()).status).toBe(202);
    }
    current = snapshot(7, true, 'current-7');
    current = snapshot(7);
    blockRuntimeSnapshot = true;
    const inFlightRuntimeResponse = publicManagementOptions.controlApi.handle(new Request('http://localhost/api/runtime/upstreams'));
    await new Promise<void>((resolve) => { snapshotStarted = resolve; });
    blockRuntimeShutdown = true;
    const shutdown = handle.shutdown();
    const stoppedRuntimeResponse = await publicManagementOptions.controlApi.handle(new Request('http://localhost/api/runtime/upstreams'));
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
    getSnapshot: () => { throw new Error('unreachable'); }, getActivePublication: async () => null,
    getOperationState: () => null, getCurrentOperationState: async () => null, commit: () => null, beginPublication: () => null,
    beginWorkerAttempt: () => null, beginDrainingRecovery: () => null, recordWorkerResult: () => null,
    markDraining: () => null, finalizePublication: () => null,
    close: async () => { events.push('repository.close'); },
  };
  try {
    const dependencies = {
      context: { cwd: '/tmp', moduleDirectory: '/tmp', executable: process.execPath, entry: '/tmp/worker.ts', pid: process.pid, accessLogDbPath: '/tmp/access.db' },
      clock: { now: () => 1 },
      readOptions: () => ({ configDbPath: '/tmp/config.db', configDbLockPath: '/tmp/config.lock', workerCount: 1, host: '127.0.0.1', port: 0, startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
      acquireInstanceLock: async (path: string) => ({ release: async () => { events.push(`release:${path}`); } }),
      migrateAccessDatabase: async () => { events.push('migration'); }, createPluginPathResolver: () => ({}),
      buildPluginCatalog: async () => ({ hash: HASH, toCompileOptions: () => ({ pluginSchemas: new Map(), availablePlugins: new Set(), pluginCatalogHash: HASH }) }),
      openRepository: async () => { events.push('repository'); return repository; },
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

test.each(['stopped', 'publication-failure'] as const)('selected generic authentication and its dependency remain ready during %s', async mode => {
  const root = await mkdtemp(join(tmpdir(),'bungee-management-isolated-'));
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32,1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  const provider = 'fixture-identity', dependency = 'fixture-identity-state', broken = 'fixture-broken';
  const order: string[] = [];
  (globalThis as any).__isolatedManagementOrder = order;
  const stores = new Map<string, any>();
  (globalThis as any).__isolatedManagementStores = stores;
  try {
    for (const name of [provider,dependency,broken]) {
      const directory = join(root,name); await mkdir(directory);
      await writeFile(join(directory,'manifest.json'),JSON.stringify({name,version:'1.0.0',schemaVersion:3,artifactKind:'runtime-plugin',main:'main.ts',
        control:{entry:'control.ts',rpc:[]},capabilities:['hooks','controlPlane','dynamicRuntimeLoad'],uiExtensionMode:'none',engines:{bungee:'^5.0.0'},configSchema:[],
        ...(name===provider ? {management:{},dependencies:{[dependency]:'^1.0.0'}} : {})}));
      await writeFile(join(directory,'main.ts'),'export default {};');
      const management = name===provider ? `management:{authenticate:async()=>({id:'fixture',provider:${JSON.stringify(provider)},capabilities:['config.read']}),authorize:async()=>true,hasIdentity:async()=>true,login:async()=>Response.json({signedIn:true}),logout:async()=>Response.json({}),bootstrap:async()=>{},revokeSessions:async()=>{}},` : '';
      const observer = name===provider ? 'export function createObservationAdapter(observation){return { count:()=>observation.withDatabase(db=>db.query("SELECT 1 AS value").get().value) };}'
        : name===broken ? 'export function createObservationAdapter(){throw new Error("unrelated_observation_failure");}' : '';
      await writeFile(join(directory,'control.ts'),`${observer}export function createControl(context){globalThis.__isolatedManagementOrder.push(${JSON.stringify(name)});globalThis.__isolatedManagementStores.set(${JSON.stringify(name)},context.storage);${name===broken ? "throw new Error('unrelated_failure');" : `return {api:[],rpc:[],${management}start(){},dispose(){}};`}}`);
    }
    const catalog = await PluginManifestCatalog.build({scanDirectories:[root]});
    let current = {revision:1,content_hash:HASH,aggregate:{logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[provider,dependency,broken].map(plugin_name=>({plugin_name}))}} as unknown as RepositorySnapshot;
    const recovery = {recovery_id:'60000000-0000-4000-8000-000000000001',state:'stopped',target_revision:1,attempt_count:1,max_attempts:6,next_retry_at:null,final_reason_code:'fatal_source_failure'};
    let activePublication: any = null;
    let controlFailures = 0;
    const repository = {getSnapshot:()=>current,getServingSnapshot:async()=>null,appendServingSnapshot:async()=>{},getActivePublication:async()=>activePublication,
      finalizePublication:async()=>{controlFailures++;return {state:'degraded',error_code:'control_readiness_failed'};},
      getCurrentOperationState:async()=>null,getCurrentRecovery:async()=>mode==='stopped' ? recovery : null,getRecovery:async()=>recovery,close:async()=>{}};
    let admissionCache: Map<string, RepositorySnapshot> | undefined;
    const initial = current;
    const originalSet = Map.prototype.set;
    const cacheObserver = spyOn(Map.prototype, 'set').mockImplementation(function(this: Map<unknown, unknown>, key, value) {
      if (value === initial && key === `${initial.revision}:${initial.content_hash}:${catalog.hash}`) admissionCache = this as Map<string, RepositorySnapshot>;
      return originalSet.call(this, key, value);
    });
    let composedCoordinator: MasterProcessCoordinator | undefined;
    let managementOptions: any; let spawnCalls=0, publishCalls=0;
    const dependencies = {
      context:{cwd:root,moduleDirectory:root,executable:process.execPath,entry:join(root,'main.ts'),pid:process.pid,accessLogDbPath:join(root,'access.db')},clock:{now:Date.now},
      readOptions:()=>({configDbPath:join(root,'config.db'),configDbLockPath:join(root,'config.lock'),workerCount:1,host:'127.0.0.1',port:0,managementHost:'127.0.0.1',managementPort:0,masterControlPort:3011,startupApplyTimeoutMs:100,drainTimeoutMs:100,shutdownTimeoutMs:100}),
      acquireInstanceLock:async()=>({release:async()=>{}}),migrateAccessDatabase:migrateAccessDatabaseAsync,createMasterStats:createAsyncMasterStats,createPluginPathResolver:()=>({}),buildPluginCatalog:async()=>catalog,
      openRepository:async()=>repository,openPluginState:async(path:string,options:import('../../src/plugin-state/client').PluginStateOpenOptions)=>PluginStateClient.open(path,{...options,initialize:true}),resolveAuthToken:()=>undefined,
      createAdmission:()=>({snapshot:()=>[],acquire:()=>({worker:null,release:()=>{}}),clear(){},prepare:async()=>({commit:async()=>{},abort:async()=>{}})}),
      resolveWorkerLaunch:()=>({source:'source',executable:process.execPath,args:[]}),createMasterGeneration:()=>MASTER_GENERATION,
      createWorkerFactory:()=>({pids:()=>[],snapshot:()=>[],owns:()=>false,spawn:()=>{spawnCalls++;throw new Error('unexpected_worker_spawn');},subscribeExit:()=>()=>{},subscribeUnavailable:()=>()=>{},disconnectAll(){},markCommitted(){},setRateLimitSession(){},shutdownAll:async()=>[]}),
      createCoordinator:()=>({recoverAndPublish:async()=>null,startCurrent:async()=>{publishCalls++;throw new Error('unexpected_publication');},publish:async()=>{throw new Error('unexpected_publication');}}),
      createManagementListener:(options:any)=>{if(options.profile==='management')managementOptions=options;return{port:3011,start(){},ready(){},stop:async()=>{}};},
      createRuntime:(options:any)=>{composedCoordinator=options.coordinator;return new MasterRuntime(options);},installSignalHandlers:(runtime:any)=>({shutdown:()=>runtime.shutdown(),remove(){}}),
    } as unknown as MasterProcessDependencies;
    try { handle = await startMasterComposition(dependencies); } finally { cacheObserver.mockRestore(); }
    expect(order.slice(0,2)).toEqual([dependency,provider]);
    expect(order.includes(broken)).toBe(mode==='publication-failure');
    expect(managementOptions.health()).toMatchObject({live:true,management:true,data:false,degraded:true});
    const config = await managementOptions.controlApi.handle(new Request('http://localhost/api/config'));
    expect(config.status).toBe(200);expect(spawnCalls).toBe(0);expect(publishCalls).toBe(0);
    if (mode === 'publication-failure') {
      expect(admissionCache).toBeDefined();
      for (let revision = 2; revision <= 33; revision++) {
        current = { ...current, revision };
        const outcome = await composedCoordinator!.startCurrent(current);
        expect(outcome).toMatchObject({ kind: 'startup_degraded', error_code: 'control_readiness_failed' });
        activePublication = { snapshot: current, operation: { mutation_id: crypto.randomUUID() } };
        expect(await composedCoordinator!.publish(activePublication, [])).toMatchObject({ kind: 'degraded', error_code: 'control_readiness_failed' });
        expect(await composedCoordinator!.recoverAndPublish()).toMatchObject({ kind: 'degraded', error_code: 'control_readiness_failed' });
        activePublication = null;
        expect(admissionCache!.size).toBe(1);
        expect([...admissionCache!.values()].map(value => value.revision)).toEqual([revision]);
        expect(managementOptions.health().management).toBe(true);
      }
      expect(publishCalls).toBe(0);
      expect(controlFailures).toBe(64);
    }
    expect(stores.get(dependency).metering).toBeUndefined();
    const observation = stores.get(provider).metering;
    expect(await observation.count()).toBe(1);
    await handle.shutdown();handle=undefined;
    expect(()=>observation.count()).toThrow('observation_capability_revoked');
  } finally {
    await handle?.shutdown();delete (globalThis as any).__isolatedManagementOrder;
    delete (globalThis as any).__isolatedManagementStores;
    if(previousSecret===undefined)delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;else process.env.BUNGEE_PLUGIN_SECRETS_KEY=previousSecret;
    await rm(root,{recursive:true,force:true});
  }
});

test('storage commands never automatically resend after an unknown acknowledgement', async () => {
  let sends = 0;
  const rpc = createSignedWorkerRpcClient({transportSecret:Buffer.alloc(32,8).toString('base64url'),
    worker:{role:'worker',master_generation:MASTER_GENERATION,process_instance_id:identity(0).worker_instance_id,boot_nonce:MASTER_GENERATION,worker_slot:0},
    expectedServer:{role:'ingress',process_instance_id:MASTER_GENERATION,boot_nonce:MASTER_GENERATION},url:`http://localhost${PLUGIN_STORAGE_RPC_PATH}`,retry:false,
    fetch:async()=>{sends++;throw new Error('acknowledgement_lost');}});
  const failure = await rpc('storage',{namespace:'fixture',operation:'increment',args:['counter',1]}).catch(error=>error);
  expect(String(failure)).toContain('acknowledgement_lost');expect(sends).toBe(1);
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
  let runtimeStateVersion = 0;
  const admission = {
    prepare: async (workers: readonly ServingConfigWorker[]) => ({
      commit: async () => { activeAdmission = { workers, revision: current.revision, content_hash: current.content_hash, plugin_catalog_hash: HASH, master_generation: MASTER_GENERATION, admission_sequence: 1 }; },
      abort: async () => undefined,
      releaseRetiredAfterExitProof: async () => undefined, handoffStatus: async () => ({ retired_id: `sha256:${'a'.repeat(64)}`, pending: 0, complete: true, remaining_ms: 0 }),
    }),
    adoptCommitted: () => undefined,
    snapshot: () => activeAdmission === null ? [] : [evidence(first.process, current, HASH)],
    acquire: () => ({ worker: null, release: () => undefined }),
    clear: () => { activeAdmission = null; },
  };
  const repository = {
    getSnapshot: () => current,
    getActivePublication: async () => null,
    appendServingSnapshot: async () => undefined,
    getServingSnapshot: async () => null,
    getOperationState: () => null,
    getCurrentOperationState: async () => null,
    getCurrentRecovery: async () => null,
    beginPublication: () => null,
    beginWorkerAttempt: () => null,
    beginDrainingRecovery: () => null,
    recordWorkerResult: () => null,
    markDraining: () => null,
    finalizePublication: () => null,
    commit: () => null,
    close: async () => undefined,
    claimControllerWithCapability: async () => ({ instance_id: '11111111-1111-4111-8111-111111111111', controller_epoch: 1, current_controller_id: '00000000-0000-4000-8000-000000000001', updated_at: 1 }),
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
    readOptions: () => ({ configDbPath: '/work/config.db', configDbLockPath: '/work/config.lock', workerCount: 1, host: '127.0.0.1', port: 8088, managementHost: '127.0.0.1', managementPort: 8089, masterControlPort: 3011, ingressControlPort: 3010, ingressInstanceLockPath: '/work/ingress.lock', startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
    acquireInstanceLock: async () => ({ release: async () => undefined }),
    migrateAccessDatabase: async () => undefined,
    createPluginPathResolver: () => ({}),
    buildPluginCatalog: async () => ({ hash: HASH, toCompileOptions: () => ({ pluginSchemas: new Map(), availablePlugins: new Set(), pluginCatalogHash: HASH }) }),
    resolveAuthToken: () => undefined,
    openRepository: async () => repository,
    openPluginState: async () => runtimePluginState(),
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
      queryRuntimeState: async () => ({version:runtimeStateVersion}),
      publishRuntimeState: async (state: {version:number}) => { runtimeStateVersion=state.version; },
      trustedActiveAdmission: () => null, hasTrustedActiveAdmission: () => false,
      trustedActiveAdmissionIfFresh: () => null,
      trustedAdmissionRegistryIfFresh: () => ({active:null,prepared:null,retired:[]}),
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
        getServingSnapshot: async (key: { revision: number; content_hash: string; plugin_catalog_hash: string }) =>
          key.revision === oldSnapshot.revision && key.content_hash === oldSnapshot.content_hash
            && key.plugin_catalog_hash === catalog.hash ? oldSnapshot : null,
        appendServingSnapshot: async () => undefined,
        getActivePublication: async () => null,
        getOperationState: () => null,
        getCurrentOperationState: async () => null,
        getCurrentRecovery: async () => currentRecovery,
        getRecovery: async () => currentRecovery,
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
        close: async () => undefined,

        claimControllerWithCapability: async (_capability: unknown, controllerId: string, updatedAt: number) => {
          startupClaims += 1;
          auditAtStartupClaim.push(...readAudit());
          return { instance_id: '62000000-0000-4000-8000-000000000001', controller_epoch: 1,
            current_controller_id: controllerId, updated_at: updatedAt };
        },
      };
      database = new Database(':memory:');
      database.run(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
      database.run('CREATE TABLE secret_store_namespaces (namespace TEXT PRIMARY KEY, namespace_epoch INTEGER NOT NULL)');
      database.run('CREATE TABLE secret_store_objects (namespace TEXT NOT NULL, key TEXT NOT NULL, namespace_epoch INTEGER NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, envelope BLOB, PRIMARY KEY(namespace,key))');
      const admission = {
        prepare: async () => ({ commit: async () => undefined, abort: async () => undefined, releaseRetiredAfterExitProof: async () => undefined, handoffStatus: async () => ({ retired_id: `sha256:${'a'.repeat(64)}`, pending: 0, complete: true, remaining_ms: 0 }) }),
        adoptCommitted: (workers: readonly ServingConfigWorker[]) => { admitted = workers; },
        snapshot: () => admitted,
        acquire: () => ({ worker: null, release: () => undefined }),
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
      let publishedVersion = 0;
      const ingress = {
        queryRuntimeState: async () => ({version:publishedVersion}),
        publishRuntimeState: async (state: {version:number}) => { publishedVersion=state.version; },
        trustedAdmissionRegistryIfFresh: () => ({active:remoteAdmission,prepared:null,retired:[]}),
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
        readOptions: () => ({ configDbPath: join(root!, 'config.db'), configDbLockPath: join(root!, 'config.lock'), workerCount: 1, host: '127.0.0.1', port: 0, managementHost: '127.0.0.1', managementPort: 0, masterControlPort: 3011, ingressControlPort: 3010, ingressInstanceLockPath: join(root!, 'ingress.lock'), startupApplyTimeoutMs: 100, drainTimeoutMs: 100, shutdownTimeoutMs: 100 }),
        createMasterStats: () => ({

          matches: () => false,
          handle: async () => new Response(null, { status: 404 }),
          close: async () => undefined,
        }),
        acquireInstanceLock: async () => ({ release: async () => undefined }),
        migrateAccessDatabase: async () => undefined,
        createPluginPathResolver: () => ({}),
        buildPluginCatalog: async () => catalog,
        openRepository: async () => repository,
        openPluginState: async (path: string, options: import('../../src/plugin-state/client').PluginStateOpenOptions) => PluginStateClient.open(path, { ...options, initialize: true }),
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
