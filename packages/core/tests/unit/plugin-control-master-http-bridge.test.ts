import { expect, test } from 'bun:test';
import { createPluginControlHttpClient, createPluginControlRpcCredential } from '../../src/plugin-control';
import {
  createPluginControlMasterHttpBridge,
  type PluginControlMasterBridgeOptions,
} from '../../src/plugin-control/master-http-bridge';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed } from '../../src/supervision';

const ROOT = new Uint8Array(32).fill(7);
const AUTHORITY = { controller_epoch: 1, controller_id: '40000000-0000-4000-8000-000000000001' } as const;
const HASH = `sha256:${'a'.repeat(64)}` as const;
const OTHER_HASH = `sha256:${'c'.repeat(64)}` as const;
const CATALOG = `sha256:${'b'.repeat(64)}` as const;
const GENERATION = '10000000-0000-4000-8000-000000000001';
const ENDPOINT_ID = '60000000-0000-4000-8000-000000000001';
const PLUGIN = 'test-plugin';

type Worker = {
  master_generation: string;
  worker_instance_id: string;
  worker_slot: number;
  boot_nonce: string;
  private_port: number;
};
type Registry = { active: any; prepared: any; retired: readonly any[] };
type Process = { readonly name: string };
type Harness = ReturnType<typeof createHarness>;

function worker(number: number, privatePort = 45_000 + number, slot = 0): Worker {
  return {
    master_generation: GENERATION,
    worker_instance_id: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    worker_slot: slot,
    boot_nonce: `50000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    private_port: privatePort,
  };
}

function admission(item: Worker, sequence = 1): any {
  return {
    master_generation: GENERATION, admission_sequence: sequence, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [item],
  };
}

function endpoint(options: Record<string, unknown> = { accountRef: 'serving', nested: { value: 'serving' } }): any {
  return {
    id: ENDPOINT_ID, target: 'https://example.test', weight: 100, priority: 1, is_disabled: false,
    managedBy: { plugin: PLUGIN, contributionId: 'credential', bindingId: 'binding' },
    plugins: [{ id: 'binding', position: 0, name: PLUGIN, enabled: true, options }],
  };
}

function snapshot(options: { readonly endpoints?: readonly any[]; readonly activated?: boolean } = {}): any {
  return {
    revision: 1, content_hash: HASH,
    aggregate: {
      logical_configuration: {
        services: [{ id: 'service', position: 0, name: 'service', endpoints: [...(options.endpoints ?? [endpoint()])], plugins: [] }],
        routes: [], plugins: [],
      },
      plugin_activations: options.activated === false ? [] : [{ plugin_name: PLUGIN }],
    },
  };
}

function clone<T>(value: T): T { return structuredClone(value); }

function createHarness(options: {
  readonly workers?: readonly Worker[];
  readonly active?: Worker;
  readonly registry?: Registry;
  readonly invoke?: (payload: unknown, context: any) => unknown | Promise<unknown>;
} = {}) {
  const activeWorker = options.active ?? worker(1);
  const allWorkers = new Map<string, Worker>((options.workers ?? [activeWorker]).map((item) => [item.worker_instance_id, item]));
  allWorkers.set(activeWorker.worker_instance_id, activeWorker);
  let registry: Registry = options.registry ?? { active: admission(activeWorker), prepared: null, retired: [] };
  let fresh = true;
  let authority = AUTHORITY;
  let currentSnapshot = snapshot();
  let servingSnapshot = snapshot();
  let hostStatus: 'ready' | 'inactive' = 'ready';
  let allowedMethods = ['refresh'];
  let statusPatch: Record<string, unknown> = {};
  let evidencePatch: Record<string, unknown> = {};
  let factoryEnabled = true;
  let factoryCalls = 0;
  let statusCalls = 0;
  let hostCalls = 0;
  const processes = new Map<string, Process>([...allWorkers.values()].map((item) => [item.worker_instance_id, { name: `process-${item.worker_instance_id}` }]));
  const clients: ReturnType<typeof createPluginControlHttpClient>[] = [];
  let statusGate: Promise<void> | null = null;
  let statusGateEntered: (() => void) | null = null;
  let onFactoryLookup: (() => void) | null = null;

  const rawCredential = (item: Worker) => deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(ROOT, item.master_generation, item.worker_instance_id, item.worker_slot), item.boot_nonce,
  );
  const workerForIdentity = (identity: { readonly worker_instance_id: string; readonly boot_nonce: string }): Worker | null => {
    const item = allWorkers.get(identity.worker_instance_id);
    return item !== undefined && item.boot_nonce === identity.boot_nonce ? item : null;
  };
  const readyMessage = (item: Worker, pid: number) => ({
    status: 'config-ready' as const, ...item, pid, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
    plugin_runtime_generation: 1, required_plugins: [PLUGIN], serving_plugins: [PLUGIN], publication: null,
  });
  const statusFor = async (item: Worker): Promise<any> => {
    statusCalls += 1;
    statusGateEntered?.();
    if (statusGate !== null) await statusGate;
    const pid = typeof statusPatch.pid === 'number' ? statusPatch.pid : 42;
    const message = { ...readyMessage(item, pid), ...evidencePatch };
    const value = {
      schema: 'bungee-worker-status-v1', role: 'worker', ...item,
      pid, control_port: 44_000, phase: 'serving', frozen: false,
      revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG, started_at: 1,
      snapshot_hash: HASH, authority, request_correlation: '70000000-0000-4000-8000-000000000001',
      replay: { sequence: statusCalls, request_id: '70000000-0000-4000-8000-000000000001' },
      evidence: { kind: 'ready', message },
    };
    return { ...value, ...statusPatch, authority: statusPatch.authority ?? authority,
      evidence: statusPatch.evidence ?? value.evidence };
  };

  const bridgeOptions: PluginControlMasterBridgeOptions = {
    ingress: {
      trustedActiveAdmissionIfFresh: () => fresh ? registry.active : null,
      currentControllerAuthority: () => authority,
    },
    factory: {
      lookupExactControlSession(identity) {
        factoryCalls += 1;
        const item = workerForIdentity(identity);
        if (!factoryEnabled || item === null || identity.private_port !== item.private_port || identity.revision !== 1
          || identity.content_hash !== HASH || identity.plugin_catalog_hash !== CATALOG) return null;
        const process = processes.get(item.worker_instance_id)!;
        const session = {
          process: process as never,
          credential: rawCredential(item),
          get controlState() { return 'attached' as const; },
          status: () => statusFor(item),
        };
        const hook = onFactoryLookup;
        onFactoryLookup = null;
        hook?.();
        return session;
      },
    },
    repository: { getSnapshot: () => currentSnapshot, getServingSnapshot: () => servingSnapshot },
    pluginControlHost: {
      status: () => hostStatus,
      invokeRpc: async (_plugin, _method, payload, invocation) => {
        hostCalls += 1;
        return options.invoke === undefined ? payload : options.invoke(payload, invocation);
      },
    },
    catalog: {
      hash: CATALOG,
      records: () => [{ name: PLUGIN, manifest: { control: { rpc: allowedMethods.map((name) => ({ name, access: 'bound-attempt' })) } } }] as any,
    },
  };
  const bridge = createPluginControlMasterHttpBridge(bridgeOptions);
  bridge.syncActiveAdmission();

  function clientFor(item: Worker): ReturnType<typeof createPluginControlHttpClient> {
    const credential = createPluginControlRpcCredential(rawCredential(item), {
      master_generation: item.master_generation, worker_instance_id: item.worker_instance_id,
      worker_slot: item.worker_slot, boot_nonce: item.boot_nonce,
    });
    const client = createPluginControlHttpClient({
      baseUrl: 'http://127.0.0.1:1', session: () => ({ credential, authority }),
      fetchImpl: (_input, init) => bridge.handle(new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1', init)),
    });
    clients.push(client);
    return client;
  }

  async function call(item = activeWorker, input: Record<string, unknown> = {}, client = clientFor(item), keepClient = false): Promise<unknown> {
    try {
      return await client.call({ revision: 1, endpoint_id: ENDPOINT_ID, attempt_id: '80000000-0000-4000-8000-000000000001', method: 'refresh', payload: input }, new AbortController().signal);
    } finally {
      if (!keepClient && clients.includes(client)) { client.dispose(); clients.splice(clients.indexOf(client), 1); }
    }
  }

  return {
    activeWorker, bridge, call, clientFor,
    setRegistry: (next: Registry) => { registry = next; }, setFresh: (next: boolean) => { fresh = next; },
    setAuthority: (next: typeof AUTHORITY) => { authority = next; }, setSnapshots: (current: any, serving: any) => { currentSnapshot = current; servingSnapshot = serving; },
    setStatus: (next: Record<string, unknown>) => { statusPatch = next; }, setEvidence: (next: Record<string, unknown>) => { evidencePatch = next; },
    setHostStatus: (next: 'ready' | 'inactive') => { hostStatus = next; }, setMethods: (next: string[]) => { allowedMethods = next; },
    setFactoryEnabled: (next: boolean) => { factoryEnabled = next; }, setProcess: (item: Worker, process: Process) => { processes.set(item.worker_instance_id, process); },
    replaceAfterFactoryLookup: (item: Worker, process: Process) => { onFactoryLookup = () => { processes.set(item.worker_instance_id, process); }; },
    register: (item: Worker) => { allWorkers.set(item.worker_instance_id, item); processes.set(item.worker_instance_id, { name: `process-${item.worker_instance_id}` }); },
    counts: () => ({ factoryCalls, statusCalls, hostCalls }),
    blockStatus: () => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      statusGate = new Promise<void>((resolve) => { release = resolve; });
      statusGateEntered = entered;
      return { started, release: () => { release(); statusGate = null; statusGateEntered = null; } };
    },
    dispose: () => { for (const client of clients.splice(0)) client.dispose(); bridge.dispose(); },
  };
}

test('complete admission marker rejects stale A after ingress changes only its workers', async () => {
  const a = worker(1);
  const b = worker(2);
  const harness = createHarness({ active: a, workers: [a, b] });
  harness.setRegistry({ active: admission(b), prepared: null, retired: [] });
  await expect(harness.call(a)).rejects.toBeDefined();
  expect(harness.counts()).toEqual({ factoryCalls: 1, statusCalls: 0, hostCalls: 0 });
  harness.dispose();
});

test('freshness expiry and wrong signed authority reject before host execution', async () => {
  const cases = [
    { name: 'expired', configure: (h: Harness) => h.setFresh(false), status: 0 },
    { name: 'recovering with prepared admission', configure: (h: Harness) => h.setRegistry({ active: null, prepared: admission(worker(90), 2), retired: [] }), status: 0 },
    { name: 'wrong authority', configure: (h: Harness) => h.setStatus({ authority: { ...AUTHORITY, controller_epoch: 2 } }), status: 1 },
  ];
  for (const item of cases) {
    const harness = createHarness();
    item.configure(harness);
    await expect(harness.call()).rejects.toBeDefined();
    expect(harness.counts().statusCalls, item.name).toBe(item.status);
    expect(harness.counts().hostCalls, item.name).toBe(0);
    harness.dispose();
  }
});

test('freshness clearing prunes guards and aborts an in-flight host call immediately', async () => {
  let entered!: () => void;
  let aborted!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const abortedPromise = new Promise<void>((resolve) => { aborted = resolve; });
  const harness = createHarness({ invoke: async (_payload, invocation) => {
    entered();
    await new Promise<void>((resolve) => invocation.attempt.signal.addEventListener('abort', () => {
      aborted();
      resolve();
    }, { once: true }));
    return 'late';
  }});
  const pending = harness.call(undefined, {}, undefined, true);
  await enteredPromise;
  harness.setFresh(false);
  harness.bridge.syncActiveAdmission();
  await abortedPromise;
  await expect(pending).rejects.toBeDefined();
  expect(harness.counts().hostCalls).toBe(1);
  expect(harness.counts().statusCalls).toBe(1);
  harness.dispose();
});

test('different-process replacement is rejected before old session status while same-process wrappers survive concurrency', async () => {
  const item = worker(3);
  const replacement = { name: 'replacement' };
  const harness = createHarness({ active: item });
  const gate = harness.blockStatus();
  // The fake factory is process-swappable; swapping before the action status call
  // models a forgotten/replaced adapter without granting the old process access.
  harness.replaceAfterFactoryLookup(item, replacement);
  await expect(harness.call(item)).rejects.toBeDefined();
  expect(harness.counts().statusCalls).toBe(0);
  expect(harness.counts().hostCalls).toBe(0);
  gate.release();
  harness.dispose();

  const concurrent = createHarness({ active: worker(4) });
  const shared = concurrent.clientFor(concurrent.activeWorker);
  const statusGate = concurrent.blockStatus();
  const first = concurrent.call(concurrent.activeWorker, { request: 1 }, shared, true);
  await statusGate.started;
  const second = concurrent.call(concurrent.activeWorker, { request: 2 }, shared, true);
  statusGate.release();
  await expect(Promise.all([first, second])).resolves.toEqual([{ request: 1 }, { request: 2 }]);
  expect(concurrent.counts().hostCalls).toBe(2);
  concurrent.dispose();
});

test('active B remains usable with retired A while prepared C, orphan D, and factory-only candidate E are denied', async () => {
  const a = worker(10), b = worker(11), c = worker(12), d = worker(13), e = worker(14);
  const harness = createHarness({ active: b, workers: [a, b, c, d, e], registry: { active: admission(b), prepared: admission(c, 2), retired: [admission(a)] } });
  harness.setRegistry({ active: admission(b), prepared: admission(c, 2), retired: [admission(a)] });
  await expect(harness.call(b)).resolves.toEqual({});
  const before = harness.counts();
  for (const candidate of [a, c, d, e]) {
    await expect(harness.call(candidate)).rejects.toBeDefined();
    expect(harness.counts().factoryCalls).toBe(before.factoryCalls);
    expect(harness.counts().statusCalls).toBe(before.statusCalls);
    expect(harness.counts().hostCalls).toBe(before.hostCalls);
  }
  harness.dispose();
});

test('status identity fields are all enforced, while PID remains diagnostic when status and evidence agree', async () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['phase', { phase: 'draining' }], ['frozen', { frozen: true }],
    ['generation', { master_generation: '10000000-0000-4000-8000-000000000099' }],
    ['worker id', { worker_instance_id: '20000000-0000-4000-8000-000000000099' }], ['slot', { worker_slot: 1 }],
    ['boot', { boot_nonce: '50000000-0000-4000-8000-000000000099' }], ['revision', { revision: 2 }],
    ['content hash', { content_hash: OTHER_HASH }], ['catalog hash', { plugin_catalog_hash: OTHER_HASH }], ['private port', { private_port: 46_000 }],
  ];
  for (const [name, patch] of cases) {
    const harness = createHarness();
    harness.setStatus(patch);
    await expect(harness.call(), name).rejects.toBeDefined();
    expect(harness.counts().statusCalls, name).toBe(1);
    expect(harness.counts().hostCalls, name).toBe(0);
    harness.dispose();
  }
  const diagnostic = createHarness();
  diagnostic.setStatus({ pid: 99 });
  diagnostic.setEvidence({ pid: 99 });
  await expect(diagnostic.call()).resolves.toEqual({});
  expect(diagnostic.counts().hostCalls).toBe(1);
  diagnostic.dispose();
});

test('config-ready evidence kind/status and every bound identity field are enforced', async () => {
  const fields: readonly [string, Record<string, unknown>][] = [
    ['kind', { evidence: { kind: 'candidate' } }], ['status', { evidence: { kind: 'ready', message: { status: 'worker-drained' } } }],
    ['generation', { master_generation: '10000000-0000-4000-8000-000000000099' }],
    ['worker id', { worker_instance_id: '20000000-0000-4000-8000-000000000099' }], ['slot', { worker_slot: 1 }],
    ['boot', { boot_nonce: '50000000-0000-4000-8000-000000000099' }], ['revision', { revision: 2 }],
    ['content hash', { content_hash: OTHER_HASH }], ['catalog hash', { plugin_catalog_hash: OTHER_HASH }],
    ['private port', { private_port: 46_000 }],
  ];
  for (const [name, patch] of fields) {
    const harness = createHarness();
    if (['generation', 'worker id', 'slot', 'boot', 'revision', 'content hash', 'catalog hash', 'private port'].includes(name)) harness.setEvidence(patch);
    else harness.setStatus(patch);
    await expect(harness.call(), name).rejects.toBeDefined();
    expect(harness.counts().hostCalls, name).toBe(0);
    harness.dispose();
  }
  const pid = createHarness();
  pid.setEvidence({ pid: 99 });
  pid.setStatus({ pid: 42 });
  await expect(pid.call()).rejects.toBeDefined();
  expect(pid.counts().hostCalls).toBe(0);
  pid.dispose();
});

test('current and serving endpoint topology and managed binding checks reject every mismatched source', async () => {
  const cases: readonly [string, (current: any, serving: any) => void][] = [
    ['current duplicate', (current) => { current.aggregate.logical_configuration.routes = [{ endpoints: [current.aggregate.logical_configuration.services[0].endpoints[0]] }]; }],
    ['serving duplicate', (_current, serving) => { serving.aggregate.logical_configuration.routes = [{ endpoints: [serving.aggregate.logical_configuration.services[0].endpoints[0]] }]; }],
    ['current missing', (current) => { current.aggregate.logical_configuration.services[0].endpoints = []; }],
    ['serving missing', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints = []; }],
    ['current disabled', (current) => { current.aggregate.logical_configuration.services[0].endpoints[0].is_disabled = true; }],
    ['serving disabled', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints[0].is_disabled = true; }],
    ['current binding missing', (current) => { current.aggregate.logical_configuration.services[0].endpoints[0].plugins = []; }],
    ['current binding disabled', (current) => { current.aggregate.logical_configuration.services[0].endpoints[0].plugins[0].enabled = false; }],
    ['current binding duplicate', (current) => { current.aggregate.logical_configuration.services[0].endpoints[0].plugins.push(clone(current.aggregate.logical_configuration.services[0].endpoints[0].plugins[0])); }],
    ['plugin mismatch', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints[0].managedBy.plugin = 'other-plugin'; }],
    ['contribution mismatch', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints[0].managedBy.contributionId = 'other'; }],
    ['binding mismatch', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints[0].managedBy.bindingId = 'other'; }],
    ['binding missing', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints[0].plugins = []; }],
    ['binding disabled', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints[0].plugins[0].enabled = false; }],
    ['binding duplicate', (_current, serving) => { serving.aggregate.logical_configuration.services[0].endpoints[0].plugins.push(clone(serving.aggregate.logical_configuration.services[0].endpoints[0].plugins[0])); }],
    ['activation missing', (current) => { current.aggregate.plugin_activations = []; }],
  ];
  for (const [name, configure] of cases) {
    const harness = createHarness();
    const current = snapshot();
    const serving = snapshot();
    configure(current, serving);
    harness.setSnapshots(current, serving);
    await expect(harness.call(), name).rejects.toBeDefined();
    expect(harness.counts().statusCalls, name).toBe(1);
    expect(harness.counts().hostCalls, name).toBe(0);
    harness.dispose();
  }
});

test('host readiness and manifest method allowlist are enforced after trusted snapshots', async () => {
  const cases = [
    ['host not ready', (h: Harness) => h.setHostStatus('inactive')],
    ['method not allowed', (h: Harness) => h.setMethods([])],
  ] as const;
  for (const [name, configure] of cases) {
    const harness = createHarness();
    configure(harness);
    await expect(harness.call(), name).rejects.toBeDefined();
    expect(harness.counts().statusCalls, name).toBe(1);
    expect(harness.counts().hostCalls, name).toBe(0);
    harness.dispose();
  }
});

test('publication windows accept monotonic current snapshots but require exact serving identity', async () => {
  const cases = [
    ['current ahead', (current: any) => { current.revision = 2; }, true],
    ['current content hash', (current: any) => { current.content_hash = OTHER_HASH; }, true],
    ['current behind', (current: any) => { current.revision = 0; }, false],
    ['serving revision', (_current: any, serving: any) => { serving.revision = 2; }, false],
    ['serving content hash', (_current: any, serving: any) => { serving.content_hash = OTHER_HASH; }, false],
  ] as const;
  for (const [name, configure, allowed] of cases) {
    const harness = createHarness();
    const current = snapshot();
    const serving = snapshot();
    configure(current, serving);
    harness.setSnapshots(current, serving);
    if (allowed) await expect(harness.call(), name).resolves.toEqual({});
    else await expect(harness.call(), name).rejects.toBeDefined();
    expect(harness.counts().hostCalls, name).toBe(allowed ? 1 : 0);
    harness.dispose();
  }
});

test('serving binding options are deep-cloned and payload accountRef/bindingOptions cannot override them', async () => {
  const current = snapshot();
  const serving = snapshot();
  let received: any;
  const harness = createHarness({ invoke: (_payload, context) => {
    received = context.binding.bindingOptions;
    context.binding.bindingOptions.nested.value = 'plugin-mutated';
    return context.binding.bindingOptions;
  } });
  harness.setSnapshots(current, serving);
  await expect(harness.call(harness.activeWorker, { accountRef: 'forged', bindingOptions: { accountRef: 'forged' } })).resolves.toEqual({ accountRef: 'serving', nested: { value: 'plugin-mutated' } });
  expect(received.accountRef).toBe('serving');
  expect(serving.aggregate.logical_configuration.services[0].endpoints[0].plugins[0].options.nested.value).toBe('serving');
  expect(current.aggregate.logical_configuration.services[0].endpoints[0].plugins[0].options.nested.value).toBe('serving');
  harness.dispose();
});

test('active admission A to B sync aborts A in-flight and makes B immediately usable', async () => {
  const a = worker(60), b = worker(61);
  let entered!: (context: any) => void;
  const enteredPromise = new Promise<any>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let firstInvocation = true;
  const harness = createHarness({ active: a, workers: [a, b], invoke: async (payload, context) => {
    entered(context);
    if (!firstInvocation) return payload;
    firstInvocation = false;
    await held;
    return 'late-A';
  } });
  const pendingA = harness.call(a);
  const context = await enteredPromise;
  harness.setRegistry({ active: admission(b), prepared: null, retired: [] });
  harness.bridge.syncActiveAdmission();
  expect(context.attempt.signal.aborted).toBe(true);
  await expect(pendingA).rejects.toBeDefined();
  release();
  await expect(harness.call(b)).resolves.toEqual({});
  expect(harness.counts().hostCalls).toBe(2);
  harness.dispose();
});

test('dispose aborts and rejects an in-flight request without delivering its result', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const harness = createHarness({ invoke: async () => { entered(); await held; return { secret: 'late' }; } });
  const pending = harness.call();
  await enteredPromise;
  harness.bridge.dispose();
  await expect(pending).rejects.toBeDefined();
  release();
});
