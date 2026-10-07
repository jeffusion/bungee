import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../helpers/data-plane-runtime';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { RequestLoggerDependencies } from '../../src/logger/request-logger';
import { compileRuntimeConfigSnapshot, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { createPluginHooks } from '../../src/hooks';
import { ScopedPluginRegistry, setScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import type { PhaseAwareHooks, PrecompiledHooks } from '../../src/scoped-plugin-registry';
import {
  AttemptCleanupError,
  isManagedUpstreamAccessError,
  proxyRequest,
  UpstreamTimeoutError,
} from '../../src/worker/request/proxy';
import type { EffectiveRouteConfig, RequestSnapshot, RuntimeUpstream } from '../../src/worker/types';
import { setPluginRegistry } from '../../src/worker/state/plugin-manager';
import { setBoundControlClientProvider } from '../../src/config-worker/runtime-dependencies';
import { readHostRpcCalleeFrame } from '../../src/plugin-services/host-rpc';
import { PluginServiceHost } from '../../src/plugin-services';
import type { RpcEndpointHandle } from '../../src/plugin-services/rpc-runtime';
import { businessRpc as oauthCredentialRpc } from '../../../../plugins/chatgpt-oauth/server/rpc';
import { MODELS_DEV_CATALOG_SERVICE_ID } from '../../../../plugins/models-dev/contract';
import { rawCatalogService } from '../../../../plugins/token-stats/tests/support/catalog-service';
import type { PluginRegistry } from '../../src/plugin-registry';
import { handleRequest } from '../../src/worker/request/handler';
import { initializeRuntimeState, runtimeState } from '../../src/worker/state/runtime-state';

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
  onResponse?: (response: Response) => Response | Promise<Response>;
  stream?: (chunk: any) => any[] | Promise<any[]>;
} = {}): PhaseAwareHooks {
  const upstream = emptyPrecompiled();
  if (options.raw) {
    upstream.hooks.onRawResponse.tapPromise({ name: 'regression-raw' }, options.raw);
  }
  const configuredUpstream = {
    ...upstream,
    handlers: [{ pluginName: 'regression-hooks', config: {}, bodyRequirements: () => ({ request: 'none', response: [ ...(options.onResponse ? ['json' as const] : []), ...(options.stream ? ['sse-json' as const] : []) ] }), register() {} }],
    hasResponseCallbacks: Boolean(options.onResponse),
    hasRawResponseCallbacks: Boolean(options.raw),
    hasStreamCallbacks: Boolean(options.stream),
  };
  return {
    upstreamPhase: configuredUpstream,
    servicePhase: null,
    routePhase: emptyPrecompiled(),
    globalPrecompiled: null,
    routePrecompiled: null,
    inbound: {
      onResponse: async (response) => options.onResponse ? options.onResponse(response) : response,
      onRawResponse: async (result, context) => options.raw ? options.raw(result, context) : result,
      onStreamChunk: async (chunk) => options.stream ? options.stream(chunk) : [chunk],
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

function createSnapshot(stream?: boolean): RequestSnapshot {
  return {
    method: 'POST',
    url: 'http://proxy.test/v1/chat',
    headers: { authorization: 'client-secret', cookie: 'session=TEST_SECRET', 'x-safe': 'yes' },
    body: { input: 'ok', ...(stream === undefined ? {} : { stream }) },
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
    setScopedPluginRegistry(null);
    runtimeState.clear();
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

  async function run(options: { hooks?: PhaseAwareHooks; stream?: boolean; route?: EffectiveRouteConfig; signal?: AbortSignal } = {}) {
    return proxyRequest(
      createSnapshot(options.stream),
      options.route ?? route,
      createUpstream(),
      { requestId: 'request-1' },
      config,
      'route-1',
      undefined,
      options.hooks,
      undefined,
      options.signal,
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

  test('final request logs redact custom lease headers and retain the profiled SSE Accept', async () => {
    const customManifest = structuredClone(manifest) as any;
    const policy = customManifest.contributes.upstreamSources[0].credentialPolicy;
    policy.allowedHeaderNames = ['X-Provider-Key'];
    policy.allowedRequests[0].outboundHeaders = { passthrough: [], set: { Accept: 'text/event-stream' } };
    setPluginRegistry({ getPluginStateSnapshot: () => ({ persistedEnabled: 'enabled', manifest: customManifest }) } as unknown as PluginRegistry);
    installProvider({ credential: async () => ({ version: 3, expiresAt: Date.now() + 10_000,
      headers: { 'x-provider-key': 'CUSTOM_LEASE_TEST_SECRET' } }) });
    let fetchedHeaders: Headers | undefined;
    const wire = 'event: named\ndata: {"x":1}\n\n';
    global.fetch = (async (_input, init) => {
      fetchedHeaders = new Headers(init?.headers);
      if (init?.body) await new Response(init.body).arrayBuffer();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(wire)); controller.close();
      } }));
    }) as typeof fetch;
    const savedHeaders: Record<string, Record<string, string>> = {};
    const savedBodies: Record<string, unknown> = {};
    const { RequestLogger } = await import('../../src/logger/request-logger');
    const logger = new RequestLogger(new Request('http://proxy.test/v1/chat'), undefined, {
      accessLogWriter: { write() {}, updateResponseBodyId() {}, updateBodyId() {}, updateProtocolOutcome() {} }, fileLogWriter: { write() {} },
      headerStorage: { async save(_id, headers, direction) { savedHeaders[direction] = structuredClone(headers); return direction; } },
      bodyStorage: { async save(_id, body, direction) { savedBodies[direction] = body; return direction; } },
    });
    const result = await proxyRequest(createSnapshot(), { ...route, timeouts: { request_ms: 500 } }, createUpstream(),
      { requestId: logger.getRequestInfo().requestId }, { ...config, logging: { body: { enabled: true, max_size: 4096 } } } as AppConfig,
      'route-1', logger, undefined, undefined, undefined, { servingRevision: 7, attemptId: 'attempt-1' });
    try {
      expect(fetchedHeaders?.get('x-provider-key')).toBe('CUSTOM_LEASE_TEST_SECRET');
      expect(fetchedHeaders?.get('accept')).toBe('text/event-stream');
      expect(result.response.headers.get('content-type')).toBeNull();
      expect(await result.response.text()).toBe(wire);
      await logger.bodyLoggingCompletion(); await logger.complete(200);
      expect(savedHeaders.request.accept).toBe('text/event-stream');
      expect(savedHeaders.request['x-provider-key']).toBe('[REDACTED]');
      expect(JSON.stringify(savedHeaders)).not.toContain('CUSTOM_LEASE_TEST_SECRET');
      expect(savedBodies.response).toEqual([{ event: 'named', data: { x: 1 } }]);
    } finally { await result.cleanup?.(); }
  });

  test('actual SSE responses stay incremental when the request is non-streaming', async () => {
    installProvider();
    let onResponseCalls = 0;
    let streamCalls = 0;
    let upstreamClosedAt = 0;
    const encoder = new TextEncoder();
    global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode('data: {"value":"first"}\n\n')), 10);
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: {"value":"last"}\n\n'));
          controller.close();
          upstreamClosedAt = performance.now();
        }, 80);
      },
    }), { headers: { 'content-type': 'Text/Event-Stream; Charset=UTF-8' } })) as unknown as typeof fetch;

    const result = await run({
      route: { ...route, timeouts: { request_ms: 500 } },
      hooks: phaseHooks({
        onResponse: async (response) => {
          onResponseCalls++;
          return response;
        },
        stream: async (chunk) => {
          streamCalls++;
          return [chunk];
        },
      }),
    });
    const reader = result.response.body!.getReader();
    const firstAt = performance.now();
    const first = await reader.read();
    const firstReceivedAt = performance.now();
    const last = await reader.read();
    const lastReceivedAt = performance.now();
    const completed = await reader.read();
    await result.cleanup?.();

    expect(first.done).toBe(false);
    expect(last.done).toBe(false);
    expect(completed.done).toBe(true);
    expect((await result.completion).status).toBe('completed');
    expect(onResponseCalls).toBe(0);
    expect(streamCalls).toBeGreaterThan(0);
    expect(firstReceivedAt).toBeLessThan(upstreamClosedAt);
    expect(lastReceivedAt - firstAt).toBeGreaterThanOrEqual(60);
  });

  test('silent upstream SSE outlives Bun idle timeout within the route request deadline', async () => {
    installProvider();
    const encoder = new TextEncoder();
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0, idleTimeout: 0,
      async fetch(request, server) {
        server.timeout(request, 0);
        await request.arrayBuffer();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"value":"first"}\n\n'));
            finishTimer = setTimeout(() => {
              controller.enqueue(encoder.encode('data: {"value":"last"}\n\n'));
              controller.close();
            }, 15_000);
          },
          cancel() { clearTimeout(finishTimer); },
        }), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    global.fetch = ((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const options = init as RequestInit & { timeout?: number | boolean };
      // Accelerate Bun's five-minute default while preserving the proxy's override.
      const acceleratedOptions: RequestInit & { timeout: number | boolean } = {
        ...options, timeout: options?.timeout ?? 1000,
      };
      return originalFetch(`http://127.0.0.1:${server.port}${url.pathname}`, acceleratedOptions);
    }) as typeof fetch;

    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
      result = await run({ stream: true, route: { ...route, timeouts: { request_ms: 25_000 } } });
      const text = await result.response.text();
      expect(text).toContain('"value":"first"');
      expect(text).toContain('"value":"last"');
      expect(await result.completion).toEqual({ status: 'completed' });
    } finally {
      await result?.cleanup?.();
      clearTimeout(finishTimer);
      server.stop(true);
    }
  }, 30_000);

  test('JSON responses invoke declared onResponse and settle through generic completion', async () => {
    installProvider();
    let onResponseCalls = 0;
    global.fetch = (async () => new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const result = await run({
      stream: true,
      hooks: phaseHooks({
        onResponse: async (response) => {
          onResponseCalls++;
          return response;
        },
      }),
    });

    expect(await result.response.text()).toBe('{"ok":true}');
    expect(onResponseCalls).toBe(1);
    expect(await result.completion).toEqual({ status: 'completed' });
    await result.cleanup?.();
  });

  test('SSE content type without a body is treated as an empty non-streaming response', async () => {
    installProvider();
    let onResponseCalls = 0;
    global.fetch = (async () => new Response(null, {
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;

    const result = await run({
      hooks: phaseHooks({
        onResponse: async (response) => {
          onResponseCalls++;
          return response;
        },
      }),
    });

    expect(await result.response.text()).toBe('');
    expect(onResponseCalls).toBe(1);
    expect(result.streamCompletionState).toBeUndefined();
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

  test('client cancellation wins while managed credential acquisition is pending', async () => {
    const controller = new AbortController();
    let onErrorCalls = 0;
    let credentialStarted!: () => void;
    const started = new Promise<void>((resolve) => { credentialStarted = resolve; });
    installProvider({ credential: (signal) => new Promise((_, reject) => {
      credentialStarted();
      signal.addEventListener('abort', () => reject('private provider reason'), { once: true });
    }) });
    const pending = run({
      signal: controller.signal,
      route: { ...route, timeouts: { request_ms: 100, first_response_ms: 50 } } as EffectiveRouteConfig,
      hooks: phaseHooks({ onError: async () => {
        onErrorCalls++;
        throw new Error('private onError failure');
      } }),
    });
    await started;
    controller.abort('private client reason');
    const error = await pending.catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('Request cancelled');
    expect((error as Error).message).not.toContain('private');
    expect(onErrorCalls).toBe(1);
  });

  test('the first deadline source stays authoritative if client abort follows during credential rejection', async () => {
    const controller = new AbortController();
    installProvider({ credential: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        controller.abort('later client cancellation');
        reject('private provider rejection');
      }, { once: true });
    }) });

    const error = await run({
      signal: controller.signal,
      route: { ...route, timeouts: { request_ms: 100, first_response_ms: 10 } } as EffectiveRouteConfig,
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('Upstream first response deadline exceeded');
  });

  test('handler records deadline outcome when client aborts during onError and credentials return late', async () => {
    const controller = new AbortController();
    let onErrorCalls = 0;
    let observedProxyError = '';
    let signalOnError!: () => void;
    const onErrorStarted = new Promise<void>((resolve) => { signalOnError = resolve; });
    let credentialLate!: () => void;
    const lateCredential = new Promise<void>((resolve) => { credentialLate = resolve; });
    const managedEndpoint = {
      ...createUpstream(),
      target: 'https://api.example.test',
    };
    const handlerConfig = {
      services: [{ name: 'managed-service', endpoints: [managedEndpoint] }],
      routes: [{ path: '/v1/chat', service: 'managed-service', timeouts: { request_ms: 100, first_response_ms: 10 } }],
    } as unknown as AppConfig;
    initializeRuntimeState(handlerConfig);
    setBoundControlClientProvider(() => ({
      call: async <T>(method: string): Promise<T> => {
        if (method === 'getCredential') {
          return new Promise<T>((resolve) => {
            setTimeout(() => {
              credentialLate();
              resolve({
                version: 3,
                expiresAt: Date.now() + 10_000,
                headers: { authorization: 'Bearer TEST_SECRET' },
              } as T);
            }, 50);
          });
        }
        return true as T;
      },
    }));
    setScopedPluginRegistry({
      getPrecompiledHooks: () => phaseHooks({
        onError: async (context) => {
          onErrorCalls++;
          observedProxyError = context.error.message;
          signalOnError();
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
      }),
    } as unknown as ScopedPluginRegistry);

    const entries: Array<Record<string, unknown>> = [];
    const outcomes = new Map<string, { outcome: string; success: boolean; code?: string }>();
    const logging = {
      accessLogWriter: {
        write: (entry: Record<string, unknown>) => {
          const outcome = outcomes.get(String(entry.requestId));
          entries.push({ ...entry, ...(outcome ? { protocolOutcome: outcome.outcome, success: outcome.success, protocolCode: outcome.code } : {}) });
        },
        updateResponseBodyId: () => {},
        updateProtocolOutcome: (requestId: string, outcome: string, success: boolean, code?: string) => {
          outcomes.set(requestId, { outcome, success, code });
          const entry = entries.find((item) => item.requestId === requestId);
          if (entry) Object.assign(entry, { protocolOutcome: outcome, success, protocolCode: code });
        },
      },
      fileLogWriter: { write: async () => {} },
    };

    const responsePromise = handleRequest(new Request('http://proxy.test/v1/chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'hello' }),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    }), handlerConfig, { logging: logging as unknown as RequestLoggerDependencies, servingRevision: 7 });
    await onErrorStarted;
    controller.abort('client cancelled after deadline');
    const response = await responsePromise;
    const responseBody = await response.text();
    expect({ status: response.status, responseBody, onErrorCalls, observedProxyError, entries: entries.map(({ status, protocolOutcome }) => ({ status, protocolOutcome })) })
      .toEqual({ status: 504, responseBody: expect.any(String), onErrorCalls: 1, observedProxyError: 'Upstream first response deadline exceeded', entries: expect.any(Array) });
    await lateCredential;
    expect(onErrorCalls).toBe(1);
    expect(entries.some((entry) => entry.status === 504 && entry.protocolOutcome === 'failed')).toBe(true);
  });

  test('first-response deadline safely classifies pending fetch aborts and sends one POST', async () => {
    installProvider();
    let fetchCalls = 0;
    let onErrorCalls = 0;
    global.fetch = ((_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls++;
      expect(init?.method).toBe('POST');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject('opaque abort reason'), { once: true });
      });
    }) as unknown as typeof fetch;

    const result = await run({
      route: { ...route, timeouts: { request_ms: 1000, first_response_ms: 10 } } as EffectiveRouteConfig,
      hooks: phaseHooks({ onError: async () => {
        onErrorCalls++;
        throw new Error('private onError failure');
      } }),
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Upstream first response deadline exceeded');
    expect(fetchCalls).toBe(1);
    expect(onErrorCalls).toBe(1);
  });

  test('late fetch Response after timeout has its body cancelled', async () => {
    installProvider();
    let fetchCalls = 0;
    let bodyCancelled = false;
    global.fetch = ((_input: Parameters<typeof fetch>[0], _init: Parameters<typeof fetch>[1]) => {
      fetchCalls++;
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(new ReadableStream<Uint8Array>({
          cancel() { bodyCancelled = true; },
        }))), 25);
      });
    }) as unknown as typeof fetch;

    const error = await run({
      route: { ...route, timeouts: { request_ms: 100, first_response_ms: 10 } } as EffectiveRouteConfig,
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('Upstream first response deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchCalls).toBe(1);
    expect(bodyCancelled).toBe(true);
  });

  test('equal request and first-response deadlines always classify as first-response timeout', async () => {
    installProvider();
    let fetchCalls = 0;
    global.fetch = ((_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject('deadline rejection'), { once: true });
      });
    }) as unknown as typeof fetch;

    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await run({
        route: { ...route, timeouts: { request_ms: 10, first_response_ms: 10 } } as EffectiveRouteConfig,
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('Upstream first response deadline exceeded');
    }
    expect(fetchCalls).toBe(3);
  });

  test('network rejection shapes are safe and do not retry the POST', async () => {
    installProvider();
    for (const rejection of [undefined, null, 'network detail', new Error('socket closed'), { code: 'ECONNRESET' }]) {
      let fetchCalls = 0;
      global.fetch = ((_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        fetchCalls++;
        expect(init?.method).toBe('POST');
        return Promise.reject(rejection);
      }) as unknown as typeof fetch;

      const result = await run().catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).not.toContain('network detail');
      expect(fetchCalls).toBe(1);
    }
  });

  test('client cancellation is not classified or exposed as an upstream failure', async () => {
    installProvider();
    const controller = new AbortController();
    let fetchCalls = 0;
    global.fetch = ((_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject('private client reason'), { once: true });
      });
    }) as unknown as typeof fetch;

    const pending = run({ signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort('private client reason');
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Request cancelled');
    expect((error as Error).message).not.toContain('private client reason');
    expect(fetchCalls).toBe(1);
  });

  test('upstream HTTP 400 is passed through unchanged', async () => {
    installProvider();
    global.fetch = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;
    const result = await run();
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toBe('bad request');
    await result.cleanup?.();
  });

  test('request deadline during raw completion becomes a typed timeout', async () => {
    installProvider();
    global.fetch = (async () => new Response('buffered body')) as unknown as typeof fetch;
    const result = await run({
      route: { ...route, timeouts: { request_ms: 15 } } as EffectiveRouteConfig,
      hooks: phaseHooks({
        raw: async (raw) => ({ response: raw.response, completion: new Promise(() => {}) }),
      }),
    });
    // Generic responses return at headers; the attempt deadline belongs to completion.
    expect(result.response.status).toBe(200);
    expect(await result.completion).toEqual({ status: 'failed', code: 'request_timeout' });
    await result.cleanup?.();
  });

  test('cleanup failure blocks timeout failover and retains the deadline as cause', async () => {
    installProvider();
    let bodyCancelCalls = 0;
    global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelCalls++;
        return Promise.reject(new Error('cancel failed'));
      },
    }))) as unknown as typeof fetch;
    const error = await run({
      route: { ...route, timeouts: { request_ms: 15 } } as EffectiveRouteConfig,
      hooks: phaseHooks({ raw: async () => new Promise(() => {}) }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AttemptCleanupError);
    const cause = (error as Error).cause as { cleanupError?: unknown; deadlineError?: unknown };
    expect(cause.cleanupError).toBeInstanceOf(AttemptCleanupError);
    expect(cause.deadlineError).toBeInstanceOf(UpstreamTimeoutError);
    expect(bodyCancelCalls).toBe(1);
  });

  test('request deadline after SSE headers keeps HTTP status and records timeout outcome', async () => {
    installProvider();
    global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start() {},
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const result = await run({ route: { ...route, timeouts: { request_ms: 20 } } as EffectiveRouteConfig });
    expect(result.response.status).toBe(200);
    const outcome = await result.completion;
    expect(outcome).toEqual({ status: 'failed', code: 'request_timeout' });
    await result.cleanup?.();
  });

  test('first-response timer is cleared at SSE headers and absent configuration adds no deadline', async () => {
    installProvider();
    global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('data: ready\n\n'));
          controller.close();
        }, 35);
      },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const sse = await run({
      route: { ...route, timeouts: { request_ms: 1000, first_response_ms: 10 } } as EffectiveRouteConfig,
    });
    expect(await sse.response.text()).toContain('ready');
    await sse.cleanup?.();

    let fetchCalls = 0;
    global.fetch = ((_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject('request deadline reason'), { once: true });
      });
    }) as unknown as typeof fetch;
    const requestTimeout = await run({
      route: { ...route, timeouts: { request_ms: 15 } } as EffectiveRouteConfig,
    }).catch((error: unknown) => error);
    expect((requestTimeout as Error).message).toBe('Upstream request deadline exceeded');
    expect(fetchCalls).toBe(1);
  });

  test('pending rejectAccess is bounded and 401 notification is single-shot', async () => {
    // Fire the real deadline callback only after rejectAccess is pending. A 20ms
    // wall-clock deadline can expire during credential acquisition on busy CI.
    const originalSetTimeout = globalThis.setTimeout;
    let expireRequest!: () => void;
    // Proxy preserves the real Bun/Node timer overloads and decorated namespace.
    const timerImplementation = new Proxy(originalSetTimeout, {
      apply(target, thisArg, args) {
        const [callback, delay, ...callbackArgs] = args;
        expect(delay).toBe(60_000);
        if (typeof callback === 'function') expireRequest = () => callback(...callbackArgs);
        return Reflect.apply(target, thisArg, args);
      },
    });
    const timer = spyOn(globalThis, 'setTimeout').mockImplementationOnce(timerImplementation);
    let rejectStarted!: () => void;
    const started = new Promise<void>((resolve) => { rejectStarted = resolve; });
    let rejectAborted = false;
    installProvider({ reject: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { rejectAborted = true; reject(new Error('aborted')); }, { once: true });
      rejectStarted();
    }) });
    global.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    try {
      const pending = run({ route: { ...route, timeouts: { request_ms: 60_000 } } });
      await started;
      expireRequest();
      await expect(pending).rejects.toBeInstanceOf(UpstreamTimeoutError);
      expect(calls.filter(({ method }) => method === 'rejectAccess')).toHaveLength(1);
      expect(rejectAborted).toBe(true);
    } finally {
      timer.mockRestore();
    }
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
    const mappingBindingId = '40000000-0000-4000-8000-000000000027';
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
            plugins: [
              { id: bindingId, position: 1, name: 'chatgpt-oauth', options: { accountRef: 'account-1' }, enabled: true },
              { id: mappingBindingId, position: 2, name: 'model-mapping', options: { modelMappings: [{ source: 'codex-alias', target: 'anthropic:canonical-codex-v2' }] }, enabled: true },
            ],
          }],
        }],
      },
      plugin_activations: [{ plugin_name: 'chatgpt-oauth' }, { plugin_name: 'model-mapping' }, { plugin_name: 'models-dev' }],
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
    const mappingBinding = endpoint.plugins?.[1];
    if (!binding || typeof binding === 'string' || !binding.id) throw new Error('missing materialized ChatGPT binding');
    if (!mappingBinding || typeof mappingBinding === 'string' || mappingBinding.id !== mappingBindingId) throw new Error('missing materialized model-mapping binding');
    if (!endpoint.id) throw new Error('missing materialized ChatGPT endpoint id');
    expect(binding.id).toBe(bindingId);
    expect(binding.options).toEqual({ accountRef: 'account-1' });
    expect((endpoint as unknown as { managedBy: { bindingId: string } }).managedBy.bindingId).toBe(binding.id);

    const realManifest = JSON.parse(readFileSync(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
    const modelMappingManifest = JSON.parse(readFileSync(new URL('../../../../plugins/model-mapping/manifest.json', import.meta.url), 'utf8'));
    setPluginRegistry({
      getPluginStateSnapshot: (pluginName: string) => ({
        pluginName, discovery: 'discovered', validation: 'validated', persistedEnabled: 'enabled',
        manifest: pluginName === 'chatgpt-oauth' ? realManifest : modelMappingManifest,
      }),
    } as unknown as PluginRegistry);
    const credentialCalls: Array<{ method: string; attemptId?: string }> = [];
    let providerEndpoint: RpcEndpointHandle | undefined;
    let serviceHost!: PluginServiceHost;
    serviceHost = new PluginServiceHost('worker', {
      identity: (plugin, scope) => ({ endpoint: `fixture:${plugin}:${scope}`, instance: 'credential-regression', generation: 1, catalog: 'fixture-catalog', subject: plugin }),
      resolvePlacement: () => providerEndpoint === undefined ? null : { kind: 'endpoint', endpoint: providerEndpoint },
      resolveJournal: () => null,
      resolveCallee: () => serviceHost.currentInvocation()?.callee ?? null,
    });
    serviceHost.setDeclarations(new Map([
      ['chatgpt-oauth', realManifest.services],
      ['model-mapping', modelMappingManifest.services],
      ['models-dev', { provides: [{ id: MODELS_DEV_CATALOG_SERVICE_ID, version: 1, process: 'worker' as const }] }],
    ]));
    serviceHost.createContext('models-dev').publish(MODELS_DEV_CATALOG_SERVICE_ID, 1,
      rawCatalogService({ anthropic: { id: 'anthropic', models: {} } }));
    serviceHost.markReady('models-dev');
    providerEndpoint = serviceHost.rpc!.runtime.register({
      provider: 'chatgpt-oauth', contract: oauthCredentialRpc,
      binding: { endpoint: 'fixture-control-oauth', process: 'control', instance: 'credential-control', generation: 1, catalog: 'fixture-catalog', scope: 'global', subject: 'chatgpt-oauth' },
      handler: {
        getCredential: (_payload, context) => {
          const attempt = readHostRpcCalleeFrame(context.callee) as { kind: string; endpointId: string; attemptId: string; revision: number };
          expect(attempt).toMatchObject({ kind: 'bound', revision: 26, endpointId });
          credentialCalls.push({ method: 'getCredential', attemptId: attempt.attemptId });
          return { version: 1, expiresAt: Date.now() + 10_000,
            headers: { authorization: 'Bearer LEASE_SECRET', 'chatgpt-account-id': 'account-lease' } };
        },
        rejectAccess: (_payload, context) => {
          const attempt = readHostRpcCalleeFrame(context.callee) as { attemptId: string };
          credentialCalls.push({ method: 'rejectAccess', attemptId: attempt.attemptId });
          return { rejected: true };
        },
      },
    });
    serviceHost.rpc!.runtime.markReady(providerEndpoint);
    const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../../', import.meta.url)), serviceHost);
    registry.setServiceDependencies(new Map([['model-mapping', { 'models-dev': '^1.0.0' }]]));
    const pluginScope = { type: 'upstream' as const, routeId, upstreamId: endpoint.id };
    await registry.createInstance(pluginScope, binding);
    await registry.createInstance(pluginScope, mappingBinding);
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
          .map((name) => [name, name === 'X-OpenAI-Internal-Codex-Responses-Lite' && label === 'responses-lite'
            ? 'true'
            : `late-${label}-${name}`])),
      });
      if (mutation === 'path') context.url.pathname = '/backend-api/codex/not-allowed';
      if (mutation === 'origin') context.url = new URL(`https://evil.example${context.url.pathname}`);
      return context;
    });

    const safeHeaderNames = new Set([
      'accept', 'content-type', 'originator', 'user-agent', 'x-codex-routing-hint', ...dynamicHeaders.map((name) => name.toLowerCase()),
    ]);
    const safeHeaders = (headers: Headers): Record<string, string> => {
      const result: Record<string, string> = {};
      headers.forEach((value, name) => {
        if (safeHeaderNames.has(name.toLowerCase())) result[name.toLowerCase()] = value;
      });
      return result;
    };
    const fetches: Array<{ url: string; redirect: RequestRedirect; body?: Record<string, unknown> }> = [];
    const received: Array<{
      path: string;
      headerNames: string[];
      businessHeaders: Record<string, string>;
      userAgent?: string;
      originator?: string;
      routingHint?: string;
      matchesLease: boolean;
      matchesAccount: boolean;
      model?: unknown;
      serviceTier?: unknown;
      stream?: unknown;
      parallelToolCalls?: unknown;
    }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        let body: Record<string, unknown> = {};
        if (request.method !== 'GET') {
          try {
            const parsed: unknown = await request.json();
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
          } catch { /* Body details are intentionally limited to the expected allowlist. */ }
        }
        const authorization = request.headers.get('authorization');
        const accountId = request.headers.get('chatgpt-account-id');
        const headerNames: string[] = [];
        request.headers.forEach((_value, name) => headerNames.push(name.toLowerCase()));
        received.push({
          path: url.pathname,
          headerNames: headerNames.sort(),
          businessHeaders: safeHeaders(request.headers),
          userAgent: request.headers.get('user-agent') ?? undefined,
          originator: request.headers.get('originator') ?? undefined,
          routingHint: request.headers.get('x-codex-routing-hint') ?? undefined,
          matchesLease: authorization === 'Bearer LEASE_SECRET',
          matchesAccount: accountId === 'account-lease',
          model: body.model,
          serviceTier: body.service_tier,
          stream: body.stream,
          parallelToolCalls: body.parallel_tool_calls,
        });
        if (url.pathname.includes('/backend-api/codex/models')) {
          return new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response(
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    global.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const target = String(input);
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === 'string') {
        try {
          const parsed: unknown = JSON.parse(init.body);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const source = parsed as Record<string, unknown>;
            body = Object.fromEntries(['model', 'service_tier', 'stream', 'prompt_cache_key', 'parallel_tool_calls']
              .filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
          }
        } catch { /* Only allowlisted, parseable request fields are retained. */ }
      }
      fetches.push({
        url: target,
        redirect: init?.redirect as RequestRedirect,
        body,
      });
      const targetUrl = new URL(target);
      return originalFetch(new URL(`${targetUrl.pathname}${targetUrl.search}`, server.url), init);
    }) as unknown as typeof fetch;
    setBoundControlClientProvider((bindingContext, attempt) => {
      expect(bindingContext.bindingId).toBe(bindingId);
      if (!attempt) throw new Error('missing bound attempt identity');
      return {
        call: <T>(method: string, payload: unknown, signal: AbortSignal): Promise<T> =>
          registry.invokeBoundControl(bindingContext, attempt, method, payload, signal) as Promise<T>,
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
    const modelsHeaders = {
      accept: 'application/json',
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.153.3 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9',
    };
    const responseStatic = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      originator: 'codex-tui',
      'user-agent': 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)',
      'x-codex-routing-hint': 'model=codex;tier=priority',
    };
    const expectedDynamic = (label: string, includeSession = false) => Object.fromEntries(dynamicHeaders
      .filter((name) => includeSession || name !== 'Session-Id')
      .map((name) => [name.toLowerCase(), `late-${label}-${name}`]));
    const cases = [
      { label: 'models-attempt', path: '/v1/models', method: 'GET', body: undefined, expected: modelsHeaders },
      { label: 'responses-false', path: '/v1/responses', method: 'POST', body: { model: 'codex', service_tier: 'priority', input: 'hello', stream: false, prompt_cache_key: 'prompt-session' }, sessionId: 'explicit-session', expected: { ...responseStatic, ...expectedDynamic('responses-false'), 'session-id': 'explicit-session' } },
      { label: 'responses-true', path: '/v1/responses', method: 'POST', body: { model: 'codex', input: 'hello', stream: true, prompt_cache_key: 'prompt-session-true' }, expected: { ...responseStatic, 'x-codex-routing-hint': 'model=codex', ...expectedDynamic('responses-true'), 'session-id': 'prompt-session-true' } },
      { label: 'responses-lite', path: '/v1/responses', method: 'POST', body: { model: 'codex', input: 'hello lite', stream: false, client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: true } }, expected: { ...responseStatic, 'x-codex-routing-hint': 'model=codex', ...expectedDynamic('responses-lite'), 'x-openai-internal-codex-responses-lite': 'true' } },
      { label: 'chat-false', path: '/v1/chat/completions', method: 'POST', body: { model: 'codex', service_tier: 'priority', messages: [{ role: 'user', content: 'hello' }], stream: false }, expected: { ...responseStatic, ...expectedDynamic('chat-false') } },
      { label: 'chat-true', path: '/v1/chat/completions', method: 'POST', body: { model: 'codex', messages: [{ role: 'user', content: 'hello' }], stream: true, prompt_cache_key: 'chat-prompt-session' }, expected: { ...responseStatic, 'x-codex-routing-hint': 'model=codex', ...expectedDynamic('chat-true'), 'session-id': 'chat-prompt-session' } },
      { label: 'chat-model-mapping', path: '/v1/chat/completions', method: 'POST', body: { model: 'codex-alias', messages: [{ role: 'user', content: 'mapped' }], stream: false }, expected: { ...responseStatic, 'x-codex-routing-hint': 'model=canonical-codex-v2', ...expectedDynamic('chat-model-mapping') } },
    ] as const;

    try {
      const forbiddenOutboundHeaders = ['cookie', 'set-cookie', 'proxy-authorization', 'x-evil', 'x-forwarded-for', 'x-real-ip', 'referer'];
      const transportHeaderNames = new Set(['host', 'accept-encoding', 'connection', 'content-length', 'transfer-encoding']);
      for (const [caseIndex, item] of cases.entries()) {
        const result = await run(item.path, item.method, item.body, item.label, item.label === 'responses-false' ? 'explicit-session' : undefined);
        await read(result);
        const fetch = fetches.at(-1)!;
        const upstream = received.at(-1)!;
        expect(upstream.businessHeaders).toEqual(item.expected);
        expect(upstream.matchesLease).toBe(true);
        expect(upstream.matchesAccount).toBe(true);
        const expectedHeaderNames = [...Object.keys(item.expected), 'authorization', 'chatgpt-account-id'].sort();
        expect(upstream.headerNames.filter((name) => !transportHeaderNames.has(name))).toEqual(expectedHeaderNames);
        for (const forbiddenName of forbiddenOutboundHeaders) expect(upstream.headerNames).not.toContain(forbiddenName);
        expect(fetch.redirect).toBe('manual');
        expect(fetch.url).toBe(item.label === 'models-attempt'
          ? 'https://chatgpt.com/backend-api/codex/models?client_version=0.153.3'
          : 'https://chatgpt.com/backend-api/codex/responses');
        if (item.body === undefined) expect(fetch.body).toBeUndefined();
        else {
          const requestBody = fetch.body!;
          expect(requestBody).toMatchObject({ stream: true });
          if (item.label === 'responses-lite') expect(requestBody.parallel_tool_calls).toBe(false);
          const promptCacheKey = (item.body as Record<string, unknown>).prompt_cache_key;
          if (promptCacheKey !== undefined) expect(requestBody.prompt_cache_key).toBe(promptCacheKey);
        }
      }
      expect(received.slice(0, cases.length).map(({ path, userAgent, originator, routingHint, matchesLease, matchesAccount, model, serviceTier, stream, parallelToolCalls }) =>
        ({ path, userAgent, originator, routingHint, matchesLease, matchesAccount, model, serviceTier, stream, parallelToolCalls }))).toEqual([
        { path: '/backend-api/codex/models', userAgent: modelsHeaders['user-agent'], originator: 'codex_cli_rs', routingHint: undefined, matchesLease: true, matchesAccount: true, model: undefined, serviceTier: undefined, stream: undefined, parallelToolCalls: undefined },
        { path: '/backend-api/codex/responses', userAgent: responseStatic['user-agent'], originator: 'codex-tui', routingHint: 'model=codex;tier=priority', matchesLease: true, matchesAccount: true, model: 'codex', serviceTier: 'priority', stream: true, parallelToolCalls: true },
        { path: '/backend-api/codex/responses', userAgent: responseStatic['user-agent'], originator: 'codex-tui', routingHint: 'model=codex', matchesLease: true, matchesAccount: true, model: 'codex', serviceTier: undefined, stream: true, parallelToolCalls: true },
        { path: '/backend-api/codex/responses', userAgent: responseStatic['user-agent'], originator: 'codex-tui', routingHint: 'model=codex', matchesLease: true, matchesAccount: true, model: 'codex', serviceTier: undefined, stream: true, parallelToolCalls: false },
        { path: '/backend-api/codex/responses', userAgent: responseStatic['user-agent'], originator: 'codex-tui', routingHint: 'model=codex;tier=priority', matchesLease: true, matchesAccount: true, model: 'codex', serviceTier: 'priority', stream: true, parallelToolCalls: true },
        { path: '/backend-api/codex/responses', userAgent: responseStatic['user-agent'], originator: 'codex-tui', routingHint: 'model=codex', matchesLease: true, matchesAccount: true, model: 'codex', serviceTier: undefined, stream: true, parallelToolCalls: true },
        { path: '/backend-api/codex/responses', userAgent: responseStatic['user-agent'], originator: 'codex-tui', routingHint: 'model=canonical-codex-v2', matchesLease: true, matchesAccount: true, model: 'canonical-codex-v2', serviceTier: undefined, stream: true, parallelToolCalls: true },
      ]);
      expect(observations.map(({ label, sessionId }) => [label, sessionId])).toEqual([
        ['models-attempt', undefined],
        ['responses-false', 'explicit-session'],
        ['responses-true', 'prompt-session-true'],
        ['responses-lite', undefined],
        ['chat-false', undefined],
        ['chat-true', 'chat-prompt-session'],
        ['chat-model-mapping', undefined],
      ]);
      expect(observations.map(({ userAgent, originator }) => [userAgent, originator])).toEqual([
        ['codex_cli_rs/0.153.3 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9', 'codex_cli_rs'],
        ['codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)', 'codex-tui'],
        ['codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)', 'codex-tui'],
        ['codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)', 'codex-tui'],
        ['codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)', 'codex-tui'],
        ['codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)', 'codex-tui'],
        ['codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)', 'codex-tui'],
      ]);
      expect(observations.slice(0, cases.length).every(({ requestId }) => requestId === stableRequestId)).toBe(true);
      expect(received[3]?.businessHeaders['x-openai-internal-codex-responses-lite']).toBe('true');
      expect(received[3]?.matchesLease).toBe(true);
      expect(received[3]?.matchesAccount).toBe(true);
      expect(received[3]?.parallelToolCalls).toBe(false);
      expect(received[3]?.stream).toBe(true);

      const beforeRetryFetches = fetches.length;
      const beforeRetryRequests = received.length;
      writeSessionHeader = true;
      const firstRetry = await run('/v1/chat/completions', 'POST', { model: 'codex', messages: [{ role: 'user', content: 'retry' }], stream: true }, 'retry-1');
      const secondRetry = await run('/v1/chat/completions', 'POST', { model: 'codex', messages: [{ role: 'user', content: 'retry' }], stream: true }, 'retry-2');
      await read(firstRetry);
      expect(received.slice(beforeRetryRequests).map(({ businessHeaders, matchesLease, matchesAccount }) => ({ businessHeaders, matchesLease, matchesAccount }))).toEqual([
        { businessHeaders: { ...responseStatic, 'x-codex-routing-hint': 'model=codex', ...expectedDynamic('retry-1', true) }, matchesLease: true, matchesAccount: true },
        { businessHeaders: { ...responseStatic, 'x-codex-routing-hint': 'model=codex', ...expectedDynamic('retry-2', true) }, matchesLease: true, matchesAccount: true },
      ]);
      const probe = await hooks.inbound.onRawResponse!({
        response: new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
        completion: Promise.resolve({ status: 'completed' }),
      }, { requestId: stableRequestId, attemptId: 'retry-probe', signal: new AbortController().signal } as any);
      // Reading the first complete response now runs its finalization. It must
      // not remove the second attempt's state, which is proven by its actual
      // converted response below; an unprepared probe has no conversion state.
      expect(await probe.response.text()).toContain('"type":"response.completed"');
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
      global.fetch = originalFetch;
      server.stop(true);
      await registry.destroy();
      serviceHost.rpc!.runtime.revoke(providerEndpoint);
      await serviceHost.dispose('models-dev');
    }
  });
});
