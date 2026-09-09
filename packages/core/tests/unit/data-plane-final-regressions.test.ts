import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { setPluginRegistry } from '../../src/worker/state/plugin-manager';
import { setBoundControlClientProvider } from '../../src/config-worker/runtime-dependencies';
import type { PluginRegistry } from '../../src/plugin-registry';
import { ensureDataPlaneSchema } from '../helpers/data-plane-runtime';

const originalFetch = global.fetch;
let handleRequest: typeof import('../../src/worker/request/handler').handleRequest;
let initializeRuntimeState: typeof import('../../src/worker/state/runtime-state').initializeRuntimeState;
let runtimeState: typeof import('../../src/worker/state/runtime-state').runtimeState;
let getActiveRequestCount: typeof import('../../src/worker/state/runtime-state').getActiveRequestCount;
let proxyRequest: typeof import('../../src/worker/request/proxy').proxyRequest;
let isManagedUpstreamAccessError: typeof import('../../src/worker/request/proxy').isManagedUpstreamAccessError;

const manifest = {
  control: { rpc: [{ name: 'getCredential', access: 'bound-attempt' as const }] },
  contributes: {
    upstreamSources: [{
      id: 'provider',
      credentialPolicy: {
        allowedOrigins: ['https://managed.example.test'],
        allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'] }],
        allowedHeaderNames: ['authorization'],
      },
    }],
  },
};

beforeAll(async () => {
  await ensureDataPlaneSchema();
  ({ handleRequest } = await import('../../src/worker/request/handler'));
  ({ initializeRuntimeState, runtimeState, getActiveRequestCount } = await import('../../src/worker/state/runtime-state'));
  ({ proxyRequest, isManagedUpstreamAccessError } = await import('../../src/worker/request/proxy'));
});

beforeEach(() => {
  global.fetch = originalFetch;
  setPluginRegistry(null);
  setBoundControlClientProvider(null);
});

afterEach(() => {
  global.fetch = originalFetch;
  setPluginRegistry(null);
  setBoundControlClientProvider(null);
  runtimeState.clear();
});

describe('data-plane final regressions', () => {
  test('proxy wraps the first managed policy mismatch without calling control or fetch', async () => {
    const mismatchManifest = structuredClone(manifest) as any;
    mismatchManifest.contributes.upstreamSources[0].credentialPolicy.allowedRequests = [
      { pathname: '/v1/other', methods: ['POST'] },
    ];
    setPluginRegistry({
      getPluginStateSnapshot: () => ({
        pluginName: 'provider', discovery: 'discovered', validation: 'validated',
        persistedEnabled: 'enabled', manifest: mismatchManifest,
      }),
    } as unknown as PluginRegistry);
    let controlCalls = 0;
    let fetchCalls = 0;
    setBoundControlClientProvider(() => ({ call: async () => { controlCalls++; return { version: 1, expiresAt: Date.now() + 10_000, headers: { authorization: 'lease' } }; } } as any));
    global.fetch = (async () => { fetchCalls++; return new Response('must-not-fetch'); }) as unknown as typeof fetch;

    const snapshot = {
      method: 'POST', url: 'http://proxy.test/v1/chat', headers: {}, body: { input: 'hello' },
      content_type: 'application/json', is_json_body: true,
    } as any;
    const route = { path: '/v1/chat', endpoints: [] } as any;
    const upstream = {
      id: 'managed', upstream_id: 'managed', target: 'https://managed.example.test', status: 'HEALTHY',
      plugins: [{ id: 'binding-1', name: 'provider', enabled: true, options: {} }],
      managedBy: { plugin: 'provider', contributionId: 'provider', bindingId: 'binding-1' },
      consecutive_failures: 0, consecutive_successes: 0, recovery_attempt_count: 0,
    } as any;
    let caught: unknown;
    try {
      await proxyRequest(snapshot, route, upstream, { requestId: 'policy-mismatch' }, { routes: [] } as any, 'route',
        undefined, undefined, undefined, undefined, { servingRevision: 1, attemptId: 'attempt-1' });
    } catch (error) {
      caught = error;
    }
    expect(isManagedUpstreamAccessError(caught)).toBe(true);
    expect(controlCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test('handler returns managed policy mismatches as dedicated 503 without failover or health failure', async () => {
    const mismatchManifest = structuredClone(manifest) as any;
    mismatchManifest.contributes.upstreamSources[0].credentialPolicy.allowedRequests = [
      { pathname: '/v1/other', methods: ['POST'] },
    ];
    setPluginRegistry({
      getPluginStateSnapshot: () => ({
        pluginName: 'provider', discovery: 'discovered', validation: 'validated',
        persistedEnabled: 'enabled', manifest: mismatchManifest,
      }),
    } as unknown as PluginRegistry);
    let controlCalls = 0;
    let fetchCalls = 0;
    setBoundControlClientProvider(() => ({ call: async () => { controlCalls++; throw new Error('must-not-call-control'); } }));
    global.fetch = (async () => { fetchCalls++; return new Response('must-not-fetch'); }) as unknown as typeof fetch;
    const config = {
      services: [{
        name: 'managed-policy-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          {
            id: 'managed', target: 'https://managed.example.test', priority: 0,
            plugins: [{ id: 'binding-1', name: 'provider', enabled: true, options: {} }],
            managedBy: { plugin: 'provider', contributionId: 'provider', bindingId: 'binding-1' },
          },
          { id: 'fallback', target: 'https://fallback.example.test', priority: 1 },
        ],
      }],
      routes: [{ path: '/v1/chat', service: 'managed-policy-service' }],
    } as any;
    initializeRuntimeState(config);
    const response = await handleRequest(new Request('http://proxy.test/v1/chat', {
      method: 'POST', body: JSON.stringify({ input: 'hello' }),
      headers: { 'content-type': 'application/json' },
    }), config);
    expect(response.status).toBe(503);
    expect(controlCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    const upstreams = runtimeState.get('managed-policy-service')?.upstreams ?? [];
    expect(upstreams.map((upstream) => upstream.consecutive_failures)).toEqual([0, 0]);
  });

  test('managed provider failure is fail-closed and never selects a non-managed sibling', async () => {
    setPluginRegistry({
      getPluginStateSnapshot: () => ({
        pluginName: 'provider',
        discovery: 'discovered',
        validation: 'validated',
        persistedEnabled: 'enabled',
        manifest,
      }),
    } as unknown as PluginRegistry);
    setBoundControlClientProvider(() => ({
      call: async () => { throw new Error('provider failure'); },
    }));

    let fetchCount = 0;
    global.fetch = (async () => {
      fetchCount++;
      return new Response('must-not-fetch');
    }) as unknown as typeof fetch;

    const config = {
      services: [{
        name: 'managed-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          {
            id: 'managed',
            target: 'https://managed.example.test',
            priority: 0,
            plugins: [{ id: 'binding-1', name: 'provider', enabled: true, options: {} }],
            managedBy: { plugin: 'provider', contributionId: 'provider', bindingId: 'binding-1' },
          },
          { id: 'non-managed', target: 'https://fallback.example.test', priority: 1 },
        ],
      }],
      routes: [{ path: '/v1/chat', service: 'managed-service' }],
    } as any;
    initializeRuntimeState(config);

    const response = await handleRequest(
      new Request('http://proxy.test/v1/chat', {
        method: 'POST',
        body: JSON.stringify({ input: 'hello' }),
        headers: { 'content-type': 'application/json' },
      }),
      config,
    );

    expect(response.status).toBe(503);
    expect(fetchCount).toBe(0);
  });

  test('503 SSE teardown holds the first slot until cancel settles, then permits failover', async () => {
    let releaseFirstCancel!: () => void;
    const firstCancel = new Promise<void>((resolve) => { releaseFirstCancel = resolve; });
    let cancelStartedActive = -1;
    let secondFetchActive = -1;
    const sse = (status: number, cancel?: () => Promise<void>) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        if (status === 200) controller.close();
      },
      async cancel() {
        cancelStartedActive = getActiveRequestCount('sse-service', 'first');
        await cancel?.();
      },
    }), { status, headers: { 'content-type': 'text/event-stream' } });
    let first = true;
    global.fetch = (async (_input: Parameters<typeof fetch>[0]) => {
      if (first) {
        first = false;
        return sse(503, async () => await firstCancel);
      }
      secondFetchActive = getActiveRequestCount('sse-service', 'first');
      return sse(200);
    }) as unknown as typeof fetch;

    const config = {
      services: [{
        name: 'sse-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          { id: 'first', target: 'https://first.example.test', priority: 0 },
          { id: 'second', target: 'https://second.example.test', priority: 1 },
        ],
      }],
      routes: [{ path: '/stream', service: 'sse-service' }],
    } as any;
    initializeRuntimeState(config);
    const responsePromise = handleRequest(new Request('http://proxy.test/stream', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
      headers: { 'content-type': 'application/json' },
    }), config);
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseFirstCancel();
    const response = await responsePromise;
    await response.text();
    expect(cancelStartedActive).toBe(1);
    expect(secondFetchActive).toBe(0);
    expect(getActiveRequestCount('sse-service', 'first')).toBe(0);
    expect(getActiveRequestCount('sse-service', 'second')).toBe(0);
  });

  test('never-cancelled 503 SSE stops retry after the bounded teardown deadline', async () => {
    let fetchCount = 0;
    let cancelCalled = false;
    global.fetch = (async () => {
      fetchCount++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        },
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => {});
        },
      }), { status: 503, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const config = {
      services: [{
        name: 'stuck-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          { id: 'stuck', target: 'https://stuck.example.test', priority: 0, status: 'HALF_OPEN' },
          { id: 'never', target: 'https://never.example.test', priority: 1 },
        ],
      }],
      routes: [{ path: '/stuck', service: 'stuck-service' }],
    } as any;
    initializeRuntimeState(config);

    const started = Date.now();
    const response = await handleRequest(new Request('http://proxy.test/stuck', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
      headers: { 'content-type': 'application/json' },
    }), config);

    expect(response.status).toBe(503);
    expect(cancelCalled).toBe(true);
    expect(fetchCount).toBe(1);
    expect(Date.now() - started).toBeLessThan(800);
    expect(getActiveRequestCount('stuck-service', 'stuck')).toBe(0);
    expect(getActiveRequestCount('stuck-service', 'never')).toBe(0);
  });

  test('raw pending completion follows the attempt deadline instead of a handler timeout', async () => {
    global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: pending\n\n'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const snapshot = {
      method: 'POST',
      url: 'http://proxy.test/raw',
      headers: {},
      body: { stream: true },
      content_type: 'application/json',
      is_json_body: true,
    } as any;
    const route = { path: '/raw', endpoints: [], timeouts: { request_ms: 30 } } as any;
    const upstream = {
      id: 'raw', upstream_id: 'raw', target: 'https://raw.example.test', status: 'HEALTHY',
      consecutive_failures: 0, consecutive_successes: 0, recovery_attempt_count: 0,
    } as any;
    const result = await proxyRequest(snapshot, route, upstream, { requestId: 'raw-deadline' }, { routes: [] } as any, 'route');
    const outcome = await result.completion;

    expect(outcome).toEqual({ status: 'failed', code: 'request_timeout' });
    await result.cleanup?.();
  });

  test('client cancellation releases the slot without recording an upstream failure', async () => {
    global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: live\n\n'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const config = {
      services: [{
        name: 'cancel-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{ id: 'cancel', target: 'https://cancel.example.test' }],
      }],
      routes: [{ path: '/cancel', service: 'cancel-service' }],
    } as any;
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://proxy.test/cancel', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
      headers: { 'content-type': 'application/json' },
    }), config);
    await response.body?.cancel('client closed');

    const upstream = runtimeState.get('cancel-service')?.upstreams[0];
    expect(getActiveRequestCount('cancel-service', 'cancel')).toBe(0);
    expect(upstream?.consecutive_failures).toBe(0);
  });
});
