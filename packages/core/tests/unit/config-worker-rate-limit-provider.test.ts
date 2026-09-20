import { afterEach, describe, expect, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import {
  IngressTokenBucketStore,
  createRateLimitCredential,
  createRateLimitHttpServer,
  createRateLimitProfileCollector,
  normalizeRateLimitKey,
} from '../../src/rate-limit';
import {
  createWorkerRateLimitHttpProvider,
  setWorkerRateLimitClient,
  setWorkerRateLimitFailureObserver,
} from '../../src/config-worker/rate-limit-provider';
import {
  INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER,
  INTERNAL_TRANSPORT_TOKEN_HEADER,
  INTERNAL_TRUSTED_PEER_HEADER,
  INTERNAL_TRUSTED_PEER_MAC_HEADER,
  getTrustedWorkerPeer,
  restoreWorkerTransportRequest,
  signWorkerTransportPeer,
} from '../../src/config-worker/private-transport';
import { handleRequest } from '../../src/worker/request/handler';
import { createIngressPublicListener } from '../../src/public-listener';
import { cleanupRuntimeState, initializeRuntimeState } from '../../src/worker/state/runtime-state';

const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ingress = {
  role: 'ingress' as const,
  process_instance_id: '10000000-0000-4000-8000-000000000001',
  boot_nonce: '10000000-0000-4000-8000-000000000002',
};
const routeId = '20000000-0000-4000-8000-000000000001';
const instances: Array<{ dispose(): void; stop(): void }> = [];

afterEach(() => {
  setWorkerRateLimitClient(null);
  setWorkerRateLimitFailureObserver(null);
  for (const instance of instances.splice(0)) {
    instance.dispose();
    instance.stop();
  }
});

function provider(port: number, slot: number, bootNonce: string) {
  return createWorkerRateLimitHttpProvider({
    transportSecret: secret,
    worker: {
      role: 'worker',
      process_instance_id: `30000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`,
      boot_nonce: bootNonce,
      master_generation: '40000000-0000-4000-8000-000000000001',
      worker_slot: slot,
    },
    expectedIngress: ingress,
    supervisionPort: port,
  });
}

describe('worker rate-limit provider', () => {
  test('records missing-provider and local configuration failures without debiting', async () => {
    const profile = createRateLimitProfileCollector();
    setWorkerRateLimitFailureObserver(profile.observer);
    const config: AppConfig = {
      config_version: 4,
      routes: [{ id: routeId, path: '/missing-provider', endpoints: [], rate_limit: { enabled: true } }],
    };
    const missing = await handleRequest(new Request('http://127.0.0.1/missing-provider'), config, { servingRevision: 1 });
    expect(missing.status).toBe(503);
    expect(profile.snapshot().counters.unavailable.precondition).toBe(1);

    let debits = 0;
    setWorkerRateLimitClient({
      client: {} as never,
      debit: async () => { debits += 1; return { allowed: true, reason: 'consumed', retry_after_ms: 0 }; },
      dispose: () => undefined,
    });
    const invalid = await handleRequest(new Request('http://127.0.0.1/missing-provider'), {
      ...config,
      routes: [{ ...config.routes[0]!, rate_limit: { enabled: true, burst: 0 } }],
    }, { servingRevision: 1 });
    expect(invalid.status).toBe(503);
    expect(debits).toBe(0);
    expect(profile.snapshot().counters.configuration_invalid.precondition).toBe(1);
  });

  test('signs loopback debits with a deadline no later than 500ms after entry', async () => {
    const store = new IngressTokenBucketStore({
      credential: createRateLimitCredential(secret, ingress),
      authorizeWorker: () => 'active',
    });
    const adapter = createRateLimitHttpServer({ store });
    let signedDeadline = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        signedDeadline = (JSON.parse(await request.clone().text()) as { deadline_at: number }).deadline_at;
        return adapter.fetch(request);
      },
    });
    instances.push({ dispose: () => { adapter.dispose(); store.dispose(); }, stop: () => { server.stop(true); } });
    if (server.port === undefined) throw new Error('loopback server did not bind a port');
    const originalDateNow = Date.now;
    const entryStartedAt = originalDateNow();
    Date.now = () => entryStartedAt;
    const instance = provider(server.port, 0, '50000000-0000-4000-8000-000000000000');
    try {
      expect((await instance.debit({ routeId, keyExpression: '$client_ip', key: normalizeRateLimitKey('203.0.113.9', 'ip'), revision: 1, rps: 1, burst: 1 }, new AbortController().signal)).allowed).toBe(true);
      expect(signedDeadline).toBeLessThanOrEqual(entryStartedAt + 500);
    } finally {
      instance.dispose();
      Date.now = originalDateNow;
    }
  });

  test('uses the ingress loopback adapter and keeps a route UUID bucket stable across replacement revisions', async () => {
    const store = new IngressTokenBucketStore({
      credential: createRateLimitCredential(secret, ingress),
      authorizeWorker: () => 'active',
    });
    const adapter = createRateLimitHttpServer({ store });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => adapter.fetch(request) });
    instances.push({ dispose: () => { adapter.dispose(); store.dispose(); }, stop: () => { server.stop(true); } });
    if (server.port === undefined) throw new Error('loopback server did not bind a port');
    const first = provider(server.port, 0, '50000000-0000-4000-8000-000000000001');
    const replacement = provider(server.port, 1, '50000000-0000-4000-8000-000000000002');
    try {
      const input = {
        routeId,
        keyExpression: '$client_ip',
        key: normalizeRateLimitKey('203.0.113.9', 'ip'),
        rps: 1,
        burst: 1,
      };
      expect((await first.debit({ ...input, revision: 1 }, new AbortController().signal)).allowed).toBe(true);
      expect((await replacement.debit({ ...input, revision: 2 }, new AbortController().signal)).allowed).toBe(false);
    } finally {
      first.dispose();
      replacement.dispose();
    }
  });

  test('takes the peer from the public listener socket, not client forwarding headers', async () => {
    const worker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const restored = restoreWorkerTransportRequest(request, secret);
        if (!restored.ok) return new Response(null, { status: restored.status });
        return new Response(getTrustedWorkerPeer(restored.request) ?? 'missing');
      },
    });
    if (worker.port === undefined) throw new Error('worker did not bind a port');
    const listener = createIngressPublicListener({
      admission: { select: () => ({ private_port: worker.port! }) },
      transportSecret: secret,
      hostname: '127.0.0.1',
      port: 0,
    });
    listener.start();
    if (listener.port === null) throw new Error('public listener did not bind a port');
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/limited`, {
        headers: {
          'x-forwarded-for': '198.51.100.99',
          [INTERNAL_TRUSTED_PEER_HEADER]: '198.51.100.98',
          [INTERNAL_TRUSTED_PEER_MAC_HEADER]: 'hmac-sha256:forged',
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('127.0.0.1');
    } finally {
      await listener.stop();
      worker.stop(true);
    }
  });

  test('debits once before a worker failover loop', async () => {
    let failedCalls = 0;
    let successfulCalls = 0;
    const failed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { failedCalls += 1; return new Response('failed', { status: 500 }); } });
    const successful = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { successfulCalls += 1; return new Response('ok'); } });
    if (failed.port === undefined || successful.port === undefined) throw new Error('upstreams did not bind');
    const config: AppConfig = {
      config_version: 4,
      services: [{
        name: 'failover',
        endpoints: [
          { target: `http://127.0.0.1:${failed.port}`, priority: 1 },
          { target: `http://127.0.0.1:${successful.port}`, priority: 2 },
        ],
        failover: { enabled: true, retry_on: [500] },
      }],
      routes: [{ id: routeId, path: '/failover', service: 'failover', rate_limit: { enabled: true, requests_per_second: 10, burst: 10 } }],
    };
    let debits = 0;
    setWorkerRateLimitClient({
      client: {} as never,
      debit: async () => { debits += 1; return { allowed: true, reason: 'consumed', retry_after_ms: 0 }; },
      dispose: () => undefined,
    });
    const headers = new Headers({
      [INTERNAL_TRANSPORT_TOKEN_HEADER]: secret,
      [INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER]: 'http://public.example/failover',
      [INTERNAL_TRUSTED_PEER_HEADER]: '203.0.113.9',
      [INTERNAL_TRUSTED_PEER_MAC_HEADER]: signWorkerTransportPeer('203.0.113.9', 'GET', 'http://public.example/failover', secret),
    });
    const restored = restoreWorkerTransportRequest(new Request('http://127.0.0.1/internal', { headers }), secret);
    if (!restored.ok) throw new Error('expected authenticated worker transport');
    initializeRuntimeState(config);
    try {
      expect((await handleRequest(restored.request, config, { servingRevision: 1 })).status).toBe(200);
      expect(debits).toBe(1);
      expect(failedCalls).toBe(1);
      expect(successfulCalls).toBe(1);
    } finally {
      cleanupRuntimeState();
      failed.stop(true);
      successful.stop(true);
    }
  });

  test('fails closed without a session, authenticates before one debit, and ignores forged forwarding IP headers', async () => {
    let upstreamCalls = 0;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => { upstreamCalls += 1; return new Response('ok'); },
    });
    if (upstream.port === undefined) throw new Error('upstream did not bind a port');
    const config: AppConfig = {
      config_version: 4,
      routes: [{
        id: routeId,
        path: '/limited',
        endpoints: [{ target: `http://127.0.0.1:${upstream.port}` }],
        auth: { enabled: true, tokens: ['accepted'] },
        rate_limit: { enabled: true, requests_per_second: 1, burst: 1 },
      }],
    };
    const request = (authorization: string | undefined, forwardedFor: string) => {
      const headers = new Headers({
        [INTERNAL_TRANSPORT_TOKEN_HEADER]: secret,
        [INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER]: 'http://public.example/limited',
        [INTERNAL_TRUSTED_PEER_HEADER]: '203.0.113.9',
        [INTERNAL_TRUSTED_PEER_MAC_HEADER]: signWorkerTransportPeer('203.0.113.9', 'GET', 'http://public.example/limited', secret),
        'x-forwarded-for': forwardedFor,
      });
      if (authorization !== undefined) headers.set('authorization', authorization);
      const restored = restoreWorkerTransportRequest(new Request('http://127.0.0.1/internal', { headers }), secret);
      if (!restored.ok) throw new Error('expected authenticated worker transport');
      return restored.request;
    };
    try {
      expect((await handleRequest(request('Bearer accepted', '198.51.100.1'), config, { servingRevision: 1 })).status).toBe(503);
      const store = new IngressTokenBucketStore({
        credential: createRateLimitCredential(secret, ingress),
        authorizeWorker: () => 'active',
      });
      const adapter = createRateLimitHttpServer({ store });
      const rateServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (input) => adapter.fetch(input) });
      if (rateServer.port === undefined) throw new Error('rate-limit server did not bind a port');
      const actual = provider(rateServer.port, 0, '50000000-0000-4000-8000-000000000003');
      let debits = 0;
      setWorkerRateLimitClient({
        ...actual,
        debit: async (input, signal) => { debits += 1; return actual.debit(input, signal); },
      });
      try {
        expect((await handleRequest(request(undefined, '198.51.100.2'), config, { servingRevision: 1 })).status).toBe(401);
        expect(debits).toBe(0);
        expect((await handleRequest(request('Bearer accepted', '198.51.100.3'), config, { servingRevision: 1 })).status).toBe(200);
        expect((await handleRequest(request('Bearer accepted', '198.51.100.4'), config, { servingRevision: 1 })).status).toBe(429);
        expect(debits).toBe(2);
        expect(upstreamCalls).toBe(1);
      } finally {
        actual.dispose();
        adapter.dispose();
        store.dispose();
        rateServer.stop(true);
      }
    } finally {
      upstream.stop(true);
    }
  });

  test('strictly evaluates a complete outer-spaced key expression before a real debit', async () => {
    let upstreamCalls = 0;
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { upstreamCalls += 1; return new Response('ok'); } });
    if (upstream.port === undefined) throw new Error('upstream did not bind');
    const store = new IngressTokenBucketStore({ credential: createRateLimitCredential(secret, ingress), authorizeWorker: () => 'active' });
    const adapter = createRateLimitHttpServer({ store });
    const rateServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => adapter.fetch(request) });
    if (rateServer.port === undefined) throw new Error('rate-limit server did not bind');
    const actual = provider(rateServer.port, 0, '50000000-0000-4000-8000-000000000004');
    let debits = 0;
    setWorkerRateLimitClient({ ...actual, debit: async (input, signal) => { debits += 1; return actual.debit(input, signal); } });
    const config: AppConfig = {
      config_version: 4,
      routes: [{
        id: routeId,
        path: '/expression',
        endpoints: [{ target: `http://127.0.0.1:${upstream.port}` }],
        rate_limit: { enabled: true, requests_per_second: 0.5, key_expression: '  {{ body.account }}  ' },
      }],
    };
    const request = (body: Record<string, unknown>) => {
      const originalUrl = 'http://public.example/expression';
      const headers = new Headers({
        [INTERNAL_TRANSPORT_TOKEN_HEADER]: secret,
        [INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER]: originalUrl,
        [INTERNAL_TRUSTED_PEER_HEADER]: '203.0.113.9',
        [INTERNAL_TRUSTED_PEER_MAC_HEADER]: signWorkerTransportPeer('203.0.113.9', 'POST', originalUrl, secret),
        'content-type': 'application/json',
      });
      const restored = restoreWorkerTransportRequest(new Request('http://127.0.0.1/internal', {
        method: 'POST', headers, body: JSON.stringify(body),
      }), secret);
      if (!restored.ok) throw new Error('expected authenticated worker transport');
      return restored.request;
    };
    try {
      expect((await handleRequest(request({}), config, { servingRevision: 1 })).status).toBe(503);
      expect((await handleRequest(request({ account: null }), config, { servingRevision: 1 })).status).toBe(503);
      expect(upstreamCalls).toBe(0);
      expect(debits).toBe(0);
      expect((await handleRequest(request({ account: 'tenant-a' }), config, { servingRevision: 1 })).status).toBe(200);
      const limited = await handleRequest(request({ account: 'tenant-a' }), config, { servingRevision: 1 });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('2');
      expect(debits).toBe(2);
      expect(upstreamCalls).toBe(1);
    } finally {
      actual.dispose();
      adapter.dispose();
      store.dispose();
      rateServer.stop(true);
      upstream.stop(true);
    }
  });
});
