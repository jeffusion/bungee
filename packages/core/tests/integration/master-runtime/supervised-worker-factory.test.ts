import { ConfigRepository } from '../../../src/config-storage';
import { configurationRepositoryFixture } from '../../helpers/config-repository';
import { armProcessLifetimeGuard } from '../../../src/supervision/process-lifetime-guard';
import { randomUUID } from 'node:crypto';
import { kernelMonotonicNowNs } from '../../../src/master-runtime/kernel-monotonic-clock';
import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PUBLICATION_POLICY } from '@jeffusion/bungee-types';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  hashSupervisionBody,
  parseWorkerDescriptor,
  signSupervisionMessage,
  signWorkerDescriptor,
  type WorkerDescriptorBody,
} from '../../../src/supervision';
import { STRIPPED_ROOT_ENV_NAMES, SupervisedConfigWorkerFactory, SupervisedConfigWorkerFactoryError, type WorkerLaunchRepository } from '../../../src/master-runtime/supervised-worker-factory';
import type { ProcessIdentityControl } from '../../../src/master-runtime/supervised-worker-process-adapter';
import { ProcessIdentityUnavailableError, type CapturedProcessIdentity, type ProcessIdentityProbe } from '../../../src/master-runtime/process-identity';
import type { AdmissionRegistryStatus, AdmissionSet } from '../../../src/ingress';
import type { ConfigProcessIdentity, ServingConfigWorker } from '../../../src/config-publication';
import type { SupervisedWorkerRateLimitSession } from '../../../src/config-worker/process-environment';

// Simulated processes must not start native OS probes, including kernel boot queries.
const TEST_KERNEL_BOOT_ID = 'linux:11111111-1111-4111-8111-111111111111';
const ROOT = new Uint8Array(32).fill(9);
const AUTHORITY = { controller_epoch: 4, controller_id: '80000000-0000-4000-8000-000000000001' } as const;
const GENERATION = '10000000-0000-4000-8000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG = `sha256:${'b'.repeat(64)}` as const;

async function triggerExitAndWaitForFactory(
  workerFactory: SupervisedConfigWorkerFactory,
  process: Awaited<ReturnType<SupervisedConfigWorkerFactory['spawn']>>,
  trigger: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolveNotification!: (notified: boolean) => void;
  const notification = new Promise<boolean>((resolve) => { resolveNotification = resolve; });
  unsubscribe = workerFactory.subscribeExit((exitedProcess) => {
    if (exitedProcess === process) resolveNotification(true);
  });
  timer = setTimeout(() => resolveNotification(false), 2_000);
  try {
    trigger();
    if (!await notification) throw new Error(`Timed out waiting for factory exit notification for PID ${process.pid}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe?.();
  }
}

type OnlineWorker = ReturnType<typeof onlineWorker>;

function onlineWorker(workerInstanceId: string, bootNonce: string, controlPort: number, privatePort: number, workerSlot = 0) {
  const identity = { master_generation: GENERATION, worker_instance_id: workerInstanceId, worker_slot: workerSlot };
  const credential = deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(ROOT, GENERATION, workerInstanceId, workerSlot), bootNonce);
  const ready = {
    status: 'config-ready' as const, ...identity, boot_nonce: bootNonce, pid: process.pid, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG, private_port: privatePort, plugin_runtime_generation: 1,
    required_plugins: [], serving_plugins: [], publication: null,
  };
  const body: WorkerDescriptorBody = {
    schema: 'bungee-worker-descriptor-v1', role: 'worker', ...identity, boot_nonce: bootNonce, pid: process.pid,
    control_port: controlPort, master_control_port: 3011, phase: 'serving', frozen: false, private_port: privatePort, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG, started_at: 1, evidence: { kind: 'ready', message: ready },
  };
  let responseSequence = 0;
  let shutdowns = 0;
  let attaches = 0;
  let statusReads = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === '/__supervision/attach') attaches += 1;
    if (path === '/__supervision/status') statusReads += 1;
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
       pid: process.pid, control_port: controlPort, master_control_port: 3011, phase: 'serving' as const, frozen: false, private_port: privatePort,
      revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG, started_at: 1, authority: AUTHORITY,
      request_correlation: requestId, replay, evidence: { kind: 'ready' as const, message: ready },
    };
    const body = { ...withoutHash, snapshot_hash: hashSupervisionBody(withoutHash) };
    const status = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
      ...credential.identity, ...AUTHORITY, sequence: replay.sequence, request_id: requestId, status: 'serving', body_hash: hashSupervisionBody(body) }, credential);
    return Response.json({ message: status, body });
  };
  return { identity, credential, descriptor: signWorkerDescriptor(body, credential.process_key), fetch, get shutdowns() { return shutdowns; },
    get attaches() { return attaches; }, get statusReads() { return statusReads; } };
}

async function completedWorker(worker: OnlineWorker): Promise<OnlineWorker> {
  const expiredDeadline = (kernelMonotonicNowNs() - 1n).toString();
  const { descriptor_mac: _descriptorMac, ...existingBody } = worker.descriptor;
  const message = {
    status: 'worker-drained' as const, ...worker.identity, boot_nonce: worker.descriptor.boot_nonce,
    pid: worker.descriptor.pid, revision: worker.descriptor.revision!, content_hash: HASH,
    plugin_catalog_hash: CATALOG, drain_id: '94000000-0000-4000-8000-000000000001',
    policy: DEFAULT_PUBLICATION_POLICY, boot_id: TEST_KERNEL_BOOT_ID, exit_deadline_ns: expiredDeadline,
    exit_remaining_ms: 1, cleanup_state: 'success' as const, publication: null,
  };
  const body: WorkerDescriptorBody = { ...existingBody, phase: 'stopped', frozen: true,
    evidence: { kind: 'drained', message } };
  return { ...worker, descriptor: signWorkerDescriptor(body, worker.credential.process_key) };
}

function admission(worker: OnlineWorker): AdmissionSet {
  return {
    master_generation: GENERATION, websocket_max_connections: 512, websocket_max_message_bytes: 16 * 1024 * 1024, admission_sequence: 1, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker.identity, boot_nonce: worker.descriptor.boot_nonce, private_port: worker.descriptor.private_port! }],
  };
}

/** Fake exact-process control: unit tests never touch the real operating system. */
function fakeIdentityControl(probe: (expected: CapturedProcessIdentity) => ProcessIdentityProbe = () => 'exact') {
  const captures: Array<readonly [number, string]> = [];
  const probes: CapturedProcessIdentity[] = [];
  const control: ProcessIdentityControl = {
    capture: async (pid, processInstanceId) => {
      captures.push([pid, processInstanceId]);
      return { pid, startToken: '100', executable: '/usr/bin/bungee', processInstanceId };
    },
    probe: async (expected) => {
      probes.push(expected);
      return probe(expected);
    },
  };
  return { control, captures, probes };
}

function factory(
  directory: string,
  workers: readonly OnlineWorker[],
  confirmOrphan?: () => Promise<AdmissionRegistryStatus>,
  identity: ProcessIdentityControl = fakeIdentityControl().control,
  kernelBootId: () => Promise<string> = async () => TEST_KERNEL_BOOT_ID,
  retirementRepository?: import('../../../src/master-runtime/supervised-worker-factory').SupervisedConfigWorkerFactoryOptions['retirementRepository'],
  launchRepository?: import('../../../src/master-runtime/supervised-worker-factory').WorkerLaunchRepository,
) {
  const byPort = new Map(workers.map((worker) => [worker.descriptor.control_port, worker]));
  return new SupervisedConfigWorkerFactory({
    kernelBootId, retirementRepository, launchRepository,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 3011,
    accessLogDbPath: join(directory, 'access.db'),
    transportSecret: 'secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25, confirmOrphan,
    processIdentity: identity,
    client: { fetch: (async (input, init) => {
      const target = byPort.get(Number(new URL(String(input)).port));
      if (target === undefined) throw new Error(`missing test worker ${String(input)}`);
      return target.fetch(input, init);
    }) as typeof globalThis.fetch },
  });
}

function launchRepositoryFixture(repository: ConfigRepository): WorkerLaunchRepository {
  return configurationRepositoryFixture(repository) as unknown as WorkerLaunchRepository;
}

async function spawnedEnvironment(
  directory: string,
  env: NodeJS.ProcessEnv,
  rateLimitSession?: SupervisedWorkerRateLimitSession,
): Promise<NodeJS.ProcessEnv> {
  let spawned: NodeJS.ProcessEnv | undefined;
  const child = {
    pid: 12_345,
    unref: () => undefined,
    kill: () => true,
    once() { return this; },
  } as unknown as ChildProcess;
  const workerFactory = new SupervisedConfigWorkerFactory({
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25,
    env, rateLimitSession, processIdentity: fakeIdentityControl().control,
    spawn: (_executable, _args, options) => {
      spawned = options.env;
      return child;
    },
  });
  try {
    await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000010', worker_slot: 0 });
    if (spawned === undefined) throw new Error('test worker was not spawned');
    return spawned;
  } finally { workerFactory.disconnect(); }
}

async function writeWorkers(directory: string, workers: readonly OnlineWorker[]): Promise<void> {
  for (const worker of workers) await writeFile(join(directory, `${worker.identity.worker_instance_id}.json`), JSON.stringify(worker.descriptor));
}

test('recovery uses durable members, separates exit/cleanup and ignores unrelated history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-recovery-exit-'));
  const old = await completedWorker(onlineWorker('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 40101, 41101));
  const next = onlineWorker('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 40102, 41102);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: old.identity.worker_instance_id });
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const committed = repository.commit({ mutation_id: 'retirement-authority', expected_revision: 1,
    aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
    kind: 'config', created_at: 1, target_worker_slots: [] });
  expect(committed.kind).toBe('committed');
  expect(repository.claimPublicationTarget(CATALOG, 2)?.operation.mutation_id).toBe('retirement-authority');
  const terminal = old.descriptor.evidence.message as import('../../../src/config-publication').WorkerDrainedMessage;
  repository.freezePublicationRetirement('retirement-authority', 0, [{ identity: old.identity,
    boot_nonce: old.descriptor.boot_nonce, pid: old.descriptor.pid, private_port: old.descriptor.private_port!, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG, publication: null, guard: guard.facts,
    drain_id: terminal.drain_id, deadline_boot_id: TEST_KERNEL_BOOT_ID, start_deadline_ns: '123456789' }], 1);
  const workers = factory(directory, [old, next], undefined, fakeIdentityControl(() => 'mismatch').control,
    async () => TEST_KERNEL_BOOT_ID, configurationRepositoryFixture(repository));
  const registry = { active: admission(next), prepared: null, retired: [admission(old)] };
  const replacements = [{ process: { identity: next.identity, pid: old.descriptor.pid }, boot_nonce: next.descriptor.boot_nonce,
    publication: { mutation_id: 'retirement-authority', attempt_no: 1, drain_recovery_generation: 0 } }] as unknown as readonly ServingConfigWorker[];
  const { descriptor_mac: _mac, ...body } = old.descriptor;
  const signed = signWorkerDescriptor({ ...body, lifetime_guard: { ...guard.facts, held: true },
    evidence: { kind: 'drained', message: { ...terminal, cleanup_state: 'failed' } } }, old.credential.process_key);
  const path = join(directory, `${old.identity.worker_instance_id}.json`);
  try {
    await writeFile(path, JSON.stringify(signed));
    await writeFile(join(directory, 'unrelated-history.json'), '{broken');
    // A colliding/reused raw PID cannot override the live native guard.
    expect(await workers.confirmPreviousWorkersExited(registry, replacements)).toBe(false);
    await writeFile(path, JSON.stringify({ ...signed, pid: 999 }));
    expect(await workers.confirmPreviousWorkersExited(registry, replacements)).toBe(false);
    await rm(path);
    expect(await workers.confirmPreviousWorkersExited(registry, replacements)).toBe(false);
    await writeFile(path, JSON.stringify(signed));
    guard.closeAfterChildExit();
    expect(await workers.confirmPreviousWorkersExited(registry, replacements)).toBe(true);
    expect(repository.getPublicationRetirement('retirement-authority')?.evidence[0]).toMatchObject({ exit_state: 'confirmed', cleanup_state: 'failed' });
    await rm(path);
    // The durable confirmed fence survives descriptor removal and reopen.
    expect(await workers.confirmPreviousWorkersExited(registry, replacements)).toBe(true);
    expect(repository.getRetiredWorkerInstanceIds()).toContain(old.identity.worker_instance_id);
    expect(old.shutdowns).toBe(0);
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reclaims an expired completed terminal descriptor only after the signed registry no longer protects it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-reclaim-terminal-'));
  const completed = await completedWorker(onlineWorker('40000000-0000-4000-8000-000000000045',
    '50000000-0000-4000-8000-000000000045', 43245, 44245));
  const identity: ProcessIdentityControl = { ...fakeIdentityControl().control, probeInstance: async () => 'dead' };
  const workerFactory = factory(directory, [completed], undefined, identity);
  const path = join(directory, `${completed.identity.worker_instance_id}.json`);
  try {
    await writeWorkers(directory, [completed]);
    const protectedCleanup = await workerFactory.cleanupAuthenticatedOrphans({ active: null, prepared: null,
      retired: [admission(completed)] });
    expect(protectedCleanup.cleaned).toEqual([]);
    expect(await workerFactory.confirmPreviousWorkersExited({ active: null, prepared: null,
      retired: [admission(completed)] }, [])).toBe(false);

    const releasedCleanup = await workerFactory.cleanupAuthenticatedOrphans({ active: null, prepared: null, retired: [] });
    expect(releasedCleanup.cleaned).toContainEqual(completed.identity);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

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

function spySpawnChild(pid: number) {
  const kills: string[] = [];
  const listeners = new Map<string, () => void>();
  const child = {
    pid,
    unref: () => undefined,
    kill: (signal?: string) => { kills.push(signal ?? 'default'); return true; },
    once: (event: string, listener: () => void) => { listeners.set(event, listener); return child; },
  } as unknown as ChildProcess;
  return { child, kills, emitExit: () => listeners.get('exit')?.() };
}

function putOwned(workerFactory: SupervisedConfigWorkerFactory, process: object): void {
  const internal = workerFactory as unknown as { owned: Map<object, { process: object }> };
  internal.owned.set(process, { process });
}

test('does not inherit rate-limit ingress environment from the master', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-rate-env-'));
  try {
    const onlyPort = await spawnedEnvironment(directory, { BUNGEE_INGRESS_SUPERVISION_PORT: '3010' });
    expect(onlyPort.BUNGEE_INGRESS_SUPERVISION_PORT).toBeUndefined();
    const forged = await spawnedEnvironment(directory, {
      BUNGEE_INGRESS_SUPERVISION_PORT: '3010',
      BUNGEE_INGRESS_PROCESS_INSTANCE_ID: '70000000-0000-4000-8000-000000000001',
      BUNGEE_INGRESS_BOOT_NONCE: '70000000-0000-4000-8000-000000000002',
    });
    expect(forged.BUNGEE_INGRESS_SUPERVISION_PORT).toBeUndefined();
    expect(forged.BUNGEE_INGRESS_PROCESS_INSTANCE_ID).toBeUndefined();
    expect(forged.BUNGEE_INGRESS_BOOT_NONCE).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('worker script and compiled launches retain their shape and carry exact non-secret replacement markers', async () => {
  const workerInstanceIds = [
    '40000000-0000-4000-8000-000000000010',
    '40000000-0000-4000-8000-000000000011',
  ] as const;
  for (const source of ['source', 'compiled'] as const) {
    const captured: string[][] = [];
    const child = { pid: 12_346, unref: () => undefined, kill: () => true, once() { return this; } } as unknown as ChildProcess;
    const directory = `/tmp/bungee-worker-marker-${source}`;
    const workerFactory = new SupervisedConfigWorkerFactory({
      kernelBootId: async () => TEST_KERNEL_BOOT_ID,
      launch: { source, executable: process.execPath, args: source === 'source' ? ['/tmp/worker.ts'] : [] }, rootKey: ROOT,
      runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
      accessLogDbPath: join(directory, 'access.db'), transportSecret: 'worker-supervision-secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25,
      env: { BUNGEE_DAEMON_SHUTDOWN_SECRET: 'worker-shutdown-secret' },
      processIdentity: fakeIdentityControl().control,
      spawn: (_executable, args) => { captured.push([...args]); return child; },
    });
    try {
      for (const [workerSlot, worker_instance_id] of workerInstanceIds.entries()) {
        await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id, worker_slot: workerSlot });
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
    const spawned = await spawnedEnvironment(directory, {
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
    const spawned = await spawnedEnvironment(directory, env);
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
    const spawned = await spawnedEnvironment(directory, {
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
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25,
    rateLimitSession: first, processIdentity: fakeIdentityControl().control,
    spawn: (_executable, _args, options) => {
      environments.push(options.env!);
      return child;
    },
  });
  try {
    await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000011', worker_slot: 0 });
    workerFactory.setRateLimitSession(second);
    await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000012', worker_slot: 1 });
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
    await expect(spawnedEnvironment(directory, {}, {
      supervisionPort: 65_536,
      expectedIngress: { process_instance_id: '70000000-0000-4000-8000-000000000003', boot_nonce: '70000000-0000-4000-8000-000000000004' },
    })).rejects.toThrow('rate-limit ingress port');
    await expect(spawnedEnvironment(directory, {}, { supervisionPort: 3010 } as SupervisedWorkerRateLimitSession))
      .rejects.toThrow('rate-limit ingress identity');
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
    expect((await workerFactory.discoverAndAdopt(activeA)).kind).toBe('adopted');
    expect(a.attaches).toBe(1);
    const result = await workerFactory.cleanupAuthenticatedOrphans(registry());
    expect(a.attaches).toBe(1);
    expect(a.statusReads).toBe(1);
    expect(b.attaches).toBe(1);
    expect(result.exitUnknown).toEqual([b.identity]);
    expect(result.cleaned).toEqual([]);
    expect(a.shutdowns).toBe(0);
    expect(b.shutdowns).toBe(1);
    // No exit proof: the unprotected adopted worker stays owned — nothing is forgotten.
    expect(workerFactory.snapshot()).toHaveLength(2);
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
      master_generation: GENERATION, websocket_max_connections: 512, websocket_max_message_bytes: 16 * 1024 * 1024, admission_sequence: 1, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
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
    // Force failed closed and no proof arrived: ownership is retained, not deleted.
    expect(workerFactory.owns(process as never)).toBe(true);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('adopted graceful shutdown with a dead probe yields exact OS exit proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-dead-'));
  const adopted = onlineWorker('40000000-0000-4000-8000-000000000042', '50000000-0000-4000-8000-000000000042', 43242, 44242);
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000043', '50000000-0000-4000-8000-000000000043', 43243, 44243);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  await writeWorkers(directory, [adopted]);
  const identity = fakeIdentityControl(() => 'dead');
  const workerFactory = factory(directory, [adopted], undefined, identity.control);
  try {
    const result = await workerFactory.discoverAndAdopt(admission(adopted));
    expect(result.kind).toBe('adopted');
    expect(identity.captures).toEqual([[adopted.descriptor.pid, adopted.identity.worker_instance_id]]);
    const cleanup = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(cleanup.kind).toBe('cleaned');
    expect(cleanup.exited).toEqual([adopted.identity]);
    expect(adopted.shutdowns).toBe(1);
    expect(workerFactory.snapshot()).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('ordinary shutdown of a committed worker without a drain task accepts exact OS exit without terminal evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-ordinary-shutdown-'));
  const worker = onlineWorker('40000000-0000-4000-8000-000000000044', '50000000-0000-4000-8000-000000000044', 43244, 44244);
  await writeWorkers(directory, [worker]);
  const identity = fakeIdentityControl(() => 'dead');
  const workerFactory = factory(directory, [worker], undefined, identity.control);
  try {
    const adopted = await workerFactory.discoverAndAdopt(admission(worker));
    expect(adopted.kind).toBe('adopted');
    if (adopted.kind !== 'adopted') throw new Error('worker adoption failed');
    expect(adopted.serving[0]?.boot_nonce).toBe(worker.descriptor.boot_nonce);
    workerFactory.markCommitted(adopted.workers);
    const exits = await workerFactory.shutdownOwned();
    expect(exits).toMatchObject([{ exited: true, pid: worker.descriptor.pid }]);
    expect(exits[0]?.terminalDrain).toBeUndefined();
    expect(workerFactory.snapshot()).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('pid replacement after adopted shutdown releases old ownership with zero OS signals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-replacement-'));
  const adopted = onlineWorker('40000000-0000-4000-8000-000000000044', '50000000-0000-4000-8000-000000000044', 43244, 44244);
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000045', '50000000-0000-4000-8000-000000000045', 43245, 44245);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  await writeWorkers(directory, [adopted]);
  const identity = fakeIdentityControl(() => 'mismatch');
  const workerFactory = factory(directory, [adopted], undefined, identity.control);
  try {
    await workerFactory.discoverAndAdopt(admission(adopted));
    const cleanup = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(cleanup.kind).toBe('cleaned');
    expect(cleanup.exited).toEqual([adopted.identity]);
    // Only the authenticated HTTP shutdown happened; force termination does not exist,
    // so no OS signal can ever be sent on this path.
    expect(adopted.shutdowns).toBe(1);
    expect(workerFactory.snapshot()).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('unknown exit state after adopted shutdown keeps ownership and reports cleanup debt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-unknown-'));
  const adopted = onlineWorker('40000000-0000-4000-8000-000000000046', '50000000-0000-4000-8000-000000000046', 43246, 44246);
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000047', '50000000-0000-4000-8000-000000000047', 43247, 44247);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  await writeWorkers(directory, [adopted]);
  const workerFactory = factory(directory, [adopted], undefined, fakeIdentityControl(() => 'unknown').control);
  try {
    await workerFactory.discoverAndAdopt(admission(adopted));
    const cleanup = await workerFactory.retireForIngressBootChange({ registry, getFreshRegistry: async () => registry });
    expect(cleanup).toMatchObject({ kind: 'cleanup_debt', adoptedExitUnknown: [adopted.identity], exited: [] });
    expect(workerFactory.snapshot()).toHaveLength(1);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('adopted confirmed-uncommitted discard succeeds with exact exit proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-discard-'));
  const adopted = onlineWorker('40000000-0000-4000-8000-000000000048', '50000000-0000-4000-8000-000000000048', 43248, 44248);
  await writeWorkers(directory, [adopted]);
  const workerFactory = factory(directory, [adopted], undefined, fakeIdentityControl(() => 'dead').control);
  try {
    await workerFactory.discoverAndAdopt(admission(adopted));
    await workerFactory.discardConfirmedUncommitted(admission(adopted));
    expect(adopted.shutdowns).toBe(1);
    expect(workerFactory.snapshot()).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('adopted confirmed-uncommitted discard throws worker_exit_unconfirmed while retaining ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-discard-unknown-'));
  const adopted = onlineWorker('40000000-0000-4000-8000-000000000049', '50000000-0000-4000-8000-000000000049', 43249, 44249);
  await writeWorkers(directory, [adopted]);
  const workerFactory = factory(directory, [adopted], undefined, fakeIdentityControl(() => 'unknown').control);
  try {
    await workerFactory.discoverAndAdopt(admission(adopted));
    await expect(workerFactory.discardConfirmedUncommitted(admission(adopted))).rejects.toMatchObject({
      code: 'worker_exit_unconfirmed',
    });
    expect(workerFactory.snapshot()).toHaveLength(1);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('spawn initialization failure keeps ownership until the child handle reports exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-spawn-term-'));
  const workerInstanceId = '40000000-0000-4000-8000-000000000050';
  const spawnIdentity: ConfigProcessIdentity = { master_generation: GENERATION, worker_instance_id: workerInstanceId, worker_slot: 0 };
  const spawnSeed = deriveWorkerSupervisionSeed(ROOT, GENERATION, workerInstanceId, 0);
  const spawnCredential = deriveWorkerSupervisionCredential(spawnSeed, '50000000-0000-4000-8000-000000000050');
  const kills: string[] = [];
  const listeners = new Map<string, () => void>();
  const child = {
    pid: 52_101, unref: () => undefined,
    kill: (signal?: string) => { kills.push(signal ?? 'default'); return true; },
    once: (event: string, listener: () => void) => { listeners.set(event, listener); return child; },
  } as unknown as ChildProcess;
  const identity = fakeIdentityControl();
  const descriptorPath = join(directory, `${workerInstanceId}.json`);
  const workerFactory = new SupervisedConfigWorkerFactory({
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret',
    initializationTimeoutMs: 60, shutdownTimeoutMs: 25, processIdentity: identity.control,
    descriptorPathFor: () => descriptorPath,
    client: { fetch: (async () => { throw new Error('control attach unavailable'); }) as unknown as typeof globalThis.fetch },
    spawn: () => child,
  });
  try {
    await writeFile(descriptorPath, JSON.stringify(signWorkerDescriptor({
      schema: 'bungee-worker-descriptor-v1', role: 'worker', ...spawnIdentity,
      boot_nonce: '50000000-0000-4000-8000-000000000050', pid: 52_101,
      control_port: 43_250, phase: 'candidate', frozen: true,
      private_port: null, revision: null, content_hash: null, plugin_catalog_hash: null,
      started_at: 1, evidence: { kind: 'candidate' },
    }, spawnCredential.process_key)));
    const process = await workerFactory.spawn(spawnIdentity);
    await process.initialization.catch(() => undefined);
    // Initialization failed (attach unreachable) even though capture succeeded: no OS
    // signal is sent and ownership is retained.
    expect(identity.captures).toEqual([[52_101, workerInstanceId]]);
    expect(kills).toEqual([]);
    expect(workerFactory.snapshot()).toEqual([process]);
    // The still-bound child exit event releases the retained ownership.
    await triggerExitAndWaitForFactory(workerFactory, process, () => listeners.get('exit')?.());
    expect(workerFactory.snapshot()).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('spawn initialization failure without capture still keeps ownership until the child handle exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-spawn-nocapture-'));
  const workerInstanceId = '40000000-0000-4000-8000-000000000051';
  const spawnIdentity: ConfigProcessIdentity = { master_generation: GENERATION, worker_instance_id: workerInstanceId, worker_slot: 0 };
  const kills: string[] = [];
  const listeners = new Map<string, () => void>();
  const child = {
    pid: 52_102, unref: () => undefined,
    kill: (signal?: string) => { kills.push(signal ?? 'default'); return true; },
    once: (event: string, listener: () => void) => { listeners.set(event, listener); return child; },
  } as unknown as ChildProcess;
  const identity = fakeIdentityControl();
  const workerFactory = new SupervisedConfigWorkerFactory({
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret',
    initializationTimeoutMs: 40, shutdownTimeoutMs: 25, processIdentity: identity.control,
    spawn: () => child,
  });
  try {
    const process = await workerFactory.spawn(spawnIdentity);
    await process.initialization.catch(() => undefined);
    // No capture, no exit proof: nothing is signaled and nothing is released.
    expect(identity.captures).toEqual([]);
    expect(kills).toEqual([]);
    expect(workerFactory.snapshot()).toEqual([process]);
    await triggerExitAndWaitForFactory(workerFactory, process, () => listeners.get('exit')?.());
    expect(workerFactory.snapshot()).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('two adapters sharing a PID never consume each other exit proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-samepid-'));
  const first = spySpawnChild(52_103);
  const second = spySpawnChild(52_103);
  const identity = fakeIdentityControl();
  let next = first;
  const workerFactory = new SupervisedConfigWorkerFactory({
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret',
    initializationTimeoutMs: 40, shutdownTimeoutMs: 25, processIdentity: identity.control,
    spawn: () => { const current = next; next = second; return current.child; },
  });
  try {
    const firstProcess = await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000052', worker_slot: 0 });
    const secondProcess = await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000053', worker_slot: 1 });
    await Promise.all([firstProcess, secondProcess].map((process) => process.initialization.catch(() => undefined)));
    // Only the first child exits; the second adapter keeps the shared PID and its own —
    // still unproven — ownership.
    await triggerExitAndWaitForFactory(workerFactory, firstProcess, () => first.emitExit());
    expect(workerFactory.snapshot()).toEqual([secondProcess]);
    expect(workerFactory.owns(firstProcess)).toBe(false);
    expect(workerFactory.owns(secondProcess)).toBe(true);
    expect(first.kills).toEqual([]);
    expect(second.kills).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('adoption that fails mid-flight leaves ownership maps unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-exact-adopt-fail-'));
  const good = onlineWorker('40000000-0000-4000-8000-000000000054', '50000000-0000-4000-8000-000000000054', 43254, 44254, 0);
  const bad = onlineWorker('40000000-0000-4000-8000-000000000055', '50000000-0000-4000-8000-000000000055', 43255, 44255, 1);
  await writeWorkers(directory, [good, bad]);
  const identity = fakeIdentityControl();
  const captureRefused: Array<readonly [number, string]> = [];
  const control: ProcessIdentityControl = {
    capture: async (pid, processInstanceId) => {
      if (processInstanceId === bad.identity.worker_instance_id) {
        captureRefused.push([pid, processInstanceId]);
        throw new ProcessIdentityUnavailableError('captured process does not carry the requested identity marker');
      }
      return identity.control.capture(pid, processInstanceId);
    },
    probe: identity.control.probe,
  };
  const workerFactory = factory(directory, [good, bad], undefined, control);
  try {
    const admissionSet: AdmissionSet = {
      master_generation: GENERATION, websocket_max_connections: 512, websocket_max_message_bytes: 16 * 1024 * 1024, admission_sequence: 1, revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG,
      workers: [
        { ...good.identity, boot_nonce: good.descriptor.boot_nonce, private_port: good.descriptor.private_port! },
        { ...bad.identity, boot_nonce: bad.descriptor.boot_nonce, private_port: bad.descriptor.private_port! },
      ],
    };
    await expect(workerFactory.discoverAndAdopt(admissionSet)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(captureRefused).toHaveLength(1);
    expect(workerFactory.snapshot()).toEqual([]);
    expect(workerFactory.owns(good as never)).toBe(false);
    // Every staged adapter — including the one whose capture failed — released its
    // discovery control client: no connection survives the failed adoption.
    expect((workerFactory as unknown as { clients: Map<string, unknown> }).clients.size).toBe(0);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('disconnectAll does not mask later real child exits and ownership converges per process object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-disconnect-all-exit-'));
  const first = spySpawnChild(52_104);
  const second = spySpawnChild(52_105);
  const workerFactory = new SupervisedConfigWorkerFactory({
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret',
    initializationTimeoutMs: 40, shutdownTimeoutMs: 25, processIdentity: fakeIdentityControl().control,
    spawn: () => firstOrSecond(),
  });
  let next = first;
  function firstOrSecond() { const current = next; next = second; return current.child; }
  try {
    const firstProcess = await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000057', worker_slot: 0 });
    const secondProcess = await workerFactory.spawn({ master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000058', worker_slot: 1 });
    await Promise.all([firstProcess, secondProcess].map((process) => process.initialization.catch(() => undefined)));
    workerFactory.disconnectAll();
    // The real child exit after disconnectAll is no longer forgotten: exactly the exited
    // object converges out of ownership while its sibling keeps its own entry.
    await triggerExitAndWaitForFactory(workerFactory, firstProcess, () => first.emitExit());
    expect(workerFactory.snapshot()).toEqual([secondProcess]);
    expect(workerFactory.owns(firstProcess)).toBe(false);
    expect(workerFactory.owns(secondProcess)).toBe(true);
    expect(first.kills).toEqual([]);
    expect(second.kills).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('a mid-flight adoption failure disconnects the failing adapter as part of the staged set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-adopt-stage-first-'));
  const bad = onlineWorker('40000000-0000-4000-8000-000000000059', '50000000-0000-4000-8000-000000000059', 43259, 44259);
  await writeWorkers(directory, [bad]);
  const identity = fakeIdentityControl();
  const control: ProcessIdentityControl = {
    capture: async (pid, processInstanceId) => {
      throw new ProcessIdentityUnavailableError('captured process does not carry the requested identity marker');
    },
    probe: identity.control.probe,
  };
  const workerFactory = factory(directory, [bad], undefined, control);
  try {
    // The very first staged adapter fails its capture: it must be disconnected with the
    // rest of the staged set instead of leaking its discovery client.
    await expect(workerFactory.discoverAndAdopt(admission(bad))).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(workerFactory.snapshot()).toEqual([]);
    expect((workerFactory as unknown as { clients: Map<string, unknown> }).clients.size).toBe(0);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

/** Wraps a worker so every authenticated /shutdown request fails at the transport layer. */
function refuseShutdown(worker: OnlineWorker): void {
  const original = worker.fetch;
  worker.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const request = JSON.parse(String(init?.body ?? '{}')) as { message?: { path?: string } };
    if (path === '/__supervision/command' && request.message?.path === '/shutdown') throw new Error('shutdown refused');
    return original(input, init);
  };
}

test('orphan cleanup converges through the exact OS probe even when graceful shutdown fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-orphan-graceful-fail-'));
  const orphan = onlineWorker('40000000-0000-4000-8000-000000000060', '50000000-0000-4000-8000-000000000060', 43260, 44260);
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000061', 43261, 44261);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  refuseShutdown(orphan);
  await writeWorkers(directory, [orphan]);
  const workerFactory = factory(directory, [orphan], undefined, fakeIdentityControl(() => 'dead').control);
  try {
    const result = await workerFactory.cleanupAuthenticatedOrphans(registry);
    // The graceful failure is observable, yet the dead probe proves the exit and
    // ownership converges instead of silently stalling between cleaned and exitUnknown.
    expect(result.cleaned).toEqual([orphan.identity]);
    expect(result.exitUnknown).toEqual([]);
    expect(result.issues.some((issue) => issue.kind === 'unreachable' && issue.detail.includes('worker supervision request failed'))).toBe(true);
    expect(orphan.shutdowns).toBe(0);
    expect(workerFactory.snapshot()).toEqual([]);
  } finally { workerFactory.disconnect(); await rm(directory, { recursive: true, force: true }); }
});

test('orphan cleanup keeps ownership and reports exitUnknown when the failed graceful shutdown stays unproven', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-orphan-graceful-fail-unknown-'));
  const orphan = onlineWorker('40000000-0000-4000-8000-000000000062', '50000000-0000-4000-8000-000000000062', 43262, 44262);
  const protectedWorker = onlineWorker('40000000-0000-4000-8000-000000000063', '50000000-0000-4000-8000-000000000063', 43263, 44263);
  const registry: AdmissionRegistryStatus = { active: admission(protectedWorker), prepared: null, retired: [] };
  refuseShutdown(orphan);
  await writeWorkers(directory, [orphan]);
  try {
    // exact-alive and unknown both leave the exit unproven: the worker is reported as
    // exitUnknown (driving admission recovery upstream) while ownership is retained.
    for (const probe of ['exact', 'unknown'] as const) {
      const workerFactory = factory(directory, [orphan], undefined, fakeIdentityControl(() => probe).control);
      try {
        const result = await workerFactory.cleanupAuthenticatedOrphans(registry);
        expect(result.cleaned).toEqual([]);
        expect(result.exitUnknown).toEqual([orphan.identity]);
        expect(result.issues.some((issue) => issue.kind === 'unreachable' && issue.detail.includes('worker supervision request failed'))).toBe(true);
        expect(workerFactory.snapshot()).toHaveLength(1);
      } finally { workerFactory.disconnect(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a new attempt requires all prior serving targets to exit and persists the identity fence before reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-publication-target-exit-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const worker = onlineWorker(randomUUID(), randomUUID(), 40111, 41111);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const workers = factory(directory, [], undefined, fakeIdentityControl(() => 'mismatch').control,
    async () => TEST_KERNEL_BOOT_ID, configurationRepositoryFixture(repository), launchRepositoryFixture(repository));
  try {
    repository.commit({ mutation_id: 'target-exit', expected_revision: 1, kind: 'config', created_at: 1, target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication('target-exit', 2);
    repository.beginWorkerAttempt('target-exit', 0, 0, 'initial', 3);
    repository.registerWorkerLaunch(worker.identity, guard.facts,
      { mutation_id: 'target-exit', worker_slot: 0, attempt_no: 1 }, 3);
    repository.recordWorkerResult('target-exit', 0, { kind: 'converged', attempt_no: 1, applied_revision: 2 }, 4);
    const publication = { mutation_id: 'target-exit', attempt_no: 1, drain_recovery_generation: 0 };
    const contentHash = repository.getSnapshot().content_hash;
    const { descriptor_mac: _mac, ...body } = worker.descriptor;
    const message = body.evidence.message;
    if (message?.status !== 'config-ready') throw new Error('target ready fixture missing');
    const descriptor = signWorkerDescriptor({ ...body, revision: 2, content_hash: contentHash,
      phase: 'stopped', lifetime_guard: { ...guard.facts, held: true },
      cleanup: { cleanup_state: 'success', revision: 2, content_hash: contentHash,
        plugin_catalog_hash: CATALOG, publication: { ...publication } },
      evidence: { kind: 'ready', message: { ...message, revision: 2, content_hash: contentHash, publication } } }, worker.credential.process_key);
    const path = join(directory, `${worker.identity.worker_instance_id}.json`);
    await writeFile(path, JSON.stringify(descriptor));
    repository.freezePublicationRetirement('target-exit', 0, [], 4);
    repository.freezePublicationServingSet('target-exit', 0, [{ identity: worker.identity, boot_nonce: worker.descriptor.boot_nonce,
      pid: worker.descriptor.pid, private_port: 41111, revision: 2, content_hash: contentHash, plugin_catalog_hash: CATALOG,
      publication, guard: guard.facts, kernel_boot_id: TEST_KERNEL_BOOT_ID }]);
    repository.markDraining('target-exit', 5);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('target publication missing');
    expect(await workers.confirmActivePublicationExited(active)).toBe(false);
    expect(repository.getPublicationServingSet('target-exit', 0)?.exited).toEqual([]);
    guard.closeAfterChildExit();
    await writeFile(path, JSON.stringify({ ...descriptor, pid: 999 }));
    expect(await workers.confirmActivePublicationExited(active)).toBe(false);
    await writeFile(path, JSON.stringify(descriptor));
    expect(await workers.confirmActivePublicationExited(active)).toBe(true);
    expect(repository.getPublicationServingSet('target-exit', 0)?.exited).toEqual([worker.identity.worker_instance_id]);
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id)).toMatchObject({ exited: true, cleanup_released: true });
    expect(repository.getRetiredWorkerInstanceIds()).toContain(worker.identity.worker_instance_id);
    expect((await workers.discoverAndAdopt(admission(worker))).kind).toBe('recovering');
    // Proof alone does not consume an attempt. Only the caller's actual new attempt does.
    expect(repository.getOperation('target-exit')?.drain_recovery_generation).toBe(0);
    repository.beginDrainingRecovery('target-exit', 0, 6);
    expect(repository.getActivePublication()?.targets[0]).toMatchObject({ attempt_no: 2, drain_recovery_generation: 1 });
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('awaits durable launch intent registration before the native fork and fails closed when it is unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-launch-intent-'));
  try {
    const order: string[] = [];
    let failRegistration = true;
    const registered: { identity: ConfigProcessIdentity; guard: { readonly process_instance_id: string }; allocation: unknown }[] = [];
    const admitted: string[] = [];
    const repository = {
      registerWorkerLaunch: async (identity: ConfigProcessIdentity, guard: { readonly process_instance_id: string }, allocation: unknown) => {
        order.push(`register:${identity.worker_instance_id}`);
        registered.push({ identity, guard, allocation });
        if (failRegistration) throw new Error('launch intent storage is unknown');
        return {} as never;
      },
      recordWorkerLaunchExit: async () => ({} as never),
      recordWorkerLaunchAdmitted: async (workerInstanceId: string) => { admitted.push(workerInstanceId); return {} as never; },
      fenceWorkerLaunchNotStarted: async () => undefined,
      getWorkerLaunch: async (workerInstanceId: string) => workerInstanceId === second.worker_instance_id ? ({} as never) : null,
      getUnsettledWorkerLaunches: async () => [],
    };
    const child = { pid: 12_345, unref: () => undefined, kill: () => true, once() { return this; } } as unknown as ChildProcess;
    const workerFactory = new SupervisedConfigWorkerFactory({
      kernelBootId: async () => TEST_KERNEL_BOOT_ID,
      launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
      runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 8089,
      accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret', initializationTimeoutMs: 1, shutdownTimeoutMs: 25,
      processIdentity: fakeIdentityControl().control,
      launchRepository: repository as unknown as WorkerLaunchRepository,
      spawn: () => { order.push('fork'); return child; },
    });
    const first = { master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-0000000000a1', worker_slot: 0 };
    const second = { ...first, worker_instance_id: '40000000-0000-4000-8000-0000000000a2' };
    await expect(workerFactory.spawn(first)).rejects.toThrow('launch intent storage is unknown');
    expect(order).toEqual([`register:${first.worker_instance_id}`]);
    expect(workerFactory.snapshot()).toEqual([]);
    failRegistration = false;
    const spawnedProcess = await workerFactory.spawn(second, { mutation_id: '90000000-0000-4000-8000-000000000001', committed_revision: 2, attempt_no: 1 });
    expect(order).toEqual([`register:${first.worker_instance_id}`, `register:${second.worker_instance_id}`, 'fork']);
    expect(registered[1]!.allocation).toEqual({ mutation_id: '90000000-0000-4000-8000-000000000001', worker_slot: 0, attempt_no: 1 });
    expect(registered[1]!.guard.process_instance_id).toBe(second.worker_instance_id);
    expect(Object.keys(registered[1]!.guard)).not.toContain('held');
    await workerFactory.markCommitted([spawnedProcess]);
    expect(admitted).toEqual([second.worker_instance_id]);
    workerFactory.disconnect();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fences a pre-ready reservation without a launch intent as not_started', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-pre-ready-fence-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, fixture, launchRepositoryFixture(repository));
  try {
    repository.commit({ mutation_id: 'pre-ready-fence', expected_revision: 1, kind: 'config', created_at: 1,
      target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication('pre-ready-fence', 3);
    repository.beginWorkerAttempt('pre-ready-fence', 0, 0, 'initial', 4);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('pre-ready publication missing');
    expect(repository.getUnsettledWorkerLaunches()).toHaveLength(1);
    expect(await workers.confirmActivePublicationExited(active)).toBe(true);
    // The reservation was fenced and its candidate evidence recorded: no unsettled
    // launch remains even though the attempt row itself is still the current attempt.
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    expect(await workers.confirmActivePublicationExited(active)).toBe(true);
  } finally { workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('serving-set confirmation requires signed cleanup even after a physical exit row and settles both ledgers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-serving-cleanup-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const worker = onlineWorker('40000000-0000-4000-8000-0000000000b1', '50000000-0000-4000-8000-0000000000b1', 45101, 46101);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, fixture, launchRepositoryFixture(repository));
  try {
    repository.commit({ mutation_id: 'serving-cleanup', expected_revision: 1, kind: 'config', created_at: 1,
      target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication('serving-cleanup', 3);
    repository.beginWorkerAttempt('serving-cleanup', 0, 0, 'initial', 4);
    repository.registerWorkerLaunch(worker.identity, guard.facts,
      { mutation_id: 'serving-cleanup', worker_slot: 0, attempt_no: 1 }, 4);
    repository.recordWorkerResult('serving-cleanup', 0, { kind: 'converged', attempt_no: 1, applied_revision: 2 }, 4);
    const publication = { mutation_id: 'serving-cleanup', attempt_no: 1, drain_recovery_generation: 0 };
    const contentHash = repository.getSnapshot().content_hash;
    const { descriptor_mac: _mac, ...body } = worker.descriptor;
    const message = body.evidence.message;
    if (message?.status !== 'config-ready') throw new Error('cleanup fixture message missing');
    const ready = { ...message, revision: 2, content_hash: contentHash, publication };
    const cleanup = { cleanup_state: 'success' as const, revision: 2, content_hash: contentHash,
      plugin_catalog_hash: CATALOG, publication: { ...publication } };
    const path = join(directory, `${worker.identity.worker_instance_id}.json`);
    await writeFile(path, JSON.stringify(signWorkerDescriptor({ ...body, revision: 2, content_hash: contentHash,
      lifetime_guard: { ...guard.facts, held: true }, evidence: { kind: 'ready', message: ready } },
    worker.credential.process_key)));
    repository.freezePublicationServingSet('serving-cleanup', 0, [{ identity: worker.identity,
      boot_nonce: worker.descriptor.boot_nonce, pid: worker.descriptor.pid, private_port: 46101, revision: 2,
      content_hash: contentHash, plugin_catalog_hash: CATALOG, publication, guard: guard.facts, kernel_boot_id: TEST_KERNEL_BOOT_ID }]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('serving cleanup publication missing');
    expect(active.operation.state).toBe('publishing');
    // A prior physical-exit row must not bypass the missing signed cleanup.
    repository.confirmPublicationServingMemberExit('serving-cleanup', 0, worker.identity.worker_instance_id);
    guard.closeAfterChildExit();
    expect(await workers.confirmActivePublicationExited(active)).toBe(false);
    await writeFile(path, JSON.stringify(signWorkerDescriptor({ ...body, revision: 2, content_hash: contentHash,
      phase: 'stopped', lifetime_guard: { ...guard.facts, held: true }, cleanup,
      evidence: { kind: 'ready', message: ready } }, worker.credential.process_key)));
    expect(await workers.confirmActivePublicationExited(active)).toBe(true);
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ exited: true, cleanup_released: true });
    // The exact candidate proof exists: cancellation can now terminalize the owner.
    repository.requestPublicationCancellation('serving-cleanup', 2, 7);
    expect(repository.confirmPublicationCandidateExited('serving-cleanup', 2, 8).state).toBe('superseded');
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('pre-ready candidate whose launch already settled still writes the missing candidate proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-pre-ready-settled-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const worker = onlineWorker('40000000-0000-4000-8000-0000000000b2', '50000000-0000-4000-8000-0000000000b2', 45102, 46102);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, fixture, launchRepositoryFixture(repository));
  try {
    repository.commit({ mutation_id: 'pre-ready-settled', expected_revision: 1, kind: 'config', created_at: 1,
      target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication('pre-ready-settled', 3);
    repository.beginWorkerAttempt('pre-ready-settled', 0, 0, 'initial', 4);
    repository.registerWorkerLaunch(worker.identity, guard.facts,
      { mutation_id: 'pre-ready-settled', worker_slot: 0, attempt_no: 1 }, 4);
    // Generic exit listener settlement: no serving set and no candidate evidence yet.
    repository.recordWorkerLaunchExit(worker.identity.worker_instance_id, { kind: 'exited', cleanup: 'released' }, 5);
    guard.closeAfterChildExit();
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('pre-ready settled publication missing');
    expect(await workers.confirmActivePublicationExited(active)).toBe(true);
    repository.requestPublicationCancellation('pre-ready-settled', 2, 7);
    expect(repository.confirmPublicationCandidateExited('pre-ready-settled', 2, 8).state).toBe('superseded');
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an admitted live pre-ready launch is not released just because unsettled launches are empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-pre-ready-admitted-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const worker = onlineWorker('40000000-0000-4000-8000-0000000000b3', '50000000-0000-4000-8000-0000000000b3', 45103, 46103);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, fixture, launchRepositoryFixture(repository));
  try {
    repository.commit({ mutation_id: 'pre-ready-admitted', expected_revision: 1, kind: 'config', created_at: 1,
      target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication('pre-ready-admitted', 3);
    repository.beginWorkerAttempt('pre-ready-admitted', 0, 0, 'initial', 4);
    repository.registerWorkerLaunch(worker.identity, guard.facts,
      { mutation_id: 'pre-ready-admitted', worker_slot: 0, attempt_no: 1 }, 4);
    repository.recordWorkerLaunchAdmitted(worker.identity.worker_instance_id, 5);
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('pre-ready admitted publication missing');
    expect(await workers.confirmActivePublicationExited(active)).toBe(false);
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ admitted: true, exited: false, cleanup_released: false });
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a pre-ready attempt without durable allocation facts is not released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-pre-ready-no-facts-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, fixture,
    { getWorkerLaunchAllocationFacts: async () => null } as unknown as WorkerLaunchRepository);
  try {
    repository.commit({ mutation_id: 'pre-ready-no-facts', expected_revision: 1, kind: 'config', created_at: 1,
      target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication('pre-ready-no-facts', 3);
    repository.beginWorkerAttempt('pre-ready-no-facts', 0, 0, 'initial', 4);
    expect(repository.getOutstandingPublicationCandidates()).toHaveLength(1);
    const active = repository.getActivePublication();
    if (active === null) throw new Error('pre-ready facts publication missing');
    expect(await workers.confirmActivePublicationExited(active)).toBe(false);
  } finally { workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('debt-only pass fences a crashed reservation without forking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-debt-reservation-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const allocation = { mutation_id: 'debt-reservation', worker_slot: 0, attempt_no: 1 } as const;
  const launchRepository = {
    ...fixture,
    getWorkerLaunchInventory: async () => [{ kind: 'reservation' as const, allocation }],
  } as unknown as WorkerLaunchRepository;
  const workers = factory(directory, [], { active: null, prepared: null, retired: [] } as never,
    fakeIdentityControl().control, async () => TEST_KERNEL_BOOT_ID, fixture, launchRepository);
  try {
    repository.commit({ mutation_id: 'debt-reservation', expected_revision: 1, kind: 'config', created_at: 1,
      target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication('debt-reservation', 3);
    repository.beginWorkerAttempt('debt-reservation', 0, 0, 'initial', 4);
    const result = await workers.settleWorkerLaunchDebt({ active: null, prepared: null, retired: [] });
    expect(result).toMatchObject({ fenced: [allocation], unknown: [], released: [] });
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    expect(workers.snapshot()).toEqual([]);
  } finally { workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a startup launch stays unknown until signed cleanup arrives, then releases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-debt-startup-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const worker = onlineWorker('40000000-0000-4000-8000-0000000000c1', '50000000-0000-4000-8000-0000000000c1', 45104, 46104);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const launchRepository = {
    ...fixture,
    getWorkerLaunchInventory: async () => {
      const launch = repository.getWorkerLaunch(worker.identity.worker_instance_id);
      return launch === null ? [] : [{ kind: 'launch' as const, launch }];
    },
  } as unknown as WorkerLaunchRepository;
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, fixture, launchRepository);
  try {
    repository.registerWorkerLaunch(worker.identity, guard.facts, null, 1);
    repository.recordWorkerLaunchExit(worker.identity.worker_instance_id, { kind: 'exited', cleanup: 'unknown' }, 2);
    guard.closeAfterChildExit();
    const first = await workers.settleWorkerLaunchDebt({ active: null, prepared: null, retired: [] });
    expect(first.released).toEqual([]);
    expect(first.unknown).toHaveLength(1);
    const { descriptor_mac: _mac, ...body } = worker.descriptor;
    const path = join(directory, `${worker.identity.worker_instance_id}.json`);
    await writeFile(path, JSON.stringify(signWorkerDescriptor({ ...body, phase: 'stopped', lifetime_guard: { ...guard.facts, held: true },
      cleanup: { cleanup_state: 'success', revision: null, content_hash: null, plugin_catalog_hash: null,
        publication: null } }, worker.credential.process_key)));
    guard.closeAfterChildExit();
    const second = await workers.settleWorkerLaunchDebt({ active: null, prepared: null, retired: [] });
    expect(second).toMatchObject({ released: [worker.identity], unknown: [] });
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ exited: true, cleanup_released: true });
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('debt-only pass leaves every legal admitted member alone even with a free guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-debt-legal-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const worker = onlineWorker('40000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-0000000000c2', 45105, 46105);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const launchRepository = {
    ...fixture,
    getWorkerLaunchInventory: async () => {
      const launch = repository.getWorkerLaunch(worker.identity.worker_instance_id);
      return launch === null ? [] : [{ kind: 'launch' as const, launch }];
    },
  } as unknown as WorkerLaunchRepository;
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, fixture, launchRepository);
  try {
    repository.registerWorkerLaunch(worker.identity, guard.facts, null, 1);
    repository.recordWorkerLaunchAdmitted(worker.identity.worker_instance_id, 2);
    guard.closeAfterChildExit();
    for (const registry of [
      { active: admission(worker), prepared: null, retired: [] },
      { active: null, prepared: admission(worker), retired: [] },
      { active: null, prepared: null, retired: [admission(worker)] },
    ]) {
      expect(await workers.settleWorkerLaunchDebt(registry)).toEqual({ released: [], fenced: [], unknown: [] });
    }
    expect((await readFile(guard.facts.path, 'utf8')).startsWith('armed  \n')).toBeTrue();
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ admitted: true, exited: false, cleanup_released: false, capacity_reclaimed: false });
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test.each([false, true])('an admitted startup with frozen=%s reclaims only capacity from its free original guard', async (frozen) => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-startup-capacity-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const worker = onlineWorker(randomUUID(), randomUUID(), 45107, 46107);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, configurationRepositoryFixture(repository), launchRepositoryFixture(repository));
  const registry = { active: null, prepared: null, retired: [] };
  const path = join(directory, `${worker.identity.worker_instance_id}.json`);
  const { descriptor_mac: _mac, ...body } = worker.descriptor;
  try {
    await writeFile(path, JSON.stringify(signWorkerDescriptor({ ...body, frozen,
      lifetime_guard: { ...guard.facts, held: true } }, worker.credential.process_key)));
    const descriptor = await readFile(path, 'utf8');
    repository.registerWorkerLaunch(worker.identity, guard.facts, null, 1);
    repository.recordWorkerLaunchAdmitted(worker.identity.worker_instance_id, 2);
    expect((await workers.settleWorkerLaunchDebt(registry)).released).toEqual([]);
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ exited: false, cleanup_released: false, capacity_reclaimed: false });

    guard.closeAfterChildExit();
    await rename(guard.facts.path, `${guard.facts.path}.moved`);
    expect((await workers.settleWorkerLaunchDebt(registry)).unknown).toHaveLength(1);
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ exited: false, cleanup_released: false, capacity_reclaimed: false });
    await rename(`${guard.facts.path}.moved`, guard.facts.path);

    const result = await workers.settleWorkerLaunchDebt(registry);
    expect(result).toMatchObject({ released: [], fenced: [], unknown: [expect.anything()] });
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ admitted: true, exited: true, cleanup_released: false, capacity_reclaimed: true });
    expect(await readFile(path, 'utf8')).toBe(descriptor);
    expect((await readFile(guard.facts.path, 'utf8')).startsWith('retired\n')).toBeTrue();
    expect(await workers.settleWorkerLaunchDebt(registry)).toMatchObject({ released: [], unknown: [expect.anything()] });
    expect(repository.getWorkerLaunchInventory()).toEqual([{ kind: 'launch', launch: expect.objectContaining({
      exited: true, cleanup_released: false, capacity_reclaimed: true,
    }) }]);
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('startup capacity recovery resumes after an interruption between durable exit and capacity writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-startup-capacity-interrupted-'));
  const dbPath = join(directory, 'config.db');
  let repository = ConfigRepository.open(dbPath);
  const worker = onlineWorker(randomUUID(), randomUUID(), 45108, 46108);
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  let workers = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, configurationRepositoryFixture(repository), {
      ...launchRepositoryFixture(repository),
      recordWorkerLaunchCapacityReclaimed: async () => { throw new Error('fixture interrupted capacity write'); },
    });
  const registry = { active: null, prepared: null, retired: [] };
  try {
    repository.registerWorkerLaunch(worker.identity, guard.facts, null, 1);
    repository.recordWorkerLaunchAdmitted(worker.identity.worker_instance_id, 2);
    guard.closeAfterChildExit();
    await expect(workers.settleWorkerLaunchDebt(registry)).rejects.toThrow('fixture interrupted capacity write');
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ exited: true, cleanup_released: false, capacity_reclaimed: false });
    workers.disconnect();
    repository.close();
    repository = ConfigRepository.open(dbPath);
    workers = factory(directory, [], undefined, fakeIdentityControl().control,
      async () => TEST_KERNEL_BOOT_ID, configurationRepositoryFixture(repository), launchRepositoryFixture(repository));
    expect(await workers.settleWorkerLaunchDebt(registry)).toMatchObject({ released: [], unknown: [expect.anything()] });
    expect(repository.getWorkerLaunch(worker.identity.worker_instance_id))
      .toMatchObject({ exited: true, cleanup_released: false, capacity_reclaimed: true });
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('only exact failed cleanup and the free original guard reclaim an admitted, exited launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-reclaim-'));
  const repository = ConfigRepository.open(join(directory, 'config.db'));
  const fixture = configurationRepositoryFixture(repository);
  const worker = await completedWorker(onlineWorker(randomUUID(), randomUUID(), 45106, 46106));
  const guard = armProcessLifetimeGuard({ directory: join(directory, 'guards'), processInstanceId: worker.identity.worker_instance_id });
  const workers = factory(directory, [], undefined, { ...fakeIdentityControl().control, probeInstance: async () => 'dead' },
    async () => TEST_KERNEL_BOOT_ID, fixture, launchRepositoryFixture(repository));
  const registry = { active: null, prepared: null, retired: [] };
  const path = join(directory, `${worker.identity.worker_instance_id}.json`);
  const publication = { mutation_id: 'historical-failed-cleanup', attempt_no: 1, drain_recovery_generation: 0 };
  try {
    repository.commit({ mutation_id: publication.mutation_id, expected_revision: 1, kind: 'config', created_at: 1,
      target_worker_slots: [0],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    repository.claimPublicationTarget(CATALOG, 2);
    repository.beginPublication(publication.mutation_id, 3);
    repository.beginWorkerAttempt(publication.mutation_id, 0, 0, 'initial', 4);
    repository.registerWorkerLaunch(worker.identity, guard.facts, { mutation_id: publication.mutation_id, worker_slot: 0, attempt_no: 1 }, 4);
    const launch = () => repository.getWorkerLaunch(worker.identity.worker_instance_id)!;
    const { descriptor_mac: _mac, ...descriptor } = worker.descriptor;
    const terminal = descriptor.evidence.message;
    if (terminal?.status !== 'worker-drained') throw new Error('expected drained worker fixture');
    const contentHash = repository.getSnapshot().content_hash;
    const body = { ...descriptor, revision: 2, content_hash: contentHash,
      lifetime_guard: { ...guard.facts, held: true as const },
      evidence: { kind: 'drained' as const, message: { ...terminal, revision: 2, content_hash: contentHash, publication } },
      cleanup: { cleanup_state: 'failed' as const, revision: 2, content_hash: contentHash,
        plugin_catalog_hash: CATALOG, publication: { ...publication } } };
    const save = (value: WorkerDescriptorBody) => writeFile(path, JSON.stringify(signWorkerDescriptor(value, worker.credential.process_key)));
    await save(body);
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    repository.recordWorkerLaunchAdmitted(worker.identity.worker_instance_id, 5);
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    repository.recordWorkerLaunchExit(worker.identity.worker_instance_id, { kind: 'exited', cleanup: 'unknown' }, 6);
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse(); // The original lock is held.
    guard.closeAfterChildExit();
    expect((await workers.settleWorkerLaunchDebt(registry)).unknown).toEqual([launch()]);
    expect(launch().capacity_reclaimed).toBeFalse(); // Publication launches still need their exact failed-cleanup proof.

    await rm(path);
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    await writeFile(path, JSON.stringify(signWorkerDescriptor(body, new Uint8Array(32))));
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    await save({ ...body, cleanup: { ...body.cleanup, publication: { ...publication, attempt_no: 2 } } });
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    await save({ ...body, cleanup: { ...body.cleanup, publication: { ...publication, drain_recovery_generation: 1 } } });
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    await save({ ...body, lifetime_guard: { ...body.lifetime_guard, inode: `${guard.facts.inode}0` } });
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    const { lifetime_guard: _guard, ...withoutGuard } = body;
    await save(withoutGuard);
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();

    await save(body);
    await rename(guard.facts.path, `${guard.facts.path}.moved`);
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    await rename(`${guard.facts.path}.moved`, guard.facts.path);
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeTrue();
    expect((await workers.cleanupAuthenticatedOrphans(registry)).cleaned).toEqual([]);
    expect(parseWorkerDescriptor(JSON.parse(await readFile(path, 'utf8')), worker.credential).cleanup?.cleanup_state).toBe('failed');
    expect(await workers.reclaimExitedWorkerLaunchCapacity(launch())).toBeFalse();
    expect((await workers.settleWorkerLaunchDebt(registry)).unknown).toEqual([launch()]);
    expect(repository.getWorkerLaunchInventory()).toEqual([{ kind: 'launch', launch: expect.objectContaining({
      admitted: true, exited: true, cleanup_released: false, capacity_reclaimed: true,
    }) }]);
    expect(repository.getWorkerLaunchAllocationFacts(launch().allocation!)?.settled).toBeFalse();
  } finally { guard.closeAfterChildExit(); workers.disconnect(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('adopted shutdown waits for delayed exact proof and the durable launch-exit ACK', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-adopted-delayed-proof-'));
  const worker = onlineWorker('40000000-0000-4000-8000-0000000000d1', '50000000-0000-4000-8000-0000000000d1', 43252, 44252);
  await writeWorkers(directory, [worker]);
  let released = false;
  let proofSeen!: () => void;
  const proofObserved = new Promise<void>((resolve) => { proofSeen = resolve; });
  let writeSeen!: () => void;
  const writeStarted = new Promise<void>((resolve) => { writeSeen = resolve; });
  let writeAck!: () => void;
  const writeGate = new Promise<void>((resolve) => { writeAck = resolve; });
  const identity = fakeIdentityControl();
  const control: ProcessIdentityControl = {
    ...identity.control,
    probe: async () => { proofSeen(); return released ? 'dead' : 'exact'; },
  };
  const launchRepository = {
    recordWorkerLaunchExit: async (workerInstanceId: string) => {
      writeSeen();
      await writeGate;
      return { identity: { worker_instance_id: workerInstanceId } } as never;
    },
  } as unknown as WorkerLaunchRepository;
  const workerFactory = factory(directory, [worker], undefined, control,
    async () => TEST_KERNEL_BOOT_ID, undefined, launchRepository);
  try {
    expect((await workerFactory.discoverAndAdopt(admission(worker))).kind).toBe('adopted');
    let completed = false;
    const shutdown = workerFactory.shutdownAll().then((results) => { completed = true; return results; });
    await proofObserved;
    // The graceful ACK already returned; the physical guard is still live, so the
    // bounded wait must not report an exit yet.
    expect(completed).toBe(false);
    released = true;
    await writeStarted;
    // Exact OS proof arrived, but the durable launch-exit fact is still unacknowledged.
    expect(completed).toBe(false);
    writeAck();
    const results = await shutdown;
    expect(results).toMatchObject([{ exitEvidence: { exited: true, pid: worker.descriptor.pid } }]);
    expect(completed).toBe(true);
    expect(workerFactory.snapshot()).toEqual([]);
  } finally {
    workerFactory.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test('adopted shutdown reports a rejected durable launch-exit write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-adopted-write-failure-'));
  const worker = onlineWorker('40000000-0000-4000-8000-0000000000d2', '50000000-0000-4000-8000-0000000000d2', 43253, 44253);
  await writeWorkers(directory, [worker]);
  const launchRepository = {
    recordWorkerLaunchExit: async () => { throw new Error('launch ledger write failed'); },
  } as unknown as WorkerLaunchRepository;
  const workerFactory = factory(directory, [worker], undefined, fakeIdentityControl(() => 'dead').control,
    async () => TEST_KERNEL_BOOT_ID, undefined, launchRepository);
  try {
    expect((await workerFactory.discoverAndAdopt(admission(worker))).kind).toBe('adopted');
    await expect(workerFactory.shutdownAll()).rejects.toMatchObject({ name: 'AggregateError' });
  } finally {
    workerFactory.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown durable exit failure survives a queued released write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-launch-write-chain-unknown-'));
  let rejectUnknown!: (error: unknown) => void;
  let resolveReleased!: () => void;
  let unknownStarted!: () => void;
  let releasedStarted!: () => void;
  const unknownStartedGate = new Promise<void>((resolve) => { unknownStarted = resolve; });
  const releasedStartedGate = new Promise<void>((resolve) => { releasedStarted = resolve; });
  const calls: string[] = [];
  const launchRepository = {
    recordWorkerLaunchExit: async (_workerInstanceId: string, evidence: { readonly cleanup: string }) => {
      calls.push(evidence.cleanup);
      if (evidence.cleanup === 'unknown') {
        unknownStarted();
        return new Promise((_resolve, reject) => { rejectUnknown = reject; }) as never;
      }
      releasedStarted();
      return new Promise((resolve) => { resolveReleased = () => resolve({} as never); }) as never;
    },
  } as unknown as WorkerLaunchRepository;
  const workerFactory = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, undefined, launchRepository);
  const record = (workerFactory as unknown as {
    recordLaunchExit(id: string, evidence: { readonly exited: true; readonly pid: number; readonly cleanup_state?: 'success' | 'failed' }): Promise<void>;
  }).recordLaunchExit.bind(workerFactory);
  const workerInstanceId = '40000000-0000-4000-8000-0000000000d3';
  try {
    const unknown = record(workerInstanceId, { exited: true, pid: 1 });
    await unknownStartedGate;
    const released = record(workerInstanceId, { exited: true, pid: 1, cleanup_state: 'success' });
    rejectUnknown(new Error('unknown launch write failed'));
    await expect(unknown).rejects.toThrow('unknown launch write failed');
    await releasedStartedGate;
    expect(calls).toEqual(['unknown', 'released']);
    resolveReleased();
    await expect(released).resolves.toBeUndefined();
    await expect(workerFactory.shutdownAll()).rejects.toMatchObject({ name: 'AggregateError' });
    // A second shutdown must not forget the first durable-write failure.
    await expect(workerFactory.shutdownAll()).rejects.toMatchObject({ name: 'AggregateError' });
  } finally {
    workerFactory.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed unknown write stays sticky when a later released write succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-factory-launch-write-chain-sticky-'));
  let rejectUnknown!: (error: unknown) => void;
  let resolveReleased!: () => void;
  let unknownStarted!: () => void;
  let releasedStarted!: () => void;
  const unknownStartedGate = new Promise<void>((resolve) => { unknownStarted = resolve; });
  const releasedStartedGate = new Promise<void>((resolve) => { releasedStarted = resolve; });
  const calls: string[] = [];
  const launchRepository = {
    recordWorkerLaunchExit: async (_workerInstanceId: string, evidence: { readonly cleanup: string }) => {
      calls.push(evidence.cleanup);
      if (evidence.cleanup === 'unknown') {
        unknownStarted();
        return new Promise((_resolve, reject) => { rejectUnknown = reject; }) as never;
      }
      releasedStarted();
      return new Promise((resolve) => { resolveReleased = () => resolve({} as never); }) as never;
    },
  } as unknown as WorkerLaunchRepository;
  const workerFactory = factory(directory, [], undefined, fakeIdentityControl().control,
    async () => TEST_KERNEL_BOOT_ID, undefined, launchRepository);
  const record = (workerFactory as unknown as {
    recordLaunchExit(id: string, evidence: { readonly exited: true; readonly pid: number; readonly cleanup_state?: 'success' | 'failed' }): Promise<void>;
  }).recordLaunchExit.bind(workerFactory);
  const workerInstanceId = '40000000-0000-4000-8000-0000000000d4';
  try {
    const unknown = record(workerInstanceId, { exited: true, pid: 1 });
    await unknownStartedGate;
    rejectUnknown(new Error('unknown launch write failed'));
    await expect(unknown).rejects.toThrow('unknown launch write failed');
    const released = record(workerInstanceId, { exited: true, pid: 1, cleanup_state: 'success' });
    await releasedStartedGate;
    expect(calls).toEqual(['unknown', 'released']);
    resolveReleased();
    await expect(released).resolves.toBeUndefined();
    await expect(workerFactory.shutdownAll()).rejects.toMatchObject({ name: 'AggregateError' });
    await expect(workerFactory.shutdownAll()).rejects.toMatchObject({ name: 'AggregateError' });
  } finally {
    workerFactory.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
