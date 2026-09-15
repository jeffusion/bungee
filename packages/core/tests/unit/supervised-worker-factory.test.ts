import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  hashSupervisionBody,
  signSupervisionMessage,
  signWorkerDescriptor,
  type WorkerDescriptorBody,
} from '../../src/supervision';
import { STRIPPED_ROOT_ENV_NAMES, SupervisedConfigWorkerFactory, SupervisedConfigWorkerFactoryError } from '../../src/master-runtime/supervised-worker-factory';
import type { AdmissionRegistryStatus, AdmissionSet } from '../../src/ingress';
import type { ConfigProcessIdentity } from '../../src/config-publication';
import type { SupervisedWorkerRateLimitSession } from '../../src/config-worker/process-environment';

const ROOT = new Uint8Array(32).fill(9);
const AUTHORITY = { controller_epoch: 4, controller_id: '80000000-0000-4000-8000-000000000001' } as const;
const GENERATION = '10000000-0000-4000-8000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG = `sha256:${'b'.repeat(64)}` as const;

type OnlineWorker = ReturnType<typeof onlineWorker>;

function onlineWorker(workerInstanceId: string, bootNonce: string, controlPort: number, privatePort: number) {
  const identity = { master_generation: GENERATION, worker_instance_id: workerInstanceId, worker_slot: 0 };
  const credential = deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(ROOT, GENERATION, workerInstanceId, 0), bootNonce);
  const ready = {
    status: 'config-ready' as const, ...identity, boot_nonce: bootNonce, pid: process.pid, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG, private_port: privatePort, plugin_runtime_generation: 1,
    required_plugins: [], serving_plugins: [], publication: null,
  };
  const body: WorkerDescriptorBody = {
    schema: 'bungee-worker-descriptor-v1', role: 'worker', ...identity, boot_nonce: bootNonce, pid: process.pid,
    control_port: controlPort, phase: 'serving', frozen: false, private_port: privatePort, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG, started_at: 1, evidence: { kind: 'ready', message: ready },
  };
  let responseSequence = 0;
  let shutdowns = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const request = JSON.parse(String(init?.body ?? '{}')) as { message?: { request_id: string; path?: string } };
    const message = request.message ?? request as unknown as { request_id: string; path?: string };
    if (path === '/__supervision/challenge') {
      return Response.json({ message: signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'challenge', direction: 'process-to-controller',
        ...credential.identity, ...AUTHORITY, sequence: 1, request_id: message.request_id, challenge_nonce: 'c'.repeat(64), expires_at: Date.now() + 10_000 }, credential) });
    }
    if (path === '/__supervision/command' && message.path === '/shutdown') shutdowns += 1;
    const requestId = message.request_id;
    const replay = { sequence: ++responseSequence, request_id: requestId };
    const withoutHash = {
      schema: 'bungee-worker-status-v1' as const, role: 'worker' as const, ...identity, boot_nonce: bootNonce,
      pid: process.pid, control_port: controlPort, phase: 'serving' as const, frozen: false, private_port: privatePort,
      revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG, started_at: 1, authority: AUTHORITY,
      request_correlation: requestId, replay, evidence: { kind: 'ready' as const, message: ready },
    };
    const body = { ...withoutHash, snapshot_hash: hashSupervisionBody(withoutHash) };
    const status = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
      ...credential.identity, ...AUTHORITY, sequence: replay.sequence, request_id: requestId, status: 'serving', body_hash: hashSupervisionBody(body) }, credential);
    return Response.json({ message: status, body });
  };
  return { identity, credential, descriptor: signWorkerDescriptor(body, credential.process_key), fetch, get shutdowns() { return shutdowns; } };
}

function admission(worker: OnlineWorker): AdmissionSet {
  return {
    master_generation: GENERATION, admission_sequence: 1, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker.identity, boot_nonce: worker.descriptor.boot_nonce, private_port: worker.descriptor.private_port! }],
  };
}

function factory(directory: string, workers: readonly OnlineWorker[], confirmOrphan?: () => Promise<AdmissionRegistryStatus>) {
  const byPort = new Map(workers.map((worker) => [worker.descriptor.control_port, worker]));
  return new SupervisedConfigWorkerFactory({
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, managementHost: '127.0.0.1', managementPort: 8089,
    accessLogDbPath: join(directory, 'access.db'),
    transportSecret: 'secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25, confirmOrphan,
    client: { fetch: (async (input, init) => {
      const target = byPort.get(Number(new URL(String(input)).port));
      if (target === undefined) throw new Error(`missing test worker ${String(input)}`);
      return target.fetch(input, init);
    }) as typeof globalThis.fetch },
  });
}

function spawnedEnvironment(
  directory: string,
  env: NodeJS.ProcessEnv,
  rateLimitSession?: SupervisedWorkerRateLimitSession,
): NodeJS.ProcessEnv {
  let spawned: NodeJS.ProcessEnv | undefined;
  const child = {
    pid: 12_345,
    unref: () => undefined,
    kill: () => true,
    once() { return this; },
  } as unknown as ChildProcess;
  const workerFactory = new SupervisedConfigWorkerFactory({
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, managementHost: '127.0.0.1', managementPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25,
    env, rateLimitSession,
    spawn: (_executable, _args, options) => {
      spawned = options.env;
      return child;
    },
  });
  try {
    workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000010', worker_slot: 0 });
    if (spawned === undefined) throw new Error('test worker was not spawned');
    return spawned;
  } finally { workerFactory.disconnect(); }
}

async function writeWorkers(directory: string, workers: readonly OnlineWorker[]): Promise<void> {
  for (const worker of workers) await writeFile(join(directory, `${worker.identity.worker_instance_id}.json`), JSON.stringify(worker.descriptor));
}

function cleanupProcess(worker: OnlineWorker, origin: 'spawned' | 'adopted', emitOnForce = false) {
  const calls: string[] = [];
  let disconnects = 0;
  let exits = new Set<(evidence: { readonly exited: true; readonly pid: number }) => void>();
  const process = {
    identity: worker.identity,
    slot: worker.identity.worker_slot,
    bootNonce: worker.descriptor.boot_nonce,
    origin,
    pid: worker.descriptor.pid,
    supervisionCredential: worker.credential as typeof worker.credential | null,
    cachedStatus: {
      ...worker.identity, boot_nonce: worker.descriptor.boot_nonce, private_port: worker.descriptor.private_port,
      revision: worker.descriptor.revision, content_hash: worker.descriptor.content_hash,
      plugin_catalog_hash: worker.descriptor.plugin_catalog_hash,
    },
    terminate: async (mode: 'graceful' | 'force') => {
      calls.push(mode);
      if (mode === 'force' && emitOnForce) {
        const evidence = { exited: true as const, pid: worker.descriptor.pid };
        setTimeout(() => { for (const listener of exits) listener(evidence); }, 0);
      }
    },
    subscribeExit: (listener: (evidence: { readonly exited: true; readonly pid: number }) => void) => {
      exits.add(listener);
      return () => { exits.delete(listener); };
    },
    disconnect: () => { disconnects += 1; },
    set emitOnForce(value: boolean) { emitOnForce = value; },
    get calls() { return calls; },
    get disconnects() { return disconnects; },
  };
  return process;
}

function putOwned(workerFactory: SupervisedConfigWorkerFactory, process: object): void {
  const internal = workerFactory as unknown as { owned: Map<object, { process: object }> };
  internal.owned.set(process, { process });
}

test('does not inherit rate-limit ingress environment from the master', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-rate-env-'));
  try {
    const onlyPort = spawnedEnvironment(directory, { BUNGEE_INGRESS_SUPERVISION_PORT: '3010' });
    expect(onlyPort.BUNGEE_INGRESS_SUPERVISION_PORT).toBeUndefined();
    const forged = spawnedEnvironment(directory, {
      BUNGEE_INGRESS_SUPERVISION_PORT: '3010',
      BUNGEE_INGRESS_PROCESS_INSTANCE_ID: '70000000-0000-4000-8000-000000000001',
      BUNGEE_INGRESS_BOOT_NONCE: '70000000-0000-4000-8000-000000000002',
    });
    expect(forged.BUNGEE_INGRESS_SUPERVISION_PORT).toBeUndefined();
    expect(forged.BUNGEE_INGRESS_PROCESS_INSTANCE_ID).toBeUndefined();
    expect(forged.BUNGEE_INGRESS_BOOT_NONCE).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('worker script and compiled launches retain their shape and carry exact non-secret replacement markers', () => {
  const workerInstanceIds = [
    '40000000-0000-4000-8000-000000000010',
    '40000000-0000-4000-8000-000000000011',
  ] as const;
  for (const source of ['source', 'compiled'] as const) {
    const captured: string[][] = [];
    const child = { pid: 12_346, unref: () => undefined, kill: () => true, once() { return this; } } as unknown as ChildProcess;
    const directory = `/tmp/bungee-worker-marker-${source}`;
    const workerFactory = new SupervisedConfigWorkerFactory({
      launch: { source, executable: process.execPath, args: source === 'source' ? ['/tmp/worker.ts'] : [] }, rootKey: ROOT,
      runtimeWorkersDirectory: directory, authority: AUTHORITY, managementHost: '127.0.0.1', managementPort: 8089,
      accessLogDbPath: join(directory, 'access.db'), transportSecret: 'worker-supervision-secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25,
      env: { BUNGEE_DAEMON_SHUTDOWN_SECRET: 'worker-shutdown-secret' },
      spawn: (_executable, args) => { captured.push([...args]); return child; },
    });
    try {
      for (const [workerSlot, worker_instance_id] of workerInstanceIds.entries()) {
        workerFactory.spawn({ master_generation: GENERATION, worker_instance_id, worker_slot: workerSlot });
      }
      expect(captured).toEqual(workerInstanceIds.map((worker_instance_id) => [
        ...(source === 'source' ? ['/tmp/worker.ts'] : []),
        `--bungee-process-identity=${worker_instance_id}`,
      ]));
      expect(captured.map((args) => args.filter((arg) => arg.startsWith('--bungee-process-identity=')))).toEqual([
        ['--bungee-process-identity=40000000-0000-4000-8000-000000000010'],
        ['--bungee-process-identity=40000000-0000-4000-8000-000000000011'],
      ]);
      expect(captured[0]?.at(-1)).not.toBe(captured[1]?.at(-1));
      const argv = captured.flat().join(' ');
      expect(argv).not.toContain('worker-shutdown-secret');
      expect(argv).not.toContain('worker-supervision-secret');
    } finally { workerFactory.disconnect(); }
  }
});

test('strips bootstrap secrets case-insensitively from worker children', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-bootstrap-env-'));
  try {
    const spawned = spawnedEnvironment(directory, {
      bUnGeE_dAeMoN_mEtAdAtA_pAtH: '/tmp/metadata',
      BUNGEE_DAEMON_BOOT_NONCE: 'boot',
      bungee_daemon_shutdown_secret: 'secret',
    });
    expect(Object.keys(spawned).some((name) => name.toLowerCase().includes('daemon_'))).toBeFalse();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('strips every listed root-only environment name regardless of casing and keeps business environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-root-env-'));
  const mixedCase = (name: string): string => name.split('').map((char, index) => /[a-z]/i.test(char)
    ? index % 2 === 0 ? char.toUpperCase() : char.toLowerCase() : char).join('');
  try {
    const env = Object.fromEntries([
      ...STRIPPED_ROOT_ENV_NAMES.map((name) => [mixedCase(name), 'must-not-cross']),
      ['BUNGEE_TEST_BUSINESS_ENV', 'keep-me'],
    ]);
    const spawned = spawnedEnvironment(directory, env);
    expect(spawned.BUNGEE_TEST_BUSINESS_ENV).toBe('keep-me');
    const stripped = new Set(STRIPPED_ROOT_ENV_NAMES.map((name) => name.toLowerCase()));
    expect(Object.keys(spawned).some((name) => stripped.has(name.toLowerCase()))).toBeFalse();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('injects only an explicit complete rate-limit ingress session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-rate-session-'));
  const session = {
    supervisionPort: 3011,
    expectedIngress: {
      process_instance_id: '70000000-0000-4000-8000-000000000003',
      boot_nonce: '70000000-0000-4000-8000-000000000004',
    },
  } as const;
  try {
    const spawned = spawnedEnvironment(directory, {
      BUNGEE_INGRESS_SUPERVISION_PORT: '3010',
      BUNGEE_INGRESS_PROCESS_INSTANCE_ID: '70000000-0000-4000-8000-000000000001',
      BUNGEE_INGRESS_BOOT_NONCE: '70000000-0000-4000-8000-000000000002',
    }, session);
    expect(spawned.BUNGEE_INGRESS_SUPERVISION_PORT).toBe('3011');
    expect(spawned.BUNGEE_INGRESS_PROCESS_INSTANCE_ID).toBe(session.expectedIngress.process_instance_id);
    expect(spawned.BUNGEE_INGRESS_BOOT_NONCE).toBe(session.expectedIngress.boot_nonce);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('updates the rate-limit session for future spawns without changing an existing worker environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-rate-session-update-'));
  const environments: NodeJS.ProcessEnv[] = [];
  const child = {
    pid: 12_345,
    unref: () => undefined,
    kill: () => true,
    once() { return this; },
  } as unknown as ChildProcess;
  const first = {
    supervisionPort: 3011,
    expectedIngress: {
      process_instance_id: '70000000-0000-4000-8000-000000000003',
      boot_nonce: '70000000-0000-4000-8000-000000000004',
    },
  } as const;
  const second = {
    supervisionPort: 3012,
    expectedIngress: {
      process_instance_id: '70000000-0000-4000-8000-000000000005',
      boot_nonce: '70000000-0000-4000-8000-000000000006',
    },
  } as const;
  const workerFactory = new SupervisedConfigWorkerFactory({
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, managementHost: '127.0.0.1', managementPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25,
    rateLimitSession: first,
    spawn: (_executable, _args, options) => {
      environments.push(options.env!);
      return child;
    },
  });
  try {
    workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000011', worker_slot: 0 });
    workerFactory.setRateLimitSession(second);
    workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000012', worker_slot: 1 });
    expect(environments[0]?.BUNGEE_INGRESS_SUPERVISION_PORT).toBe('3011');
    expect(environments[0]?.BUNGEE_INGRESS_BOOT_NONCE).toBe(first.expectedIngress.boot_nonce);
    expect(environments[1]?.BUNGEE_INGRESS_SUPERVISION_PORT).toBe('3012');
    expect(environments[1]?.BUNGEE_INGRESS_BOOT_NONCE).toBe(second.expectedIngress.boot_nonce);
  } finally {
    workerFactory.disconnectAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects incomplete rate-limit ingress sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-rate-invalid-'));
  try {
    expect(() => spawnedEnvironment(directory, {}, {
      supervisionPort: 65_536,
      expectedIngress: { process_instance_id: '70000000-0000-4000-8000-000000000003', boot_nonce: '70000000-0000-4000-8000-000000000004' },
    })).toThrow('rate-limit ingress port');
    expect(() => spawnedEnvironment(directory, {}, { supervisionPort: 3010 } as SupervisedWorkerRateLimitSession))
      .toThrow('rate-limit ingress identity');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('orphan cleanup inventories overlapping slot workers and shuts down only the fresh-unprotected B', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-orphans-'));
  const a = onlineWorker('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 43201, 44201);
  const b = onlineWorker('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 43202, 44202);
  const activeA = admission(a);
  const registry = (): AdmissionRegistryStatus => ({ active: activeA, prepared: null, retired: [] });
  const workers = [a, b];
  await writeWorkers(directory, workers);
  const workerFactory = factory(directory, workers, async () => registry());
  try {
    const result = await workerFactory.cleanupAuthenticatedOrphans(registry());
    expect(result.exitUnknown).toEqual([b.identity]);
    expect(result.cleaned).toEqual([]);
    expect(a.shutdowns).toBe(0);
    expect(b.shutdowns).toBe(1);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('prepared and retired identities are protected, while tampered descriptors never receive shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-protected-'));
  const a = onlineWorker('40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', 43203, 44203);
  const b = onlineWorker('40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000004', 43204, 44204);
  const c = onlineWorker('40000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000005', 43205, 44205);
  const d = onlineWorker('40000000-0000-4000-8000-000000000006', '50000000-0000-4000-8000-000000000006', 43206, 44206);
  const e = onlineWorker('40000000-0000-4000-8000-000000000007', '50000000-0000-4000-8000-000000000007', 43207, 44207);
  e.fetch = async () => { throw new Error('worker unreachable'); };
  await writeWorkers(directory, [a, b, c, d, e]);
  const tamperedPath = join(directory, `${d.identity.worker_instance_id}.json`);
  await writeFile(tamperedPath, JSON.stringify({ ...d.descriptor, pid: d.descriptor.pid + 1 }));
  const status: AdmissionRegistryStatus = { active: admission(a), prepared: admission(b), retired: [admission(c)] };
  const workerFactory = factory(directory, [a, b, c, d, e], async () => status);
  try {
    const result = await workerFactory.cleanupAuthenticatedOrphans(status);
    expect(result.exitUnknown).toEqual([]);
    expect(a.shutdowns + b.shutdowns + c.shutdowns + d.shutdowns).toBe(0);
    expect(result.issues.some((issue) => issue.kind === 'tampered')).toBe(true);
    expect(result.issues.some((issue) => issue.kind === 'unreachable')).toBe(true);
    expect(e.shutdowns).toBe(0);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('ingress boot cleanup retains adopted workers when no OS exit proof exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-ingress-boot-adopted-'));
  const adopted = onlineWorker('40000000-0000-4000-8000-000000000013', '50000000-0000-4000-8000-000000000013', 43213, 44213);
  const current = onlineWorker('40000000-0000-4000-8000-000000000014', '50000000-0000-4000-8000-000000000014', 43214, 44214);
  const registry: AdmissionRegistryStatus = { active: admission(current), prepared: null, retired: [] };
  await writeWorkers(directory, [adopted]);
  const workerFactory = factory(directory, [adopted]);
  try {
    const result = await workerFactory.discoverAndAdopt(admission(adopted));
    expect(result.kind).toBe('adopted');
    const cleanup = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(cleanup.exited).toEqual([]);
    expect(cleanup.adoptedExitUnknown).toEqual([adopted.identity]);
    expect(cleanup.kind).toBe('cleanup_debt');
    expect(adopted.shutdowns).toBe(1);
    expect(workerFactory.snapshot()).toHaveLength(1);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('ingress boot cleanup protects active, prepared, and retired exact workers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-ingress-protected-'));
  const active = onlineWorker('40000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000021', 43221, 44221);
  const prepared = onlineWorker('40000000-0000-4000-8000-000000000022', '50000000-0000-4000-8000-000000000022', 43222, 44222);
  const retired = onlineWorker('40000000-0000-4000-8000-000000000023', '50000000-0000-4000-8000-000000000023', 43223, 44223);
  const registry: AdmissionRegistryStatus = { active: admission(active), prepared: admission(prepared), retired: [admission(retired)] };
  const workerFactory = factory(directory, []);
  const processes = [cleanupProcess(active, 'spawned'), cleanupProcess(prepared, 'spawned'), cleanupProcess(retired, 'adopted')];
  for (const process of processes) putOwned(workerFactory, process);
  try {
    const result = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(result.kind).toBe('cleaned');
    expect(processes.map((process) => process.calls)).toEqual([[], [], []]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('ingress boot cleanup stops if the registry changes between graceful and force', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-ingress-fence-'));
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000024', '50000000-0000-4000-8000-000000000024', 43224, 44224);
  const candidate = onlineWorker('40000000-0000-4000-8000-000000000025', '50000000-0000-4000-8000-000000000025', 43225, 44225);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  const changed: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: admission(candidate), retired: [] };
  const workerFactory = factory(directory, []);
  const process = cleanupProcess(candidate, 'spawned');
  putOwned(workerFactory, process);
  let reads = 0;
  try {
    const result = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => ++reads === 1 ? registry : changed });
    expect(result).toMatchObject({ kind: 'retryable', code: 'registry_changed', spawnedExitUnconfirmed: [candidate.identity] });
    expect(process.calls).toEqual(['graceful']);
    expect(workerFactory.owns(process as never)).toBe(true);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('ingress boot cleanup retains spawned ownership after timeout and retries to confirmed exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-ingress-retry-'));
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000026', '50000000-0000-4000-8000-000000000026', 43226, 44226);
  const candidate = onlineWorker('40000000-0000-4000-8000-000000000027', '50000000-0000-4000-8000-000000000027', 43227, 44227);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  const workerFactory = factory(directory, []);
  const process = cleanupProcess(candidate, 'spawned');
  putOwned(workerFactory, process);
  try {
    const first = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(first).toMatchObject({ kind: 'retryable', code: 'spawned_exit_unconfirmed', spawnedExitUnconfirmed: [candidate.identity] });
    expect(workerFactory.owns(process as never)).toBe(true);
    process.emitOnForce = true;
    const second = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(second.kind).toBe('cleaned');
    expect(process.calls).toEqual(['graceful', 'force', 'graceful', 'force']);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('ingress boot cleanup keeps adopted control connected after authenticated shutdown without exit proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-ingress-adopted-retry-'));
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000028', '50000000-0000-4000-8000-000000000028', 43228, 44228);
  const candidate = onlineWorker('40000000-0000-4000-8000-000000000029', '50000000-0000-4000-8000-000000000029', 43229, 44229);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  const workerFactory = factory(directory, []);
  const process = cleanupProcess(candidate, 'adopted');
  putOwned(workerFactory, process);
  try {
    const first = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    const second = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(first).toMatchObject({ kind: 'cleanup_debt', adoptedExitUnknown: [candidate.identity] });
    expect(second.kind).toBe('cleanup_debt');
    expect(process.calls).toEqual(['graceful', 'graceful']);
    expect(process.disconnects).toBe(0);
    expect(workerFactory.owns(process as never)).toBe(true);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('ingress boot cleanup fails closed for missing worker credentials or registry freshness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-ingress-fail-closed-'));
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000030', '50000000-0000-4000-8000-000000000030', 43230, 44230);
  const candidate = onlineWorker('40000000-0000-4000-8000-000000000031', '50000000-0000-4000-8000-000000000031', 43231, 44231);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  const workerFactory = factory(directory, []);
  const process = cleanupProcess(candidate, 'spawned');
  putOwned(workerFactory, process);
  try {
    process.supervisionCredential = null;
    const missingCredential = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(missingCredential).toMatchObject({ kind: 'retryable', code: 'worker_facts_unavailable' });
    expect(process.calls).toEqual([]);
    process.supervisionCredential = candidate.credential;
    const staleFreshness = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => { throw new Error('unavailable'); } });
    expect(staleFreshness).toMatchObject({ kind: 'retryable', code: 'registry_unavailable' });
    expect(process.calls).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('force cleanup waits a second bounded interval and retains ownership without exit proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exit-'));
  const workerFactory = factory(directory, []);
  const identity: ConfigProcessIdentity = { master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000006', worker_slot: 0 };
  const calls: string[] = [];
  const process = {
    identity, bootNonce: '50000000-0000-4000-8000-000000000006', origin: 'spawned' as const, pid: 12345,
    terminate: async (mode: 'graceful' | 'force') => { calls.push(mode); },
    subscribeExit: () => () => {}, disconnect: () => {},
  };
  const internal = workerFactory as unknown as { owned: Map<unknown, { process: unknown }> };
  internal.owned.set(process, { process });
  try {
    await expect(workerFactory.discardConfirmedUncommitted({
      master_generation: GENERATION, admission_sequence: 1, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
      workers: [{ ...identity, boot_nonce: process.bootNonce, private_port: 44206 }],
    })).rejects.toBeInstanceOf(SupervisedConfigWorkerFactoryError);
    expect(calls).toEqual(['graceful', 'force']);
    expect(workerFactory.owns(process as never)).toBe(true);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('shutdown escalation uses the shutdown timeout for both graceful and force waits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-shutdown-'));
  const workerFactory = factory(directory, []);
  const identity: ConfigProcessIdentity = {
    master_generation: GENERATION,
    worker_instance_id: '40000000-0000-4000-8000-000000000007',
    worker_slot: 0,
  };
  const calls: string[] = [];
  const process = {
    identity, bootNonce: '50000000-0000-4000-8000-000000000007', origin: 'spawned' as const, pid: 12346,
    terminate: async (mode: 'graceful' | 'force') => { calls.push(mode); },
    subscribeExit: () => () => {}, disconnect: () => {},
  };
  const internal = workerFactory as unknown as { owned: Map<unknown, { process: unknown }> };
  internal.owned.set(process, { process });
  const started = performance.now();
  try {
    await workerFactory.shutdownOwned();
    expect(calls).toEqual(['graceful', 'force']);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});
