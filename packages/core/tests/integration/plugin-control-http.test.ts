import { describe, expect, test } from 'bun:test';
import { createPluginControlRpcCredential } from '../../src/plugin-control';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed } from '../../src/supervision';
import {
  createPluginControlHttpClient,
  createPluginControlHttpServer,
  PluginControlHttpError,
} from '../../src/plugin-control';

const generation = '11000000-0000-4000-8000-000000000001';
const workerId = '22000000-0000-4000-8000-000000000001';
const boot = '33000000-0000-4000-8000-000000000001';
const controller = '44000000-0000-4000-8000-000000000001';
const attempt = '55000000-0000-4000-8000-000000000001';
const worker = { master_generation: generation, worker_instance_id: workerId, worker_slot: 1, boot_nonce: boot } as const;
const credential = createPluginControlRpcCredential(
  deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(new Uint8Array(32).fill(9), generation, workerId, 1), boot),
  worker,
);

function freshCredential() {
  return createPluginControlRpcCredential(
    deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(new Uint8Array(32).fill(9), generation, workerId, 1), boot),
    worker,
  );
}

function session(execute: (call: any, signal: AbortSignal) => unknown | Promise<unknown>) {
  return { credential, authority: { controller_epoch: 1, controller_id: controller }, execute };
}
type ClientSession = Pick<ReturnType<typeof session>, 'credential' | 'authority'>;

async function withLoopback<T>(
  execute: (call: any, signal: AbortSignal) => unknown | Promise<unknown>,
  run: (client: ReturnType<typeof createPluginControlHttpClient>, server: ReturnType<typeof createPluginControlHttpServer>) => Promise<T>,
  clientSession?: () => ClientSession,
): Promise<T> {
  const current = session(execute);
  const server = createPluginControlHttpServer({ resolveCredential: () => current, execute });
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => server.handle(request) });
  const client = createPluginControlHttpClient({ baseUrl: `http://127.0.0.1:${listener.port}`, session: clientSession ?? (() => current) });
  try { return await run(client, server); }
  finally { client.dispose(); server.dispose(); await listener.stop(true); }
}

describe('W3a2a plugin control HTTP adapters', () => {
  test('uses only the strict envelope, retries the same bytes, and executes once', async () => {
    let executions = 0;
    let first = true;
    const wire: unknown[] = [];
    const current = session(async (call) => { executions += 1; return call.body.payload; });
    const server = createPluginControlHttpServer({ resolveCredential: () => ({ credential: freshCredential(), authority: current.authority }), execute: current.execute });
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      const raw = await request.clone().text();
      wire.push(JSON.parse(raw));
      return server.handle(request);
    } });
    const client = createPluginControlHttpClient({
      baseUrl: `http://127.0.0.1:${listener.port}`, session: () => ({ credential: freshCredential(), authority: current.authority }),
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        if (first) { first = false; await response.arrayBuffer(); throw new Error('ack lost'); }
        return response;
      },
    });
    try {
      await expect(client.call({ revision: 1, endpoint_id: 'endpoint', attempt_id: attempt, method: 'get', payload: { value: 4 }, binding: 'forged' } as any, new AbortController().signal)).resolves.toEqual({ value: 4 });
      expect(executions).toBe(1);
      expect(server.guardCount).toBe(1);
      expect((wire[0] as any).binding).toBeUndefined();
      expect((wire[0] as any).body.binding).toBeUndefined();
    } finally { client.dispose(); server.dispose(); await listener.stop(true); }
  });

  test('rejects non-loopback clients and recovers after an unavailable session', async () => {
    expect(() => createPluginControlHttpClient({ baseUrl: 'http://192.0.2.1:1', session: () => null })).toThrow(PluginControlHttpError);
    let active: ReturnType<typeof session> | null = null;
    const server = createPluginControlHttpServer({ resolveCredential: () => active, execute: async () => 'recovered' });
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => server.handle(request) });
    const client = createPluginControlHttpClient({ baseUrl: `http://127.0.0.1:${listener.port}`, session: () => active });
    try {
      await expect(client.call({ revision: 1, endpoint_id: 'endpoint', attempt_id: attempt, method: 'get', payload: {} }, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' });
      active = session(async () => 'recovered');
      await expect(client.call({ revision: 1, endpoint_id: 'endpoint', attempt_id: attempt, method: 'get', payload: {} }, new AbortController().signal)).resolves.toBe('recovered');
    } finally { client.dispose(); server.dispose(); await listener.stop(true); }
  });

  test('cancellation aborts the host call and reconcile disposes its guard', async () => {
    let entered!: () => void;
    let aborted!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const abortedPromise = new Promise<void>((resolve) => { aborted = resolve; });
    await withLoopback(async (_call, signal) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      return 'late';
    }, async (client, server) => {
      const controller = new AbortController();
      const pending = client.call({ revision: 1, endpoint_id: 'endpoint', attempt_id: attempt, method: 'get', payload: {} }, controller.signal);
      await enteredPromise;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'aborted' });
      await abortedPromise;
      expect(server.guardCount).toBe(1);
      server.pruneGuards([]);
      expect(server.guardCount).toBe(0);
    });
  });

  test('reconcile aborts a pending body before lookup or guard creation', async () => {
    let pullStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { pullStarted = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullStarted();
        return new Promise<void>((resolve) => { release = () => { try { controller.close(); } catch {} resolve(); }; });
      },
    });
    let lookups = 0;
    let executions = 0;
    const current = session(async () => { executions += 1; return 'unexpected'; });
    const server = createPluginControlHttpServer({ resolveCredential: () => { lookups += 1; return current; }, execute: current.execute });
    const pending = server.handle(new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half',
    } as RequestInit));
    await started;
    server.pruneGuards([]);
    release();
    expect((await pending).status).not.toBe(200);
    expect(lookups).toBe(0);
    expect(executions).toBe(0);
    expect(server.guardCount).toBe(0);
    server.dispose();
  });

  test('bounds pre-auth body reads at 64, cancels the 65th, then recovers after pruning', async () => {
    let startedCount = 0;
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => { allStarted = resolve; });
    const releases: (() => void)[] = [];
    const hangingRequest = () => new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: new ReadableStream<Uint8Array>({
        pull() {
          startedCount += 1;
          if (startedCount === 64) allStarted();
          return new Promise<void>((resolve) => { releases.push(resolve); });
        },
      }), duplex: 'half',
    } as RequestInit);
    const current = session(async () => 'recovered');
    const server = createPluginControlHttpServer({ resolveCredential: () => current, execute: current.execute });
    const pending = Array.from({ length: 64 }, () => server.handle(hangingRequest()));
    await started;
    expect(server.preauthBodyReadCount).toBe(64);
    let cancelled = 0;
    const busyBody = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } });
    const busy = await server.handle(new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: busyBody, duplex: 'half',
    } as RequestInit));
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: 'busy' });
    expect(cancelled).toBe(1);
    server.pruneGuards([]);
    for (const release of releases) release();
    expect((await Promise.all(pending)).every((response) => response.status !== 200)).toBe(true);
    expect(server.preauthBodyReadCount).toBe(0);

    const client = createPluginControlHttpClient({
      baseUrl: 'http://127.0.0.1:1', session: () => current,
      fetchImpl: async (_input, init) => server.handle(new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1', init)),
    });
    try {
      await expect(client.call({ revision: 1, endpoint_id: 'endpoint', attempt_id: attempt, method: 'get', payload: {} }, new AbortController().signal)).resolves.toBe('recovered');
      expect(server.preauthBodyReadCount).toBe(0);
    } finally { client.dispose(); server.dispose(); }
  });

  test('final absolute timeout sends cancel and aborts the host signal', async () => {
    let entered!: () => void;
    let aborted!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const abortedPromise = new Promise<void>((resolve) => { aborted = resolve; });
    let hostAbortReason: unknown;
    let resolveCancelAccepted!: () => void;
    const cancelAcceptedPromise = new Promise<void>((resolve) => { resolveCancelAccepted = resolve; });
    let cancelCount = 0;
    const current = session(async (_call, signal) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
        hostAbortReason = signal.reason;
        aborted();
        resolve();
      }, { once: true }));
      return 'late';
    });
    const server = createPluginControlHttpServer({
      resolveCredential: () => current,
      execute: current.execute,
      // Keep the server-side call deadline behind the client deadline so this
      // test proves that the signed cancel, not the server timer, aborts the host.
      wallClock: () => Date.now() - 1_000,
    });
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => server.handle(request) });
    const client = createPluginControlHttpClient({
      baseUrl: `http://127.0.0.1:${listener.port}`, session: () => current, responseTimeoutMs: 250,
      fetchImpl: async (input, init) => {
        const message = JSON.parse(String(init?.body)) as { readonly kind?: unknown };
        const response = await fetch(input, init);
        if (message.kind === 'cancel') {
          cancelCount += 1;
          if (response.status === 204) resolveCancelAccepted();
        }
        return response;
      },
    });
    try {
      const pending = client.call({ revision: 1, endpoint_id: 'endpoint', attempt_id: attempt, method: 'get', payload: {} }, new AbortController().signal);
      const settled = pending.then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error) => ({ kind: 'rejected' as const, error }),
      );
      await enteredPromise;
      const outcome = await settled;
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.error).toMatchObject({ code: 'timeout' });
      await Promise.all([abortedPromise, cancelAcceptedPromise]);
      expect(hostAbortReason).toBe('cancelled');
      expect(cancelCount).toBe(1);
    } finally {
      client.dispose(); server.dispose(); await listener.stop(true);
    }
  });

  test('supports 64 concurrent calls without coupling response order', async () => {
    const releases = new Map<number, () => void>();
    let entered = 0;
    let allEntered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { allEntered = resolve; });
    await withLoopback(async (call) => {
      const value = call.body.payload.value as number;
      entered += 1;
      if (entered === 64) allEntered();
      await new Promise<void>((resolve) => { releases.set(value, resolve); });
      return value;
    }, async (client) => {
      const calls = Array.from({ length: 64 }, (_, value) => client.call<number>({
        revision: 1, endpoint_id: `endpoint-${value}`, attempt_id: attempt, method: 'get', payload: { value },
      }, new AbortController().signal));
      await enteredPromise;
      for (let value = 63; value >= 0; value -= 1) releases.get(value)?.();
      expect(await Promise.all(calls)).toEqual(Array.from({ length: 64 }, (_, value) => value));
    }, () => ({ credential: freshCredential(), authority: { controller_epoch: 1, controller_id: controller } }));
  });
});
