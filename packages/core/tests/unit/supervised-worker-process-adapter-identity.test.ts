import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupervisedConfigWorkerProcessAdapter, type ProcessIdentityControl } from '../../src/master-runtime/supervised-worker-process-adapter';
import {
  ProcessIdentityUnavailableError,
  type CapturedProcessIdentity,
  type ProcessIdentityProbe,
} from '../../src/master-runtime/process-identity';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  signWorkerDescriptor,
  type ControllerAuthority,
} from '../../src/supervision';

const IDENTITY = {
  master_generation: '53000000-0000-4000-8000-0000000000a1',
  worker_instance_id: '63000000-0000-4000-8000-0000000000a1',
  worker_slot: 0,
} as const;
const BOOT = '73000000-0000-4000-8000-0000000000a1';
const AUTHORITY: ControllerAuthority = {
  controller_epoch: 1,
  controller_id: '83000000-0000-4000-8000-0000000000a1',
};
const PID = 52_001;

function spyChild(pid: number) {
  const kills: string[] = [];
  const listeners = new Map<string, () => void>();
  const child = {
    pid,
    unref: () => undefined,
    kill: (signal?: string) => { kills.push(signal ?? 'default'); return true; },
    once: (event: string, listener: () => void) => { listeners.set(event, listener); return child; },
  } as unknown as ChildProcess;
  return { child, kills, emit: (event: string) => listeners.get(event)?.() };
}

function identityControl(overrides: {
  capture?: (pid: number, processInstanceId: string) => Promise<CapturedProcessIdentity>;
  probe?: (expected: CapturedProcessIdentity) => Promise<ProcessIdentityProbe>;
} = {}) {
  const captures: Array<readonly [number, string]> = [];
  const probes: CapturedProcessIdentity[] = [];
  const control: ProcessIdentityControl = {
    capture: async (pid, processInstanceId) => {
      captures.push([pid, processInstanceId]);
      return overrides.capture?.(pid, processInstanceId)
        ?? { pid, startToken: '100', executable: '/usr/bin/bungee', processInstanceId };
    },
    probe: async (expected) => {
      probes.push(expected);
      return overrides.probe?.(expected) ?? 'exact';
    },
  };
  return { control, captures, probes };
}

const SEED = deriveWorkerSupervisionSeed(new Uint8Array(32).fill(3), IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot);
const CREDENTIAL = deriveWorkerSupervisionCredential(SEED, BOOT);

function readyClient(subscriptions?: { count: number }) {
  return {
    credential: CREDENTIAL,
    cachedStatus: null,
    state: 'attached' as const,
    subscribeControlState: () => { if (subscriptions) subscriptions.count += 1; return () => undefined; },
    async attach() { return {} as any; },
    async shutdown() {},
    disconnect() {},
  };
}

async function writeDescriptor(directory: string, pid: number): Promise<string> {
  const descriptorPath = join(directory, 'worker.json');
  await writeFile(descriptorPath, JSON.stringify(signWorkerDescriptor({
    schema: 'bungee-worker-descriptor-v1', role: 'worker', ...IDENTITY, boot_nonce: BOOT,
    pid, control_port: 45_001, phase: 'candidate', frozen: true,
    private_port: null, revision: null, content_hash: null, plugin_catalog_hash: null,
    started_at: 1, evidence: { kind: 'candidate' },
  }, CREDENTIAL.process_key)));
  return descriptorPath;
}

function spawnedAdapter(options: {
  directory: string;
  identity: ReturnType<typeof identityControl>;
  attachLog?: string[];
  shutdownLog?: string[];
  initializationTimeoutMs?: number;
}) {
  const { child, kills, emit } = spyChild(PID);
  const adapter = new SupervisedConfigWorkerProcessAdapter({
    identity: IDENTITY,
    descriptorPath: join(options.directory, 'worker.json'),
    supervisionSeed: SEED,
    client: { authority: AUTHORITY },
    child,
    initializationTimeoutMs: options.initializationTimeoutMs ?? 5_000,
    processIdentity: options.identity.control,
    clientFor: () => ({
      credential: CREDENTIAL, cachedStatus: null, state: 'attached', subscribeControlState: () => () => undefined,
      async attach() { options.attachLog?.push('attach'); return {} as any; },
      async shutdown() { options.shutdownLog?.push('shutdown'); },
      disconnect() {},
    }) as any,
  });
  return { adapter, kills, emitExit: () => emit('exit') };
}

test('spawned initialization captures exact identity before attach, retrying while the marker argv is not ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const order: string[] = [];
    const identity = identityControl({
      capture: async (pid, processInstanceId) => {
        order.push('capture');
        if (order.filter((entry) => entry === 'capture').length < 2) {
          // A freshly exec'd child may not expose its marker argv yet.
          throw new ProcessIdentityUnavailableError('captured process does not carry the requested identity marker');
        }
        return { pid, startToken: '100', executable: '/usr/bin/bungee', processInstanceId };
      },
    });
    await writeDescriptor(directory, PID);
    const { adapter } = spawnedAdapter({ directory, identity, attachLog: order });
    await adapter.initialization;
    expect(order).toEqual(['capture', 'capture', 'attach']);
    expect(identity.captures).toEqual([[PID, IDENTITY.worker_instance_id], [PID, IDENTITY.worker_instance_id]]);
    expect(adapter.capturedProcessIdentity).toEqual({
      pid: PID, startToken: '100', executable: '/usr/bin/bungee', processInstanceId: IDENTITY.worker_instance_id,
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('adopted initialization with a ready client captures exact identity once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const identity = identityControl();
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: readyClient() as any, processIdentity: identity.control,
    });
    await adapter.initialization;
    expect(identity.captures).toEqual([[PID, IDENTITY.worker_instance_id]]);
    expect(adapter.capturedProcessIdentity?.processInstanceId).toBe(IDENTITY.worker_instance_id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a spawned worker whose capture never proves the marker stays not ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const attachLog: string[] = [];
    const identity = identityControl({
      capture: async () => { throw new ProcessIdentityUnavailableError('captured process does not carry the requested identity marker'); },
    });
    await writeDescriptor(directory, PID);
    const { adapter } = spawnedAdapter({ directory, identity, attachLog, initializationTimeoutMs: 80 });
    await expect(adapter.initialization).rejects.toThrow('supervised worker initialization timed out');
    expect(adapter.capturedProcessIdentity).toBeNull();
    expect(attachLog).toEqual([]);
    await expect(adapter.status()).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('adopted initialization rejects when capture cannot prove exact identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const subscriptions = { count: 0 };
    const identity = identityControl({
      capture: async () => { throw new ProcessIdentityUnavailableError('process identity sampling timed out'); },
    });
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: readyClient(subscriptions) as any, processIdentity: identity.control,
    });
    await expect(adapter.initialization).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(adapter.capturedProcessIdentity).toBeNull();
    // The ready client's control-state subscription is retained only after capture succeeds.
    expect(subscriptions.count).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('adopted force termination fails closed without any OS signal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const identity = identityControl();
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: readyClient() as any, processIdentity: identity.control,
    });
    await adapter.initialization;
    expect(adapter.capturedProcessIdentity).not.toBeNull();
    await expect(adapter.terminate('force')).rejects.toThrow('worker force termination is unsupported');
    expect(identity.probes).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('graceful termination stays an authenticated client shutdown and force fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const shutdownLog: string[] = [];
    const identity = identityControl();
    await writeDescriptor(directory, PID);
    const { adapter, kills } = spawnedAdapter({ directory, identity, shutdownLog });
    await adapter.initialization;
    const captured = adapter.capturedProcessIdentity;
    if (captured === null) throw new Error('exact identity was not captured');
    expect(captured.processInstanceId).toBe(IDENTITY.worker_instance_id);
    await adapter.terminate('graceful');
    expect(shutdownLog).toEqual(['shutdown']);
    // Even with a captured identity, force never sends an OS signal — with or without
    // one it fails closed and the caller retains ownership.
    await expect(adapter.terminate('force')).rejects.toThrow('worker force termination is unsupported');
    expect(kills).toEqual([]);
    expect(identity.probes).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('force termination without a captured identity fails closed and never touches the child handle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const identity = identityControl();
    const { adapter, kills } = spawnedAdapter({ directory, identity, initializationTimeoutMs: 40 });
    await adapter.initialization.catch(() => undefined);
    expect(adapter.capturedProcessIdentity).toBeNull();
    await expect(adapter.terminate('force')).rejects.toThrow('worker force termination is unsupported');
    expect(kills).toEqual([]);
    expect(identity.probes).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a child exit event is sufficient spawned exit proof without probing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const identity = identityControl();
    await writeDescriptor(directory, PID);
    const { adapter, emitExit } = spawnedAdapter({ directory, identity });
    await adapter.initialization;
    emitExit();
    expect(await adapter.verifyExactExit()).toEqual({ exited: true, pid: PID });
    expect(identity.probes).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a dead probe after adopted graceful shutdown publishes exit evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const identity = identityControl({ probe: async () => 'dead' });
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: readyClient() as any, processIdentity: identity.control,
    });
    await adapter.initialization;
    const evidence: unknown[] = [];
    adapter.subscribeExit((value) => evidence.push(value));
    await adapter.terminate('graceful');
    expect(await adapter.verifyExactExit()).toEqual({ exited: true, pid: PID });
    expect(evidence).toEqual([{ exited: true, pid: PID }]);
    expect(await adapter.verifyExactExit()).toEqual({ exited: true, pid: PID });
    expect(identity.probes).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a mismatch probe proves the old instance is gone even though the PID survives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const identity = identityControl({ probe: async () => 'mismatch' });
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: readyClient() as any, processIdentity: identity.control,
    });
    await adapter.initialization;
    expect(await adapter.verifyExactExit()).toEqual({ exited: true, pid: PID });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an exact probe reports the process as still alive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const identity = identityControl({ probe: async () => 'exact' });
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: readyClient() as any, processIdentity: identity.control,
    });
    await adapter.initialization;
    expect(await adapter.verifyExactExit()).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unknown probe throws a sanitized error while ownership is retained', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    let probeResult: ProcessIdentityProbe = 'unknown';
    const identity = identityControl({ probe: async () => probeResult });
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: readyClient() as any, processIdentity: identity.control,
    });
    await adapter.initialization;
    const evidence: unknown[] = [];
    adapter.subscribeExit((value) => evidence.push(value));
    const failure = await adapter.verifyExactExit().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(IDENTITY.worker_instance_id);
    expect(evidence).toEqual([]);
    // Ownership is retained: a later exact probe still reports alive, and force stays
    // unavailable (it fails closed rather than ever signaling the OS).
    probeResult = 'exact';
    expect(await adapter.verifyExactExit()).toBeNull();
    await expect(adapter.terminate('force')).rejects.toThrow('worker force termination is unsupported');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('disconnect after a failed capture releases the discovery ready client exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-identity-'));
  try {
    const disconnects = { count: 0 };
    const identity = identityControl({
      capture: async () => { throw new ProcessIdentityUnavailableError('process identity sampling timed out'); },
    });
    const discoveryClient = {
      credential: CREDENTIAL, cachedStatus: null, state: 'attached' as const,
      subscribeControlState: () => () => undefined,
      async attach() { return {} as any; },
      async shutdown() {},
      disconnect: () => { disconnects.count += 1; },
    };
    const adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY, descriptorPath: join(directory, 'worker.json'), supervisionSeed: SEED,
      client: { authority: AUTHORITY }, pid: PID, readyClient: discoveryClient as any, processIdentity: identity.control,
    });
    await expect(adapter.initialization).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    // The capture failed before the ready client was retained as this.client, yet it must
    // still be released — idempotently, exactly once across repeated disconnects.
    adapter.disconnect();
    adapter.disconnect();
    expect(disconnects.count).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
