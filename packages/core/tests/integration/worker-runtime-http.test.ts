import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WorkerControllerClient, WorkerControllerClientError } from '../../src/master-runtime/supervised-worker-client';
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
import { startCurrentMessage } from '../unit/config-publication-worker-runtime.fixtures';

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

async function workerFixture(provider: RuntimeProvider = completeSnapshot) {
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
  const worker = new WorkerSupervisionHttpServer({ credential, identity: IDENTITY, runtime: runtime as any, controlPort: 0, runtimeSnapshotProvider: provider });
  await worker.listen();
  const client = new WorkerControllerClient({
    baseUrl: `http://127.0.0.1:${worker.port}`,
    credential,
    authority: AUTHORITY,
    timeoutMs: 1_000,
    leaseDurationMs: 5_000,
    renewBeforeMs: 1_000,
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
        await expect(withTimeout(client.runtimeSnapshot(), 1_200)).rejects.toMatchObject({ code: 'timeout' });
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
});
