/**
 * P4 canonical Host integration: real loopback WebSockets connect the two
 * real `master-control` management listener; a real worker service host dials it
 * with its real supervision-derived credential and consumes a control-provided
 * RPC service during plugin bootstrap and afterwards.
 *
 * Nothing here is mocked at the transport, protocol, host or registry layer: the
 * only fixtures are trivial secret/storage capabilities and a synthetic plugin
 * class, exactly like the other plugin-control tests. One test additionally runs
 * the worker half in a real child process. Membership/exit/storage are explicit
 * unit fixtures; this is NOT production supervised-entry/OS-exit acceptance.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID, createHash } from 'node:crypto';
import type { PluginExecutorProof } from '../../../src/plugin-services/peer-executor-proof';
import {captureProcessIdentity, readKernelBootId} from '../../../src/master-runtime/process-identity';
import { HostChannelAdapter } from '../../../src/plugin-services/channels';
import { createManagementListener, type ManagementListener } from '../../../src/management-listener';
import { createPluginControlHost, type SecretStoreFactory } from '../../../src/plugin-control';
import type { ControlPlugin } from '../../../src/plugin-control/contracts';
import { PluginDependencyGraph } from '../../../src/plugin-dependencies';
import { PluginServiceHost, defineRpcService, type AsyncRpcClient } from '../../../src/plugin-services';
import {
  ControlPeerBroker,
  WorkerPeerBroker,
  encodePluginPeerUpgradeIdentity,
  encodePluginPeerUpgradeProof,
  parsePluginPeerUpgradeIdentity,
  pluginPeerLifecycleIdentity,
  PLUGIN_PEER_IDENTITY_HEADER,
  PLUGIN_PEER_PROOF_HEADER,
  type ControlPeerSession,
  type PluginPeerUpgradeIdentity,
} from '../../../src/plugin-services/peer-broker';
import { createPluginPeerCredential, encodePluginPeerHeader, signPluginPeerPacket } from '../../../src/plugin-services/peer-protocol';
import { PLUGIN_PEER_WS_PATH } from '../../../src/plugin-services/peer-websocket';
import { ScopedPluginRegistry, type PluginClass } from '../../../src/scoped-plugin-registry';
import type { PluginStorage } from '../../../src/plugin.types.ts';
import type { PluginManifestRecord } from '../../../src/plugin-manifest-catalog/types';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  serializeWorkerSupervisionSeed,
} from '../../../src/supervision';

const MASTER_GENERATION = '11111111-1111-4111-8111-111111111111';
const WORKER_INSTANCE = '22222222-2222-4222-8222-222222222222';
const BOOT_NONCE = '33333333-3333-4333-8333-333333333333';
const SECOND_INSTANCE = '88888888-8888-4888-8888-888888888888';
const SECOND_NONCE = '99999999-9999-4999-8999-999999999999';
const THIRD_INSTANCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THIRD_NONCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTROLLER_ID = '44444444-4444-4444-8444-444444444444';
const CATALOG = `sha256:${'a'.repeat(64)}`;
const SERVICE_ID = 'control.quota.v1';
const WORKER_SERVICE_ID = 'worker.echo.v1';
const AUTHORITY = Object.freeze({ controller_epoch: 1, controller_id: CONTROLLER_ID });

const CONTRACT = defineRpcService({
  id: SERVICE_ID,
  version: 1,
  methods: {
    read: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['bootstrap', 'background'] },
    slow: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] },
    admin: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['management'] },
  },
});

const WORKER_CONTRACT = defineRpcService({
  id: WORKER_SERVICE_ID,
  version: 1,
  methods: {
    echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['background'] },
  },
});

const graph = new PluginDependencyGraph([
  {
    name: 'provider', version: '1.0.0', runtimeScope: 'global',
    capabilities: ['api', 'dynamicRuntimeLoad', 'controlPlane'],
    services: { provides: [{ id: SERVICE_ID, version: 1, process: 'control', kind: 'rpc' }] },
  },
  {
    // A consumption's `process` names the process the *consumer* runs in; the
    // provider publishes the same contract in `control` above.
    name: 'consumer', version: '1.0.0', dependencies: { provider: '^1.0.0' },
    services: { consumes: [{ plugin: 'provider', id: SERVICE_ID, version: 1, process: 'worker', kind: 'rpc' }] },
  },
  {
    name: 'workerecho', version: '1.0.0', runtimeScope: 'global',
    services: { provides: [{ id: WORKER_SERVICE_ID, version: 1, process: 'worker', kind: 'rpc' }] },
  },
  {
    name: 'workerecho.consumer', version: '1.0.0', dependencies: { workerecho: '^1.0.0' },
    capabilities: ['api', 'dynamicRuntimeLoad', 'controlPlane'],
    services: { consumes: [{ plugin: 'workerecho', id: WORKER_SERVICE_ID, version: 1, process: 'control', kind: 'rpc' }] },
  },
]);

function providerRecord(): PluginManifestRecord {
  return {
    name: 'provider', rootPath: '/tmp', pluginPath: '/tmp/provider', pluginDir: '/tmp/provider',
    manifestPath: '/tmp/provider/manifest.json', mainPath: '/tmp/provider/main.ts', controlPath: '/tmp/provider/control.ts',
    runtimeHash: `sha256:${'b'.repeat(64)}`, configSchema: [],
    manifest: {
      name: 'provider', version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin', main: 'main.ts',
      capabilities: ['api', 'dynamicRuntimeLoad', 'controlPlane'], runtimeScope: 'global', uiExtensionMode: 'none',
      engines: { bungee: '^4.3.0 || ^5.0.0' }, control: { entry: 'control.ts', rpc: [] }, configSchema: [],
    },
  };
}

function stores(): SecretStoreFactory {
  return {
    create(namespace) {
      return { namespace, get: async () => null, compareAndSet: async () => 1, delete: async () => undefined };
    },
    revoke: () => undefined,
    clear: () => undefined,
  };
}

function storages() {
  return {
    create() {
      const values = new Map<string, unknown>();
      return {
        get: async <T = unknown>(key: string) => (values.get(key) as T | undefined) ?? null,
        set: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => { values.delete(key); },
        keys: async (prefix?: string) => [...values.keys()].filter(key => prefix === undefined || key.startsWith(prefix)),
        clear: async () => { values.clear(); },
        increment: async () => 0,
        compareAndSet: async () => false,
      } satisfies PluginStorage;
    },
    revoke: () => undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  if (!predicate()) throw new Error('condition was not reached in time');
}

/** Real master-side facts for one exact worker process. */
function kernelFacts(instance = WORKER_INSTANCE, nonce = BOOT_NONCE) {
  const rootKey = new Uint8Array(32).fill(9);
  const seed = deriveWorkerSupervisionSeed(rootKey, MASTER_GENERATION, instance, 0);
  return { seed, credential: deriveWorkerSupervisionCredential(seed, nonce) };
}

/** Frees a loopback port for the `master-control` profile (which forbids port 0). */
function reservePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 204 }) });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('probe server did not bind a port');
  return port;
}

const cleanups: Array<() => Promise<void> | void> = [];
const releaseGates = new Set<() => void>();
afterEach(async () => {
  for (const release of releaseGates) release();
  releaseGates.clear();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!;
    try { await cleanup(); } catch { /* each test asserts its own evidence */ }
  }
});

interface ControlSide {
  readonly listener: ManagementListener;
  readonly broker: ControlPeerBroker;
  readonly port: number;
  readonly host: PluginServiceHost;
  readonly control: ReturnType<typeof createPluginControlHost>;
  readonly seedSerialized: string;
  readonly credential: ReturnType<typeof kernelFacts>['credential'];
  readonly fireExit: () => void;
  readonly setExitProof: (value: boolean) => void;
  readonly onSlowEntered: (listener: () => void) => void;
  readonly releaseSlow: () => void;
}

interface PeerFacts {
  readonly instance: string;
  readonly nonce: string;
  readonly activated: readonly string[];
}

const DEFAULT_PEERS: readonly PeerFacts[] = [
  { instance: WORKER_INSTANCE, nonce: BOOT_NONCE, activated: ['provider', 'consumer', 'workerecho'] },
];

async function createControlSide(peers: readonly PeerFacts[] = DEFAULT_PEERS, managementReady = true, executorProof?: () => PluginExecutorProof | null): Promise<ControlSide> {
  const primary = kernelFacts();
  const factsByKey = new Map<string, { facts: ReturnType<typeof kernelFacts>; peer: PeerFacts }>();
  for (const peer of peers) {
    const facts = peer.instance === WORKER_INSTANCE && peer.nonce === BOOT_NONCE ? primary : kernelFacts(peer.instance, peer.nonce);
    factsByKey.set(`${peer.instance}\0${peer.nonce}`, { facts, peer });
  }
  let releaseSlow!: () => void;
  let slowListener: (() => void) | null = null;
  const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
  releaseGates.add(releaseSlow);
  const exitListeners = new Set<() => void>();
  let exitProof = false;

  let broker!: ControlPeerBroker;
  const host: PluginServiceHost = new PluginServiceHost('control', {
    identity: (plugin, scope) => pluginPeerLifecycleIdentity({
      process: 'control', instance: MASTER_GENERATION, generation: AUTHORITY.controller_epoch, catalog: CATALOG,
    }, plugin, scope),
    resolvePlacement: request => broker.placementResolver(request),
    resolveJournal: () => null,
    resolveCallee: (): unknown => host.currentInvocation()?.callee ?? null,
    ensureRemoteRoute: input => { broker.ensureRemoteRoute(input); },
    channels: input => new HostChannelAdapter({ hub: broker.channels, process: 'control' }).createOwner(input),
  });
  broker = new ControlPeerBroker({
    services: host,
    executorProof,
    instance: () => MASTER_GENERATION,
    authority: () => AUTHORITY,
    catalog: () => CATALOG,
    // The broker validates the claimed authority/instance before this trusted
    // physical-session lookup, which resolves only the exact owned worker
    // identity and returns that peer's OWN facts (its activation set, its pinned
    // start target and its real per-process exit subscription).
    resolvePeer: identity => {
      const entry = factsByKey.get(`${identity.worker_instance_id}\0${identity.boot_nonce}`);
      if (entry === undefined || identity.master_generation !== MASTER_GENERATION || identity.worker_slot !== 0) return null;
      const session: ControlPeerSession = Object.freeze({
        credential: entry.facts.credential,
        activatedPlugins: Object.freeze([...entry.peer.activated]),
        configurationTarget: Object.freeze({
          revision: 1, content_hash: `sha256:${'c'.repeat(64)}`, plugin_catalog_hash: CATALOG,
        }),
        onExit: (listener: () => void) => { exitListeners.add(listener); return () => { exitListeners.delete(listener); }; },
        verifyExit: async () => exitProof,
      });
      return session;
    },
  });

  broker.setChannelProviderLease((plugin, context) => host.beginChannelOperation(plugin, 'global', { ...context, authenticated: true })?.release ?? null);

  const control = createPluginControlHost({
    records: [providerRecord()], dependencies: graph, services: host,
    secretStores: stores(), storage: storages(),
    loadControl: async (): Promise<ControlPlugin> => ({
      createControl: context => ({
        api: [], rpc: [],
        start: () => {
          context.services!.rpc!.publish(CONTRACT, {
            read: (input: string) => `control:${input}`,
            slow: async () => { slowListener?.(); await slowGate; return 'slow-done'; },
            admin: () => 'admin',
          });
        },
        dispose: () => undefined,
      }),
    }),
  });
  await control.activate('provider');
  expect(control.status('provider')).toBe('ready');

  const listener = createManagementListener({
    profile: 'master-control', hostname: '127.0.0.1', port: reservePort(), shutdownTimeoutMs: 1000,
    controlApi: { handle: async () => null },
    internalPluginPeer: broker.websocket,
  });
  listener.start();
  if (managementReady) listener.ready();
  const port = listener.port;
  if (port === null) throw new Error('management listener did not bind');

  cleanups.push(async () => {
    await control.dispose();
    await broker.dispose();
    await listener.stop();
  });
  return {
    listener, broker, port, host, control,
    seedSerialized: serializeWorkerSupervisionSeed(primary.seed),
    credential: primary.credential,
    fireExit: () => { for (const listener of [...exitListeners]) listener(); },
    setExitProof: value => { exitProof = value; },
    onSlowEntered: listener => { slowListener = listener; },
    releaseSlow,
  };
}

interface WorkerRig {
  readonly broker: WorkerPeerBroker;
  readonly host: PluginServiceHost;
  readonly registry: ScopedPluginRegistry;
  readonly client: () => AsyncRpcClient<typeof CONTRACT.methods>;
  readonly bootstrapResult: () => string | undefined;
  readonly result: () => { success: number; failed: number };
}

interface ConnectWorkerOptions {
  /** Really publish the worker-provided RPC service, as a worker plugin would. */
  readonly publishWorkerService?: boolean;
  readonly authority?: () => typeof AUTHORITY | null;
}

/** Connects one real worker process (its canonical host + plugin init path). */
async function connectWorker(
  control: ControlSide,
  instance: string,
  nonce: string,
  options: ConnectWorkerOptions = {},
): Promise<WorkerRig> {
  let workerHost!: PluginServiceHost;
  let workerBroker!: WorkerPeerBroker;
  workerHost = new PluginServiceHost('worker', {
    identity: (plugin, scope) => pluginPeerLifecycleIdentity({
      process: 'worker', instance, generation: AUTHORITY.controller_epoch, catalog: CATALOG,
    }, plugin, scope),
    resolvePlacement: request => workerBroker.placementResolver(request),
    resolveJournal: () => null,
    resolveCallee: (): unknown => workerHost.currentInvocation()?.callee ?? null,
    ensureRemoteRoute: input => { workerBroker.ensureRemoteRoute(input); },
    channels: input => new HostChannelAdapter({ hub: workerBroker.channels, process: 'worker' }).createOwner(input),
  });
  // The declared service graph, exactly as the registry installs it, so a real
  // worker publication is declared before it is registered.
  workerHost.setDeclarations(graph.serviceDeclarations());
  workerBroker = new WorkerPeerBroker({
    services: workerHost,
    credential: kernelFacts(instance, nonce).credential,
    masterGeneration: MASTER_GENERATION,
    workerInstanceId: instance,
    bootNonce: nonce,
    workerSlot: 0,
    masterControlPort: () => control.port,
    catalog: () => CATALOG,
    authority: options.authority ?? (() => AUTHORITY),
  });
  workerBroker.setChannelProviderLease((plugin, context) => workerHost.beginChannelOperation(plugin, 'global', { ...context, authenticated: true })?.release ?? null);
  workerBroker.start();
  await waitFor(() => workerBroker.status.attached);
  cleanups.push(() => workerBroker.dispose());

  if (options.publishWorkerService === true) {
    // A real worker publication: its own host registers the real binding the
    // control side can only learn through the peer directory.
    const owner = workerHost.createContext('workerecho', 'global', {});
    owner.rpc!.publish(WORKER_CONTRACT, { echo: (value: string) => `worker:${value}` });
    workerHost.markReady('workerecho', 'global', owner);
  }

  // Real startup gate: the authenticated transport AND control's real
  // publication directory must be loaded before any plugin initializes.
  await workerBroker.waitUntilDirectoryLoaded({ timeoutMs: 5_000 });

  let capturedClient: AsyncRpcClient<typeof CONTRACT.methods> | null = null;
  let bootstrapValue: string | undefined;
  const registry = new ScopedPluginRegistry('/tmp', workerHost);
  registry.ensurePluginClassLoaded = async config => {
    const name = typeof config === 'string' ? config : config.name;
    const pluginClass: PluginClass = {
      name, version: '1.0.0',
      createHandler: async (_options, context) => {
        // Runs inside the real host bootstrap frame opened by createInstance.
        const client = context.services!.rpc!.consume('provider', CONTRACT);
        bootstrapValue = await client.read('bootstrap');
        capturedClient = client;
        return { bodyRequirements() { return { request: 'none' as const }; }, pluginName: name, config: {}, register() {}, async destroy() { /* nothing to release */ } };
      },
    };
    return pluginClass;
  };
  const outcome = await registry.initializeFromConfig({ plugins: ['consumer'] }, graph);
  cleanups.push(() => registry.destroy());
  return {
    broker: workerBroker, host: workerHost, registry,
    client: () => {
      if (capturedClient === null) throw new Error('consumer client was not captured');
      return capturedClient;
    },
    bootstrapResult: () => bootstrapValue,
    result: () => ({ ...outcome }),
  };
}

async function createRig(): Promise<ControlSide & Omit<WorkerRig, 'broker'> & { workerBroker: WorkerPeerBroker }> {
  const control = await createControlSide();
  const worker = await connectWorker(control, WORKER_INSTANCE, BOOT_NONCE);
  expect(worker.result()).toEqual({ success: 1, failed: 0 });
  return { ...control, ...worker, broker: control.broker, workerBroker: worker.broker };
}

async function expectUpgradeRejected(port: number, headers: Record<string, string>): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${PLUGIN_PEER_WS_PATH}`, { headers } as never);
  const opened = await new Promise<boolean>(resolve => {
    const settle = (value: boolean) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => settle(false), 1000);
    socket.addEventListener('open', () => settle(true));
    socket.addEventListener('error', () => settle(false));
    socket.addEventListener('close', () => settle(false));
  });
  try { socket.close(); } catch { /* already closed */ }
  expect(opened).toBe(false);
}

const upgradeIdentity = (instance: string, nonce: string): PluginPeerUpgradeIdentity => ({
  master_generation: MASTER_GENERATION, worker_instance_id: instance, worker_slot: 0,
  boot_nonce: nonce, controller_epoch: AUTHORITY.controller_epoch, controller_id: AUTHORITY.controller_id,
});

const workerPlacement = (broker: ControlPeerBroker) => broker.placementResolver({
  provider: 'workerecho', service: WORKER_SERVICE_ID, major: 1, method: 'echo',
  scope: 'global', caller: Object.freeze({ subject: 'workerecho.consumer', scope: 'global' }),
});

describe('P4 canonical Host control ↔ worker peer integration', () => {
  test('signed peer bootstrap precedes management readiness without bypassing shutdown', async () => {
    const control = await createControlSide(DEFAULT_PEERS, false);
    expect((await fetch(`http://127.0.0.1:${control.port}/health`)).status).toBe(503);
    const worker = await connectWorker(control, WORKER_INSTANCE, BOOT_NONCE);
    expect(worker.bootstrapResult()).toBe('control:bootstrap');
    expect(await worker.client().read('before-ready')).toBe('control:before-ready');
    expect((await fetch(`http://127.0.0.1:${control.port}/health`)).status).toBe(503);
    control.listener.stopAccepting();
    expect((await fetch(`http://127.0.0.1:${control.port}${PLUGIN_PEER_WS_PATH}`)).status).toBe(503);
  });

  test('a worker plugin consumes a control RPC service during bootstrap and afterwards', async () => {
    const rig = await createRig();

    // Same-process unit hosts use genuine loopback frames; child proof is separate.
    expect(rig.bootstrapResult()).toBe('control:bootstrap');
    // Background: the same canonical client, no bootstrap frame.
    expect(await rig.client().read('background')).toBe('control:background');
    // A management-only method is refused by the canonical runtime purpose rules.
    await expect(rig.client().admin(null)).rejects.toMatchObject({ code: 'wrong_purpose' });
    expect(rig.broker.peers().length).toBe(1);
  });

  test('a missing, expired, stale or replayed upgrade proof never creates a peer link', async () => {
    const rig = await createRig();
    const credential = createPluginPeerCredential(rig.credential);
    const identity = upgradeIdentity(WORKER_INSTANCE, BOOT_NONCE);

    // (1) identity only, no proof at all.
    await expectUpgradeRejected(rig.port, { [PLUGIN_PEER_IDENTITY_HEADER]: encodePluginPeerUpgradeIdentity(identity) });
    // (2) an expired proof (finite timestamp, already past).
    const expiredProof = encodePluginPeerHeader(signPluginPeerPacket({
      direction: 'peer-to-control', authority: AUTHORITY, sequence: 42, request_id: randomUUID(),
      lane: 'rpc', kind: 'request', deadline_at: Date.now() - 1_000,
      context: { op: 'websocket-upgrade', path: PLUGIN_PEER_WS_PATH, identity: { ...identity } },
    }, new Uint8Array(0), credential).header);
    await expectUpgradeRejected(rig.port, {
      [PLUGIN_PEER_IDENTITY_HEADER]: encodePluginPeerUpgradeIdentity(identity),
      [PLUGIN_PEER_PROOF_HEADER]: expiredProof,
    });
    // (3) a stale authority is refused, proof or not.
    const staleIdentity = { ...identity, controller_id: '66666666-6666-4666-8666-666666666666' };
    await expectUpgradeRejected(rig.port, {
      [PLUGIN_PEER_IDENTITY_HEADER]: encodePluginPeerUpgradeIdentity(staleIdentity),
      [PLUGIN_PEER_PROOF_HEADER]: encodePluginPeerUpgradeProof(staleIdentity, rig.credential, 43),
    });
    // (4) an unknown physical identity (no owned session).
    const unknownIdentity = upgradeIdentity(randomUUID(), randomUUID());
    await expectUpgradeRejected(rig.port, {
      [PLUGIN_PEER_IDENTITY_HEADER]: encodePluginPeerUpgradeIdentity(unknownIdentity),
      [PLUGIN_PEER_PROOF_HEADER]: encodePluginPeerUpgradeProof(unknownIdentity, rig.credential, 44),
    });
    // (5) a replayed proof: this rig's own first upgrade already consumed sequence 1.
    await expectUpgradeRejected(rig.port, {
      [PLUGIN_PEER_IDENTITY_HEADER]: encodePluginPeerUpgradeIdentity(identity),
      [PLUGIN_PEER_PROOF_HEADER]: encodePluginPeerUpgradeProof(identity, rig.credential, 1),
    });
    expect(rig.broker.peers()).toEqual([{ worker_instance_id: WORKER_INSTANCE, boot_nonce: BOOT_NONCE }]);
  });

  test('a caller must be activated by that peer own snapshot; two eligible peers are ambiguous', async () => {
    const control = await createControlSide([
      { instance: WORKER_INSTANCE, nonce: BOOT_NONCE, activated: ['provider', 'consumer', 'workerecho'] },
      { instance: SECOND_INSTANCE, nonce: SECOND_NONCE, activated: ['workerecho'] },
      { instance: THIRD_INSTANCE, nonce: THIRD_NONCE, activated: ['workerecho'] },
    ]);
    // Declare a control-side consumption of the worker-provided service.
    control.broker.ensureRemoteRoute({
      plugin: 'workerecho.consumer', scope: 'global', provider: 'workerecho',
      contract: WORKER_CONTRACT,
    });
    // Nobody connected yet: no route exists at all.
    expect(workerPlacement(control.broker)).toBeNull();

    // The second peer is really authenticated but never activated the consumer
    // plugin, so its bootstrap consumption must be refused.
    const second = await connectWorker(control, SECOND_INSTANCE, SECOND_NONCE, { publishWorkerService: true });
    expect(second.bootstrapResult()).toBeUndefined();
    expect(second.result()).toEqual({ success: 0, failed: 1 });
    // It really publishes the worker service, so the declared route becomes real
    // only after control learned the exact binding from the peer directory.
    await waitFor(() => workerPlacement(control.broker) !== null);

    // A third eligible peer (also really publishing the service) makes the same
    // route explicitly ambiguous instead of picking one.
    await connectWorker(control, THIRD_INSTANCE, THIRD_NONCE, { publishWorkerService: true });
    await waitFor(() => control.broker.peers().length === 2);
    await waitFor(() => workerPlacement(control.broker)?.kind === 'ambiguous');
    expect(workerPlacement(control.broker)).toEqual({ kind: 'ambiguous' });
  });

  test('a proxy route is registered from the peer REAL published binding, not a local guess', async () => {
    const control = await createControlSide([
      { instance: WORKER_INSTANCE, nonce: BOOT_NONCE, activated: ['provider', 'consumer', 'workerecho'] },
      { instance: SECOND_INSTANCE, nonce: SECOND_NONCE, activated: ['workerecho'] },
    ]);
    control.broker.ensureRemoteRoute({
      plugin: 'workerecho.consumer', scope: 'global', provider: 'workerecho',
      contract: WORKER_CONTRACT,
    });
    const worker = await connectWorker(control, SECOND_INSTANCE, SECOND_NONCE, { publishWorkerService: true });

    // The worker's own host exposes the REAL binding of its publication.
    const published = worker.host.rpc!.publicationView().find(publication => publication.provider === 'workerecho');
    expect(published).toBeDefined();
    expect(published!.ready).toBe(true);

    await waitFor(() => workerPlacement(control.broker)?.kind === 'endpoint');
    const placement = workerPlacement(control.broker);
    if (placement === null || placement === undefined || placement.kind !== 'endpoint') {
      throw new Error('the worker route was not materialized');
    }
    // The route control registered really carries that exact binding (field by
    // field), and that is the only thing the peer accepts inbound.
    const runtime = control.host.rpc!.runtime;
    const info = runtime.endpointInfo(placement.endpoint);
    expect(info).not.toBeNull();
    expect(info!.binding).toEqual(published!.binding);
    expect(info!.provider).toBe('workerecho');
    expect(info!.contract.id).toBe(WORKER_SERVICE_ID);
  });

  test('an unproven peer exit never stops the peer; an exact exit proof does', async () => {
    const rig = await createRig();
    expect(await rig.client().read('before-exit')).toBe('control:before-exit');

    // Physical exit notification WITHOUT an exact proof: retire admission only.
    rig.setExitProof(false);
    rig.fireExit();
    await waitFor(() => rig.broker.peers().length === 1);
    await expect(rig.client().read('after-unproven-exit')).rejects.toBeDefined();

    // The same notification with a real exact-exit proof releases the peer.
    rig.setExitProof(true);
    rig.fireExit();
    await waitFor(() => rig.broker.peers().length === 0);
  });

  test('retirement refuses new peer work while the accepted task keeps its barrier', async () => {
    const rig = await createRig();

    let entered = false;
    rig.onSlowEntered(() => { entered = true; });
    const pending = rig.client().slow(null);
    void pending.catch(() => undefined);
    await waitFor(() => entered);
    rig.broker.retirePeer({ worker_instance_id: WORKER_INSTANCE, boot_nonce: BOOT_NONCE });
    rig.releaseSlow();
    // The already accepted task completes normally: retirement never revokes it.
    expect(await pending).toBe('slow-done');
    // New work is refused without producing a result.
    await expect(rig.client().read('after-retire')).rejects.toBeDefined();
  });

  test('a socket close only detaches and reconnects; only an exit proof releases the peer', async () => {
    const rig = await createRig();
    expect(await rig.client().read('before-close')).toBe('control:before-close');

    rig.workerBroker.disconnectTransport();
    await waitFor(() => !rig.workerBroker.status.attached);
    // A disconnect is not an exit proof: the peer record and its routes stay.
    expect(rig.broker.peers()).toEqual([{ worker_instance_id: WORKER_INSTANCE, boot_nonce: BOOT_NONCE }]);

    // The host owns reconnection: the same link is re-bound, keeping its records.
    rig.workerBroker.refresh();
    await waitFor(() => rig.workerBroker.status.attached);
    expect(await rig.client().read('after-reconnect')).toBe('control:after-reconnect');

    await rig.broker.confirmPeerStopped({ worker_instance_id: WORKER_INSTANCE, boot_nonce: BOOT_NONCE });
    expect(rig.broker.peers()).toEqual([]);
  });

  test('a corrupt executor proof and a socket disconnect preserve alive business capacity and owner leases', async () => {
    const control = await createControlSide(DEFAULT_PEERS, true, () => ({
      source: {process: 'control', instance: MASTER_GENERATION, generation: 1, catalog: CATALOG},
      physical: {pid: process.pid}, boot: 'same-epoch',
    }) as unknown as PluginExecutorProof);
    const worker = await connectWorker(control, WORKER_INSTANCE, BOOT_NONCE);
    let entered = false;
    control.onSlowEntered(() => { entered = true; });
    const pending = worker.client().slow(null);
    void pending.catch(() => undefined);
    await waitFor(() => entered);
    worker.broker.disconnectTransport();
    worker.broker.refresh();
    await waitFor(() => worker.broker.status.attached);
    // Cross a complete OS-verification interval: invalid proof must not become PID evidence.
    await Bun.sleep(1200);
    expect(worker.host.rpc!.runtime.status().active).toBe(1);
    expect(worker.host.references('consumer').find(owner => owner.plugin === 'consumer')?.leases).toBe(1);
    control.releaseSlow();
    expect(await pending).toBe('slow-done');
    await waitFor(() => worker.host.rpc!.runtime.status().active === 0);
    expect(worker.host.references('consumer').find(owner => owner.plugin === 'consumer')?.leases).toBe(0);
  });

  test('a complete alive executor proof does not release 64 tasks across disconnect and verification', async () => {
    const marker = process.env.BUNGEE_ALIVE_EXECUTOR_TEST_MARKER;
    if (!marker) {
      const id = randomUUID();
      // The child really hosts the control business and carries its marker in
      // OS argv; a separate idle process would be false executor evidence.
      const child = Bun.spawn([process.execPath, 'test', import.meta.path,
        '--test-name-pattern', 'a complete alive executor proof', '--', `--bungee-process-identity=${id}`], {
        env: {...process.env, BUNGEE_ALIVE_EXECUTOR_TEST_MARKER: id}, stdout: 'pipe', stderr: 'pipe',
      });
      try {
        const [output, errors, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(code, output + errors).toBe(0);
      } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
      return;
    }
    const proof: PluginExecutorProof = {
      source: {process: 'control', instance: MASTER_GENERATION, generation: 1, catalog: CATALOG},
      physical: await captureProcessIdentity(process.pid, marker), boot: await readKernelBootId(),
    };
    const control = await createControlSide(DEFAULT_PEERS, true, () => proof);
    const worker = await connectWorker(control, WORKER_INSTANCE, BOOT_NONCE);
    const pending = Array.from({length: 64}, () => worker.client().slow(null));
    void Promise.all(pending).catch(() => undefined);
    await waitFor(() => worker.host.rpc!.runtime.status().active === 64);
    await expect(worker.client().read('capacity-full')).rejects.toMatchObject({code: 'overloaded'});
    worker.broker.disconnectTransport();
    worker.broker.refresh();
    await waitFor(() => worker.broker.status.attached);
    await Bun.sleep(1200);
    expect(worker.host.rpc!.runtime.status().active).toBe(64);
    expect(worker.host.references('consumer').find(owner => owner.plugin === 'consumer')?.leases).toBe(64);
    control.releaseSlow();
    expect(await Promise.all(pending)).toEqual(Array(64).fill('slow-done'));
    await waitFor(() => worker.host.rpc!.runtime.status().active === 0);
    expect(worker.host.references('consumer').find(owner => owner.plugin === 'consumer')?.leases).toBe(0);
  }, 20000);

  test('a draining worker reattaches its exact link and preserves the real terminal barrier', async () => {
    const rig = await createRig();
    let entered = false;
    rig.onSlowEntered(() => { entered = true; });
    const pending = rig.client().slow(null);
    void pending.catch(() => undefined);
    await waitFor(() => entered);
    rig.broker.retirePeer({ worker_instance_id: WORKER_INSTANCE, boot_nonce: BOOT_NONCE });
    rig.workerBroker.retire();
    rig.workerBroker.disconnectTransport();
    await waitFor(() => !rig.workerBroker.status.attached);
    // Detaching a socket does not fabricate a terminal for accepted work.
    expect(rig.host.rpc!.runtime.status().active).toBe(1);
    rig.workerBroker.refresh();
    await waitFor(() => rig.workerBroker.status.attached);
    expect(rig.host.rpc!.runtime.status().active).toBe(1);
    await expect(rig.client().read('after-retired-reconnect')).rejects.toBeDefined();
    rig.releaseSlow();
    expect(await pending).toBe('slow-done');
    await waitFor(() => rig.host.rpc!.runtime.status().active === 0);
  });

  test('a draining worker admits no new work while the transport stays attached', async () => {
    const rig = await createRig();
    expect(await rig.client().read('before-drain')).toBe('control:before-drain');

    rig.workerBroker.retire();
    expect(rig.workerBroker.status.retired).toBe(true);
    expect(rig.workerBroker.status.attached).toBe(true);
    // Route discovery remains available for existing request settlements; actual
    // bootstrap/background calls are refused at invocation admission.
    expect(rig.workerBroker.placementResolver({
      provider: 'provider', service: SERVICE_ID, major: 1, method: 'read',
      scope: 'global', caller: Object.freeze({ subject: 'consumer', scope: 'global' }),
    })).not.toBeNull();
    await expect(rig.client().read('after-drain')).rejects.toBeDefined();
  });

  test('shutdown authority loss preserves accepted terminals until Host cleanup finishes', async () => {
    const control = await createControlSide();
    let authority: typeof AUTHORITY | null = AUTHORITY;
    const worker = await connectWorker(control, WORKER_INSTANCE, BOOT_NONCE, { authority: () => authority });
    let entered = false;
    control.onSlowEntered(() => { entered = true; });
    const pending = worker.client().slow(null);
    void pending.catch(() => undefined);
    await waitFor(() => entered);
    worker.broker.retire();
    worker.host.retireAll();
    authority = null;
    worker.broker.refresh();
    expect(worker.broker.status.attached).toBe(true);
    await expect(worker.client().read('after-shutdown')).rejects.toBeDefined();
    let cleaned = false;
    const cleanup = worker.registry.destroy().then(() => { cleaned = true; });
    await Bun.sleep(20);
    expect(cleaned).toBe(false);
    expect(worker.host.rpc!.runtime.status().active).toBe(1);
    control.releaseSlow();
    expect(await pending).toBe('slow-done');
    await cleanup;
    expect(cleaned).toBe(true);
    expect(worker.host.rpc!.runtime.status().active).toBe(0);
  });

  test('a real worker child process consumes a control service across processes', async () => {
    const control = await createControlSide();
    const script = new URL('../../fixtures/plugin-peer-worker-child.ts', import.meta.url).pathname;
    const child = Bun.spawn(['bun', 'run', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PEER_MASTER_GENERATION: MASTER_GENERATION,
        PEER_WORKER_INSTANCE: WORKER_INSTANCE,
        PEER_BOOT_NONCE: BOOT_NONCE,
        PEER_WORKER_SLOT: '0',
        PEER_CONTROLLER_EPOCH: String(AUTHORITY.controller_epoch),
        PEER_CONTROLLER_ID: AUTHORITY.controller_id,
        PEER_MASTER_CONTROL_PORT: String(control.port),
        PEER_CATALOG: CATALOG,
        BUNGEE_WORKER_SUPERVISION_SEED: control.seedSerialized,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    cleanups.push(() => { try { child.kill(); } catch { /* already exited */ } });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // The real registry also logs to stdout, so select the child's result line.
    const reported: unknown = stdout.split('\n').map(safeParse)
      .find(value => typeof value === 'object' && value !== null && 'ok' in value);
    expect({ exitCode, stderr: stderr.slice(0, 512), reported }).toEqual({
      exitCode: 0,
      stderr: '',
      reported: { ok: true, bootstrap: 'control:child-bootstrap', background: 'control:child-background', attached: true },
    });
    // The child's peer was authenticated by the real control process.
    expect(control.broker.peers()).toEqual([{ worker_instance_id: WORKER_INSTANCE, boot_nonce: BOOT_NONCE }]);
  });

  test('the peer identity codec is strict and every owner activation has a new endpoint', () => {
    const identity: PluginPeerUpgradeIdentity = {
      master_generation: MASTER_GENERATION, worker_instance_id: WORKER_INSTANCE, worker_slot: 0,
      boot_nonce: BOOT_NONCE, controller_epoch: 1, controller_id: CONTROLLER_ID,
    };
    expect(parsePluginPeerUpgradeIdentity(encodePluginPeerUpgradeIdentity(identity))).toEqual(identity);
    expect(parsePluginPeerUpgradeIdentity('{}')).toBeNull();
    expect(parsePluginPeerUpgradeIdentity(null)).toBeNull();
    expect(parsePluginPeerUpgradeIdentity(JSON.stringify({ ...identity, extra: 1 }))).toBeNull();
    expect(parsePluginPeerUpgradeIdentity(JSON.stringify({ ...identity, worker_slot: -1 }))).toBeNull();

    const facts = { process: 'control' as const, instance: MASTER_GENERATION, generation: 1, catalog: CATALOG };
    const first = pluginPeerLifecycleIdentity(facts, 'provider', 'global');
    const replacement = pluginPeerLifecycleIdentity(facts, 'provider', 'global');
    expect(first.endpoint).not.toBe(replacement.endpoint);
    expect(first.instance).toBe(replacement.instance);
    expect(first.subject).toBe(replacement.subject);
    expect(first.catalog).toBe(replacement.catalog);
  });

  test('same plugin worker reads its explicitly declared control snapshot over the authenticated peer', async () => {
    const side = await createControlSide([{ instance: WORKER_INSTANCE, nonce: BOOT_NONCE, activated: ['provider', 'consumer', 'models-dev'] }]);
    const service = { id: 'models-dev.catalog.snapshot.v1', version: 1, kind: 'snapshot' as const };
    const self = new PluginDependencyGraph([{ name: 'models-dev', version: '1.0.0', runtimeScope: 'global', services: {
      provides: [{ ...service, process: 'control' }], consumes: [{ ...service, plugin: 'models-dev', process: 'worker' }],
    } }]);
    const declarations = new Map([...graph.serviceDeclarations(), ...self.serviceDeclarations()]);
    side.host.setDeclarations(declarations);
    const provider = side.host.createContext('models-dev');
    const bytes = new TextEncoder().encode(JSON.stringify({ models: ['one'] }));
    const descriptor = { owner: 'models-dev', epoch: 1, version: 1, schemaVersion: 1,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const, size: bytes.length, chunkBytes: 1024 };
    const source = { descriptor, read: async (offset: number, length: number) => bytes.slice(offset, offset + length) };
    const contract = { id: service.id, version: 1, content: { type: 'json' as const } };
    side.host.runInInvocation(provider, { purpose: 'bootstrap' }, () => provider.snapshot!.provide(contract, { current: () => source, version: () => source }));
    side.host.markReady('models-dev');
    const worker = await connectWorker(side, WORKER_INSTANCE, BOOT_NONCE);
    worker.host.setDeclarations(declarations);
    const consumer = worker.host.createContext('models-dev'); worker.host.markReady('models-dev');
    const view = consumer.snapshot!.consume('models-dev', contract);
    expect(await view.sync()).toBe('applied');
    expect(JSON.parse(new TextDecoder().decode(view.current()!.bytes))).toEqual({ models: ['one'] });
    // The same authenticated channel still refuses self-consumption whose
    // provider declaration no longer names the receiving control process.
    side.host.setDeclarations(new Map([...graph.serviceDeclarations(), ['models-dev', {
      provides: [{ ...service, process: 'worker' as const }], consumes: [{ ...service, plugin: 'models-dev', process: 'worker' as const }],
    }]]));
    expect(await view.sync({ force: true })).toBe('failed');
    expect(view.current()!.descriptor).toEqual(descriptor);
    side.host.setDeclarations(declarations);
    await worker.host.dispose('models-dev'); await side.host.dispose('models-dev');
  });

  test('binding provider declarations fail before peer routing starts', () => {
    expect(() => new PluginDependencyGraph([{ name: 'provider', version: '1.0.0', runtimeScope: 'global', services: {
      provides: [{ id: SERVICE_ID, version: 1, process: 'control', kind: 'rpc', scope: 'binding' } as never],
    } }])).toThrow('Only global');
  });

});

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
