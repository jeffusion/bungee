import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import { createPluginHooks, type FinallyContext, type StreamChunkContext } from '../../src/hooks';
import { setScopedPluginRegistry, type PrecompiledHooks } from '../../src/scoped-plugin-registry';
import { handleRequest, initializeRuntimeState, runtimeState } from '../../src/worker';

const originalFetch = global.fetch;

interface FinallyRecord {
  success: boolean;
  statusCode?: number;
  latencyMs: number;
  requestId: string;
  routeId?: string;
  upstreamId?: string;
}

function createPrecompiledHooks(options?: {
  onFinally?: (ctx: FinallyContext) => void | Promise<void>;
  onStreamChunk?: (chunk: any, ctx: StreamChunkContext) => any[] | Promise<any[]>;
  onFlushStream?: (chunks: any[], ctx: StreamChunkContext) => any[] | Promise<any[]>;
}): PrecompiledHooks {
  const hooks = createPluginHooks();

  if (options?.onStreamChunk) {
    hooks.onStreamChunk.tapPromise({ name: 'test-stream-chunk', stage: 0 }, async (chunk, ctx) => {
      return await options.onStreamChunk!(chunk, ctx);
    });
  }

  if (options?.onFlushStream) {
    hooks.onFlushStream.tapPromise({ name: 'test-flush-stream' }, async (chunks, ctx) => {
      return await options.onFlushStream!(chunks, ctx);
    });
  }

  if (options?.onFinally) {
    hooks.onFinally.tapPromise({ name: 'test-finally' }, async (ctx) => {
      await options.onFinally!(ctx);
    });
  }

  return {
    handlers: [],
    hooks,
    hasInterceptCallbacks: false,
    hasResponseCallbacks: false,
    hasStreamCallbacks: hooks.onStreamChunk.hasCallbacks(),
    metadata: {
      createdAt: Date.now(),
      pluginCount: 1,
      pluginNames: ['test-plugin'],
      scope: 'test',
    },
  };
}

function installPrecompiledHooks(precompiledHooks: PrecompiledHooks): void {
  setScopedPluginRegistry({
    getPrecompiledHooks: () => precompiledHooks,
  } as any);
}

function createBaseConfig(): AppConfig {
  return {
    routes: [
      {
        path: '/api',
        upstreams: [
          { id: 'primary', target: 'http://primary.test' },
        ],
      },
    ],
  };
}

function setFetchMock(mock: (...args: any[]) => Promise<Response>): void {
  global.fetch = mock as typeof fetch;
}

function createSSEStream(chunks: string[], options?: { error?: Error }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      if (options?.error) {
        controller.error(options.error);
        return;
      }

      controller.close();
    },
  });
}

beforeEach(() => {
  runtimeState.clear();
  setScopedPluginRegistry(null);
  global.fetch = originalFetch;
});

afterEach(() => {
  runtimeState.clear();
  setScopedPluginRegistry(null);
  global.fetch = originalFetch;
});

describe('plugin onFinally lifecycle', () => {
  test('在非流式成功响应时只触发一次 finally，并带上完整上下文', async () => {
    const records: FinallyRecord[] = [];
    installPrecompiledHooks(createPrecompiledHooks({
      onFinally: (ctx) => {
        records.push({
          success: ctx.success,
          statusCode: ctx.statusCode,
          latencyMs: ctx.latencyMs,
          requestId: ctx.requestId,
          routeId: ctx.routeId,
          upstreamId: ctx.upstreamId,
        });
      },
    }));

    setFetchMock(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const config = createBaseConfig();
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost:8088/api/success'), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      success: true,
      statusCode: 200,
      routeId: '/api',
      upstreamId: 'primary',
    });
    expect(records[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(records[0]?.requestId).toBeTruthy();
  });

  test('在流式成功结束时先 flush 再 finally，且 finally 不会重复触发', async () => {
    const events: string[] = [];
    const records: FinallyRecord[] = [];
    installPrecompiledHooks(createPrecompiledHooks({
      onStreamChunk: async (chunk) => [chunk],
      onFlushStream: async (chunks) => {
        events.push('flush');
        return chunks;
      },
      onFinally: (ctx) => {
        events.push('finally');
        records.push({
          success: ctx.success,
          statusCode: ctx.statusCode,
          latencyMs: ctx.latencyMs,
          requestId: ctx.requestId,
          routeId: ctx.routeId,
          upstreamId: ctx.upstreamId,
        });
      },
    }));

    setFetchMock(async () => new Response(
      createSSEStream([
        'data: {"type":"message_start"}\n\n',
        'data: [DONE]\n\n',
      ]),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }
    ));

    const config = createBaseConfig();
    initializeRuntimeState(config);

    const request = new Request('http://localhost:8088/api/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });

    const response = await handleRequest(request, config);
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    expect(bodyText.includes('data: [DONE]')).toBeTrue();

    expect(events).toEqual(['flush', 'finally']);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      success: true,
      statusCode: 200,
      routeId: '/api',
      upstreamId: 'primary',
    });
  });

  test('在流中断时仍触发 finally，并标记为失败', async () => {
    const records: FinallyRecord[] = [];
    installPrecompiledHooks(createPrecompiledHooks({
      onStreamChunk: async (chunk) => [chunk],
      onFinally: (ctx) => {
        records.push({
          success: ctx.success,
          statusCode: ctx.statusCode,
          latencyMs: ctx.latencyMs,
          requestId: ctx.requestId,
          routeId: ctx.routeId,
          upstreamId: ctx.upstreamId,
        });
      },
    }));

    setFetchMock(async () => new Response(
      createSSEStream([
        'data: {"type":"message_start"}\n\n',
      ], { error: new Error('upstream stream aborted') }),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }
    ));

    const config = createBaseConfig();
    initializeRuntimeState(config);

    const request = new Request('http://localhost:8088/api/stream-abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });

    const response = await handleRequest(request, config);
    expect(response.status).toBe(200);
    await response.text();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      success: false,
      statusCode: 200,
      routeId: '/api',
      upstreamId: 'primary',
    });
  });

  test('在 failover 后最终成功时只对最终成功的请求触发一次 finally', async () => {
    const records: FinallyRecord[] = [];
    installPrecompiledHooks(createPrecompiledHooks({
      onFinally: (ctx) => {
        records.push({
          success: ctx.success,
          statusCode: ctx.statusCode,
          latencyMs: ctx.latencyMs,
          requestId: ctx.requestId,
          routeId: ctx.routeId,
          upstreamId: ctx.upstreamId,
        });
      },
    }));

    setFetchMock(async (input) => {
      const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      if (url.includes('primary.test')) {
        return new Response(JSON.stringify({ error: 'retry-me' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ upstream: 'secondary' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          failover: {
            enabled: true,
            retryableStatusCodes: [503],
          },
          upstreams: [
            { id: 'primary', target: 'http://primary.test' },
            { id: 'secondary', target: 'http://secondary.test' },
          ],
        },
      ],
    };
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost:8088/api/failover'), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ upstream: 'secondary' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      success: true,
      statusCode: 200,
      routeId: '/api',
      upstreamId: 'secondary',
    });
  });

  test('在异常返回 503 时也会触发 finally', async () => {
    const records: FinallyRecord[] = [];
    installPrecompiledHooks(createPrecompiledHooks({
      onFinally: (ctx) => {
        records.push({
          success: ctx.success,
          statusCode: ctx.statusCode,
          latencyMs: ctx.latencyMs,
          requestId: ctx.requestId,
          routeId: ctx.routeId,
          upstreamId: ctx.upstreamId,
        });
      },
    }));

    setFetchMock(async () => {
      throw new Error('socket hang up');
    });

    const config: AppConfig = {
      routes: [
        {
          path: '/api',
          failover: {
            enabled: true,
          },
          upstreams: [
            { id: 'primary', target: 'http://primary.test' },
          ],
        },
      ],
    };
    initializeRuntimeState(config);

    const response = await handleRequest(new Request('http://localhost:8088/api/error'), config);
    expect(response.status).toBe(503);

    const payload = await response.json();
    expect(payload).toEqual({ error: 'Service Unavailable' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      success: false,
      statusCode: 503,
      routeId: '/api',
      upstreamId: 'primary',
    });
  });
});
