import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WorkerControllerClient, WorkerControllerClientError, type WorkerControllerClientTimers } from '../../src/master-runtime/supervised-worker-client';
import { createConfigWorkerRuntimeController } from '../../src/config-publication';
import { drainWorkers } from '../../src/config-publication/drain-workers';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  hashSupervisionBody,
  MAX_WORKER_RUNTIME_SNAPSHOT_RECORDS,
  signSupervisionMessage,
  WorkerSupervisionHttpServer,
  type ControllerAuthority,
  type WorkerRuntimeSnapshot,
  type WorkerRuntimeSnapshotInput,
} from '../../src/supervision';
import { drainMessage, startCurrentMessage } from '../unit/config-publication-worker-runtime.fixtures';

const IDENTITY = {
  master_generation: '51000000-0000-4000-8000-000000000001',
  worker_instance_id: '61000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;
const BOOT = '71000000-0000-4000-8000-000000000001';
const AUTHORITY: ControllerAuthority = {
  controller_epoch: 1,
  controller_id: '81000000-0000-4000-8000-000000000001',
};

type RuntimeProvider = (input: WorkerRuntimeSnapshotInput) => WorkerRuntimeSnapshot;

function virtualTimers() {
  let now = 0;
  let nextHandle = 0;
  const pending = new Map<ReturnType<typeof setTimeout>, { readonly due: number; readonly callback: () => void }>();
  const timers = {
    setTimeout(callback: () => void, delayMs: number) {
      const handle = ++nextHandle as unknown as ReturnType<typeof setTimeout>;
      pending.set(handle, { due: now + Math.max(0, delayMs), callback });
      return handle;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) { pending.delete(handle); },
  };
  return {
    timers,
    get now() { return now; },
    advance(delayMs: number) {
      now += delayMs;
      while (true) {
        const due = [...pending.entries()].filter(([, timer]) => timer.due <= now).sort(([, left], [, right]) => left.due - right.due)[0];
        if (due === undefined) return;
        pending.delete(due[0]);
        due[1].callback();
      }
    },
  };
}

function record(index: number, padding = '') {
  return {
    state_key: `state-${index}${padding}`,
    upstream_id: `upstream-${index}`,
    circuit_state: 'HEALTHY' as const,
    active_request_count: 0,
    last_used_time: null,
    last_failure_time: null,
    consecutive_failures: 0,
    consecutive_successes: 0,
    health_check_successes: 0,
    health_check_failures: 0,
    recovery_attempt_count: 0,
  };
}

function completeSnapshot(input: WorkerRuntimeSnapshotInput, records = [record(1)]): WorkerRuntimeSnapshot {
  return { schema: 'bungee-worker-runtime-snapshot-v1', ...input, result: { kind: 'complete', records } };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

async function workerFixture(provider: RuntimeProvider = completeSnapshot, options: {
  readonly timers?: WorkerControllerClientTimers;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly leaseDurationMs?: number;
  readonly renewBeforeMs?: number;
  readonly clock?: () => number;
} = {}) {
  const credential = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(new Uint8Array(32).fill(9), IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot),
    BOOT,
  );
  const runtime = {
    async apply(input: any) {
      if (input.command === 'start-current-config-worker' || input.command === 'start-config-worker') {
        return { ok: true as const, message: {
          status: 'config-ready' as const, ...IDENTITY, boot_nonce: BOOT, pid: process.pid,
          revision: input.revision, content_hash: input.content_hash, plugin_catalog_hash: input.plugin_catalog_hash,
          private_port: 41_003, plugin_runtime_generation: 1, required_plugins: [], serving_plugins: [], publication: input.publication,
        } };
      }
      return { ok: true as const, message: {
        status: 'worker-drained' as const, ...IDENTITY, boot_nonce: BOOT, pid: process.pid,
        revision: input.revision, content_hash: input.content_hash, plugin_catalog_hash: input.plugin_catalog_hash, publication: input.publication,
      } };
    },
    async failClosed() {},
  };
  const worker = new WorkerSupervisionHttpServer({ credential, identity: IDENTITY, runtime: runtime as any,
    masterControlPort: 3011, controlPort: 0, runtimeSnapshotProvider: provider, clock: options.clock });
  await worker.listen();
  const client = new WorkerControllerClient({
    baseUrl: `http://127.0.0.1:${worker.port}`,
    credential,
    authority: AUTHORITY,
    timeoutMs: 1_000,
    leaseDurationMs: 5_000,
    renewBeforeMs: 1_000,
    ...options,
  });
  return { credential, worker, client };
}

async function serve(worker: Awaited<ReturnType<typeof workerFixture>>) {
  await worker.client.attach();
  await worker.client.start({ ...startCurrentMessage(), ...IDENTITY });
}

async function stop(worker: Awaited<ReturnType<typeof workerFixture>>) {
  worker.client.disconnect(false);
  await worker.worker.stop();
}

async function realShutdownFixture(options: { readonly leaseDurationMs?: number; readonly fetcher?: typeof fetch } = {}) {
  const credential = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(new Uint8Array(32).fill(10), IDENTITY.master_generation, IDENTITY.worker_instance_id, IDENTITY.worker_slot),
    BOOT,
  );
  let releaseDrain!: () => void;
  let drainStarted!: () => void;
  const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const drainReady = new Promise<void>((resolve) => { drainStarted = resolve; });
  let stopCalls = 0;
  let shutdownCalls = 0;
  const runtime = createConfigWorkerRuntimeController({
    pid: process.pid,
    identity: IDENTITY,
    bootNonce: BOOT,
    lifecycle: {
      async start() {
        return { handle: {}, private_port: 41_004, plugin_runtime_generation: 1,
          plugin_status: { generation: 1, appliedAt: new Date().toISOString(), plugins: [], summary: { total: 0, serving: 0, disabled: 0, degraded: 0, quarantined: 0 } } } as any;
      },
      async stopAccepting() {},
      async drain() { drainStarted(); await drainGate; },
      async stop() { stopCalls += 1; releaseDrain(); },
    },
    compileSnapshot: (command) => ({ revision: command.revision, content_hash: command.content_hash, config: { config_version: 4, routes: [] } } as any),
  });
  const worker = new WorkerSupervisionHttpServer({ credential, identity: IDENTITY, runtime,
    masterControlPort: 3011, controlPort: 0, onShutdown: async () => { shutdownCalls += 1; await runtime.failClosed(); } });
  await worker.listen();
  const client = new WorkerControllerClient({
    baseUrl: `http://127.0.0.1:${worker.port}`, credential, authority: AUTHORITY,
    timeoutMs: 500, leaseDurationMs: options.leaseDurationMs ?? 5_000, renewBeforeMs: 1_000,
    fetch: options.fetcher,
  });
  return { worker, client, credential, drainReady, releaseDrain, get stopCalls() { return stopCalls; }, get shutdownCalls() { return shutdownCalls; } };
}

function runtimeClient(baseUrl: string, fixture: Awaited<ReturnType<typeof workerFixture>>, fetcher?: typeof fetch, sequence = 10_000) {
  const client = new WorkerControllerClient({ baseUrl, credential: fixture.credential, authority: AUTHORITY, fetch: fetcher });
  // The primary controller obtained this signed status through the real worker before this observer probes its runtime endpoint.
  (client as any).lastStatus = fixture.client.cachedStatus;
  (client as any).sequence = sequence;
  return client;
}

function drainBody(client: WorkerControllerClient) {
  const status = client.cachedStatus!;
  return { command: 'drain-worker' as const, ...IDENTITY, revision: status.revision!, content_hash: status.content_hash!,
    plugin_catalog_hash: status.plugin_catalog_hash!, publication: null };
}

function assertIdentity(snapshot: WorkerRuntimeSnapshot) {
  expect(snapshot).toMatchObject({
    master_generation: IDENTITY.master_generation,
    worker_instance_id: IDENTITY.worker_instance_id,
    worker_slot: IDENTITY.worker_slot,
    boot_nonce: BOOT,
    pid: process.pid,
    private_port: 41_003,
    revision: 7,
  });
}

describe('worker runtime signed HTTP integration', () => {
  test('cancels a first renewal attempt before the drain acknowledgement budget expires', async () => {
    const clock = virtualTimers();
    let renewalAttempts = 0;
    let drainRequests = 0;
    let drainRequestAt: number | null = null;
    let holdRenewals = false;
    let firstAttemptEntered!: () => void;
    let firstAttemptSettled!: () => void;
    let secondAttemptEntered!: () => void;
    let secondAttemptSettled!: () => void;
    let drainEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstAttemptEntered = resolve; });
    const firstSettled = new Promise<void>((resolve) => { firstAttemptSettled = resolve; });
    const secondEntered = new Promise<void>((resolve) => { secondAttemptEntered = resolve; });
    const secondSettled = new Promise<void>((resolve) => { secondAttemptSettled = resolve; });
    const drainRequestEntered = new Promise<void>((resolve) => { drainEntered = resolve; });
    const states: string[] = [];
    const renewalTransport: typeof fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (holdRenewals && path === '/__supervision/lease') {
        renewalAttempts += 1;
        const entered = renewalAttempts === 1 ? firstAttemptEntered : secondAttemptEntered;
        const settled = renewalAttempts === 1 ? firstAttemptSettled : secondAttemptSettled;
        entered();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          const abort = () => { settled(); reject(new DOMException('cancelled', 'AbortError')); };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      if (path === '/__supervision/command'
        && typeof init?.body === 'string' && (JSON.parse(init.body) as any).body?.command === 'drain-worker') drainRequests += 1;
      if (drainRequests === 1) { drainRequestAt = clock.now; drainEntered(); }
      return fetch(input, init);
    }) as typeof fetch;
    const fixture = await workerFixture(completeSnapshot, {
      timers: clock.timers, fetch: renewalTransport, timeoutMs: 5_000, leaseDurationMs: 60_000, renewBeforeMs: 1_000,
    });
    const client = fixture.client;
    const unsubscribe = client.subscribeControlState((state) => states.push(state));
    try {
      await client.attach();
      await client.start({ ...startCurrentMessage(), ...IDENTITY });
      holdRenewals = true;
      const renewal = client.lease().catch((error) => error);
      await firstEntered;
      const queuedRenewal = client.lease().catch((error) => error);

      const listeners = new Set<(message: unknown) => void>();
      const exits = new Set<(evidence: { readonly exited: true; readonly pid: number }) => void>();
      const workerProcess = {
        slot: IDENTITY.worker_slot, identity: IDENTITY, pid: process.pid,
        async send(message: any) {
          const status = await client.command(message);
          if (status.evidence.kind !== 'drained') throw new Error('drain ACK evidence was not drained');
          expect(status.evidence.message).toMatchObject({ status: 'worker-drained', ...IDENTITY, boot_nonce: BOOT,
            pid: process.pid, revision: message.revision, content_hash: message.content_hash,
            plugin_catalog_hash: message.plugin_catalog_hash, publication: message.publication });
          for (const listener of listeners) listener(status.evidence.message);
        },
        subscribeMessage(listener: (message: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        subscribeExit(listener: (evidence: { readonly exited: true; readonly pid: number }) => void) { exits.add(listener); return () => exits.delete(listener); },
        async terminate() { for (const listener of exits) listener({ exited: true, pid: process.pid }); },
      };
      const status = client.cachedStatus!;
      const drain = drainWorkers([{
        process: workerProcess,
        boot_nonce: BOOT,
        revision: status.revision!, content_hash: status.content_hash!, plugin_catalog_hash: status.plugin_catalog_hash!,
        publication: null, private_port: status.private_port!,
      }], {
        schedule(delayMs: number, callback: () => void) {
          const timer = clock.timers.setTimeout(callback, delayMs);
          return { cancel: () => clock.timers.clearTimeout(timer) };
        },
      }, 30_000);
      clock.advance(5_000);
      await firstSettled;
      const next = await Promise.race([
        drainRequestEntered.then(() => 'drain' as const),
        secondEntered.then(() => 'retry' as const),
      ]);
      if (next === 'retry') {
        clock.advance(5_000);
        await secondSettled;
      }
      const evidence = await drain;
      const observed = {
        renewalAttempts,
        drainRequests,
        drainRequestAt,
        acknowledgementFailure: evidence[0]?.acknowledgementFailure?.code ?? null,
        blockedStates: states.filter((state) => state === 'unavailable' || state === 'recovering'),
      };
      expect(observed).toMatchObject({ renewalAttempts: 1, drainRequests: 1, drainRequestAt: 5_000, acknowledgementFailure: null, blockedStates: [] });
      await renewal;
      expect(await queuedRenewal).toMatchObject({ code: 'timeout' });
      const attemptsAfterDrain = renewalAttempts;
      clock.advance(60_000);
      expect(renewalAttempts).toBe(attemptsAfterDrain);
    } finally {
      unsubscribe();
      client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 3_000);

  test('cancels the second in-flight renewal attempt before sending drain', async () => {
    const clock = virtualTimers();
    let renewalAttempts = 0;
    let drainRequests = 0;
    let holdRenewals = false;
    let firstAttemptEntered!: () => void;
    let firstAttemptSettled!: () => void;
    let secondAttemptEntered!: () => void;
    let secondAttemptSettled!: () => void;
    let drainEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstAttemptEntered = resolve; });
    const firstSettled = new Promise<void>((resolve) => { firstAttemptSettled = resolve; });
    const secondEntered = new Promise<void>((resolve) => { secondAttemptEntered = resolve; });
    const secondSettled = new Promise<void>((resolve) => { secondAttemptSettled = resolve; });
    const drainRequestEntered = new Promise<void>((resolve) => { drainEntered = resolve; });
    const states: string[] = [];
    const renewalTransport: typeof fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (holdRenewals && path === '/__supervision/lease') {
        renewalAttempts += 1;
        const entered = renewalAttempts === 1 ? firstAttemptEntered : secondAttemptEntered;
        const settled = renewalAttempts === 1 ? firstAttemptSettled : secondAttemptSettled;
        entered();
        return await new Promise<Response>((_, reject) => {
          const abort = () => { settled(); reject(new DOMException('cancelled', 'AbortError')); };
          init?.signal?.addEventListener('abort', abort, { once: true });
          if (init?.signal?.aborted) abort();
        });
      }
      if (path === '/__supervision/command' && typeof init?.body === 'string'
        && (JSON.parse(init.body) as any).body?.command === 'drain-worker') drainRequests += 1;
      if (drainRequests === 1) drainEntered();
      return fetch(input, init);
    }) as typeof fetch;
    const fixture = await workerFixture(completeSnapshot, {
      timers: clock.timers, fetch: renewalTransport, timeoutMs: 5_000, leaseDurationMs: 60_000, renewBeforeMs: 1_000,
    });
    const unsubscribe = fixture.client.subscribeControlState((state) => states.push(state));
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      holdRenewals = true;
      const renewal = fixture.client.lease().catch((error) => error);
      await firstEntered;
      clock.advance(5_000);
      await firstSettled;
      await secondEntered;
      const drain = fixture.client.drain(drainBody(fixture.client));
      await drainRequestEntered;
      await withTimeout(drain, 100);
      await secondSettled;
      expect(await renewal).toMatchObject({ code: 'timeout' });
      expect({ renewalAttempts, drainRequests, blockedStates: states.filter((state) => state === 'unavailable' || state === 'recovering') })
        .toEqual({ renewalAttempts: 2, drainRequests: 1, blockedStates: [] });
      const attemptsAfterDrain = renewalAttempts;
      clock.advance(60_000);
      expect(renewalAttempts).toBe(attemptsAfterDrain);
    } finally {
      unsubscribe();
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 3_000);

  test('does not accept an already-served lease response after drain cancellation', async () => {
    const clock = virtualTimers();
    let holdRenewals = false;
    let leaseResponseReady!: () => void;
    const leaseReady = new Promise<void>((resolve) => { leaseResponseReady = resolve; });
    let releaseLateResponse!: () => void;
    let bodyCancelled!: () => void;
    const lateBodyCancelled = new Promise<void>((resolve) => { bodyCancelled = resolve; });
    let bodyCancels = 0;
    let renewalRequests = 0;
    let lateResponse: Response | undefined;
    const fetcher: typeof fetch = (async (input, init) => {
      if (holdRenewals && new URL(String(input)).pathname === '/__supervision/lease') {
        renewalRequests += 1;
        const upstream = await fetch(input, init);
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(bytes); controller.close(); },
          cancel() { bodyCancels += 1; bodyCancelled(); },
        });
        lateResponse = new Response(body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
        leaseResponseReady();
        return await new Promise<Response>((resolve) => {
          releaseLateResponse = () => resolve(lateResponse!);
        });
      }
      return fetch(input, init);
    }) as typeof fetch;
    const fixture = await workerFixture(completeSnapshot, {
      timers: clock.timers, fetch: fetcher, timeoutMs: 5_000, leaseDurationMs: 60_000, renewBeforeMs: 1_000,
    });
    const states: string[] = [];
    const unsubscribe = fixture.client.subscribeControlState((state) => states.push(state));
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      holdRenewals = true;
      const before = fixture.client.cachedStatus;
      const renewal = fixture.client.lease().catch((error) => error);
      await leaseReady;
      const drain = await withTimeout(fixture.client.drain(drainBody(fixture.client)), 100);
      const afterDrain = fixture.client.cachedStatus;
      const stateAfterDrain = fixture.client.state;
      releaseLateResponse();
      await lateBodyCancelled;
      expect(await renewal).toMatchObject({ code: 'timeout' });
      expect(bodyCancels).toBe(1);
      expect(renewalRequests).toBe(1);
      expect(fixture.client.cachedStatus).toBe(afterDrain);
      expect(afterDrain).not.toBe(before);
      expect(drain.phase).toBe('draining');
      expect(fixture.client.state).toBe(stateAfterDrain);
      expect(states.filter((state) => state === 'unavailable' || state === 'recovering')).toEqual([]);
    } finally {
      releaseLateResponse?.();
      unsubscribe();
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 3_000);

  test('cancels a supervision response reader locally before drain', async () => {
    const clock = virtualTimers();
    let holdRenewals = false;
    let leaseResponseReady!: () => void;
    let bodyCancelled!: () => void;
    const leaseReady = new Promise<void>((resolve) => { leaseResponseReady = resolve; });
    const readerCancelled = new Promise<void>((resolve) => { bodyCancelled = resolve; });
    let bodyCancels = 0;
    const fetcher: typeof fetch = (async (input, init) => {
      if (holdRenewals && new URL(String(input)).pathname === '/__supervision/lease') {
        const upstream = await fetch(input, init);
        await upstream.arrayBuffer();
        const reader = {
          read: () => {
            leaseResponseReady();
            return new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined);
          },
          cancel: () => { bodyCancels += 1; bodyCancelled(); },
        };
        return { ok: true, status: 200, body: { getReader: () => reader, cancel: reader.cancel } } as unknown as Response;
      }
      return fetch(input, init);
    }) as typeof fetch;
    const fixture = await workerFixture(completeSnapshot, {
      timers: clock.timers, fetch: fetcher, timeoutMs: 5_000, leaseDurationMs: 60_000, renewBeforeMs: 1_000,
    });
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      holdRenewals = true;
      const renewal = fixture.client.lease().catch((error) => error);
      await leaseReady;
      const drain = await withTimeout(fixture.client.drain(drainBody(fixture.client)), 100);
      await withTimeout(readerCancelled, 100);
      expect(await renewal).toMatchObject({ code: 'timeout' });
      expect(bodyCancels).toBe(1);
      expect(drain.phase).toBe('draining');
    } finally {
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 3_000);

  test('fails closed on an expired undelivered lease and keeps shutdown reachable', async () => {
    let workerNow = Date.now();
    const fixture = await workerFixture(completeSnapshot, {
      timeoutMs: 5_000, leaseDurationMs: 5_000, renewBeforeMs: 1_000, clock: () => workerNow,
    });
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      workerNow += 6_000;
      await expect(fixture.client.drain(drainBody(fixture.client))).rejects.toMatchObject({ code: 'http' });
      await expect(fixture.client.shutdown()).resolves.toMatchObject({ phase: 'stopped' });
    } finally {
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 3_000);

  test('rejects invalid start and drain entry points without stopping later lease renewal', async () => {
    const fixture = await workerFixture();
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      await expect(fixture.client.drain(startCurrentMessage() as any)).rejects.toMatchObject({ code: 'protocol' });
      await expect(fixture.client.start(drainMessage() as any)).rejects.toMatchObject({ code: 'protocol' });
      await expect(fixture.client.lease()).resolves.toMatchObject({ phase: 'serving' });
      await expect(fixture.client.lease()).resolves.toMatchObject({ phase: 'serving' });
    } finally {
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 5_000);

  test('does not execute a scheduled recovery attach after drain', async () => {
    const clock = virtualTimers();
    let holdRenewals = false;
    let renewalAttempts = 0;
    let challengeRequests = 0;
    let secondAttemptEntered!: () => void;
    let recoveryScheduled!: () => void;
    const secondAttempt = new Promise<void>((resolve) => { secondAttemptEntered = resolve; });
    const recoveryTimer = new Promise<void>((resolve) => { recoveryScheduled = resolve; });
    const timers = {
      setTimeout(callback: () => void, delayMs: number) {
        if (delayMs === 250) recoveryScheduled();
        return clock.timers.setTimeout(callback, delayMs);
      },
      clearTimeout: clock.timers.clearTimeout,
    };
    const fetcher: typeof fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (holdRenewals && path === '/__supervision/challenge') challengeRequests += 1;
      if (holdRenewals && path === '/__supervision/lease') {
        renewalAttempts += 1;
        if (renewalAttempts === 2) secondAttemptEntered();
        throw new Error('renewal transport unavailable');
      }
      return fetch(input, init);
    }) as typeof fetch;
    const fixture = await workerFixture(completeSnapshot, {
      timers, fetch: fetcher, timeoutMs: 5_000, leaseDurationMs: 5_000, renewBeforeMs: 1_000,
    });
    const states: string[] = [];
    const unsubscribe = fixture.client.subscribeControlState((state) => states.push(state));
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      holdRenewals = true;
      clock.advance(4_000);
      await secondAttempt;
      await recoveryTimer;
      const stateCountBeforeDrain = states.length;
      await fixture.client.drain(drainBody(fixture.client));
      clock.advance(250);
      expect(challengeRequests).toBe(0);
      expect(renewalAttempts).toBe(2);
      expect(states.slice(stateCountBeforeDrain)).not.toContain('recovering');
      expect(states.slice(stateCountBeforeDrain)).not.toContain('unavailable');
    } finally {
      unsubscribe();
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 3_000);

  test('returns a signed serving snapshot and serializes concurrent status/runtime calls without a sequence fork', async () => {
    const fixture = await workerFixture();
    try {
      await serve(fixture);
      const [status, snapshot] = await Promise.all([fixture.client.status(), fixture.client.runtimeSnapshot()]);
      expect(status.phase).toBe('serving');
      expect(status.frozen).toBeFalse();
      expect(snapshot.result).toEqual({ kind: 'complete', records: [record(1)] });
      assertIdentity(snapshot);
    } finally {
      await stop(fixture);
    }
  }, 5_000);

  test('refuses runtime snapshots before serving and after its lease is frozen', async () => {
    const fixture = await workerFixture();
    try {
      await fixture.client.attach();
      await expect(fixture.client.runtimeSnapshot()).rejects.toMatchObject({ code: 'http' });

      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      const expired = signSupervisionMessage({
        protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
        ...fixture.credential.identity, ...AUTHORITY, sequence: 999, request_id: randomUUID(), lease_expires_at: Date.now() + 20,
      }, fixture.credential);
      const response = await fetch(`http://127.0.0.1:${fixture.worker.port}/__supervision/lease`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(expired),
      });
      expect(response.status).toBe(200);
      await Bun.sleep(40);
      await expect(fixture.client.runtimeSnapshot()).rejects.toMatchObject({ code: 'http' });
    } finally {
      await stop(fixture);
    }
  }, 5_000);

  test('converts record and byte overflows while preserving the complete worker identity', async () => {
    for (const provider of [
      (input: WorkerRuntimeSnapshotInput) => completeSnapshot(input, Array.from({ length: MAX_WORKER_RUNTIME_SNAPSHOT_RECORDS + 1 }, (_, index) => record(index))),
      (input: WorkerRuntimeSnapshotInput) => completeSnapshot(input, Array.from({ length: 500 }, (_, index) => record(index, 'x'.repeat(600)))),
    ] satisfies RuntimeProvider[]) {
      const fixture = await workerFixture(provider);
      try {
        await serve(fixture);
        const snapshot = await fixture.client.runtimeSnapshot();
        expect(snapshot.result.kind).toBe('overflow');
        assertIdentity(snapshot);
      } finally {
        await stop(fixture);
      }
    }
  }, 8_000);

  test('rejects signed runtime replies with wrong authority, correlation, body hash, or full identity, plus a bad MAC', async () => {
    const fixture = await workerFixture();
    const proxyFor = (mode: string) => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      const upstream = await fetch(`http://127.0.0.1:${fixture.worker.port}${new URL(request.url).pathname}`, {
        method: request.method, headers: request.headers, body: request.body,
      });
      if (new URL(request.url).pathname !== '/__supervision/runtime') return upstream;
      if (!upstream.ok) return upstream;
      const value = await upstream.json() as { message: any; body: WorkerRuntimeSnapshot };
      const message = { ...value.message };
      if (mode === 'authority') Object.assign(message, { controller_epoch: 2, controller_id: '82000000-0000-4000-8000-000000000001' });
      if (mode === 'correlation') message.request_id = '82000000-0000-4000-8000-000000000002';
      if (mode === 'identity') value.body = { ...value.body, worker_instance_id: '62000000-0000-4000-8000-000000000001' };
      if (mode === 'bodyhash') message.body_hash = hashSupervisionBody(null);
      const { mac: _mac, ...unsigned } = message;
      const signed = mode === 'bad-mac'
        ? { ...message, mac: `hmac-sha256:${'0'.repeat(64)}` }
        : signSupervisionMessage({ ...unsigned, body_hash: mode === 'bodyhash' ? message.body_hash : hashSupervisionBody(value.body) }, fixture.credential);
      return Response.json({ message: signed, body: value.body });
    } });
    try {
      await serve(fixture);
      for (const [index, mode] of ['authority', 'correlation', 'bodyhash', 'identity', 'bad-mac'].entries()) {
        const proxy = proxyFor(mode);
        const client = runtimeClient(`http://127.0.0.1:${proxy.port}`, fixture, undefined, 10_000 + index);
        try {
          if (mode === 'bad-mac') await expect(client.runtimeSnapshot()).rejects.toThrow('MAC');
          else await expect(client.runtimeSnapshot()).rejects.toMatchObject({ code: 'protocol' });
        } finally {
          client.disconnect(false);
          await proxy.stop(true);
        }
      }
    } finally {
      await stop(fixture);
    }
  }, 10_000);

  test('rejects duplicate JSON and oversized runtime response bodies over real loopback HTTP', async () => {
    const fixture = await workerFixture();
    const proxyFor = (mode: 'duplicate' | 'oversize') => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      if (new URL(request.url).pathname === '/__supervision/runtime' && mode === 'duplicate') {
        return new Response('{"message":{},"message":{}}', { headers: { 'content-type': 'application/json' } });
      }
      if (new URL(request.url).pathname === '/__supervision/runtime' && mode === 'oversize') {
        return new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
      }
      return fetch(`http://127.0.0.1:${fixture.worker.port}${new URL(request.url).pathname}`, {
        method: request.method, headers: request.headers, body: request.body,
      });
    } });
    try {
      await serve(fixture);
      for (const [mode, code] of [['duplicate', 'protocol'], ['oversize', 'response_too_large']] as const) {
        const proxy = proxyFor(mode);
        const client = runtimeClient(`http://127.0.0.1:${proxy.port}`, fixture);
        try {
          await expect(client.runtimeSnapshot()).rejects.toMatchObject({ code });
        } finally {
          client.disconnect(false);
          await proxy.stop(true);
        }
      }
    } finally {
      await stop(fixture);
    }
  }, 8_000);

  test('uses one 750ms absolute runtime deadline across queue waiting and does not retry', async () => {
    const fixture = await workerFixture();
    let runtimeRequests = 0;
    let delayedResponse: Promise<unknown> | undefined;
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      if (new URL(request.url).pathname === '/__supervision/runtime') {
        runtimeRequests += 1;
        delayedResponse = Bun.sleep(850);
        await delayedResponse;
      }
      return fetch(`http://127.0.0.1:${fixture.worker.port}${new URL(request.url).pathname}`, {
        method: request.method, headers: request.headers, body: request.body,
      });
    } });
    const client = runtimeClient(`http://127.0.0.1:${proxy.port}`, fixture);
    try {
      await serve(fixture);
      const first = client.runtimeSnapshot().catch((error) => error);
      while (runtimeRequests === 0) await Bun.sleep(5);
      const started = Date.now();
      const queued = await withTimeout(client.runtimeSnapshot().catch((error) => error), 1_200);
      expect(queued).toMatchObject({ code: 'timeout' });
      expect(Date.now() - started).toBeLessThan(950);
      expect(await first).toMatchObject({ code: 'timeout' });
      // The queued call may expire before it reaches the transport when the
      // event loop resumes after its absolute deadline. Either way, neither
      // call may retry.
      expect(runtimeRequests).toBeGreaterThanOrEqual(1);
      expect(runtimeRequests).toBeLessThanOrEqual(2);
      await delayedResponse;
    } finally {
      client.disconnect(false);
      await proxy.stop(true);
      await stop(fixture);
    }
  }, 5_000);

  test('times out, aborts, disconnects, and releases a body resolved after a hostile transport ignores AbortSignal', async () => {
    const fixture = await workerFixture();
    let resolveLate: ((response: Response) => void) | undefined;
    let closeLate: (() => void) | undefined;
    let lateResolved = false;
    let bodyCancels = 0;
    const lateBody = new ReadableStream<Uint8Array>({
      start(controller) { closeLate = () => { try { controller.close(); } catch {} }; },
      cancel() { bodyCancels += 1; },
    });
    const hostileFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/__supervision/runtime')) return fetch(input, init);
      // hostile fetch is intentional: a real network peer cannot reliably be made to ignore AbortSignal and resolve late.
      return new Promise<Response>((resolve) => { resolveLate = resolve; });
    }) as typeof fetch;
    const client = runtimeClient(`http://127.0.0.1:${fixture.worker.port}`, fixture, hostileFetch);
    try {
      await serve(fixture);
      const pending = client.runtimeSnapshot();
      const outcome = await withTimeout(pending.then(() => null, (error) => error), 1_200);
      expect(outcome).toMatchObject({ code: 'timeout' });
      client.disconnect(false);
      if (!lateResolved) {
        resolveLate?.(new Response(lateBody));
        lateResolved = true;
      }
      await Bun.sleep(20);
      expect(bodyCancels).toBe(1);
    } finally {
      client.disconnect(false);
      if (!lateResolved) resolveLate?.(new Response(lateBody));
      closeLate?.();
      await stop(fixture);
    }
  }, 3_000);

  test('does not let expired runtime probes bypass a pending control request or add per-probe delay after it releases', async () => {
    const fixture = await workerFixture();
    let releaseControl!: () => void;
    let controlStarted!: () => void;
    const controlGate = new Promise<void>((resolve) => { releaseControl = resolve; });
    const controlReady = new Promise<void>((resolve) => { controlStarted = resolve; });
    let runtimeRequests = 0;
    let leaseRequests = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/__supervision/status') {
        controlStarted();
        await controlGate;
      }
      if (path === '/__supervision/runtime') runtimeRequests += 1;
      if (path === '/__supervision/lease') leaseRequests += 1;
      return fetch(input, init);
    }) as typeof fetch;
    const client = runtimeClient(`http://127.0.0.1:${fixture.worker.port}`, fixture, fetcher);
    try {
      await serve(fixture);
      const control = client.status();
      await controlReady;
      const expired = Array.from({ length: 8 }, () => client.runtimeSnapshot().catch((error) => error));
      const laterControl = client.lease();
      await Bun.sleep(800);
      expect(runtimeRequests).toBe(0);
      expect(leaseRequests).toBe(0);
      expect((client as any).sequence).toBe(10_001);
      const releasedAt = Date.now();
      releaseControl();
      await control;
      expect((await Promise.all(expired)).every((error: any) => error?.code === 'timeout')).toBeTrue();
      await withTimeout(laterControl, 700);
      expect(leaseRequests).toBe(1);
      expect(Date.now() - releasedAt).toBeLessThan(500);
      await client.drain(drainBody(client));
    } finally {
      releaseControl?.();
      client.disconnect(false);
      await stop(fixture);
    }
  }, 5_000);

  test('releases the control lane when runtime fetch, read, or cleanup never settles', async () => {
    for (const mode of ['fetch', 'read', 'cancel'] as const) {
      const fixture = await workerFixture();
      const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith('/__supervision/runtime')) return fetch(input, init);
        if (mode === 'fetch') return new Promise<Response>(() => undefined);
        const reader = {
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
          cancel: () => mode === 'cancel' ? new Promise<void>(() => undefined) : undefined,
        };
        return Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response);
      }) as typeof fetch;
      const client = runtimeClient(`http://127.0.0.1:${fixture.worker.port}`, fixture, fetcher);
      try {
        await serve(fixture);
        // Bun 1.4.2 on Windows stalls `.rejects` matchers on unsettled timer-driven
        // promises; capture the rejection with a plain await instead.
        const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
          try { await promise; } catch (caught) { return caught; }
          throw new Error('expected the promise to reject');
        };
        const error = await captureRejection(withTimeout(client.runtimeSnapshot(), 1_200));
        expect(error).toMatchObject({ code: 'timeout' });
        await withTimeout(client.status(), 700);
        await withTimeout(client.lease(), 700);
        await withTimeout(client.drain(drainBody(client)), 700);
      } finally {
        client.disconnect(false);
        await stop(fixture);
      }
    }
  }, 6_000);

  test('fences a late valid high-sequence runtime reply around normal status reads', async () => {
    const fixture = await workerFixture();
    let release!: () => void;
    let lateReady!: () => void;
    const ready = new Promise<void>((resolve) => { lateReady = resolve; });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/__supervision/runtime')) return fetch(input, init);
      const upstream = await fetch(input, init);
      const value = await upstream.json() as { message: any; body: WorkerRuntimeSnapshot };
      const { mac: _mac, ...unsigned } = value.message;
      const message = signSupervisionMessage({ ...unsigned, sequence: 20_000, body_hash: hashSupervisionBody(value.body) }, fixture.credential);
      lateReady();
      return new Promise<Response>((resolve) => { release = () => resolve(Response.json({ message, body: value.body })); });
    }) as typeof fetch;
    const client = runtimeClient(`http://127.0.0.1:${fixture.worker.port}`, fixture, fetcher);
    try {
      await serve(fixture);
      const late = client.runtimeSnapshot().catch((error) => error);
      await ready;
      expect(await withTimeout(late, 1_200)).toMatchObject({ code: 'timeout' });
      await client.status();
      const watermark = (client as any).statusSequence;
      const cached = client.cachedStatus;
      release();
      await Bun.sleep(20);
      expect((client as any).statusSequence).toBe(watermark);
      expect(client.cachedStatus).toBe(cached);
      await client.status();
    } finally {
      release?.();
      client.disconnect(false);
      await stop(fixture);
    }
  }, 5_000);

  test('fences abort, stop, and deadline in the fetch-to-accept microtask handoff', async () => {
    for (const mode of ['abort', 'stop', 'deadline'] as const) {
      const fixture = await workerFixture();
      const originalNow = Date.now;
      let releaseRead!: () => void;
      let interstice!: () => void;
      let ready!: () => void;
      let finalReadReady!: () => void;
      const responseReady = new Promise<void>((resolve) => { ready = resolve; });
      const finalRead = new Promise<void>((resolve) => { finalReadReady = resolve; });
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith('/__supervision/runtime')) return fetch(input, init);
        const upstream = await fetch(input, init);
        const value = await upstream.json() as { message: any; body: WorkerRuntimeSnapshot };
        const { mac: _mac, ...unsigned } = value.message;
        const message = signSupervisionMessage({ ...unsigned, sequence: 20_000, body_hash: hashSupervisionBody(value.body) }, fixture.credential);
        const bytes = new TextEncoder().encode(JSON.stringify({ message, body: value.body }));
        let reads = 0;
        const reader = {
          read: () => reads++ === 0
            ? Promise.resolve({ done: false, value: bytes } as ReadableStreamReadResult<Uint8Array>)
            : new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            releaseRead = () => {
              resolve({ done: true, value: undefined });
              queueMicrotask(interstice);
            };
            finalReadReady();
          }),
          cancel: () => undefined,
        };
        ready();
        return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
      }) as typeof fetch;
      const client = runtimeClient(`http://127.0.0.1:${fixture.worker.port}`, fixture, fetcher);
      const deadline = originalNow() + 5_000;
      const abort = new AbortController();
      try {
        await serve(fixture);
        const before = { statusSequence: (client as any).statusSequence, statusRequestId: (client as any).statusRequestId,
          cachedStatus: client.cachedStatus, controlState: client.state };
        interstice = () => {
          if (mode === 'abort') abort.abort('interstice');
          if (mode === 'stop') client.disconnect(false);
          if (mode === 'deadline') Date.now = () => deadline + 1;
        };
        const pending = client.runtimeSnapshot(mode === 'abort' ? abort.signal : undefined, deadline).catch((error) => error);
        await responseReady;
        await finalRead;
        releaseRead();
        expect(await withTimeout(pending, 700)).toMatchObject({ code: 'timeout' });
        await Bun.sleep(10);
        expect((client as any).statusSequence).toBe(before.statusSequence);
        expect((client as any).statusRequestId).toBe(before.statusRequestId);
        expect(client.cachedStatus).toBe(before.cachedStatus);
        expect(client.state).toBe(mode === 'stop' ? 'disconnected' : before.controlState);
      } finally {
        Date.now = originalNow;
        client.disconnect(false);
        await stop(fixture);
      }
    }
  }, 8_000);

  test('keeps a blocked control tail ordered and accepts a lower lease sequence from its separate direction', async () => {
    const fixture = await workerFixture();
    let releaseControl!: () => void;
    let controlStarted!: () => void;
    const controlGate = new Promise<void>((resolve) => { releaseControl = resolve; });
    const controlReady = new Promise<void>((resolve) => { controlStarted = resolve; });
    const events: string[] = [];
    let statusCalls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/__supervision/status') {
        statusCalls += 1;
        if (statusCalls === 1) {
          events.push('control-start');
          controlStarted();
          await controlGate;
          events.push('control-end');
        } else events.push('later-control');
      }
      if (path === '/__supervision/runtime') events.push('runtime');
      return fetch(input, init);
    }) as typeof fetch;
    const client = runtimeClient(`http://127.0.0.1:${fixture.worker.port}`, fixture, fetcher);
    try {
      await serve(fixture);
      const firstControl = client.status();
      await controlReady;
      const runtime = client.runtimeSnapshot();
      const laterControl = client.status();
      await Bun.sleep(20);
      expect(events).toEqual(['control-start']);
      releaseControl();
      await Promise.all([firstControl, runtime, laterControl]);
      expect(events).toEqual(['control-start', 'control-end', 'runtime', 'later-control']);
      const lease = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
        ...fixture.credential.identity, ...AUTHORITY, sequence: 5, request_id: randomUUID(), lease_expires_at: Date.now() + 5_000 }, fixture.credential);
      const response = await fixture.worker.fetch(new Request('http://127.0.0.1/__supervision/lease', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lease),
      }));
      expect(response.status).toBe(200);
    } finally {
      releaseControl?.();
      client.disconnect(false);
      await stop(fixture);
    }
  }, 5_000);

  test('uses the same real client for start, held drain, and shutdown without reviving drain', async () => {
    let drainRequests = 0;
    const fixture = await realShutdownFixture({
      fetcher: (async (input, init) => {
        if (new URL(String(input)).pathname === '/__supervision/command'
          && typeof init?.body === 'string' && (JSON.parse(init.body) as any).body?.command === 'drain-worker') drainRequests += 1;
        return fetch(input, init);
      }) as typeof fetch,
    });
    try {
      await fixture.client.attach();
      const ready = await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      expect(ready.evidence).toMatchObject({ kind: 'ready', message: { boot_nonce: BOOT, worker_instance_id: IDENTITY.worker_instance_id } });
      expect(fixture.worker.identity.boot_nonce).toBe(fixture.credential.identity.boot_nonce);
      const draining = fixture.client.drain(drainBody(fixture.client)).then(() => null, (error) => error);
      await fixture.drainReady;
      const shutdown = fixture.client.shutdown();
      const status = await withTimeout(shutdown, 500);
      expect(status.phase).toBe('stopped');
      expect(await withTimeout(draining, 500)).toMatchObject({ code: 'timeout' });
      await Bun.sleep(20);
      expect(fixture.stopCalls).toBe(1);
      expect(fixture.shutdownCalls).toBe(1);
      expect(drainRequests).toBe(1);
      expect(fixture.worker.currentPhase).toBe('stopped');
    } finally {
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 5_000);

  test('permits shutdown with the current authority after the lease expires', async () => {
    const fixture = await realShutdownFixture({ leaseDurationMs: 25 });
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      fixture.client.disconnect(false);
      await Bun.sleep(50);
      const status = await withTimeout(fixture.client.shutdown(), 500);
      expect(status.phase).toBe('stopped');
      await Bun.sleep(20);
      expect(fixture.stopCalls).toBe(1);
    } finally {
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 5_000);

  test('does not repeat stop when delivered shutdown responses are lost, then resends with a new sequence', async () => {
    const requests: any[] = [];
    let dropped = 0;
    const fixture = await realShutdownFixture({
      fetcher: (async (input, init) => {
        if (new URL(String(input)).pathname === '/__supervision/command') {
          const request = JSON.parse(String(init?.body));
          if (request.message.path === '/shutdown') requests.push(request);
          const response = await fetch(input, init);
          if (request.message.path === '/shutdown' && dropped < 2) { dropped += 1; throw new Error('lost shutdown response'); }
          return response;
        }
        return fetch(input, init);
      }) as typeof fetch,
    });
    try {
      await fixture.client.attach();
      await fixture.client.start({ ...startCurrentMessage(), ...IDENTITY });
      let firstError: unknown;
      try { await fixture.client.shutdown(); } catch (error) { firstError = error; }
      expect(firstError).toMatchObject({ code: 'network' });
      const status = await withTimeout(fixture.client.shutdown(), 500);
      expect(status.phase).toBe('stopped');
      await Bun.sleep(20);
      expect(requests).toHaveLength(3);
      expect(requests[0].message.request_id).toBe(requests[1].message.request_id);
      expect(requests[0].message.sequence).toBe(requests[1].message.sequence);
      expect(requests[2].message.request_id).not.toBe(requests[0].message.request_id);
      expect(requests[2].message.sequence).toBeGreaterThan(requests[1].message.sequence);
      expect(fixture.stopCalls).toBe(1);
      await expect(fixture.client.start({ ...startCurrentMessage(), ...IDENTITY })).rejects.toMatchObject({ code: 'recovering' });
    } finally {
      fixture.client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 5_000);

  test('clears a rejected shutdown attempt while preserving the terminating fence', async () => {
    const fixture = await workerFixture();
    let attempts = 0;
    const requests: any[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/__supervision/command') {
        const root = JSON.parse(String(init?.body));
        requests.push(root);
        attempts += 1;
        if (attempts <= 2) throw new Error('shutdown transport unavailable');
      }
      return fetch(input, init);
    }) as typeof fetch;
    const client = new WorkerControllerClient({
      baseUrl: `http://127.0.0.1:${fixture.worker.port}`, credential: fixture.credential, authority: AUTHORITY,
      timeoutMs: 100, leaseDurationMs: 5_000, fetch: fetcher,
    });
    try {
      await client.attach();
      let firstError: unknown;
      try { await client.shutdown(); } catch (error) { firstError = error; }
      expect(firstError).toMatchObject({ code: 'network' });
      const status = await client.shutdown();
      expect(status.phase).toBe('stopped');
      expect(requests).toHaveLength(3);
      expect(requests[0].message.request_id).not.toBe(requests[2].message.request_id);
      expect(requests[0].message.sequence).toBeLessThan(requests[2].message.sequence);
      await expect(client.start({ ...startCurrentMessage(), ...IDENTITY })).rejects.toMatchObject({ code: 'recovering' });
    } finally {
      client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 5_000);

  test('concurrent shutdown calls share one in-flight signed request', async () => {
    const fixture = await workerFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let shutdownRequests = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/__supervision/command') {
        shutdownRequests += 1;
        await gate;
      }
      return fetch(input, init);
    }) as typeof fetch;
    const client = new WorkerControllerClient({
      baseUrl: `http://127.0.0.1:${fixture.worker.port}`, credential: fixture.credential, authority: AUTHORITY,
      timeoutMs: 500, leaseDurationMs: 5_000, fetch: fetcher,
    });
    try {
      await client.attach();
      const first = client.shutdown();
      const second = client.shutdown();
      expect(first).toBe(second);
      await Bun.sleep(20);
      expect(shutdownRequests).toBe(1);
      release();
      await first;
    } finally {
      release?.();
      client.disconnect(false);
      await fixture.worker.stop();
    }
  }, 5_000);
});
