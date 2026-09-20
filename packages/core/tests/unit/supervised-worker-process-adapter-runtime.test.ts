import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { drainWorkers } from '../../src/config-publication/drain-workers';
import { timeoutScheduler } from '../../src/config-worker/timeout-scheduler';
import { captureProcessIdentity, probeProcessIdentity } from '../../src/master-runtime/process-identity';
import { WorkerControllerClient } from '../../src/master-runtime/supervised-worker-client';
import { SupervisedConfigWorkerProcessAdapter, type ProcessIdentityControl } from '../../src/master-runtime/supervised-worker-process-adapter';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  signWorkerDescriptor,
  type ControllerAuthority,
} from '../../src/supervision';
import { startCurrentMessage, drainMessage } from './config-publication-worker-runtime.fixtures';

/** Fake exact-process control so adapter initialization never touches the OS. */
const identityControl: ProcessIdentityControl = {
  capture: async (pid, processInstanceId) => ({ pid, startToken: '100', executable: '/usr/bin/bungee', processInstanceId }),
  probe: async () => 'exact',
};

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
    processIdentity: identityControl,
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
    processIdentity: identityControl,
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

test('真实进程可终止性故障注入：drain边界由shutdown解除并产生exact exit evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-adapter-real-termination-'));
  const descriptorPath = join(directory, 'worker.json');
  const childEntry = resolve(import.meta.dir, '../fixtures/supervised-worker-termination-child.ts');
  const rootKey = new Uint8Array(32).fill(11);
  const seed = deriveWorkerSupervisionSeed(rootKey, IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot);
  const credential = deriveWorkerSupervisionCredential(seed, BOOT);
  const events: { readonly event: string; readonly [key: string]: unknown }[] = [];
  const waiters = new Map<string, ((event: { readonly event: string; readonly [key: string]: unknown }) => void)[]>();
  let child: ChildProcess | undefined;
  let adapter: SupervisedConfigWorkerProcessAdapter | undefined;
  let childExitObserved = false;
  let childStdoutBuffer = '';
  let rejectChildError!: (error: unknown) => void;
  const childError = new Promise<never>((_, reject) => { rejectChildError = reject; });
  void childError.catch(() => undefined);
  const onEvent = (event: { readonly event: string; readonly [key: string]: unknown }): void => {
    events.push(event);
    for (const resolveEvent of waiters.get(event.event) ?? []) resolveEvent(event);
    waiters.delete(event.event);
  };
  const waitForEvent = async (name: string, ms: number): Promise<{ readonly event: string; readonly [key: string]: unknown }> => {
    const existing = events.find((event) => event.event === name);
    if (existing !== undefined) return existing;
    const event = new Promise<{ readonly event: string; readonly [key: string]: unknown }>((resolveEvent, reject) => {
      const timer = setTimeout(() => reject(new Error(`child event ${name} timed out`)), ms);
      const resolveOnce = (event: { readonly event: string; readonly [key: string]: unknown }): void => {
        clearTimeout(timer);
        resolveEvent(event);
      };
      waiters.set(name, [...(waiters.get(name) ?? []), resolveOnce]);
    });
    return await Promise.race([event, childError]);
  };
  const consumeChildStdout = (chunk: string, end = false): void => {
    childStdoutBuffer += chunk;
    const lines = childStdoutBuffer.split('\n');
    childStdoutBuffer = end ? '' : (lines.pop() ?? '');
    for (const line of lines.concat(end && childStdoutBuffer.length > 0 ? [childStdoutBuffer] : [])) {
      if (line.trim().length === 0) continue;
      try { onEvent(JSON.parse(line) as { readonly event: string; readonly [key: string]: unknown }); } catch { /* child diagnostics are assertions below */ }
    }
  };
  try {
    child = spawn(process.execPath, [childEntry, `--bungee-process-identity=${IDENTITY.worker_instance_id}`], {
      cwd: directory,
      env: {
        ...process.env,
        BUNGEE_TEST_WORKER_IDENTITY: JSON.stringify(IDENTITY),
        BUNGEE_TEST_WORKER_BOOT: BOOT,
        BUNGEE_TEST_WORKER_SEED: Buffer.from(rootKey).toString('base64'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', rejectChildError);
    child.stdout?.on('data', (chunk: Buffer) => consumeChildStdout(chunk.toString('utf8')));
    child.stdout?.on('end', () => consumeChildStdout('', true));
    child.stderr?.on('data', () => undefined);
    if (child.pid === undefined) throw new Error('real worker child has no pid');
    const ready = await waitForEvent('ready', 2_000);
    const port = ready.port;
    if (!Number.isSafeInteger(port)) throw new Error('real worker control port is invalid');
    const client = new WorkerControllerClient({
      baseUrl: `http://127.0.0.1:${port}`, credential, authority: AUTHORITY, timeoutMs: 500,
    });
    await client.attach();
    const probes: Awaited<ReturnType<typeof captureProcessIdentity>>[] = [];
    adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY,
      descriptorPath,
      supervisionSeed: seed,
      client: { authority: AUTHORITY, timeoutMs: 500 },
      pid: child.pid,
      readyClient: client,
      processIdentity: {
        capture: (pid, processInstanceId) => captureProcessIdentity(pid, processInstanceId),
        probe: async (captured) => { probes.push(captured); return probeProcessIdentity(captured); },
      },
    });
    await within(adapter.initialization, 2_000);
    const start = { ...startCurrentMessage(), ...IDENTITY };
    await adapter.send(start);
    const privatePort = adapter.cachedStatus?.private_port;
    if (!Number.isSafeInteger(privatePort)) throw new Error('real worker private listener was not ready');
    const worker = {
      process: adapter,
      boot_nonce: BOOT,
      revision: start.revision,
      content_hash: start.content_hash,
      plugin_catalog_hash: start.plugin_catalog_hash,
      publication: start.publication,
      private_port: privatePort as number,
    };
    const exits: unknown[] = [];
    const unsubscribe = adapter.subscribeExit((evidence) => exits.push(evidence));
    const drain = drainWorkers([worker], timeoutScheduler, 3_000);
    await waitForEvent('drain_enter', 2_000);
    const evidence = await within(drain, 5_000);
    if (events.some(({ event }) => event === 'stop_enter')) await waitForEvent('control_stopped', 2_000);
    expect(events.map(({ event }) => event)).toEqual(expect.arrayContaining(['ready', 'drain_enter', 'stop_enter', 'cleanup', 'control_stopped']));
    expect(events.find(({ event }) => event === 'cleanup')?.count).toBe(1);
    expect(evidence[0]?.exitEvidence).toEqual({ exited: true, pid: child.pid });
    expect(exits).toEqual([{ exited: true, pid: child.pid }]);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]?.pid).toBe(child.pid);
    expect(probes[0]?.processInstanceId).toBe(IDENTITY.worker_instance_id);
    const childExit = await within(child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolveExit) => {
        child?.once('exit', (code, signal) => { childExitObserved = true; resolveExit({ code, signal }); });
    }), 2_000);
    childExitObserved ||= child.exitCode !== null || child.signalCode !== null;
    expect(childExit.code).toBe(0);
    expect(childExit.signal).toBeNull();
    expect(childExitObserved).toBeTrue();
    expect(await adapter.verifyExactExit()).toEqual({ exited: true, pid: child.pid });
    unsubscribe();
  } finally {
    adapter?.disconnect();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child?.once('exit', () => resolveExit()));
      child.kill();
      try { await within(exited, 1_000); }
      catch (error) { throw new Error(`child cleanup exit timed out: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
