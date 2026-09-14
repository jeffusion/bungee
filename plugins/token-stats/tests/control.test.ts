import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import type { PluginInitContext, PluginLogger, ResponseContext, MutableRequestContext, FinallyContext, } from '../../../packages/core/src/hooks';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import type { ControlHostContext, SecretStore } from '../../../packages/core/src/plugin-control/contracts';
import { parsePluginManifestText } from '../../../packages/core/src/plugin-manifest-catalog';
import TokenStatsPlugin from '../server/index';
import { createControl } from '../server/control';

class MemoryPluginStorage implements PluginStorage {
  private readonly data = new Map<string, unknown>();

  async get<T = any>(key: string): Promise<T | null> {
    return (this.data.get(key) as T | undefined) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> { this.data.set(key, value); }
  async delete(key: string): Promise<void> { this.data.delete(key); }
  async keys(prefix?: string): Promise<string[]> {
    return [...this.data.keys()].filter((key) => !prefix || key.startsWith(prefix));
  }
  async clear(): Promise<void> { this.data.clear(); }
  async increment(key: string, field: string, delta = 1): Promise<number> {
    const row = (this.data.get(key) as Record<string, number> | undefined) ?? {};
    const value = (row[field] ?? 0) + delta;
    row[field] = value;
    this.data.set(key, row);
    return value;
  }
  async compareAndSet(key: string, field: string, expected: unknown, value: unknown): Promise<boolean> {
    const row = (this.data.get(key) as Record<string, unknown> | undefined) ?? {};
    if (row[field] !== expected) return false;
    row[field] = value;
    this.data.set(key, row);
    return true;
  }
}

const secretStore: SecretStore = {
  namespace: 'token-stats-test',
  async get() { return null; },
  async compareAndSet() { return 1; },
  async delete() {},
};

function host(storage: PluginStorage, signal = new AbortController().signal): ControlHostContext {
  return { signal, secretStore, storage };
}

function logger(): PluginLogger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function requestContext(): MutableRequestContext {
  return {
    method: 'POST',
    originalUrl: new URL('http://localhost/v1/chat/completions'),
    clientIP: '127.0.0.1',
    requestId: 'token-stats-control-test',
    routeId: 'route-test',
    upstreamId: 'upstream-test',
    url: new URL('http://upstream.test/v1/chat/completions'),
    headers: {},
    body: { model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'hello' }] },
  };
}

function responseContext(ctx: MutableRequestContext): ResponseContext {
  return {
    method: ctx.method,
    originalUrl: ctx.originalUrl,
    clientIP: ctx.clientIP,
    requestId: ctx.requestId,
    routeId: ctx.routeId,
    upstreamId: ctx.upstreamId,
    response: new Response(null),
    latencyMs: 1,
  };
}

function finallyContext(ctx: MutableRequestContext): FinallyContext {
  return {
    method: ctx.method,
    originalUrl: ctx.originalUrl,
    clientIP: ctx.clientIP,
    requestId: ctx.requestId,
    routeId: ctx.routeId,
    upstreamId: ctx.upstreamId,
    success: true,
    statusCode: 200,
    latencyMs: 1,
  };
}

async function invoke(control: ReturnType<typeof createControl>, request: Request, context = host(new MemoryPluginStorage())) {
  const handler = control.api.find((item) => item.handler === 'getStats')!;
  return handler.invoke({ ...context, request, requestSignal: new AbortController().signal });
}

describe('token-stats control artifact', () => {
  test('runtime writes and control reads the same plugin storage namespace', async () => {
    const storage = new MemoryPluginStorage();
    const plugin = new TokenStatsPlugin();
    const init: PluginInitContext = { config: {}, storage, logger: logger() };
    const request = requestContext();
    await plugin.init(init);
    await plugin.handleAttemptStart(request);
    await plugin.handleResponse(new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'content-type': 'application/json' } }), responseContext(request));
    await plugin.handleFinally(finallyContext(request));

    const control = createControl(host(storage));
    const response = await invoke(control, new Request('http://localhost/stats?groupBy=all'), host(storage));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 5, logicalRequests: 1, upstreamAttempts: 1 });
    control.dispose();
  });

  test('empty storage returns a bounded empty DTO', async () => {
    const storage = new MemoryPluginStorage();
    const control = createControl(host(storage));
    const response = await invoke(control, new Request('http://localhost/stats?groupBy=all'), host(storage));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalInputTokens: 0, totalOutputTokens: 0, logicalRequests: 0, upstreamAttempts: 0 });
    control.dispose();
  });

  test('range and groupBy reject unknown values without defaulting', async () => {
    const storage = new MemoryPluginStorage();
    const control = createControl(host(storage));
    for (const query of ['range=7d', 'groupBy=unknown', 'range=', 'groupBy=']) {
      const response = await invoke(control, new Request(`http://localhost/stats?${query}`), host(storage));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_input' });
    }
    control.dispose();
  });

  test('malformed persisted values fail closed', async () => {
    const storage = new MemoryPluginStorage();
    await storage.set('token-stats:v2:all:all:2026-09-14T12', { inputTokens: 'not-a-number' });
    const control = createControl(host(storage));
    const response = await invoke(control, new Request('http://localhost/stats?groupBy=all'), host(storage));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'invalid_persisted_value' });
    control.dispose();
  });

  test('bounded storage entries and serialized rows fail closed', async () => {
    const storage = new MemoryPluginStorage();
    for (let index = 0; index < 4097; index++) {
      await storage.set(`token-stats:v2:route:route-${index}:2026-09-14T12`, { inputTokens: 1 });
    }
    const control = createControl(host(storage));
    const entries = await invoke(control, new Request('http://localhost/stats?groupBy=route'), host(storage));
    expect(entries.status).toBe(500);
    expect(await entries.json()).toEqual({ error: 'response_limit' });
    control.dispose();

    const rowStorage = new MemoryPluginStorage();
    await rowStorage.set('token-stats:v2:all:all:2026-09-14T12', { inputTokens: 1, extra: 'x'.repeat(20_000) });
    const rowControl = createControl(host(rowStorage));
    const row = await invoke(rowControl, new Request('http://localhost/stats?groupBy=all'), host(rowStorage));
    expect(row.status).toBe(500);
    expect(await row.json()).toEqual({ error: 'response_limit' });
    rowControl.dispose();
  });

  test('manifest declares only the control GET API and no legacy worker paths', () => {
    const manifest = parsePluginManifestText(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.control?.entry).toBe('server/control.ts');
    expect(manifest.capabilities).toContain('controlPlane');
    expect(manifest.contributes?.api).toEqual([{ path: '/stats', methods: ['GET'], handler: 'getStats', execution: 'control' }]);
  });

  test('method, request signal, and disposal are rejected by the control', async () => {
    const storage = new MemoryPluginStorage();
    const control = createControl(host(storage));
    const handler = control.api[0]!;
    const methodResponse = await handler.invoke({ ...host(storage), request: new Request('http://localhost/stats', { method: 'POST' }), requestSignal: new AbortController().signal });
    expect(methodResponse.status).toBe(405);

    const requestController = new AbortController();
    requestController.abort();
    const cancelled = await handler.invoke({ ...host(storage), request: new Request('http://localhost/stats'), requestSignal: requestController.signal });
    expect(cancelled.status).toBe(400);

    control.dispose();
    const inactive = await handler.invoke({ ...host(storage), request: new Request('http://localhost/stats'), requestSignal: new AbortController().signal });
    expect(inactive.status).toBe(409);

    const hostController = new AbortController();
    hostController.abort();
    const inactiveHost = createControl(host(storage, hostController.signal));
    const refused = await inactiveHost.api[0]!.invoke({ ...host(storage, hostController.signal), request: new Request('http://localhost/stats'), requestSignal: new AbortController().signal });
    expect(refused.status).toBe(409);
  });
});
