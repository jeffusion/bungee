import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AppConfig, InterceptResult } from '@jeffusion/bungee-types';
import { createPluginHooks, type FinallyContext, type MutableRequestContext, type ResponseContext } from '../../src/hooks';
import { logger } from '../../src/logger';
import { setScopedPluginRegistry, type PhaseAwareHooks, type PrecompiledHooks, type ScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { handleRequest } from '../../src/worker/request/handler';
import { initializeRuntimeState, runtimeState } from '../../src/worker/state/runtime-state';

const originalFetch = global.fetch;
const originalWarn = logger.warn;

function createPrecompiledHooks(options: {
  label?: string;
  onBeforeRequest?: (ctx: MutableRequestContext) => MutableRequestContext | Promise<MutableRequestContext>;
  onInterceptRequest?: (ctx: MutableRequestContext) => InterceptResult | Promise<InterceptResult>;
  onResponse?: (response: Response, ctx: ResponseContext) => Response | Promise<Response>;
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
  if (options.onFinally) {
    hooks.onFinally.tapPromise({ name: `${label}:finally` }, async (ctx) => await options.onFinally!(ctx));
  }

  return {
    handlers: [],
    hooks,
    hasInterceptCallbacks: hooks.onInterceptRequest.hasCallbacks(),
    hasResponseCallbacks: hooks.onResponse.hasCallbacks(),
    hasStreamCallbacks: hooks.onStreamChunk.hasCallbacks(),
    metadata: {
      createdAt: Date.now(),
      pluginCount: hooks.onBeforeRequest.hasCallbacks() || hooks.onInterceptRequest.hasCallbacks() || hooks.onResponse.hasCallbacks() || hooks.onFinally.hasCallbacks() ? 1 : 0,
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

function createInboundChain(onResponse?: (response: Response) => Promise<Response> | Response): PhaseAwareHooks['inbound'] {
  return {
    onResponse: async (response) => onResponse ? await onResponse(response) : response,
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
