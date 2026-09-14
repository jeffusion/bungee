import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginLogger, PluginInitContext, ResponseContext, MutableRequestContext, FinallyContext } from '../../src/hooks';
import type { PluginStorage } from '../../src/plugin.types';
import { cleanupPluginRegistry } from '../../src/worker/state/plugin-manager';
import TokenStatsPlugin from '../../../../plugins/token-stats/server/index';

afterEach(async () => {
  await cleanupPluginRegistry();
});

class MemoryPluginStorage implements PluginStorage {
  private readonly data = new Map<string, Record<string, number>>();

  async get<T = any>(key: string): Promise<T | null> {
    return (this.data.get(key) as T | undefined) ?? null;
  }

  async set(key: string, value: any): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    return Array.from(this.data.keys()).filter((key) => !prefix || key.startsWith(prefix));
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async increment(key: string, field: string, delta = 1): Promise<number> {
    const current = this.data.get(key) ?? {};
    const nextValue = (current[field] ?? 0) + delta;
    current[field] = nextValue;
    this.data.set(key, current);
    return nextValue;
  }

  async compareAndSet(key: string, field: string, expected: any, newValue: any): Promise<boolean> {
    const current = this.data.get(key) ?? {};
    if (current[field] !== expected) {
      return false;
    }

    current[field] = newValue;
    this.data.set(key, current);
    return true;
  }
}

function createLogger(): PluginLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createRequestContext(overrides: Partial<MutableRequestContext> = {}): MutableRequestContext {
  return {
    method: 'POST',
    originalUrl: new URL('http://localhost/v1/chat/completions'),
    clientIP: '127.0.0.1',
    requestId: 'req-failover',
    routeId: 'route-chat',
    upstreamId: 'upstream-a',
    url: new URL('http://upstream.example/v1/chat/completions'),
    headers: {},
    body: {
      model: 'gpt-4o-mini',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    },
    ...overrides,
  };
}

function createResponseContext(ctx: MutableRequestContext): ResponseContext {
  return {
    method: ctx.method,
    originalUrl: ctx.originalUrl,
    clientIP: ctx.clientIP,
    requestId: ctx.requestId,
    routeId: ctx.routeId,
    upstreamId: ctx.upstreamId,
    response: new Response(null),
    latencyMs: 10,
  };
}

function createFinallyContext(ctx: MutableRequestContext, success = true): FinallyContext {
  return {
    method: ctx.method,
    originalUrl: ctx.originalUrl,
    clientIP: ctx.clientIP,
    requestId: ctx.requestId,
    routeId: ctx.routeId,
    upstreamId: 'upstream-b',
    success,
    statusCode: success ? 200 : 502,
    latencyMs: 20,
  };
}

async function seedFailoverStats(plugin: InstanceType<typeof TokenStatsPlugin>, storage: MemoryPluginStorage) {
  const baseInitContext: PluginInitContext = {
    config: {},
    storage,
    logger: createLogger(),
  };

  await plugin.init(baseInitContext);

  const firstAttempt = createRequestContext();
  await plugin.handleAttemptStart(firstAttempt);
  await plugin.handleResponse(
    new Response(JSON.stringify({
      id: 'cmpl-1',
      choices: [{ message: { role: 'assistant', content: 'partial' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { headers: { 'Content-Type': 'application/json' } }),
    createResponseContext(firstAttempt)
  );

  const secondAttempt = createRequestContext({ upstreamId: 'upstream-b' });
  await plugin.handleAttemptStart(secondAttempt);
  await plugin.handleResponse(
    new Response(JSON.stringify({
      id: 'cmpl-2',
      choices: [{ message: { role: 'assistant', content: 'final' } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }), { headers: { 'Content-Type': 'application/json' } }),
    createResponseContext(secondAttempt)
  );

  await plugin.handleFinally(createFinallyContext(secondAttempt));
}

describe('Token Stats v2 Integration Contract', () => {
  test('v2 storage should use token-stats:v2 namespace, UTC hour buckets, and preserve failover semantics', async () => {
    const storage = new MemoryPluginStorage();
    const plugin = new TokenStatsPlugin();

    await seedFailoverStats(plugin, storage);

    const keys = await storage.keys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('token-stats:v2:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('tokens#'))).toBe(false);

    const currentUtcHourBucket = new Date().toISOString().slice(0, 13);
    expect(keys.every((key) => key.endsWith(currentUtcHourBucket))).toBe(true);
    const allRow = await storage.get<Record<string, number>>(keys.find((key) => key.startsWith('token-stats:v2:all:'))!);
    expect(allRow).toMatchObject({ inputTokens: 22, outputTokens: 12, logicalRequests: 1, upstreamAttempts: 2 });
  });
});
