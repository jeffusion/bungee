import { expect, test } from 'bun:test';
import { DEFAULT_PUBLICATION_POLICY } from '@jeffusion/bungee-types';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { drainWorkers } from '../../src/config-publication/drain-workers';
import { timeoutScheduler } from '../../src/config-worker/timeout-scheduler';
import { captureProcessIdentity, probeProcessIdentity } from '../../src/master-runtime/process-identity';
import { WorkerControllerClient } from '../../src/master-runtime/supervised-worker-client';
import { SupervisedConfigWorkerProcessAdapter, type ProcessIdentityControl } from '../../src/master-runtime/supervised-worker-process-adapter';
import { logger } from '../../src/logger';
import { readShutdownDiagnostic, SHUTDOWN_DIAGNOSTIC_MESSAGE } from '../../src/master-runtime/shutdown-diagnostics';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  signWorkerDescriptor,
  type ControllerAuthority,
} from '../../src/supervision';
import { startCurrentMessage, drainMessage, TEST_KERNEL_BOOT_ID } from './config-publication-worker-runtime.fixtures';

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

test.each(['expired', 'rejected'] as const)('drain command %s retains the original error and emits sanitized CI evidence', async (mode) => {
  const seed = deriveWorkerSupervisionSeed(new Uint8Array(32).fill(5), IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot);
  const credential = deriveWorkerSupervisionCredential(seed, BOOT);
  const failure = Object.assign(new Error('drain request failed api_key=hidden-drain-key'), { code: 'timeout' });
  let drainRequests = 0;
  const readyClient = {
    credential, cachedStatus: null, state: 'attached',
    subscribeControlState: () => () => undefined,
    async drain() { drainRequests += 1; throw failure; },
    async status() { return { evidence: { kind: 'ready' } }; },
    disconnect() {},
  };
  const adapter = new SupervisedConfigWorkerProcessAdapter({
    identity: IDENTITY, descriptorPath: 'unused', supervisionSeed: seed,
    client: { authority: AUTHORITY }, pid: 43_003, readyClient: readyClient as any,
    processIdentity: identityControl, kernelBootId: async () => TEST_KERNEL_BOOT_ID,
  });
  await adapter.initialization;
  const calls: Array<{ context: any; message?: string }> = [];
  const original = logger.error;
  logger.error = ((context: any, message?: string) => { calls.push({ context, message }); }) as typeof logger.error;
  try {
    const command = { ...drainMessage(), ...IDENTITY, command: 'drain-worker' as const, pid: adapter.pid, boot_nonce: BOOT,
      ...(mode === 'expired' ? { start_deadline_ns: '0' } : {}) };
    const error = await adapter.send(command).then(() => null, error => error);
    if (mode === 'expired') expect(error?.message).toContain('expired before control dispatch');
    else expect(error).toBe(failure);
    expect(drainRequests).toBe(mode === 'expired' ? 0 : 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe(SHUTDOWN_DIAGNOSTIC_MESSAGE);
    const diagnostic = readShutdownDiagnostic(calls[0]?.context.shutdown);
    expect(diagnostic).toMatchObject({ stage: 'worker_drain_command', pid: 43_003, origin: 'adopted',
      commandOutcome: 'failed', deadlineExceeded: mode === 'expired',
      timeoutMs: command.policy.drain_start_timeout_ms, elapsedMs: expect.any(Number) });
    if (mode === 'rejected') expect(diagnostic?.error).toMatchObject({ code: 'timeout',
      message: 'drain request failed api_key=[REDACTED]' });
    expect(JSON.stringify(diagnostic)).not.toContain('hidden-drain-key');
  } finally {
    adapter.disconnect();
    logger.error = original;
  }
});

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

test.each([[0, 'within budget'], [750, 'within budget'], [750, 'deadline exceeded']] as const)('真实进程可终止性故障注入：drain边界由shutdown解除并产生exact exit evidence (prepare response delay %ims, %s)', async (prepareDelayMs, scenario) => {
  const expectSetupTimeout = scenario === 'deadline exceeded';
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
  let client: WorkerControllerClient | undefined;
  let setupFailure: Error | undefined;
  let childExitObserved = false;
  let childStdoutBuffer = '';
  let stderrTail = '';
  let phase = 'spawn';
  let phaseStartedAt = performance.now();
  let setupDeadline = performance.now() + 15_000;
  const requests: Array<{ path: string; command?: string; status?: number; elapsedMs: number; errorCode?: string; startedAt: number; completed: boolean }> = [];
  const prepare = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    phase = name; phaseStartedAt = performance.now();
    const remaining = setupDeadline - performance.now();
    if (remaining <= 0) throw new Error(`fixture preparation deadline expired before ${name}`);
    return within(operation(), remaining);
  };
  // Observe only endpoint/command/timing. Never retain signed messages or headers.
  const observedFetch: typeof fetch = (async (input, init) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const command = ['start-current-config-worker', 'start-config-worker', 'drain-worker'].includes(body?.body?.command)
      ? body.body.command : undefined;
    const entry = { path, command, elapsedMs: 0, startedAt: performance.now(), completed: false } as (typeof requests)[number];
    requests.push(entry); if (requests.length > 16) requests.shift();
    const started = performance.now();
    try {
      const response = await fetch(input, init);
      entry.status = response.status;
      // A slow descriptor write/response must not consume the later drain budget.
      if (phase === 'attach' && path === '/__supervision/lease' && prepareDelayMs) await Bun.sleep(prepareDelayMs);
      return response;
    } catch (error) { entry.errorCode = (error as { code?: string })?.code ?? 'request_failed'; throw error; }
    finally { entry.elapsedMs = Math.round(performance.now() - started); entry.completed = true; }
  }) as typeof fetch;
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
        BUNGEE_WORKER_DESCRIPTOR_PATH: descriptorPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', rejectChildError);
    child.stdout?.on('data', (chunk: Buffer) => consumeChildStdout(chunk.toString('utf8')));
    child.stdout?.on('end', () => consumeChildStdout('', true));
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2048); });
    if (child.pid === undefined) throw new Error('real worker child has no pid');
    const ready = await prepare('ready', () => waitForEvent('ready', Math.max(1, setupDeadline - performance.now())));
    const port = ready.port;
    if (!Number.isSafeInteger(port)) throw new Error('real worker control port is invalid');
    // Model ready consuming almost all preparation time without a 15s sleep.
    if (expectSetupTimeout) setupDeadline = performance.now() + 200;
    client = new WorkerControllerClient({
      baseUrl: `http://127.0.0.1:${port}`, credential, authority: AUTHORITY, fetch: observedFetch,
    });
    await prepare('attach', () => client!.attach());
    const probes: Awaited<ReturnType<typeof captureProcessIdentity>>[] = [];
    adapter = new SupervisedConfigWorkerProcessAdapter({
      identity: IDENTITY,
      descriptorPath,
      supervisionSeed: seed,
      client: { authority: AUTHORITY },
      pid: child.pid,
      readyClient: client,
      processIdentity: {
        capture: (pid, processInstanceId) => captureProcessIdentity(pid, processInstanceId),
        probe: async (captured) => { probes.push(captured); return probeProcessIdentity(captured); },
      },
    });
    await prepare('identity capture', () => adapter!.initialization);
    const start = { ...startCurrentMessage(), ...IDENTITY };
    await prepare('start', () => adapter!.send(start));
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
    phase = 'drain'; phaseStartedAt = performance.now();
    const drain = drainWorkers([worker], timeoutScheduler, DEFAULT_PUBLICATION_POLICY);
    await waitForEvent('drain_enter', 2_000);
    const evidence = await within(drain, 5_000);
    if (events.some(({ event }) => event === 'stop_enter')) await waitForEvent('control_stopped', 2_000);
    expect(events.map(({ event }) => event)).toEqual(expect.arrayContaining(['ready', 'drain_enter', 'stop_enter', 'cleanup', 'control_stopped']));
    expect(events.find(({ event }) => event === 'cleanup')?.count).toBe(1);
    expect(evidence[0]?.exitEvidence).toMatchObject({ exited: true, pid: child.pid,
      terminalDrain: { status: 'worker-drained', cleanup_state: 'success' } });
    expect(exits).toEqual([expect.objectContaining({ exited: true, pid: child.pid,
      terminalDrain: expect.objectContaining({ status: 'worker-drained', cleanup_state: 'success' }) })]);
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
    expect(await adapter.verifyExactExit()).toMatchObject({ exited: true, pid: child.pid,
      terminalDrain: { status: 'worker-drained', cleanup_state: 'success' } });
    unsubscribe();
  } catch (error) {
    const failure = new Error(`real worker fixture failed ${JSON.stringify({ phase,
      elapsedMs: Math.round(performance.now() - phaseStartedAt), prepareDelayMs,
      requests: requests.map(({ path, command, status, elapsedMs, errorCode, startedAt, completed }) => ({
        path, command, status, errorCode, elapsedMs: completed ? elapsedMs : Math.round(performance.now() - startedAt), pending: !completed })),
      events: events.map(({ event }) => event), exitCode: child?.exitCode, signal: child?.signalCode, stderrTail })}`,
      { cause: error });
    if (!expectSetupTimeout) throw failure;
    setupFailure = failure;
  } finally {
    // Ownership starts before adapter initialization; cancel even if attach or
    // identity capture has not handed the ready client over to the adapter yet.
    client?.disconnect(false);
    adapter?.disconnect();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child?.once('exit', () => resolveExit()));
      child.kill();
      try { await within(exited, 1_000); }
      catch (error) { throw new Error(`child cleanup exit timed out: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await rm(directory, { recursive: true, force: true });
  }
  if (expectSetupTimeout) {
    expect(setupFailure?.message).toContain('"phase":"attach"');
    expect(String(setupFailure?.cause)).toContain('test timed out after');
    expect(adapter).toBeUndefined();
    expect(client?.state).toBe('disconnected');
    const sent = requests.length;
    await Bun.sleep(850); // Let the delayed lease response complete after cleanup.
    expect(client?.state).toBe('disconnected');
    expect(requests.length).toBe(sent);
    expect(child?.exitCode !== null || child?.signalCode !== null).toBeTrue();
  }
}, 30_000);

test('真实worker D到期执行HTTP force并取消仍在传输的SSE后持久化cleanup证据', async () => {
  const directory = join(process.cwd(), 'test-results/publication', `worker-force-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const descriptorPath = join(directory, 'worker.json');
  const childEntry = resolve(import.meta.dir, '../fixtures/supervised-worker-termination-child.ts');
  const rootKey = new Uint8Array(32).fill(12);
  const seed = deriveWorkerSupervisionSeed(rootKey, IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot);
  const credential = deriveWorkerSupervisionCredential(seed, BOOT);
  const events: { readonly event: string; readonly [key: string]: unknown }[] = [];
  const waiters = new Map<string, ((event: { readonly event: string; readonly [key: string]: unknown }) => void)[]>();
  let child: ChildProcess | undefined;
  let adapter: SupervisedConfigWorkerProcessAdapter | undefined;
  let stdoutBuffer = '';
  const onEvent = (event: { readonly event: string; readonly [key: string]: unknown }): void => {
    events.push(event);
    for (const resolveEvent of waiters.get(event.event) ?? []) resolveEvent(event);
    waiters.delete(event.event);
  };
  const waitForEvent = async (name: string, ms: number) => {
    const existing = events.find((event) => event.event === name);
    if (existing !== undefined) return existing;
    return await new Promise<{ readonly event: string; readonly [key: string]: unknown }>((resolveEvent, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker event ${name} timed out`)), ms);
      waiters.set(name, [...(waiters.get(name) ?? []), (event) => { clearTimeout(timer); resolveEvent(event); }]);
    });
  };
  try {
    child = spawn(process.execPath, [childEntry, `--bungee-process-identity=${IDENTITY.worker_instance_id}`, '--bungee-test-hold-drain'], {
      cwd: directory,
      env: {
        ...process.env,
        BUNGEE_TEST_WORKER_IDENTITY: JSON.stringify(IDENTITY),
        BUNGEE_TEST_WORKER_BOOT: BOOT,
        BUNGEE_TEST_WORKER_SEED: Buffer.from(rootKey).toString('base64'),
        BUNGEE_TEST_HOLD_DRAIN: '1',
        BUNGEE_WORKER_DESCRIPTOR_PATH: descriptorPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) { try { onEvent(JSON.parse(line)); } catch { /* child diagnostics are assertions below */ } }
    });
    child.stderr?.on('data', () => undefined);
    if (child.pid === undefined) throw new Error('real worker child has no PID');
    const ready = await waitForEvent('ready', 2_000);
    const client = new WorkerControllerClient({ baseUrl: `http://127.0.0.1:${ready.port}`,
      credential, authority: AUTHORITY, timeoutMs: 500 });
    await client.attach();
    adapter = new SupervisedConfigWorkerProcessAdapter({ identity: IDENTITY, descriptorPath, supervisionSeed: seed,
      client: { authority: AUTHORITY, timeoutMs: 500 }, child, readyClient: client });
    await within(adapter.initialization, 2_000);
    const start = { ...startCurrentMessage(), ...IDENTITY };
    await adapter.send(start);
    const privatePort = adapter.cachedStatus?.private_port;
    if (!Number.isSafeInteger(privatePort)) throw new Error('real worker private listener was not ready');
    const response = await fetch(`http://127.0.0.1:${privatePort}/hold`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('real worker SSE response has no body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: stream-open');
    await waitForEvent('stream_started', 1_000);

    const worker = { process: adapter, boot_nonce: BOOT, revision: start.revision,
      content_hash: start.content_hash, plugin_catalog_hash: start.plugin_catalog_hash,
      publication: null, private_port: privatePort as number };
    const evidence = await within(drainWorkers([worker], timeoutScheduler, {
      drain_start_timeout_ms: 5_000, drain_timeout_ms: 1_000, worker_exit_timeout_ms: 5_000,
    }), 8_000);
    const names = events.map(({ event }) => event);
    if (evidence[0]?.exitEvidence === null) {
      let terminal: any = null;
      try { terminal = (JSON.parse(await readFile(descriptorPath, 'utf8')) as any).evidence?.message ?? null; } catch { /* include absence below */ }
      throw new Error(`D-force exit proof missing; childExitCode=${child.exitCode}; terminal=${JSON.stringify(terminal === null
        ? null : { status: terminal.status, cleanup_state: terminal.cleanup_state,
          exit_remaining_ms: terminal.exit_remaining_ms })}; events=${names.join(',')}`);
    }
    expect(names).toContain('force_stop_complete');
    expect(names).toContain('cleanup');
    expect(names).toContain('control_stopped');
    expect(names.some((event) => event === 'upstream_cancelled' || event === 'stream_cancelled')).toBe(true);
    expect(events.find(({ event }) => event === 'cleanup')?.count).toBe(1);
    expect(evidence[0]?.acknowledgementFailure).toMatchObject({ code: 'timeout' });
    expect(evidence[0]?.exitEvidence).toMatchObject({ exited: true, pid: child.pid,
      terminalDrain: { status: 'worker-drain-failed', cleanup_state: 'success' } });
    // OS proof can precede delivery of the child exit event on the next turn.
    if (child.exitCode === null) await within(new Promise<void>(resolveExit => child!.once('exit', () => resolveExit())), 1_000);
    expect(child.exitCode).toBe(0);
  } finally {
    adapter?.disconnect();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child?.once('exit', () => resolveExit()));
      child.kill('SIGTERM');
      await within(exited, 1_000);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 12_000);

test('real C=2s D=1s E=1s lost drain ACK still performs natural cleanup and exits with signed proof', async () => {
  const evidenceDirectory = resolve(import.meta.dir, '../../../../test-results/publication');
  await mkdir(evidenceDirectory, { recursive: true });
  const directory = await mkdtemp(join(evidenceDirectory, 'worker-cde-lost-ack-'));
  const childEntry = resolve(import.meta.dir, '../fixtures/supervised-worker-termination-child.ts');
  const descriptorPath = join(directory, 'worker.json');
  const rootKey = new Uint8Array(32).fill(12);
  const seed = deriveWorkerSupervisionSeed(rootKey, IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot);
  const credential = deriveWorkerSupervisionCredential(seed, BOOT);
  const events: Array<{ readonly event: string; readonly [key: string]: unknown }> = [];
  const waiters = new Map<string, Array<(event: { readonly event: string; readonly [key: string]: unknown }) => void>>();
  let child: ChildProcess | undefined;
  let adapter: SupervisedConfigWorkerProcessAdapter | undefined;
  let stdoutBuffer = '';
  let droppedAcks = 0;
  let drainCompletedAt = 0;
  let ackAbortedAt = 0;
  const onEvent = (event: { readonly event: string; readonly [key: string]: unknown }): void => {
    events.push(event);
    if (event.event === 'drain_complete') drainCompletedAt = performance.now();
    for (const resolveEvent of waiters.get(event.event) ?? []) resolveEvent(event);
    waiters.delete(event.event);
  };
  const waitForEvent = async (name: string, ms: number) => {
    const existing = events.find((event) => event.event === name);
    if (existing !== undefined) return existing;
    return await new Promise<{ readonly event: string; readonly [key: string]: unknown }>((resolveEvent, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker event ${name} timed out`)), ms);
      waiters.set(name, [...(waiters.get(name) ?? []), (event) => { clearTimeout(timer); resolveEvent(event); }]);
    });
  };
  const loseDrainAck: typeof fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const response = await fetch(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as any : null;
    if (new URL(String(input)).pathname === '/__supervision/command' && body?.body?.command === 'drain-worker') {
      droppedAcks += 1;
      await new Promise<void>((resolveDelay, rejectDelay) => {
        let done = false;
        const finish = (error?: Error): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          init?.signal?.removeEventListener('abort', abort);
          if (error === undefined) resolveDelay(); else rejectDelay(error);
        };
        const abort = (): void => { ackAbortedAt = performance.now(); finish(new Error('injected lost drain ACK')); };
        const timer = setTimeout(() => finish(), 3_000);
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return response;
  }) as typeof fetch;
  try {
    child = spawn(process.execPath, [childEntry, `--bungee-process-identity=${IDENTITY.worker_instance_id}`], {
      cwd: directory,
      env: {
        ...process.env,
        BUNGEE_TEST_WORKER_IDENTITY: JSON.stringify(IDENTITY),
        BUNGEE_TEST_WORKER_BOOT: BOOT,
        BUNGEE_TEST_WORKER_SEED: Buffer.from(rootKey).toString('base64'),
        BUNGEE_WORKER_DESCRIPTOR_PATH: descriptorPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) { try { onEvent(JSON.parse(line)); } catch { /* diagnostics are asserted below */ } }
    });
    child.stderr?.on('data', () => undefined);
    if (child.pid === undefined) throw new Error('real worker child has no PID');
    const ready = await waitForEvent('ready', 2_000);
    const client = new WorkerControllerClient({ baseUrl: `http://127.0.0.1:${ready.port}`,
      credential, authority: AUTHORITY, timeoutMs: 5_000, fetch: loseDrainAck });
    await client.attach();
    adapter = new SupervisedConfigWorkerProcessAdapter({ identity: IDENTITY, descriptorPath, supervisionSeed: seed,
      client: { authority: AUTHORITY, timeoutMs: 5_000 }, pid: child.pid, readyClient: client });
    await within(adapter.initialization, 2_000);
    const start = { ...startCurrentMessage(), ...IDENTITY };
    await adapter.send(start);
    const privatePort = adapter.cachedStatus?.private_port;
    if (!Number.isSafeInteger(privatePort)) throw new Error('real worker private listener was not ready');
    const worker = { process: adapter, boot_nonce: BOOT, revision: start.revision,
      content_hash: start.content_hash, plugin_catalog_hash: start.plugin_catalog_hash,
      publication: null, private_port: privatePort as number };
    const drainSentAt = performance.now();
    const evidence = await within(drainWorkers([worker], timeoutScheduler, {
      drain_start_timeout_ms: 2_000, drain_timeout_ms: 1_000, worker_exit_timeout_ms: 1_000,
    }), 7_000);
    const names = events.map(({ event }) => event);
    expect(droppedAcks).toBe(1);
    expect(drainCompletedAt - drainSentAt).toBeGreaterThanOrEqual(0);
    expect(drainCompletedAt - drainSentAt).toBeLessThan(1_000);
    expect(ackAbortedAt - drainSentAt).toBeGreaterThanOrEqual(1_800);
    expect(names).toContain('drain_complete');
    expect(names).toContain('cleanup');
    expect(names).toContain('control_stopped');
    expect(names).not.toContain('force_stop_enter');
    expect(names).not.toContain('shutdown_failed');
    expect(events.find(({ event }) => event === 'cleanup')?.count).toBe(1);
    expect(evidence[0]?.acknowledgementFailure).toBeNull();
    expect(evidence[0]?.exitEvidence).toMatchObject({ exited: true, pid: child.pid,
      terminalDrain: { status: 'worker-drained', cleanup_state: 'success' } });
    expect(child.exitCode).toBe(0);
  } finally {
    adapter?.disconnect();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child?.once('exit', () => resolveExit()));
      child.kill('SIGTERM');
      await within(exited, 1_000);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 9_000);
