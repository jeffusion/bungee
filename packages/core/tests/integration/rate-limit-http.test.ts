import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  RATE_LIMIT_HTTP_PATH,
  IngressTokenBucketStore,
  RateLimitHttpError,
  createRateLimitCredential,
  createRateLimitHttpClient,
  createRateLimitHttpServer,
  deriveRateLimitBucketId,
  normalizeRateLimitKey,
  signRateLimitDebitRequest,
  signRateLimitDebitResponse,
  type RateLimitDebitRequestBody,
  type RateLimitFailure,
  type RateLimitWorkerAuthorization,
  type RateLimitWorkerIdentity,
  type RateLimitWireCounters,
} from '../../src/rate-limit';
import { canonicalJson } from '../../src/config-storage/content-hash';

const secret = new Uint8Array(32).fill(9);
const ingress = {
  role: 'ingress' as const,
  process_instance_id: '00000000-0000-4000-8000-000000000010',
  boot_nonce: '00000000-0000-4000-8000-000000000011',
};
const routeId = '00000000-0000-4000-8000-000000000001';
const instances: Array<{ dispose(): void; stop?: (closeActiveConnections?: boolean) => void }> = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

function worker(slot = 0): RateLimitWorkerIdentity {
  return {
    role: 'worker',
    process_instance_id: `00000000-0000-4000-8000-${String(20 + slot).padStart(12, '0')}`,
    boot_nonce: `00000000-0000-4000-8000-${String(30 + slot).padStart(12, '0')}`,
    master_generation: '00000000-0000-4000-8000-000000000021',
    worker_slot: slot,
  };
}

function body(value = 'same', burst = 2): RateLimitDebitRequestBody {
  return {
    bucket_id: deriveRateLimitBucketId(secret, routeId, 'tenant', normalizeRateLimitKey(value)),
    policy_id: 'policy', revision: 1, rps: 1, burst,
  };
}

async function loopback(
  authorization: (worker: RateLimitWorkerIdentity) => RateLimitWorkerAuthorization,
  run: (baseUrl: string, store: IngressTokenBucketStore) => Promise<void>,
  options: { bodyTimeoutMs?: number; maxPreauthBodyReads?: number; counters?: RateLimitWireCounters } = {},
): Promise<void> {
  const store = new IngressTokenBucketStore({ credential: createRateLimitCredential(secret, ingress), authorizeWorker: authorization });
  const adapter = createRateLimitHttpServer({ store, ...options });
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => adapter.fetch(request) });
  instances.push({ dispose: () => { adapter.dispose(); store.dispose(); listener.stop(true); } });
  await run(`http://127.0.0.1:${listener.port}/`, store);
}

function client(baseUrl: string, identity: RateLimitWorkerIdentity, fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, deadlineMs = 1_000, counters?: RateLimitWireCounters) {
  return createRateLimitHttpClient({
    baseUrl,
    session: () => ({ credential: createRateLimitCredential(secret, identity), expectedIngress: ingress }),
    fetchImpl,
    deadlineMs,
    counters,
  });
}

describe('rate-limit bounded HTTP adapter', () => {
  test('successful first attempts parse and serialize each wire envelope once', async () => {
    let serverParses = 0;
    let serverSerializes = 0;
    let clientParses = 0;
    let clientSerializes = 0;
    await loopback(() => 'active', async (baseUrl) => {
      const instance = client(baseUrl, worker(), undefined, 1_000, {
        parse: () => { clientParses += 1; },
        serialize: () => { clientSerializes += 1; },
      });
      try {
        expect((await instance.debit(body('counters'))).allowed).toBe(true);
      } finally {
        instance.dispose();
      }
    }, {
      counters: {
        parse: () => { serverParses += 1; },
        serialize: () => { serverSerializes += 1; },
      },
    });
    expect(serverParses).toBe(1);
    expect(serverSerializes).toBe(1);
    expect(clientParses).toBe(1);
    expect(clientSerializes).toBe(1);
  });

  test('four workers share one loopback bucket without over-issuing', async () => {
    await loopback(() => 'active', async (baseUrl) => {
      const clients = [0, 1, 2, 3].map((slot) => client(baseUrl, worker(slot)));
      try {
        const results = await Promise.all(clients.map((instance) => instance.debit(body())));
        expect(results.filter((result) => result.allowed)).toHaveLength(2);
        expect(results.filter((result) => !result.allowed && result.reason === 'rate_limited')).toHaveLength(2);
      } finally {
        for (const instance of clients) instance.dispose();
      }
    });
  });

  test('retries an ACK loss with the exact signed wire request and does not debit twice', async () => {
    await loopback(() => 'active', async (baseUrl, store) => {
      const wires: string[] = [];
      let dropAck = true;
      const instance = client(baseUrl, worker(), async (input, init) => {
        wires.push(String(init?.body));
        const response = await fetch(input, init);
        if (dropAck) {
          dropAck = false;
          void response.body?.cancel();
          throw new Error('ACK lost');
        }
        return response;
      }, 500);
      try {
        expect((await instance.debit(body('ack', 1))).allowed).toBe(true);
        expect(wires).toHaveLength(2);
        expect(wires[0]).toBe(wires[1]);
        expect(store.replayCount).toBe(1);
        expect((await instance.debit(body('ack', 1))).allowed).toBe(false);
      } finally { instance.dispose(); }
    });
  });

  test('uses a fake wall clock for the signed 500ms deadline and times out at it', async () => {
    let wall = 10_000;
    let signedDeadline = 0;
    const instance = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/',
      deadlineMs: 500,
      wallClock: () => wall,
      session: () => ({ credential: createRateLimitCredential(secret, worker()), expectedIngress: ingress }),
      fetchImpl: (_input, init) => {
        signedDeadline = (JSON.parse(String(init?.body)) as { deadline_at: number }).deadline_at;
        wall = signedDeadline;
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      },
    });
    await expect(instance.debit(body('fake-wall'))).rejects.toMatchObject({ code: 'timeout' } satisfies Partial<RateLimitHttpError>);
    expect(signedDeadline).toBe(10_500);
    instance.dispose();
  });

  test('caps the timeout timer at 500ms when the wall clock rolls back', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let timerDelay = -1;
    let wallReads = 0;
    globalThis.setTimeout = ((_callback: TimerHandler, delay?: number) => {
      timerDelay = Number(delay);
      return 1;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_id: number | ReturnType<typeof setTimeout>) => undefined) as typeof clearTimeout;
    const instance = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/',
      deadlineMs: 500,
      wallClock: () => wallReads++ === 0 ? 10_000 : 0,
      session: () => new Promise(() => {}),
    });
    try {
      const pending = instance.debit(body('fake-wall-rollback'));
      instance.dispose();
      await expect(pending).rejects.toMatchObject({ code: 'disposed' } satisfies Partial<RateLimitHttpError>);
      expect(timerDelay).toBe(500);
    } finally {
      instance.dispose();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('membership is rechecked before replaying a cached allow', async () => {
    let membership: RateLimitWorkerAuthorization = 'active';
    await loopback(() => membership, async (baseUrl) => {
      let wire = '';
      const instance = client(baseUrl, worker(), async (input, init) => {
        wire = String(init?.body);
        return fetch(input, init);
      });
      try {
        expect((await instance.debit(body('membership', 1))).allowed).toBe(true);
        const endpoint = new URL(RATE_LIMIT_HTTP_PATH, baseUrl);
        membership = 'unknown';
        expect((await fetch(endpoint, { method: 'POST', body: wire, headers: { 'content-type': 'application/json' } })).status).toBe(403);
        membership = 'prepared';
        expect((await fetch(endpoint, { method: 'POST', body: wire, headers: { 'content-type': 'application/json' } })).status).toBe(403);
      } finally { instance.dispose(); }
    });
  });

  test('rejects invalid MAC, unknown identity, duplicate keys, and oversized wire bodies', async () => {
    await loopback((candidate) => candidate.worker_slot === 0 ? 'active' : 'unknown', async (baseUrl) => {
      const endpoint = new URL(RATE_LIMIT_HTTP_PATH, baseUrl);
      const credential = createRateLimitCredential(secret, worker());
      const valid = signRateLimitDebitRequest({ request_id: randomUUID(), debit_id: randomUUID(), deadline_at: Date.now() + 1_000, body: body('invalid') }, credential);
      const headers = { 'content-type': 'application/json' };
      expect((await fetch(endpoint, { method: 'POST', headers, body: canonicalJson({ ...valid, mac: `hmac-sha256:${'0'.repeat(64)}` }) })).status).toBe(403);
      const unknown = signRateLimitDebitRequest({ request_id: randomUUID(), debit_id: randomUUID(), deadline_at: Date.now() + 1_000, body: body('unknown') }, createRateLimitCredential(secret, worker(9)));
      expect((await fetch(endpoint, { method: 'POST', headers, body: canonicalJson(unknown) })).status).toBe(403);
      const duplicate = canonicalJson(valid).replace(
        '"protocol":"bungee-rate-limit"',
        '"\\u0070rotocol":"bungee-rate-limit","protocol":"bungee-rate-limit"',
      );
      expect((await fetch(endpoint, { method: 'POST', headers, body: duplicate })).status).toBe(400);
      expect((await fetch(endpoint, { method: 'POST', headers, body: 'x'.repeat(4_097) })).status).toBe(413);
    });
  });

  test('uses one absolute body deadline for slow drips and releases the preauth slot', async () => {
    await loopback(() => 'active', async (baseUrl) => {
      const credential = createRateLimitCredential(secret, worker());
      const wire = canonicalJson(signRateLimitDebitRequest({
        request_id: randomUUID(), debit_id: randomUUID(), deadline_at: Date.now() + 1_000, body: body('drip'),
      }, credential));
      let index = 0;
      let cancelled = false;
      const drip = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cancelled) { controller.close(); return; }
          if (index === wire.length) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(wire[index++]!));
          await Bun.sleep(15);
        },
        cancel: () => { cancelled = true; },
      });
      const response = await fetch(new URL(RATE_LIMIT_HTTP_PATH, baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: drip, duplex: 'half',
      } as RequestInit);
      expect(response.status).toBe(408);
      const restored = await fetch(new URL(RATE_LIMIT_HTTP_PATH, baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: wire,
      });
      expect(restored.status).toBe(200);
    }, { bodyTimeoutMs: 100, maxPreauthBodyReads: 1 });
  });

  test('client fails closed on wrong response ingress, worker, correlation, or MAC', async () => {
    const credential = createRateLimitCredential(secret, worker());
    const ingressCredential = createRateLimitCredential(secret, ingress);
    const rogueIngress = createRateLimitCredential(secret, {
      role: 'ingress', process_instance_id: '00000000-0000-4000-8000-000000000012', boot_nonce: ingress.boot_nonce,
    });
    const responseFor = (request: Record<string, any>, signer = ingressCredential, overrides: Record<string, unknown> = {}) => signRateLimitDebitResponse({
      worker: request.worker, request_id: request.request_id, debit_id: request.debit_id, deadline_at: request.deadline_at,
      body: { allowed: true, reason: 'consumed', retry_after_ms: 0 }, ...overrides,
    }, signer);
    const cases = [
      (request: Record<string, any>) => responseFor(request, rogueIngress),
      (request: Record<string, any>) => responseFor(request, ingressCredential, { worker: worker(1) }),
      (request: Record<string, any>) => responseFor(request, ingressCredential, { debit_id: randomUUID() }),
      (request: Record<string, any>) => ({ ...responseFor(request), mac: `hmac-sha256:${'0'.repeat(64)}` }),
    ];
    for (const makeResponse of cases) {
      const instance = createRateLimitHttpClient({
        baseUrl: 'http://127.0.0.1:1/', deadlineMs: 1_000,
        session: () => ({ credential, expectedIngress: ingress }),
        fetchImpl: (_input, init) => Promise.resolve(new Response(canonicalJson(makeResponse(JSON.parse(String(init?.body)))), {
          headers: { 'content-type': 'application/json' },
        })),
      });
      await expect(instance.debit(body('response'))).rejects.toMatchObject({ code: 'transport_invalid' } satisfies Partial<RateLimitHttpError>);
      instance.dispose();
    }
  });

  test('client keeps redirects isolated from the debit transport', async () => {
    let redirect: RequestRedirect | undefined;
    const instance = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/', deadlineMs: 1_000,
      session: () => ({ credential: createRateLimitCredential(secret, worker()), expectedIngress: ingress }),
      fetchImpl: async (_input, init) => {
        redirect = init?.redirect;
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:2/' } });
      },
    });
    await expect(instance.debit(body('redirect'))).rejects.toMatchObject({ code: 'transport_invalid' } satisfies Partial<RateLimitHttpError>);
    expect(redirect).toBe('manual');
    instance.dispose();
  });

  test('reader pull aborts or disposes a complete allow response', async () => {
    for (const mode of ['abort', 'dispose', 'abort-then-dispose'] as const) {
      const credential = createRateLimitCredential(secret, worker());
      const ingressCredential = createRateLimitCredential(secret, ingress);
      const abort = new AbortController();
      let instance!: ReturnType<typeof createRateLimitHttpClient>;
      instance = createRateLimitHttpClient({
        baseUrl: 'http://127.0.0.1:1/', deadlineMs: 1_000,
        session: () => ({ credential, expectedIngress: ingress }),
        fetchImpl: (_input, init) => {
          const request = JSON.parse(String(init?.body));
          const response = signRateLimitDebitResponse({
            worker: request.worker, request_id: request.request_id, debit_id: request.debit_id, deadline_at: request.deadline_at,
            body: { allowed: true, reason: 'consumed', retry_after_ms: 0 },
          }, ingressCredential);
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode(canonicalJson(response)));
              controller.close();
              if (mode === 'abort' || mode === 'abort-then-dispose') abort.abort();
              if (mode === 'dispose' || mode === 'abort-then-dispose') instance.dispose();
            },
            cancel: () => undefined,
          }, { highWaterMark: 0 });
          return Promise.resolve(new Response(stream, { headers: { 'content-type': 'application/json' } }));
        },
      });
      await expect(instance.debit(body(`fence-${mode}`), abort.signal)).rejects.toMatchObject({ code: mode === 'dispose' ? 'disposed' : 'aborted' });
      expect(instance.pendingCount).toBe(0);
    }
  });

  test('fence keeps the first abort reason when timeout listeners abort and dispose', async () => {
    const external = new AbortController();
    let instance!: ReturnType<typeof createRateLimitHttpClient>;
    instance = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/', deadlineMs: 20,
      session: () => ({ credential: createRateLimitCredential(secret, worker()), expectedIngress: ingress }),
      fetchImpl: (_input, init) => {
        init?.signal?.addEventListener('abort', () => { external.abort(); instance.dispose(); }, { once: true });
        return new Promise<Response>(() => {});
      },
    });
    await expect(instance.debit(body('timeout-first'), external.signal)).rejects.toMatchObject({ code: 'timeout' } satisfies Partial<RateLimitHttpError>);
    expect(instance.pendingCount).toBe(0);
  });

  test('nested response handoffs cancel a received body before its caller continuation', async () => {
    for (const mode of ['abort', 'dispose'] as const) {
      for (const depth of [0, 1, 2, 3]) {
        const credential = createRateLimitCredential(secret, worker());
        const ingressCredential = createRateLimitCredential(secret, ingress);
        const external = new AbortController();
        let cancels = 0;
        let instance!: ReturnType<typeof createRateLimitHttpClient>;
        instance = createRateLimitHttpClient({
          baseUrl: 'http://127.0.0.1:1/', deadlineMs: 1_000,
          session: () => ({ credential, expectedIngress: ingress }),
          fetchImpl: (_input, init) => new Promise<Response>((resolve) => {
            const request = JSON.parse(String(init?.body));
            const response = signRateLimitDebitResponse({
              worker: request.worker, request_id: request.request_id, debit_id: request.debit_id, deadline_at: request.deadline_at,
              body: { allowed: true, reason: 'consumed', retry_after_ms: 0 },
            }, ingressCredential);
            queueMicrotask(() => {
              resolve(new Response(new ReadableStream<Uint8Array>({
                cancel: () => { cancels += 1; },
              }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }));
              const handoff = (remaining: number): void => {
                queueMicrotask(() => {
                  if (remaining === 0) {
                    if (mode === 'abort') external.abort(); else instance.dispose();
                  } else handoff(remaining - 1);
                });
              };
              handoff(depth);
            });
          }),
        });
        await expect(instance.debit(body(`handoff-${mode}-${depth}`), external.signal)).rejects.toMatchObject({ code: mode === 'abort' ? 'aborted' : 'disposed' });
        expect(cancels).toBe(1);
        expect(instance.pendingCount).toBe(0);
      }
    }
  });

  test('pre-aborted server requests cancel their raw body without taking a read slot', async () => {
    const store = new IngressTokenBucketStore({ credential: createRateLimitCredential(secret, ingress), authorizeWorker: () => 'active' });
    const adapter = createRateLimitHttpServer({ store });
    instances.push({ dispose: () => { adapter.dispose(); store.dispose(); } });
    const abort = new AbortController();
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() { pulls += 1; },
      cancel: () => { cancels += 1; },
    }, { highWaterMark: 0 });
    const request = new Request(`http://127.0.0.1${RATE_LIMIT_HTTP_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, signal: abort.signal, duplex: 'half',
    } as RequestInit);
    abort.abort();
    expect((await adapter.fetch(request)).status).toBe(400);
    expect(adapter.preauthBodyReadCount).toBe(0);
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
  });

  test('session wait is bounded from entry, rejects late sessions, and caps pending calls', async () => {
    // Bun 1.4.2 on Windows stalls `.rejects` matchers on unsettled timer-driven promises;
    // capture rejections with a plain await instead (same fix as plugin-control-host).
    const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
      try { await promise; } catch (error) { return error; }
      throw new Error('expected the promise to reject');
    };
    for (const action of ['timeout', 'abort', 'dispose'] as const) {
      let resolveSession!: (value: { credential: ReturnType<typeof createRateLimitCredential>; expectedIngress: typeof ingress }) => void;
      let fetches = 0;
      const signal = new AbortController();
      const instance = createRateLimitHttpClient({
        baseUrl: 'http://127.0.0.1:1/', deadlineMs: action === 'timeout' ? 20 : 1_000,
        session: () => new Promise((resolve) => { resolveSession = resolve; }),
        fetchImpl: async () => { fetches += 1; return new Response(); },
      });
      const pending = instance.debit(body(`session-${action}`), signal.signal);
      await Bun.sleep(0);
      if (action === 'abort') signal.abort();
      if (action === 'dispose') instance.dispose();
      const error = await captureRejection(pending);
      expect(error).toMatchObject({ code: action === 'abort' ? 'aborted' : action === 'dispose' ? 'disposed' : 'timeout' });
      expect(instance.pendingCount).toBe(0);
      resolveSession({ credential: createRateLimitCredential(secret, worker()), expectedIngress: ingress });
      await Bun.sleep(0);
      expect(fetches).toBe(0);
      instance.dispose();
    }

    const saturated = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/', deadlineMs: 1_000,
      session: () => new Promise(() => {}),
    });
    const pending = Array.from({ length: 64 }, (_, index) => saturated.debit(body(`capacity-${index}`)));
    await Bun.sleep(0);
    expect(saturated.pendingCount).toBe(64);
    await expect(saturated.debit(body('capacity-overflow'))).rejects.toMatchObject({ code: 'busy' });
    saturated.dispose();
    await Promise.allSettled(pending);
    expect(saturated.pendingCount).toBe(0);
  });

  test('abort and dispose reject late results, cancel late bodies, and clear pending work', async () => {
    let resolveLate!: (response: Response) => void;
    let cancelled = false;
    const lateBody = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const fetchImpl = () => new Promise<Response>((resolve) => { resolveLate = resolve; });
    const instance = client('http://127.0.0.1:1/', worker(), fetchImpl);
    const abort = new AbortController();
    const pending = instance.debit(body('late'), abort.signal);
    await Bun.sleep(0);
    expect(instance.pendingCount).toBe(1);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' } satisfies Partial<RateLimitHttpError>);
    expect(instance.pendingCount).toBe(0);
    resolveLate(new Response(lateBody, { headers: { 'content-type': 'application/json' } }));
    await Bun.sleep(0);
    expect(cancelled).toBe(true);

    let resolveDisposed!: (response: Response) => void;
    const disposed = client('http://127.0.0.1:1/', worker(1), () => new Promise<Response>((resolve) => { resolveDisposed = resolve; }));
    const disposedPending = disposed.debit(body('disposed'));
    await Bun.sleep(0);
    disposed.dispose();
    await expect(disposedPending).rejects.toMatchObject({ code: 'disposed' } satisfies Partial<RateLimitHttpError>);
    expect(disposed.pendingCount).toBe(0);
    let disposedCancelled = false;
    resolveDisposed(new Response(new ReadableStream<Uint8Array>({ cancel: () => { disposedCancelled = true; } })));
    await Bun.sleep(0);
    expect(disposedCancelled).toBe(true);

    let rejectLate!: (error: Error) => void;
    const syncAbort = new AbortController();
    const rejected = client('http://127.0.0.1:1/', worker(2), () => {
      syncAbort.abort();
      return new Promise<Response>((_resolve, reject) => { rejectLate = reject; });
    });
    await expect(rejected.debit(body('sync-reject'), syncAbort.signal)).rejects.toMatchObject({ code: 'aborted' } satisfies Partial<RateLimitHttpError>);
    rejectLate(new Error('late transport rejection'));
    await Bun.sleep(0);
    instance.dispose();
    rejected.dispose();
  });

  test('emits one terminal diagnostic after the fetch retry and never trusts an error body', async () => {
    const failures: unknown[] = [];
    let fetches = 0;
    const instance = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/',
      session: () => ({ credential: createRateLimitCredential(secret, worker()), expectedIngress: ingress }),
      observer: { failure: (failure) => failures.push(failure) },
      fetchImpl: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error('network down');
        return new Response('protocol_error', { status: 500, headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(instance.debit(body('diagnostic'))).rejects.toMatchObject({ code: 'transport_invalid' });
    expect(failures).toEqual([expect.objectContaining({ reason: 'transport_invalid', stage: 'fetch', attempts: 2, remoteStatus: 500 })]);
    expect((failures[0] as Record<string, unknown>).protocolCode).toBeUndefined();
    instance.dispose();
  });

  test('swallows observer errors and does not call now when diagnostics are disabled', async () => {
    let nowCalls = 0;
    const credential = createRateLimitCredential(secret, worker());
    const ingressCredential = createRateLimitCredential(secret, ingress);
    const disabled = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/', session: () => ({ credential, expectedIngress: ingress }),
      now: () => { nowCalls += 1; return 0; },
      fetchImpl: (_input, init) => {
        const request = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(canonicalJson(signRateLimitDebitResponse({
          worker: request.worker, request_id: request.request_id, debit_id: request.debit_id,
          deadline_at: request.deadline_at, body: { allowed: true, reason: 'consumed', retry_after_ms: 0 },
        }, ingressCredential)), { headers: { 'content-type': 'application/json' } }));
      },
    });
    expect((await disabled.debit(body('disabled'))).allowed).toBe(true);
    expect(nowCalls).toBe(0);
    disabled.dispose();

    const observed = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/', session: () => ({ credential, expectedIngress: ingress }),
      observer: { failure: () => { throw new Error('observer failed'); } },
      fetchImpl: () => Promise.reject(new Error('network down')),
      deadlineMs: 20,
    });
    await expect(observed.debit(body('observer-throws'))).rejects.toMatchObject({ code: 'network_error' });
    observed.dispose();
  });

  test('reports monotonic timing stages only when timing observation is enabled', async () => {
    let clock = 0;
    const timings: string[] = [];
    const credential = createRateLimitCredential(secret, worker());
    const ingressCredential = createRateLimitCredential(secret, ingress);
    const instance = createRateLimitHttpClient({
      baseUrl: 'http://127.0.0.1:1/', session: () => ({ credential, expectedIngress: ingress }),
      now: () => ++clock,
      observer: { timing: (timing) => timings.push(timing.stage) },
      fetchImpl: (_input, init) => {
        const request = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(canonicalJson(signRateLimitDebitResponse({
          worker: request.worker, request_id: request.request_id, debit_id: request.debit_id,
          deadline_at: request.deadline_at, body: { allowed: true, reason: 'consumed', retry_after_ms: 0 },
        }, ingressCredential)), { headers: { 'content-type': 'application/json' } }));
      },
    });
    expect((await instance.debit(body('timing'))).allowed).toBe(true);
    expect(timings).toEqual(['session', 'sign', 'fetch1', 'read', 'verify', 'total']);
    instance.dispose();
  });

  test('maps server protocol failures authoritatively and reports honest server timing stages', async () => {
    const credential = createRateLimitCredential(secret, worker());
    const validWire = (deadlineAt = Date.now() + 1_000, debitId = randomUUID()) => canonicalJson(signRateLimitDebitRequest({
      request_id: randomUUID(), debit_id: debitId, deadline_at: deadlineAt, body: body(debitId),
    }, credential));
    const failures: RateLimitFailure[] = [];
    const timings: string[] = [];
    const store = new IngressTokenBucketStore({ credential: createRateLimitCredential(secret, ingress), authorizeWorker: () => 'active' });
    const adapter = createRateLimitHttpServer({
      store,
      observer: {
        failure: (failure) => failures.push(failure),
        timing: (timing) => timings.push(timing.stage),
      },
      now: (() => { let value = 0; return () => ++value; })(),
    });
    instances.push({ dispose: () => { adapter.dispose(); store.dispose(); } });
    const send = (wire: string) => adapter.fetch(new Request(`http://127.0.0.1${RATE_LIMIT_HTTP_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: wire,
    }));

    expect((await send(validWire())).status).toBe(200);
    expect(timings).toEqual(['server_read', 'server_store_total', 'server_serialize', 'server_total']);
    timings.length = 0;
    const expired = await send(validWire(Date.now() - 1));
    expect(expired.status).toBe(400);
    expect(failures.at(-1)).toMatchObject({ reason: 'timeout', stage: 'server_store', protocolCode: 'deadline_expired' });
    const invalidMac = JSON.parse(validWire()) as Record<string, unknown>;
    invalidMac.mac = `hmac-sha256:${'0'.repeat(64)}`;
    expect((await send(canonicalJson(invalidMac))).status).toBe(403);
    expect(failures.at(-1)).toMatchObject({ reason: 'protocol_error', stage: 'server_store', protocolCode: 'invalid_mac' });
    const tooLarge = await adapter.fetch(new Request(`http://127.0.0.1${RATE_LIMIT_HTTP_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(4_097),
    }));
    expect(tooLarge.status).toBe(413);
    expect(failures.at(-1)).toMatchObject({ reason: 'transport_invalid', stage: 'server_read', protocolCode: 'message_too_large' });
    const busyFailures: RateLimitFailure[] = [];
    const busyStore = new IngressTokenBucketStore({
      credential: createRateLimitCredential(secret, ingress), authorizeWorker: () => 'active', maxReplayEntries: 1,
    });
    const busyAdapter = createRateLimitHttpServer({ store: busyStore, observer: { failure: (failure) => busyFailures.push(failure) } });
    expect((await busyAdapter.fetch(new Request(`http://127.0.0.1${RATE_LIMIT_HTTP_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: validWire(Date.now() + 1_000, randomUUID()),
    }))).status).toBe(200);
    expect((await busyAdapter.fetch(new Request(`http://127.0.0.1${RATE_LIMIT_HTTP_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: validWire(Date.now() + 1_000, randomUUID()),
    }))).status).toBe(400);
    expect(busyFailures.at(-1)).toMatchObject({ reason: 'busy', stage: 'server_store', protocolCode: 'busy' });
    busyAdapter.dispose();
    busyStore.dispose();
    store.dispose();
    const disposed = await send(validWire());
    expect(disposed.status).toBe(400);
    expect(failures.at(-1)).toMatchObject({ reason: 'disposed', stage: 'server_store', protocolCode: 'disposed' });
  });
});
