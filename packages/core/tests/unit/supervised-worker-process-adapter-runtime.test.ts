import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupervisedConfigWorkerProcessAdapter } from '../../src/master-runtime/supervised-worker-process-adapter';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  signWorkerDescriptor,
  type ControllerAuthority,
} from '../../src/supervision';

const IDENTITY = {
  master_generation: '53000000-0000-4000-8000-000000000001',
  worker_instance_id: '63000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;
const BOOT = '73000000-0000-4000-8000-000000000001';
const AUTHORITY: ControllerAuthority = {
  controller_epoch: 1,
  controller_id: '83000000-0000-4000-8000-000000000001',
};

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`test timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('adapter runtimeSnapshot spends its 750ms budget while readyClient initialization is pending and never sends late runtime HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-runtime-'));
  const descriptorPath = join(directory, 'worker.json');
  const seed = deriveWorkerSupervisionSeed(new Uint8Array(32).fill(5), IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot);
  const credential = deriveWorkerSupervisionCredential(seed, BOOT);
  let runtimeRequests = 0;
  const readyClient = {
    credential,
    cachedStatus: null,
    state: 'attached',
    subscribeControlState() { return () => undefined; },
    async attach() { return {} as any; },
    async runtimeSnapshot() { runtimeRequests += 1; return {} as any; },
    disconnect() {},
  };
  const adapter = new SupervisedConfigWorkerProcessAdapter({
    identity: IDENTITY,
    descriptorPath,
    supervisionSeed: seed,
    client: { authority: AUTHORITY },
    pid: 43_001,
    initializationTimeoutMs: 5_000,
    clientFor: () => readyClient as any,
  });
  try {
    const started = Date.now();
    const outcome = await within(adapter.runtimeSnapshot().then(() => null, (error) => error), 950);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(900);
    expect(runtimeRequests).toBe(0);

    const descriptor = signWorkerDescriptor({
      schema: 'bungee-worker-descriptor-v1', role: 'worker', ...IDENTITY, boot_nonce: BOOT,
      pid: 43_001, control_port: 41_003, phase: 'candidate', frozen: true,
      private_port: null, revision: null, content_hash: null, plugin_catalog_hash: null,
      started_at: Date.now(), evidence: { kind: 'candidate' },
    }, credential.process_key);
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    await within(adapter.initialization, 500);
    await Bun.sleep(40);
    expect(runtimeRequests).toBe(0);
  } finally {
    adapter.disconnect();
    await adapter.initialization.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 3_000);

test('a preaborted adapter runtimeSnapshot rejects before pending initialization and has no late runtime request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-runtime-'));
  const descriptorPath = join(directory, 'worker.json');
  const seed = deriveWorkerSupervisionSeed(new Uint8Array(32).fill(6), IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot);
  const credential = deriveWorkerSupervisionCredential(seed, BOOT);
  let runtimeRequests = 0;
  const adapter = new SupervisedConfigWorkerProcessAdapter({
    identity: IDENTITY,
    descriptorPath,
    supervisionSeed: seed,
    client: { authority: AUTHORITY },
    pid: 43_002,
    initializationTimeoutMs: 5_000,
    clientFor: () => ({
      credential, cachedStatus: null, state: 'attached', subscribeControlState: () => () => undefined,
      async attach() { return {} as any; },
      async runtimeSnapshot() { runtimeRequests += 1; return {} as any; },
      disconnect() {},
    }) as any,
  });
  const abort = new AbortController();
  abort.abort('caller cancelled');
  try {
    const outcome = await within(adapter.runtimeSnapshot(abort.signal).then(() => null, (error) => error), 100);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain('disconnected');
    expect(runtimeRequests).toBe(0);
    await Bun.sleep(800);
    expect(runtimeRequests).toBe(0);
  } finally {
    adapter.disconnect();
    await adapter.initialization.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 2_000);
