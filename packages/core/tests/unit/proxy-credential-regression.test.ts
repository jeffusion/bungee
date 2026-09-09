import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import '../helpers/data-plane-runtime';
import type { AppConfig } from '@jeffusion/bungee-types';
import { compileRuntimeConfigSnapshot, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { createPluginHooks } from '../../src/hooks';
import { ScopedPluginRegistry } from '../../src/scoped-plugin-registry';
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

  test('committed ChatGPT V2 snapshot reaches the real adapter and proxy without header leakage', async () => {
    const routeId = '20000000-0000-4000-8000-000000000026';
    const endpointId = '30000000-0000-4000-8000-000000000026';
    const bindingId = '40000000-0000-4000-8000-000000000026';
    const compiledInput = parseNormalizeCompileAggregate({
      logical_configuration: {
        routes: [{
          id: routeId,
          position: 1,
          path: '/v1/chat/completions',
          endpoints: [{
            id: endpointId,
            position: 1,
            target: 'https://chatgpt.com',
            managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId },
            plugins: [{ id: bindingId, position: 1, name: 'chatgpt-oauth', options: { accountRef: 'account-1' }, enabled: true }],
          }],
        }],
      },
      plugin_activations: [{ plugin_name: 'chatgpt-oauth' }],
    });
    if (!compiledInput.ok) throw new Error(`invalid ChatGPT fixture: ${compiledInput.errors[0]?.path ?? 'unknown'}`);
    const committed = {
      revision: 26,
      content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
      aggregate: compiledInput.value,
    };
    const runtime = compileRuntimeConfigSnapshot(committed);
    const route = runtime.config.routes[0] as EffectiveRouteConfig;
    const endpoint = route.endpoints[0];
    const binding = endpoint.plugins?.[0];
    if (!binding || typeof binding === 'string') throw new Error('missing materialized ChatGPT binding');
    const materializedBindingId = binding.id;
    if (!materializedBindingId) throw new Error('missing materialized ChatGPT binding id');
    const materializedEndpointId = endpoint.id;
    if (!materializedEndpointId) throw new Error('missing materialized ChatGPT endpoint id');
    expect(materializedBindingId).toBe(bindingId);
    expect(binding.options).toEqual({ accountRef: 'account-1' });
    expect((endpoint as unknown as { managedBy: { bindingId: string } }).managedBy.bindingId).toBe(materializedBindingId);

    const manifest = JSON.parse(readFileSync(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
    setPluginRegistry({
      getPluginStateSnapshot: () => ({
        pluginName: 'chatgpt-oauth', discovery: 'discovered', validation: 'validated',
        persistedEnabled: 'enabled', manifest,
      }),
    } as unknown as PluginRegistry);
    const registry = new ScopedPluginRegistry(new URL('../../../../', import.meta.url).pathname);
    await registry.createInstance(
      { type: 'upstream', routeId, upstreamId: materializedEndpointId },
      binding,
    );
    const hooks = registry.getPrecompiledHooks(routeId, materializedEndpointId);
    const runtimeUpstream = {
      ...endpoint,
      upstream_id: materializedEndpointId,
      status: 'HEALTHY' as const,
      consecutive_failures: 0,
      consecutive_successes: 0,
      recovery_attempt_count: 0,
    } as RuntimeUpstream;
    const fetches: Array<{ url: string; headers: Headers }> = [];
    global.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetches.push({ url: String(input), headers: new Headers(init?.headers) });
      if (String(input).includes('/backend-api/codex/models')) {
        return new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;
    setBoundControlClientProvider((bindingContext, attempt) => {
      expect(bindingContext.bindingId).toBe(bindingId);
      if (!attempt) throw new Error('missing bound attempt identity');
      expect(attempt.endpointId).toBe(endpointId);
      return {
        call: async <T>(method: string): Promise<T> => {
          if (method === 'getCredential') {
            return {
              version: 1,
              expiresAt: Date.now() + 10_000,
              headers: {
                authorization: 'Bearer LEASE_SECRET',
                'chatgpt-account-id': 'account-lease',
                originator: 'client-originator',
              },
            } as T;
          }
          return true as T;
        },
      };
    });

    const run = (path: string, method: string, body: Record<string, unknown> | undefined, attemptId: string) =>
      proxyRequest(
        {
          method,
          url: `http://proxy.test${path}`,
          headers: {
            authorization: 'Bearer CLIENT_SECRET',
            'chatgpt-account-id': 'client-account',
            originator: 'client-originator',
            cookie: 'client-cookie',
          },
          body,
          content_type: body ? 'application/json' : '',
          is_json_body: body !== undefined,
        },
        route,
        runtimeUpstream,
        { requestId: attemptId },
        runtime.config,
        routeId,
        undefined,
        hooks,
        undefined,
        undefined,
        { servingRevision: 26, attemptId },
      );

    try {
      const models = await run('/v1/models', 'GET', undefined, 'models-attempt');
      await models.cleanup?.();
      expect(fetches[0]?.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.153.3');
      expect(fetches[0]?.headers.get('authorization')).toBe('Bearer LEASE_SECRET');
      expect(fetches[0]?.headers.get('chatgpt-account-id')).toBe('account-lease');
      expect(fetches[0]?.headers.get('originator')).toBe('codex_cli_rs');
      expect(fetches[0]?.headers.get('cookie')).toBeNull();
      expect(fetches[0]?.headers.get('x-api-key')).toBeNull();
      expect(fetches[0]?.headers.get('authorization')).not.toBe('Bearer CLIENT_SECRET');
      expect(fetches[0]?.headers.get('chatgpt-account-id')).not.toBe('client-account');
      expect(fetches[0]?.headers.get('originator')).not.toBe('client-originator');

      const responses = await run('/v1/responses', 'POST', { model: 'codex', input: 'hello', stream: false }, 'responses-attempt');
      await responses.cleanup?.();
      expect(fetches[1]?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(fetches[1]?.headers.get('authorization')).toBe('Bearer LEASE_SECRET');
      expect(fetches[1]?.headers.get('chatgpt-account-id')).toBe('account-lease');
      expect(fetches[1]?.headers.get('originator')).toBe('codex_cli_rs');
    } finally {
      await registry.destroy();
    }
  });
});
