import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import '../helpers/data-plane-runtime';
import type { AppConfig } from '@jeffusion/bungee-types';
import { createPluginHooks } from '../../src/hooks';
import type { PhaseAwareHooks, PrecompiledHooks } from '../../src/scoped-plugin-registry';
import { proxyRequest } from '../../src/worker/request/proxy';
import type { EffectiveRouteConfig, RequestSnapshot, RuntimeUpstream } from '../../src/worker/types';
import { setPluginRegistry } from '../../src/worker/state/plugin-manager';
import { setBoundControlClientProvider } from '../../src/config-worker/runtime-dependencies';
import type { PluginRegistry } from '../../src/plugin-registry';

const originalFetch = global.fetch;

const manifest = {
  control: {
    rpc: [{ name: 'getCredential', access: 'bound-attempt' as const }, { name: 'rejectAccess', access: 'bound-attempt' as const }],
  },
  contributes: {
    upstreamSources: [{
      id: 'provider',
      credentialPolicy: {
        allowedOrigins: ['https://api.example.test'],
        allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'] }],
        allowedHeaderNames: ['authorization', 'x-api-key'],
      },
    }],
  },
};

function emptyPrecompiled(): PrecompiledHooks {
  const hooks = createPluginHooks();
  return {
    handlers: [],
    hooks,
    hasInterceptCallbacks: false,
    hasResponseCallbacks: false,
    hasRawResponseCallbacks: false,
    hasStreamCallbacks: false,
    metadata: { createdAt: Date.now(), pluginCount: 0, pluginNames: [], scope: 'test' },
  };
}

function phaseHooks(options: {
  raw?: (result: any, context: any) => Promise<any>;
  onError?: (context: any) => Promise<void>;
} = {}): PhaseAwareHooks {
  const upstream = emptyPrecompiled();
  if (options.raw) {
    upstream.hooks.onRawResponse.tapPromise({ name: 'regression-raw' }, options.raw);
  }
  return {
    upstreamPhase: options.raw ? { ...upstream, hasRawResponseCallbacks: true } : upstream,
    servicePhase: null,
    routePhase: emptyPrecompiled(),
    globalPrecompiled: null,
    routePrecompiled: null,
    inbound: {
      onResponse: async (response) => response,
      onRawResponse: async (result, context) => options.raw ? options.raw(result, context) : result,
      onStreamChunk: async (chunk) => [chunk],
      onFlushStream: async (chunks) => chunks,
      onError: options.onError ?? (async () => {}),
    },
  } as PhaseAwareHooks;
}

function createUpstream(): RuntimeUpstream {
  return {
    id: 'endpoint-1',
    target: 'https://api.example.test',
    upstream_id: 'endpoint-1',
    plugins: [{ id: 'binding-1', name: 'provider', enabled: true, options: {} }],
    managedBy: { plugin: 'provider', contributionId: 'provider', bindingId: 'binding-1' },
    status: 'HEALTHY',
    consecutive_failures: 0,
    consecutive_successes: 0,
    recovery_attempt_count: 0,
  } as unknown as RuntimeUpstream;
}

function createSnapshot(): RequestSnapshot {
  return {
    method: 'POST',
    url: 'http://proxy.test/v1/chat',
    headers: { authorization: 'client-secret', cookie: 'session=TEST_SECRET', 'x-safe': 'yes' },
    body: { input: 'ok' },
    content_type: 'application/json',
    is_json_body: true,
  };
}

const route = {
  path: '/proxy',
  endpoints: [],
  timeouts: { request_ms: 20 },
} as unknown as EffectiveRouteConfig;
const config = { routes: [] } as AppConfig;

describe('proxy credential regressions', () => {
  let calls: Array<{ method: string; signal: AbortSignal }>;

  beforeEach(() => {
    calls = [];
    setPluginRegistry({
      getPluginStateSnapshot: () => ({ pluginName: 'provider', discovery: 'discovered', validation: 'validated', persistedEnabled: 'enabled', manifest }),
    } as unknown as PluginRegistry);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setPluginRegistry(null);
    setBoundControlClientProvider(null);
  });

  function installProvider(options: {
    credential?: (signal: AbortSignal) => Promise<unknown>;
    reject?: (signal: AbortSignal) => Promise<unknown>;
  } = {}): void {
    setBoundControlClientProvider((_binding, attempt) => {
      expect(attempt).toEqual({ revision: 7, endpointId: 'endpoint-1', attemptId: 'attempt-1' });
      return {
        call: async <T>(method: string, _payload: unknown, signal: AbortSignal): Promise<T> => {
          calls.push({ method, signal });
          if (method === 'getCredential') {
            return (await (options.credential?.(signal) ?? Promise.resolve({
              version: 3,
              expiresAt: Date.now() + 10_000,
              headers: { authorization: 'Bearer TEST_SECRET', 'x-api-key': 'LEASE_KEY' },
            }))) as T;
          }
          return (await (options.reject?.(signal) ?? Promise.resolve(true))) as T;
        },
      };
    });
  }

  async function run(options: { hooks?: PhaseAwareHooks } = {}) {
    return proxyRequest(
      createSnapshot(),
      route,
      createUpstream(),
      { requestId: 'request-1' },
      config,
      'route-1',
      undefined,
      options.hooks,
      undefined,
      undefined,
      { servingRevision: 7, attemptId: 'attempt-1' },
    );
  }

  test('real proxy injects only the trusted authorization lease', async () => {
    installProvider();
    let fetchedHeaders: Headers | undefined;
    global.fetch = (async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchedHeaders = new Headers(init?.headers);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const result = await run();
    expect(fetchedHeaders?.get('authorization')).toBe('Bearer TEST_SECRET');
    expect(fetchedHeaders?.get('x-api-key')).toBe('LEASE_KEY');
    expect(fetchedHeaders?.get('cookie')).toBeNull();
    expect(fetchedHeaders?.get('x-safe')).toBe('yes');
    await result.cleanup?.();
  });

  test('credential acquisition is deadline-bound and aborts a non-cooperative provider', async () => {
    let aborted = false;
    installProvider({ credential: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
    const started = Date.now();
    await expect(run()).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('pending rejectAccess is bounded and 401 notification is single-shot', async () => {
    let rejectAborted = false;
    installProvider({ reject: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { rejectAborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
    global.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    await expect(run()).rejects.toThrow();
    expect(calls.filter(({ method }) => method === 'rejectAccess')).toHaveLength(1);
    expect(rejectAborted).toBe(true);
  });

  test('raw hook gets the full deadline signal and onError cannot block cleanup or see secrets', async () => {
    installProvider();
    let rawSignal: AbortSignal | undefined;
    let onErrorHeaders: Record<string, string> | undefined;
    global.fetch = (async () => new Response('ok')) as unknown as typeof fetch;
    const hooks = phaseHooks({
      raw: async (_result, context) => {
        rawSignal = context.signal;
        return new Promise(() => {});
      },
      onError: async (context) => {
        onErrorHeaders = context.headers;
        return new Promise(() => {});
      },
    });
    const started = Date.now();
    await expect(run({ hooks })).rejects.toThrow();
    expect(rawSignal?.aborted).toBe(true);
    expect(onErrorHeaders?.authorization).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('onError receives pre-injection headers and redacted diagnostics', async () => {
    installProvider();
    global.fetch = (async () => new Response('ok')) as unknown as typeof fetch;
    let errorMessage = '';
    let headers: Record<string, string> | undefined;
    const hooks = phaseHooks({
      raw: async () => { throw new Error('raw TEST_SECRET'); },
      onError: async (context) => {
        errorMessage = context.error.message;
        headers = context.headers;
      },
    });
    await expect(run({ hooks })).rejects.toThrow();
    expect(errorMessage).not.toContain('TEST_SECRET');
    expect(headers?.authorization).toBeUndefined();
  });
});
