import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AppConfig, InterceptResult } from '@jeffusion/bungee-types';
import { createPluginHooks, type FinallyContext, type MutableRequestContext, type RawResponseContext, type ResponseContext } from '../../src/hooks';
import type { RawResponseResult } from '../../src/plugin-control/contracts';
import { logger } from '../../src/logger';
import { setScopedPluginRegistry, type PhaseAwareHooks, type PrecompiledHooks, type ScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { ensureDataPlaneSchema } from '../helpers/data-plane-runtime';

const originalFetch = global.fetch;
const originalWarn = logger.warn;
let handleRequest: typeof import('../../src/worker/request/handler').handleRequest;
let initializeRuntimeState: typeof import('../../src/worker/state/runtime-state').initializeRuntimeState;
let runtimeState: typeof import('../../src/worker/state/runtime-state').runtimeState;
let getActiveRequestCount: typeof import('../../src/worker/state/runtime-state').getActiveRequestCount;
let accessLogWriter: typeof import('../../src/logger/access-log-writer').accessLogWriter;

function createPrecompiledHooks(options: {
  label?: string;
  onBeforeRequest?: (ctx: MutableRequestContext) => MutableRequestContext | Promise<MutableRequestContext>;
  onInterceptRequest?: (ctx: MutableRequestContext) => InterceptResult | Promise<InterceptResult>;
  onResponse?: (response: Response, ctx: ResponseContext) => Response | Promise<Response>;
  onRawResponse?: (result: RawResponseResult, ctx: RawResponseContext) => RawResponseResult | Promise<RawResponseResult>;
  onFinally?: (ctx: FinallyContext) => void | Promise<void>;
} = {}): PrecompiledHooks {
  const hooks = createPluginHooks();
  const label = options.label ?? 'phase-test';

  if (options.onBeforeRequest) {
    hooks.onBeforeRequest.tapPromise({ name: `${label}:before` }, async (ctx) => await options.onBeforeRequest!(ctx));
  }
  if (options.onInterceptRequest) {
    hooks.onInterceptRequest.tapPromise({ name: `${label}:intercept` }, async (ctx) => await options.onInterceptRequest!(ctx));
  }
  if (options.onResponse) {
    hooks.onResponse.tapPromise({ name: `${label}:response` }, async (response, ctx) => await options.onResponse!(response, ctx));
  }
  if (options.onRawResponse) {
    hooks.onRawResponse.tapPromise({ name: `${label}:raw-response` }, async (result, ctx) => await options.onRawResponse!(result, ctx));
  }
  if (options.onFinally) {
    hooks.onFinally.tapPromise({ name: `${label}:finally` }, async (ctx) => await options.onFinally!(ctx));
  }

  return {
    handlers: [],
    hooks,
    hasInterceptCallbacks: hooks.onInterceptRequest.hasCallbacks(),
    hasResponseCallbacks: hooks.onResponse.hasCallbacks(),
    hasRawResponseCallbacks: hooks.onRawResponse.hasCallbacks(),
    hasStreamCallbacks: hooks.onStreamChunk.hasCallbacks(),
    metadata: {
      createdAt: Date.now(),
      pluginCount: hooks.onBeforeRequest.hasCallbacks() || hooks.onInterceptRequest.hasCallbacks() || hooks.onResponse.hasCallbacks() || hooks.onRawResponse.hasCallbacks() || hooks.onFinally.hasCallbacks() ? 1 : 0,
      pluginNames: [label],
      scope: label,
    },
  };
}

function installPhaseHooks(factory: (upstreamId?: string) => Omit<PhaseAwareHooks, 'globalPrecompiled' | 'routePrecompiled'> & { globalPrecompiled?: PrecompiledHooks | null; routePrecompiled?: PrecompiledHooks | null }): void {
  setScopedPluginRegistry({
    getPrecompiledHooks: (_routeId: string, upstreamId?: string) => {
      const partial = factory(upstreamId);
      return {
        ...partial,
        globalPrecompiled: partial.globalPrecompiled ?? null,
        routePrecompiled: partial.routePrecompiled ?? partial.routePhase ?? null,
      };
    },
  } as unknown as ScopedPluginRegistry);
}

function createInboundChain(
  onResponse?: (response: Response) => Promise<Response> | Response,
  onRawResponse?: (result: RawResponseResult) => Promise<RawResponseResult> | RawResponseResult,
): PhaseAwareHooks['inbound'] {
  return {
    onResponse: async (response) => onResponse ? await onResponse(response) : response,
    onRawResponse: async (result) => onRawResponse ? await onRawResponse(result) : result,
    onStreamChunk: async (chunk) => [chunk],
    onFlushStream: async (chunks) => chunks,
    onError: async () => {},
  };
}

function setFetchMock(mockFetch: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  global.fetch = mockFetch as unknown as typeof fetch;
}

function inputToUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function createSingleEndpointConfig(): AppConfig {
  return {
    routes: [
      {
        path: '/api',
        endpoints: [{ id: 'primary', target: 'http://primary.test' }],
      },
    ],
  };
}

function createFailoverConfig(): AppConfig {
  return {
    services: [
      {
        name: 'api-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          { id: 'primary', target: 'http://primary.test' },
          { id: 'secondary', target: 'http://secondary.test' },
        ],
      },
    ],
    routes: [{ path: '/api', service: 'api-service' }],
  };
}

beforeAll(async () => {
  await ensureDataPlaneSchema();
  ({ handleRequest } = await import('../../src/worker/request/handler'));
  ({ initializeRuntimeState, runtimeState, getActiveRequestCount } = await import('../../src/worker/state/runtime-state'));
  ({ accessLogWriter } = await import('../../src/logger/access-log-writer'));
});

afterAll(async () => {
  runtimeState?.clear();
});

beforeEach(() => {
  runtimeState.clear();
  setScopedPluginRegistry(null);
  global.fetch = originalFetch;
  logger.warn = originalWarn;
});

afterEach(() => {
  runtimeState.clear();
  setScopedPluginRegistry(null);
  global.fetch = originalFetch;
  logger.warn = originalWarn;
});

describe('phase-aware request pipeline', () => {
  test('runs strict raw response hook through the real local upstream path', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response('upstream-body', { headers: { 'content-type': 'text/plain' } }),
    });
    let called = false;
    try {
      installPhaseHooks(() => ({
        routePhase: createPrecompiledHooks({
          onRawResponse: async (result) => result,
        }),
        servicePhase: null,
        upstreamPhase: createPrecompiledHooks(),
        inbound: createInboundChain(undefined, async (result) => {
          called = true;
          const body = await result.response.text();
          return {
            response: new Response(body.toUpperCase(), { status: result.response.status, headers: result.response.headers }),
            completion: Promise.resolve({ status: 'completed' as const }),
          };
        }),
      }));
      const response = await handleRequest(new Request('http://proxy.test/api'), {
        routes: [{ path: '/api', endpoints: [{ id: 'local', target: upstream.url.href }] }],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('UPSTREAM-BODY');
      expect(called).toBe(true);
    } finally {
      upstream.stop();
    }
  });

  test.each([400, 404, 422])('returns a safe raw %p without failover or passive health failure', async (status) => {
    const serviceName = `safe-client-${status}`;
    const routePath = `/safe-client-${status}`;
    let fetchCount = 0;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onRawResponse: async (result) => result }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(undefined, async (result) => {
        await result.response.arrayBuffer();
        return {
          response: new Response(JSON.stringify({ error: { message: 'safe upstream error' } }), {
            status: result.response.status,
            headers: { 'content-type': 'application/json' },
          }),
          completion: Promise.resolve({ status: 'failed' as const, code: 'upstream_http_error' }),
        };
      }),
    }));
    setFetchMock(async () => {
      fetchCount++;
      return new Response(`secret-${status}`, { status });
    });
    const config: AppConfig = {
      services: [{
        name: serviceName,
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          { id: 'primary', target: 'http://primary.test' },
          { id: 'secondary', target: 'http://secondary.test' },
        ],
      }],
      routes: [{ path: routePath, service: serviceName }],
    };
    initializeRuntimeState(config);

    const requestCount = status === 400 ? 3 : 1;
    let response!: Response;
    for (let attempt = 0; attempt < requestCount; attempt++) {
      response = await handleRequest(new Request(`http://localhost${routePath}`), config);
    }
    const body = await response.text();
    await accessLogWriter.flush();
    const row = accessLogWriter.getDatabase().prepare(
      'SELECT status, protocol_outcome, protocol_code, success FROM access_logs WHERE path = ? ORDER BY timestamp DESC LIMIT 1',
    ).get(routePath) as { status: number; protocol_outcome: string; protocol_code: string; success: number } | null;

    expect(response.status).toBe(status);
    expect(body).not.toContain(`secret-${status}`);
    expect(fetchCount).toBe(requestCount);
    expect(runtimeState.get(serviceName)?.upstreams).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'primary', status: 'HEALTHY', consecutive_failures: 0 }),
    ]));
    expect(row).toEqual({ status, protocol_outcome: 'failed', protocol_code: 'upstream_http_error', success: 0 });
    accessLogWriter.getDatabase().prepare('DELETE FROM access_logs WHERE path = ?').run(routePath);
  });

  test('explicit failover retry_on 400 still selects the sibling upstream', async () => {
    const fetchedUrls: string[] = [];
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onRawResponse: async (result) => result }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(undefined, async (result) => {
        if (result.response.ok) return result;
        await result.response.arrayBuffer();
        return {
          response: new Response('safe-400', { status: 400 }),
          completion: Promise.resolve({ status: 'failed' as const, code: 'upstream_http_error' }),
        };
      }),
    }));
    setFetchMock(async (input) => {
      const target = inputToUrl(input);
      fetchedUrls.push(target);
      return target.includes('primary.test') ? new Response('secret', { status: 400 }) : new Response('sibling-ok');
    });
    const config = {
      services: [{
        name: 'explicit-400-retry',
        failover: { enabled: true, retry_on: [400] },
        endpoints: [
          { id: 'primary', target: 'http://primary.test', priority: 0 },
          { id: 'secondary', target: 'http://secondary.test', priority: 1 },
        ],
      }],
      routes: [{ path: '/explicit-400-retry', service: 'explicit-400-retry' }],
    } as AppConfig;
    initializeRuntimeState(config);

    let response!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await handleRequest(new Request('http://localhost/explicit-400-retry'), config);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('sibling-ok');
    }
    expect(fetchedUrls).toHaveLength(6);
    expect(runtimeState.get('explicit-400-retry')?.upstreams).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'primary', status: 'UNHEALTHY', consecutive_failures: 3 }),
    ]));
    expect(fetchedUrls[0]).toContain('primary.test');
    expect(fetchedUrls[1]).toContain('secondary.test');
    await accessLogWriter.flush();
    const primaryAttempt = accessLogWriter.getDatabase().prepare(
      'SELECT status, success, protocol_outcome, protocol_code FROM access_logs WHERE path = ? AND attempt_upstream LIKE ? ORDER BY timestamp DESC LIMIT 1',
    ).get('/explicit-400-retry', '%primary.test%') as { status: number; success: number; protocol_outcome: string; protocol_code: string } | null;
    const primaryAttemptCount = accessLogWriter.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM access_logs WHERE path = ? AND attempt_upstream LIKE ?',
    ).get('/explicit-400-retry', '%primary.test%') as { count: number };
    expect(primaryAttempt).toEqual({ status: 400, success: 0, protocol_outcome: 'failed', protocol_code: 'upstream_http_error' });
    expect(primaryAttemptCount.count).toBe(3);
    accessLogWriter.getDatabase().prepare('DELETE FROM access_logs WHERE path = ?').run('/explicit-400-retry');
  });

  test.each([
    { name: 'original 200 masquerades as SSE 400', originalStatus: 200, consumeOriginal: true, replacement: 'new' as const },
    { name: 'original 400 gets an SSE replacement', originalStatus: 400, consumeOriginal: true, replacement: 'new' as const },
    { name: 'original 400 is reused with an unread body', originalStatus: 400, consumeOriginal: false, replacement: 'same' as const },
  ])('strictly rejects non-2xx streaming raw errors: $name', async ({ originalStatus, consumeOriginal, replacement }) => {
    let originalResponse: Response | undefined;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onRawResponse: async (result) => result }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(undefined, async (result) => {
        if (consumeOriginal) await result.response.arrayBuffer();
        return {
          response: replacement === 'same'
            ? result.response
            : new Response('data: safe\n\n', { status: 400, headers: { 'content-type': 'text/event-stream' } }),
          completion: Promise.resolve({ status: 'failed' as const, code: 'upstream_http_error' }),
        };
      }),
    }));
    setFetchMock(async () => {
      originalResponse = new Response('data: secret\n\n', {
        status: originalStatus,
        headers: { 'content-type': 'text/event-stream' },
      });
      return originalResponse;
    });
    const config: AppConfig = {
      services: [{
        name: 'stream-safe-client-error',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{ id: 'primary', target: 'http://primary.test' }],
      }],
      routes: [{ path: '/stream-safe-client-error', service: 'stream-safe-client-error' }],
    };
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost/stream-safe-client-error', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
      headers: { 'content-type': 'application/json' },
    }), config);

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
    expect(originalResponse?.bodyUsed).toBe(true);
    expect(getActiveRequestCount('stream-safe-client-error', 'primary')).toBe(0);
  });

  test.each([
    { name: 'original 200 is disguised as 400', originalStatus: 200, replacementStatus: 400, consumeOriginal: true },
    { name: 'original 500 is changed to 400', originalStatus: 500, replacementStatus: 400, consumeOriginal: true },
    { name: 'raw 400 is changed to 200 by onResponse', originalStatus: 400, replacementStatus: 400, finalStatus: 200, consumeOriginal: true },
    { name: 'raw 400 reuses the original response', originalStatus: 400, replacementStatus: 400, consumeOriginal: true, reuseOriginal: true },
    { name: 'raw 400 leaves the original body unread', originalStatus: 400, replacementStatus: 400, consumeOriginal: false },
  ])('rejects unsafe raw HTTP completion: $name', async ({ originalStatus, replacementStatus, finalStatus, consumeOriginal, reuseOriginal }) => {
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onRawResponse: async (result) => result }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(
        finalStatus === undefined ? undefined : async () => new Response('changed', { status: finalStatus }),
        async (result) => {
          if (consumeOriginal) await result.response.arrayBuffer();
          return {
            response: reuseOriginal ? result.response : new Response('safe', { status: replacementStatus }),
            completion: Promise.resolve({ status: 'failed' as const, code: 'upstream_http_error' }),
          };
        },
      ),
    }));
    setFetchMock(async () => new Response('secret', { status: originalStatus }));
    const config: AppConfig = {
      services: [{
        name: 'unsafe-raw-completion',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{ id: 'primary', target: 'http://primary.test' }],
      }],
      routes: [{ path: '/unsafe-raw-completion', service: 'unsafe-raw-completion' }],
    };
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost/unsafe-raw-completion'), config);

    expect(response.status).toBe(503);
    expect(getActiveRequestCount('unsafe-raw-completion', 'primary')).toBe(0);
  });

  test('neutral HALF_OPEN client errors release the slot and preserve recovery state', async () => {
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onRawResponse: async (result) => result }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(undefined, async (result) => {
        await result.response.arrayBuffer();
        return {
          response: new Response('safe-half-open-400', { status: 400 }),
          completion: Promise.resolve({ status: 'failed' as const, code: 'upstream_http_error' }),
        };
      }),
    }));
    setFetchMock(async () => new Response('secret', { status: 400 }));
    const config: AppConfig = {
      services: [{
        name: 'half-open-neutral',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{ id: 'primary', target: 'http://primary.test' }],
      }],
      routes: [{ path: '/half-open-neutral', service: 'half-open-neutral' }],
    };
    initializeRuntimeState(config);
    const selected = runtimeState.get('half-open-neutral')!.upstreams[0]!;
    selected.status = 'HALF_OPEN';
    selected.consecutive_failures = 2;
    selected.consecutive_successes = 1;
    selected.recovery_attempt_count = 3;

    const response = await handleRequest(new Request('http://localhost/half-open-neutral'), config);

    expect(response.status).toBe(400);
    expect(selected).toMatchObject({
      status: 'HALF_OPEN',
      consecutive_failures: 2,
      consecutive_successes: 1,
      recovery_attempt_count: 3,
    });
    expect(getActiveRequestCount('half-open-neutral', 'primary')).toBe(0);
  });

  test('three neutral 400 responses do not open the circuit before a real 200 success', async () => {
    let fetchCount = 0;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onRawResponse: async (result) => result }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(undefined, async (result) => {
        if (result.response.ok) return result;
        await result.response.arrayBuffer();
        return {
          response: new Response('safe-400', { status: 400 }),
          completion: Promise.resolve({ status: 'failed' as const, code: 'upstream_http_error' }),
        };
      }),
    }));
    setFetchMock(async () => {
      fetchCount++;
      return fetchCount <= 3 ? new Response('secret', { status: 400 }) : new Response('real-success');
    });
    const config: AppConfig = {
      services: [{
        name: 'neutral-then-success',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{ id: 'primary', target: 'http://primary.test' }],
      }],
      routes: [{ path: '/neutral-then-success', service: 'neutral-then-success' }],
    };
    initializeRuntimeState(config);

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await handleRequest(new Request('http://localhost/neutral-then-success'), config);
      expect(response.status).toBe(400);
    }
    const beforeSuccess = runtimeState.get('neutral-then-success')!.upstreams[0]!;
    expect(beforeSuccess).toMatchObject({ status: 'HEALTHY', consecutive_failures: 0 });

    const success = await handleRequest(new Request('http://localhost/neutral-then-success'), config);

    expect(success.status).toBe(200);
    expect(await success.text()).toBe('real-success');
    expect(fetchCount).toBe(4);
    expect(beforeSuccess).toMatchObject({ status: 'HEALTHY', consecutive_failures: 0 });
  });

  test('legacy completed 500 keeps status-only health behavior', async () => {
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks(),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(),
    }));
    setFetchMock(async () => new Response('legacy-error', { status: 500 }));
    const config: AppConfig = {
      services: [{
        name: 'legacy-completed-500',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{ id: 'primary', target: 'http://primary.test' }],
      }],
      routes: [{ path: '/legacy-completed-500', service: 'legacy-completed-500' }],
    };
    initializeRuntimeState(config);
    const selected = runtimeState.get('legacy-completed-500')!.upstreams[0]!;
    selected.consecutive_failures = 1;
    selected.consecutive_successes = 2;

    const response = await handleRequest(new Request('http://localhost/legacy-completed-500'), config);

    expect(response.status).toBe(500);
    expect(selected).toMatchObject({ status: 'HEALTHY', consecutive_failures: 1, consecutive_successes: 0 });
  });

  test.each([408, 425, 429, 500, 503])('status-triggered retry %p still fails health on the final endpoint', async (status) => {
    const serviceName = `status-retry-${status}`;
    const routePath = `/${serviceName}`;
    const fetched: string[] = [];
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onRawResponse: async (result) => result }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(undefined, async (result) => {
        if (result.response.ok) return result;
        await result.response.arrayBuffer();
        return {
          response: new Response('safe-status-error', { status: result.response.status }),
          completion: Promise.resolve({ status: 'failed' as const, code: 'upstream_http_error' }),
        };
      }),
    }));
    setFetchMock(async (input) => {
      fetched.push(inputToUrl(input));
      return new Response('secret', { status });
    });
    const config: AppConfig = {
      services: [{
        name: serviceName,
        failover: { enabled: true, retry_on: [status] },
        endpoints: [
          { id: 'primary', target: 'http://primary.test', priority: 0 },
          { id: 'secondary', target: 'http://secondary.test', priority: 1 },
        ],
      }],
      routes: [{ path: routePath, service: serviceName }],
    };
    initializeRuntimeState(config);

    let response!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await handleRequest(new Request(`http://localhost${routePath}`), config);
      expect(response.status).toBe(status);
    }
    expect(fetched).toHaveLength(6);
    expect(runtimeState.get(serviceName)?.upstreams).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'primary', status: 'UNHEALTHY', consecutive_failures: 3 }),
      expect.objectContaining({ id: 'secondary', status: 'UNHEALTHY', consecutive_failures: 3 }),
    ]));
  });

  test('Phase 1 failover action logs a warning and continues to upstream', async () => {
    const warnings: string[] = [];
    logger.warn = ((_data: unknown, message?: string) => {
      warnings.push(message ?? '');
    }) as typeof logger.warn;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onInterceptRequest: async () => ({ action: 'failover', reason: 'route-says-next' }) }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(),
    }));
    setFetchMock(async () => new Response('origin', { status: 200 }));
    const config = createSingleEndpointConfig();

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('origin');
    expect(warnings.some(message => message.includes('Phase 1 onInterceptRequest returned failover action'))).toBeTrue();
  });

  test('Phase 1 respond returns immediately without fetch or inbound chain', async () => {
    let fetchCount = 0;
    let inboundCount = 0;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks({ onInterceptRequest: async () => ({ action: 'respond', response: new Response('route-hit', { status: 209 }) }) }),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain((response) => {
        inboundCount++;
        return response;
      }),
    }));
    setFetchMock(async () => {
      fetchCount++;
      return new Response('origin', { status: 200 });
    });
    const config = createSingleEndpointConfig();

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(209);
    expect(await response.text()).toBe('route-hit');
    expect(fetchCount).toBe(0);
    expect(inboundCount).toBe(0);
  });

  test('Phase 2 respond returns immediately after Phase 1 continues', async () => {
    let fetchCount = 0;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks(),
      servicePhase: createPrecompiledHooks({ onInterceptRequest: async () => ({ action: 'respond', response: new Response('service-hit', { status: 210 }) }) }),
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(),
    }));
    setFetchMock(async () => {
      fetchCount++;
      return new Response('origin', { status: 200 });
    });
    const config = createFailoverConfig();
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(210);
    expect(await response.text()).toBe('service-hit');
    expect(fetchCount).toBe(0);
  });

  test('Phase 2 failover action logs a warning and continues to upstream', async () => {
    const warnings: string[] = [];
    logger.warn = ((_data: unknown, message?: string) => {
      warnings.push(message ?? '');
    }) as typeof logger.warn;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks(),
      servicePhase: createPrecompiledHooks({ onInterceptRequest: async () => ({ action: 'failover', reason: 'service-says-next' }) }),
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(),
    }));
    setFetchMock(async () => new Response('origin', { status: 200 }));
    const config = createFailoverConfig();
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('origin');
    expect(warnings.some(message => message.includes('Phase 2 onInterceptRequest returned failover action'))).toBeTrue();
  });

  test('Phase 3 failover action skips the current upstream and tries the next upstream', async () => {
    const fetchedUrls: string[] = [];
    installPhaseHooks((upstreamId) => ({
      routePhase: createPrecompiledHooks(),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks({
        onInterceptRequest: upstreamId === 'primary' ? async () => ({ action: 'failover', reason: 'primary-skipped' }) : undefined,
      }),
      inbound: createInboundChain(),
    }));
    setFetchMock(async (input) => {
      const url = inputToUrl(input);
      fetchedUrls.push(url);
      return new Response('secondary-ok', { status: 200 });
    });
    const config = createFailoverConfig();
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('secondary-ok');
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain('secondary.test');
  });

  test('Phase 3 respond is terminal and bypasses inbound chain', async () => {
    let inboundCount = 0;
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks(),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks({ onInterceptRequest: async () => ({ action: 'respond', response: new Response('endpoint-hit', { status: 211 }) }) }),
      inbound: createInboundChain((response) => {
        inboundCount++;
        return response;
      }),
    }));
    const config = createSingleEndpointConfig();

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(211);
    expect(await response.text()).toBe('endpoint-hit');
    expect(inboundCount).toBe(0);
  });

  test('successful upstream responses use the explicit inbound chain', async () => {
    installPhaseHooks(() => ({
      routePhase: createPrecompiledHooks(),
      servicePhase: null,
      upstreamPhase: createPrecompiledHooks(),
      inbound: createInboundChain(async (response) => new Response(`${await response.text()}>endpoint>service>route>global`, { status: response.status })),
    }));
    setFetchMock(async () => new Response('origin', { status: 200 }));
    const config = createSingleEndpointConfig();

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('origin>endpoint>service>route>global');
  });

  test('onFinally runs request-level once and final-upstream-level only for final upstream', async () => {
    const finallyRecords: string[] = [];
    installPhaseHooks((upstreamId) => ({
      routePhase: createPrecompiledHooks({ label: 'route', onFinally: async () => { finallyRecords.push('route'); } }),
      servicePhase: createPrecompiledHooks({ label: 'service', onFinally: async () => { finallyRecords.push('service'); } }),
      upstreamPhase: createPrecompiledHooks({ label: `upstream:${upstreamId ?? 'none'}`, onFinally: async () => { finallyRecords.push(`upstream:${upstreamId}`); } }),
      inbound: createInboundChain(),
    }));
    setFetchMock(async (input) => {
      const url = inputToUrl(input);
      if (url.includes('primary.test')) {
        return new Response('retry', { status: 503 });
      }
      return new Response('ok', { status: 200 });
    });
    const config = createFailoverConfig();
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost/api/test'), config);

    expect(response.status).toBe(200);
  expect(finallyRecords).toEqual(['upstream:secondary', 'service', 'route']);
});

test('onFinally skips endpoint when all upstreams fail but still runs request-level', async () => {
  const finallyRecords: string[] = [];
  installPhaseHooks((upstreamId) => ({
    routePhase: createPrecompiledHooks({ label: 'route', onFinally: async () => { finallyRecords.push('route'); } }),
    servicePhase: createPrecompiledHooks({ label: 'service', onFinally: async () => { finallyRecords.push('service'); } }),
    upstreamPhase: createPrecompiledHooks({ label: `upstream:${upstreamId ?? 'none'}`, onFinally: async () => { finallyRecords.push(`upstream:${upstreamId}`); } }),
    inbound: createInboundChain(),
  }));
  setFetchMock(async () => new Response('error', { status: 503 }));
  const config = createFailoverConfig();
  initializeRuntimeState(config);

  const response = await handleRequest(new Request('http://localhost/api/test'), config);

  expect(response.status).toBe(503);
  expect(finallyRecords).toEqual(['service', 'route']);
  expect(finallyRecords).not.toContain(expect.stringContaining('upstream:'));
});
});
