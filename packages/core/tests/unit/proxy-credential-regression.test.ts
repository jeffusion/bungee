import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import '../helpers/data-plane-runtime';
import type { AppConfig } from '@jeffusion/bungee-types';
import { compileRuntimeConfigSnapshot, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { createPluginHooks } from '../../src/hooks';
import { ScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import type { PhaseAwareHooks, PrecompiledHooks } from '../../src/scoped-plugin-registry';
import { isManagedUpstreamAccessError, proxyRequest } from '../../src/worker/request/proxy';
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

  test('committed ChatGPT V2 aggregate traverses real scopes with a closed credential header profile', async () => {
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
    if (!binding || typeof binding === 'string' || !binding.id) throw new Error('missing materialized ChatGPT binding');
    if (!endpoint.id) throw new Error('missing materialized ChatGPT endpoint id');
    expect(binding.id).toBe(bindingId);
    expect(binding.options).toEqual({ accountRef: 'account-1' });
    expect((endpoint as unknown as { managedBy: { bindingId: string } }).managedBy.bindingId).toBe(binding.id);

    const realManifest = JSON.parse(readFileSync(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
    setPluginRegistry({
      getPluginStateSnapshot: () => ({
        pluginName: 'chatgpt-oauth', discovery: 'discovered', validation: 'validated',
        persistedEnabled: 'enabled', manifest: realManifest,
      }),
    } as unknown as PluginRegistry);
    const registry = new ScopedPluginRegistry(new URL('../../../../', import.meta.url).pathname);
    await registry.createInstance({ type: 'upstream', routeId, upstreamId: endpoint.id }, binding);
    const hooks = registry.getPrecompiledHooks(routeId, endpoint.id);
    const runtimeUpstream = {
      ...endpoint,
      upstream_id: endpoint.id,
      status: 'HEALTHY' as const,
      consecutive_failures: 0,
      consecutive_successes: 0,
      recovery_attempt_count: 0,
    } as RuntimeUpstream;
    const dynamicHeaders = [
      'Version', 'X-Codex-Beta-Features', 'X-Codex-Turn-Metadata', 'X-Client-Request-Id',
      'X-Codex-Window-Id', 'Thread-Id', 'Session-Id', 'X-OpenAI-Internal-Codex-Responses-Lite',
    ];
    const hostileHeaders: Record<string, string> = {
      'User-Agent': 'evil-user-agent', Originator: 'evil-originator', Accept: 'evil-accept',
      'Content-Type': 'evil-content-type', Authorization: 'Bearer CLIENT_SECRET',
      'Chatgpt-Account-Id': 'client-account', Cookie: 'client-cookie',
      'X-Forwarded-For': 'client-forwarded', Referer: 'client-referer', 'X-Evil': 'client-evil',
      Host: 'client-host', Connection: 'close', 'Accept-Encoding': 'gzip', 'Content-Length': '1',
    };
    Object.assign(hostileHeaders, Object.fromEntries(dynamicHeaders.map((name) => [name, `inbound-${name}`])));
    const observations: Array<{ label: string; requestId: string; sessionId?: string; userAgent?: string; originator?: string }> = [];
    let mutation: 'path' | 'origin' | undefined;
    let writeSessionHeader = false;
    hooks.upstreamPhase.hooks.onBeforeRequest.tapPromise({ name: 'malicious-late-hook', stage: 100 }, async (context) => {
      const marker = context.headers['x-evil'] ?? '';
      const label = marker.startsWith('inbound-evil-') ? marker.slice('inbound-evil-'.length) : context.requestId;
      observations.push({ label, requestId: context.requestId, sessionId: context.headers['session-id'], userAgent: context.headers['user-agent'], originator: context.headers.originator });
      const lateHeaders = { ...hostileHeaders };
      delete lateHeaders['Session-Id'];
      Object.assign(context.headers, {
        ...lateHeaders,
        ...Object.fromEntries(dynamicHeaders.filter((name) => writeSessionHeader || name !== 'Session-Id')
          .map((name) => [name, `late-${label}-${name}`])),
      });
      if (mutation === 'path') context.url.pathname = '/backend-api/codex/not-allowed';
      if (mutation === 'origin') context.url = new URL(`https://evil.example${context.url.pathname}`);
      return context;
    });

    const fetches: Array<{ url: string; headers: Headers; redirect: RequestRedirect; body?: string }> = [];
    global.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetches.push({
        url: String(input),
        headers: new Headers(init?.headers),
        redirect: init?.redirect as RequestRedirect,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (String(input).includes('/backend-api/codex/models')) {
        return new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;
    const credentialCalls: Array<{ method: string; attemptId?: string }> = [];
    setBoundControlClientProvider((bindingContext, attempt) => {
      expect(bindingContext.bindingId).toBe(bindingId);
      if (!attempt) throw new Error('missing bound attempt identity');
      expect(attempt.endpointId).toBe(endpointId);
      return {
        call: async <T>(method: string): Promise<T> => {
          credentialCalls.push({ method, attemptId: attempt.attemptId });
          if (method === 'getCredential') {
            return {
              version: 1,
              expiresAt: Date.now() + 10_000,
              headers: { authorization: 'Bearer LEASE_SECRET', 'chatgpt-account-id': 'account-lease' },
            } as T;
          }
          return true as T;
        },
      };
    });

    const stableRequestId = 'chatgpt-integration-request';
    const run = (path: string, method: string, body: Record<string, unknown> | undefined, attemptId: string, sessionId?: string) => {
      const headers = { ...hostileHeaders };
      delete headers['Session-Id'];
      headers['X-Evil'] = `inbound-evil-${attemptId}`;
      if (sessionId !== undefined) headers['Session-Id'] = sessionId;
      return proxyRequest(
        {
          method,
          url: `http://proxy.test${path}`,
          headers,
          body,
          content_type: body ? 'application/json' : '',
          is_json_body: body !== undefined,
        },
        route,
        runtimeUpstream,
        { requestId: stableRequestId },
        runtime.config,
        routeId,
        undefined,
        hooks,
        undefined,
        undefined,
        { servingRevision: 26, attemptId },
      );
    };
    const read = async (result: Awaited<ReturnType<typeof run>>) => {
      const body = await result.response.text();
      await result.cleanup?.();
      return body;
    };
    const appHeaders = (headers: Headers): Record<string, string> => {
      const result: Record<string, string> = {};
      headers.forEach((value, name) => { result[name] = value; });
      return result;
    };
    const modelsHeaders = {
      accept: 'application/json',
      authorization: 'Bearer LEASE_SECRET',
      'chatgpt-account-id': 'account-lease',
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.153.3 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9',
    };
    const responseStatic = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      originator: 'codex-tui',
      'user-agent': 'codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)',
      authorization: 'Bearer LEASE_SECRET',
      'chatgpt-account-id': 'account-lease',
    };
    const expectedDynamic = (label: string, includeSession = false) => Object.fromEntries(dynamicHeaders
      .filter((name) => includeSession || name !== 'Session-Id')
      .map((name) => [name.toLowerCase(), `late-${label}-${name}`]));
    const cases = [
      { label: 'models-attempt', path: '/v1/models', method: 'GET', body: undefined, expected: modelsHeaders },
      { label: 'responses-false', path: '/v1/responses', method: 'POST', body: { model: 'codex', input: 'hello', stream: false, prompt_cache_key: 'prompt-session' }, sessionId: 'explicit-session', expected: { ...responseStatic, ...expectedDynamic('responses-false'), 'session-id': 'explicit-session' } },
      { label: 'responses-true', path: '/v1/responses', method: 'POST', body: { model: 'codex', input: 'hello', stream: true, prompt_cache_key: 'prompt-session-true' }, expected: { ...responseStatic, ...expectedDynamic('responses-true'), 'session-id': 'prompt-session-true' } },
      { label: 'chat-false', path: '/v1/chat/completions', method: 'POST', body: { model: 'codex', messages: [{ role: 'user', content: 'hello' }], stream: false }, expected: { ...responseStatic, ...expectedDynamic('chat-false') } },
      { label: 'chat-true', path: '/v1/chat/completions', method: 'POST', body: { model: 'codex', messages: [{ role: 'user', content: 'hello' }], stream: true, prompt_cache_key: 'chat-prompt-session' }, expected: { ...responseStatic, ...expectedDynamic('chat-true'), 'session-id': 'chat-prompt-session' } },
    ] as const;

    try {
      for (const item of cases) {
        const result = await run(item.path, item.method, item.body, item.label, item.label === 'responses-false' ? 'explicit-session' : undefined);
        await read(result);
        const fetch = fetches.at(-1)!;
        expect(fetch.headers).toEqual(new Headers(item.expected));
        expect(appHeaders(fetch.headers)).toEqual(item.expected);
        expect(fetch.redirect).toBe('manual');
        expect(fetch.url).toBe(item.label === 'models-attempt'
          ? 'https://chatgpt.com/backend-api/codex/models?client_version=0.153.3'
          : 'https://chatgpt.com/backend-api/codex/responses');
        if (item.body === undefined) expect(fetch.body).toBeUndefined();
        else {
          expect(JSON.parse(fetch.body!)).toMatchObject({ stream: true });
          const promptCacheKey = (item.body as Record<string, unknown>).prompt_cache_key;
          if (promptCacheKey !== undefined) expect(JSON.parse(fetch.body!).prompt_cache_key).toBe(promptCacheKey);
        }
      }
      expect(observations.map(({ label, sessionId }) => [label, sessionId])).toEqual([
        ['models-attempt', undefined],
        ['responses-false', 'explicit-session'],
        ['responses-true', 'prompt-session-true'],
        ['chat-false', undefined],
        ['chat-true', 'chat-prompt-session'],
      ]);
      expect(observations.map(({ userAgent, originator }) => [userAgent, originator])).toEqual([
        ['codex_cli_rs/0.153.3 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9', 'codex_cli_rs'],
        ['codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)', 'codex-tui'],
        ['codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)', 'codex-tui'],
        ['codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)', 'codex-tui'],
        ['codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)', 'codex-tui'],
      ]);
      expect(observations.slice(0, cases.length).every(({ requestId }) => requestId === stableRequestId)).toBe(true);

      const beforeRetryFetches = fetches.length;
      writeSessionHeader = true;
      const firstRetry = await run('/v1/chat/completions', 'POST', { model: 'codex', messages: [{ role: 'user', content: 'retry' }], stream: true }, 'retry-1');
      const secondRetry = await run('/v1/chat/completions', 'POST', { model: 'codex', messages: [{ role: 'user', content: 'retry' }], stream: true }, 'retry-2');
      await read(firstRetry);
      expect(fetches.slice(beforeRetryFetches).map(({ headers }) => appHeaders(headers))).toEqual([
        { ...responseStatic, ...expectedDynamic('retry-1', true) },
        { ...responseStatic, ...expectedDynamic('retry-2', true) },
      ]);
      const probe = await hooks.inbound.onRawResponse!({
        response: new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
        completion: Promise.resolve({ status: 'completed' }),
      }, { requestId: stableRequestId, attemptId: 'retry-probe', signal: new AbortController().signal } as any);
      expect(await probe.response.text()).toContain('"object":"chat.completion.chunk"');
      await read(secondRetry);
      expect(credentialCalls.filter(({ method }) => method === 'getCredential').map(({ attemptId }) => attemptId)).toContain('retry-1');
      expect(credentialCalls.filter(({ method }) => method === 'getCredential').map(({ attemptId }) => attemptId)).toContain('retry-2');

      const fetchCount = fetches.length;
      const credentialCount = credentialCalls.length;
      mutation = 'path';
      const pathError = await run('/v1/responses', 'POST', { model: 'codex', input: 'late-path', stream: false }, 'late-path').catch((error) => error);
      expect(isManagedUpstreamAccessError(pathError)).toBe(true);
      expect(fetches).toHaveLength(fetchCount);
      expect(credentialCalls).toHaveLength(credentialCount);
      mutation = 'origin';
      const originError = await run('/v1/responses', 'POST', { model: 'codex', input: 'late-origin', stream: false }, 'late-origin').catch((error) => error);
      expect(isManagedUpstreamAccessError(originError)).toBe(true);
      expect(fetches).toHaveLength(fetchCount);
      expect(credentialCalls).toHaveLength(credentialCount);
    } finally {
      await registry.destroy();
    }
  });
});
