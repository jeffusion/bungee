import { describe, test, expect, beforeEach } from 'bun:test';
import { StreamExecutor, createPluginTransformStream, createSSEParserStream } from '../src/stream-executor';
import { createPluginHooks, type PluginHooks, type StreamChunkContext, type RequestContext } from '../src/hooks';

async function parseSSEChunks(chunks: string[]): Promise<any[]> {
  const parser = createSSEParserStream();
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });

  const output = input.pipeThrough(parser);
  const reader = output.getReader();
  const parsed: any[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parsed.push(value);
  }

  return parsed;
}

describe('createSSEParserStream', () => {
  test('should preserve event/data state across chunk boundaries', async () => {
    const result = await parseSSEChunks([
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"hello"}\n',
      '\n'
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'response.output_text.delta',
      delta: 'hello',
      _event: 'response.output_text.delta'
    });
  });

  test('should merge multi-line data fields into one payload', async () => {
    const result = await parseSSEChunks([
      'event: response.tool\n',
      'data: {"type":"response.tool",\n',
      'data: "text":"line1\\nline2"}\n',
      '\n'
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'response.tool',
      text: 'line1\nline2',
      _event: 'response.tool'
    });
  });
});

// 辅助函数：创建 RequestContext
function createRequestContext(overrides?: Partial<RequestContext>): RequestContext {
  return {
    method: 'POST',
    originalUrl: new URL('http://localhost/test'),
    clientIP: '127.0.0.1',
    requestId: 'test-request-123',
    routeId: 'test-route',
    upstreamId: 'test-upstream',
    ...overrides,
  };
}

// 辅助函数：设置简单 1:1 转换 Hook
function setupSimpleTransformHook(hooks: PluginHooks) {
  hooks.onStreamChunk.tapPromise(
    { name: 'simple-transform', stage: 0 },
    async (chunk, ctx) => {
      return [{
        ...chunk,
        transformedBy: 'simple-transform',
        index: ctx.chunkIndex
      }];
    }
  );
}

// 辅助函数：设置缓冲 Hook (N:0)
function setupBufferingHook(hooks: PluginHooks) {
  hooks.onStreamChunk.tapPromise(
    { name: 'buffering', stage: 0 },
    async (chunk, ctx) => {
      // 将 chunk 存储到 state 中
      if (!ctx.streamState.has('buffered')) {
        ctx.streamState.set('buffered', []);
      }
      const buffered = ctx.streamState.get('buffered') as any[];
      buffered.push(chunk);
      // 不输出任何东西（缓冲）
      return [];
    }
  );

  hooks.onFlushStream.tapPromise(
    { name: 'buffering' },
    async (chunks, ctx) => {
      // 在流结束时输出所有缓冲的 chunks
      const buffered = ctx.streamState.get('buffered') || [];
      return [...chunks, ...buffered];
    }
  );
}

// 辅助函数：设置拆分 Hook (1:M)
function setupSplittingHook(hooks: PluginHooks) {
  hooks.onStreamChunk.tapPromise(
    { name: 'splitting', stage: 0 },
    async (chunk, ctx) => {
      // 将一个 chunk 拆分成 3 个
      return [
        { ...chunk, part: 1 },
        { ...chunk, part: 2 },
        { ...chunk, part: 3 }
      ];
    }
  );
}

// 辅助函数：设置批处理 Hook (N:M)
function setupBatchingHook(hooks: PluginHooks) {
  hooks.onStreamChunk.tapPromise(
    { name: 'batching', stage: 0 },
    async (chunk, ctx) => {
      if (!ctx.streamState.has('batch')) {
        ctx.streamState.set('batch', []);
      }

      const batch = ctx.streamState.get('batch') as any[];
      batch.push(chunk);

      // 每收集 2 个 chunk，输出 1 个合并的 chunk
      if (batch.length === 2) {
        const merged = {
          type: 'merged',
          chunks: [...batch]
        };
        ctx.streamState.set('batch', []);
        return [merged];
      }

      // 未满 2 个，继续缓冲
      return [];
    }
  );

  hooks.onFlushStream.tapPromise(
    { name: 'batching' },
    async (chunks, ctx) => {
      // 输出剩余的 chunk
      const batch = ctx.streamState.get('batch') || [];
      if (batch.length > 0) {
        return [...chunks, {
          type: 'merged',
          chunks: batch
        }];
      }
      return chunks;
    }
  );
}

// 辅助函数：设置过滤 Hook
function setupFilteringHook(hooks: PluginHooks) {
  hooks.onStreamChunk.tapPromise(
    { name: 'filtering', stage: 0 },
    async (chunk, ctx) => {
      // 过滤掉 skip === true 的 chunks
      if (chunk.skip === true) {
        return [];
      }
      return [chunk];
    }
  );
}

// 辅助函数：设置 Passthrough Hook
function setupPassthroughHook(hooks: PluginHooks) {
  hooks.onStreamChunk.tapPromise(
    { name: 'passthrough', stage: 0 },
    async (chunk, ctx) => {
      // 返回 null 表示不处理，原样输出
      return null;
    }
  );
}

describe('StreamExecutor', () => {
  let requestContext: RequestContext;

  beforeEach(() => {
    requestContext = createRequestContext();
  });

  describe('processChunk', () => {
    test('should process chunk with simple transform hook', async () => {
      const hooks = createPluginHooks();
      setupSimpleTransformHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      const chunk = { data: 'test' };
      const result = await executor.processChunk(chunk);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        data: 'test',
        transformedBy: 'simple-transform',
        index: 0
      });
    });

    test('should handle passthrough hook', async () => {
      const hooks = createPluginHooks();
      setupPassthroughHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      const chunk = { data: 'test' };
      const result = await executor.processChunk(chunk);

      expect(result).toEqual([chunk]);
    });

    test('should handle no hooks registered', async () => {
      const hooks = createPluginHooks();
      // 不注册任何 hook
      const executor = new StreamExecutor(hooks, requestContext);

      const chunk = { data: 'test' };
      const result = await executor.processChunk(chunk);

      // 没有 hook 时，原样输出
      expect(result).toEqual([chunk]);
    });

    test('should handle buffering hook (N:0)', async () => {
      const hooks = createPluginHooks();
      setupBufferingHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      // 处理多个 chunks，应该都被缓冲
      const result1 = await executor.processChunk({ data: 'chunk1' });
      const result2 = await executor.processChunk({ data: 'chunk2' });
      const result3 = await executor.processChunk({ data: 'chunk3' });

      expect(result1).toEqual([]);
      expect(result2).toEqual([]);
      expect(result3).toEqual([]);

      // Flush 时才输出
      const flushed = await executor.flush();
      expect(flushed).toHaveLength(3);
      expect(flushed).toEqual([
        { data: 'chunk1' },
        { data: 'chunk2' },
        { data: 'chunk3' }
      ]);
    });

    test('should handle splitting hook (1:M)', async () => {
      const hooks = createPluginHooks();
      setupSplittingHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      const chunk = { data: 'original' };
      const result = await executor.processChunk(chunk);

      expect(result).toHaveLength(3);
      expect(result).toEqual([
        { data: 'original', part: 1 },
        { data: 'original', part: 2 },
        { data: 'original', part: 3 }
      ]);
    });

    test('should handle batching hook (N:M)', async () => {
      const hooks = createPluginHooks();
      setupBatchingHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      // 第一个 chunk，被缓冲
      const result1 = await executor.processChunk({ id: 1 });
      expect(result1).toEqual([]);

      // 第二个 chunk，触发批处理输出
      const result2 = await executor.processChunk({ id: 2 });
      expect(result2).toHaveLength(1);
      expect(result2[0]).toEqual({
        type: 'merged',
        chunks: [{ id: 1 }, { id: 2 }]
      });

      // 第三个 chunk，又被缓冲
      const result3 = await executor.processChunk({ id: 3 });
      expect(result3).toEqual([]);

      // Flush 输出剩余的
      const flushed = await executor.flush();
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual({
        type: 'merged',
        chunks: [{ id: 3 }]
      });
    });

    test('should handle filtering hook', async () => {
      const hooks = createPluginHooks();
      setupFilteringHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      const result1 = await executor.processChunk({ data: 'keep' });
      const result2 = await executor.processChunk({ data: 'remove', skip: true });
      const result3 = await executor.processChunk({ data: 'keep2' });

      expect(result1).toEqual([{ data: 'keep' }]);
      expect(result2).toEqual([]);
      expect(result3).toEqual([{ data: 'keep2' }]);
    });

    test('should chain multiple hooks', async () => {
      const hooks = createPluginHooks();
      // 链式处理：简单转换 -> 拆分
      // 使用 stage 控制执行顺序
      hooks.onStreamChunk.tapPromise(
        { name: 'simple-transform', stage: 0 },
        async (chunk, ctx) => {
          return [{
            ...chunk,
            transformedBy: 'simple-transform',
            index: ctx.chunkIndex
          }];
        }
      );
      hooks.onStreamChunk.tapPromise(
        { name: 'splitting', stage: 1 },
        async (chunk, ctx) => {
          return [
            { ...chunk, part: 1 },
            { ...chunk, part: 2 },
            { ...chunk, part: 3 }
          ];
        }
      );

      const executor = new StreamExecutor(hooks, requestContext);

      const chunk = { data: 'test' };
      const result = await executor.processChunk(chunk);

      // 先经过 simple transform，再经过 splitting
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        data: 'test',
        transformedBy: 'simple-transform',
        part: 1
      });
      expect(result[1].part).toBe(2);
      expect(result[2].part).toBe(3);
    });

    test('should track chunk index correctly', async () => {
      const hooks = createPluginHooks();
      setupSimpleTransformHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      const result1 = await executor.processChunk({ data: 'chunk1' });
      const result2 = await executor.processChunk({ data: 'chunk2' });
      const result3 = await executor.processChunk({ data: 'chunk3' });

      expect(result1[0].index).toBe(0);
      expect(result2[0].index).toBe(1);
      expect(result3[0].index).toBe(2);
    });

    test('should provide isFirstChunk and isLastChunk flags', async () => {
      let capturedContexts: StreamChunkContext[] = [];

      const hooks = createPluginHooks();
      hooks.onStreamChunk.tapPromise(
        { name: 'context-capturing', stage: 0 },
        async (chunk, ctx) => {
          capturedContexts.push({ ...ctx, streamState: new Map(ctx.streamState) });
          return [chunk];
        }
      );

      const executor = new StreamExecutor(hooks, requestContext);

      await executor.processChunk({ id: 1 });
      await executor.processChunk({ id: 2 });
      executor.markLastChunk();
      await executor.processChunk({ id: 3 });

      expect(capturedContexts[0].isFirstChunk).toBe(true);
      expect(capturedContexts[0].isLastChunk).toBe(false);

      expect(capturedContexts[1].isFirstChunk).toBe(false);
      expect(capturedContexts[1].isLastChunk).toBe(false);

      expect(capturedContexts[2].isFirstChunk).toBe(false);
      expect(capturedContexts[2].isLastChunk).toBe(true);
    });
  });

  describe('flush', () => {
    test('should call onFlushStream hooks', async () => {
      const flushCalls: string[] = [];

      const hooks = createPluginHooks();
      // 注册多个 flush hooks
      hooks.onFlushStream.tapPromise(
        { name: 'plugin1' },
        async (chunks, ctx) => {
          flushCalls.push('plugin1');
          return chunks;
        }
      );
      hooks.onFlushStream.tapPromise(
        { name: 'plugin2' },
        async (chunks, ctx) => {
          flushCalls.push('plugin2');
          return chunks;
        }
      );
      hooks.onFlushStream.tapPromise(
        { name: 'plugin3' },
        async (chunks, ctx) => {
          flushCalls.push('plugin3');
          return chunks;
        }
      );

      const executor = new StreamExecutor(hooks, requestContext);

      await executor.flush();

      expect(flushCalls).toEqual(['plugin1', 'plugin2', 'plugin3']);
    });

    test('should process flushed chunks through waterfall', async () => {
      const hooks = createPluginHooks();

      // 第一个 flush hook 添加 chunks
      hooks.onFlushStream.tapPromise(
        { name: 'buffering' },
        async (chunks, ctx) => {
          return [...chunks, { data: 'chunk1' }, { data: 'chunk2' }];
        }
      );

      // 第二个 flush hook 转换 chunks
      hooks.onFlushStream.tapPromise(
        { name: 'transform' },
        async (chunks, ctx) => {
          return chunks.map(c => ({ ...c, transformed: true }));
        }
      );

      const executor = new StreamExecutor(hooks, requestContext);
      const flushed = await executor.flush();

      // 第一个 hook 的输出被第二个 hook 处理
      expect(flushed).toHaveLength(2);
      expect(flushed[0].transformed).toBe(true);
      expect(flushed[1].transformed).toBe(true);
    });
  });

  describe('createPluginTransformStream', () => {
    test('should create a transform stream that processes chunks', async () => {
      const hooks = createPluginHooks();
      setupSimpleTransformHook(hooks);
      const stream = createPluginTransformStream(hooks, requestContext);

      const input = [
        { data: 'chunk1' },
        { data: 'chunk2' },
        { data: 'chunk3' }
      ];

      const output: any[] = [];

      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of input) {
            controller.enqueue(chunk);
          }
          controller.close();
        }
      });

      const transformed = readable.pipeThrough(stream);
      const reader = transformed.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.push(value);
      }

      expect(output).toHaveLength(3);
      expect(output[0].transformedBy).toBe('simple-transform');
      expect(output[0].index).toBe(0);
      expect(output[1].index).toBe(1);
      expect(output[2].index).toBe(2);
    });

    test('should handle buffering and flush correctly in stream', async () => {
      const hooks = createPluginHooks();
      setupBufferingHook(hooks);
      const stream = createPluginTransformStream(hooks, requestContext);

      const input = [
        { data: 'chunk1' },
        { data: 'chunk2' },
        { data: 'chunk3' }
      ];

      const output: any[] = [];

      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of input) {
            controller.enqueue(chunk);
          }
          controller.close();
        }
      });

      const transformed = readable.pipeThrough(stream);
      const reader = transformed.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.push(value);
      }

      // BufferingHook 在 flush 时才输出所有 chunks
      expect(output).toHaveLength(3);
      expect(output).toEqual([
        { data: 'chunk1' },
        { data: 'chunk2' },
        { data: 'chunk3' }
      ]);
    });

    test('should handle splitting hook in stream', async () => {
      const hooks = createPluginHooks();
      setupSplittingHook(hooks);
      const stream = createPluginTransformStream(hooks, requestContext);

      const input = [{ data: 'original' }];

      const output: any[] = [];

      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of input) {
            controller.enqueue(chunk);
          }
          controller.close();
        }
      });

      const transformed = readable.pipeThrough(stream);
      const reader = transformed.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.push(value);
      }

      // 1 个输入拆分成 3 个输出
      expect(output).toHaveLength(3);
      expect(output[0].part).toBe(1);
      expect(output[1].part).toBe(2);
      expect(output[2].part).toBe(3);
    });

    test('should handle errors gracefully', async () => {
      const hooks = createPluginHooks();
      hooks.onStreamChunk.tapPromise(
        { name: 'error-plugin', stage: 0 },
        async (chunk, ctx) => {
          if (chunk.throwError) {
            throw new Error('Test error');
          }
          return [chunk];
        }
      );

      const stream = createPluginTransformStream(hooks, requestContext);

      const input = [
        { data: 'good1' },
        { data: 'bad', throwError: true },
        { data: 'good2' }
      ];

      const output: any[] = [];

      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of input) {
            controller.enqueue(chunk);
          }
          controller.close();
        }
      });

      const transformed = readable.pipeThrough(stream);
      const reader = transformed.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.push(value);
      }

      // 错误的 chunk 应该原样输出
      expect(output).toHaveLength(3);
      expect(output[0].data).toBe('good1');
      expect(output[1].data).toBe('bad');
      expect(output[2].data).toBe('good2');
    });

    test('should propagate errors when the compatibility hook context is strict', async () => {
      const hooks = createPluginHooks();
      hooks.onStreamChunk.tap('strict-error-plugin', () => {
        throw new Error('strict stream error');
      });

      const stream = createPluginTransformStream(hooks, {
        ...requestContext,
        strict: true,
      } as RequestContext & { strict: boolean });
      const input = new ReadableStream({
        start(controller) {
          controller.enqueue({ data: 'bad' });
          controller.close();
        },
      });

      await expect(input.pipeThrough(stream).getReader().read()).rejects.toThrow('strict stream error');
    });
  });

  describe('cleanup', () => {
    test('should clear stream states on cleanup', async () => {
      const hooks = createPluginHooks();
      setupBufferingHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      await executor.processChunk({ data: 'chunk1' });

      executor.cleanup();

      // 清理后，streamState 应该被清空
      // flush 应该不会输出任何东西（因为 buffered 数组已被清空）
      const flushed = await executor.flush();
      expect(flushed).toEqual([]);
    });
  });

  describe('hasStreamCallbacks', () => {
    test('should return true when hooks registered', () => {
      const hooks = createPluginHooks();
      setupSimpleTransformHook(hooks);
      const executor = new StreamExecutor(hooks, requestContext);

      expect(executor.hasStreamCallbacks()).toBe(true);
    });

    test('should return false when no hooks registered', () => {
      const hooks = createPluginHooks();
      const executor = new StreamExecutor(hooks, requestContext);

      expect(executor.hasStreamCallbacks()).toBe(false);
    });
  });

  describe('Performance Optimizations', () => {
    describe('Sync-first execution', () => {
      test('should execute sync tap without Promise overhead', async () => {
        const hooks = createPluginHooks();
        const callOrder: string[] = [];

        // Register sync tap using tap() method
        hooks.onStreamChunk.tap(
          { name: 'sync-plugin', stage: 0 },
          (chunk, ctx) => {
            callOrder.push('sync');
            return [{ ...chunk, processedBy: 'sync' }];
          }
        );

        const executor = new StreamExecutor(hooks, requestContext);
        const result = await executor.processChunk({ data: 'test' });

        expect(result).toHaveLength(1);
        expect(result[0].processedBy).toBe('sync');
        expect(callOrder).toEqual(['sync']);
      });

      test('should mix sync and async taps correctly', async () => {
        const hooks = createPluginHooks();
        const callOrder: string[] = [];

        // Sync tap (stage 0)
        hooks.onStreamChunk.tap(
          { name: 'sync-plugin', stage: 0 },
          (chunk, ctx) => {
            callOrder.push('sync');
            return [{ ...chunk, sync: true }];
          }
        );

        // Async tap (stage 1)
        hooks.onStreamChunk.tapPromise(
          { name: 'async-plugin', stage: 1 },
          async (chunk, ctx) => {
            callOrder.push('async');
            return [{ ...chunk, async: true }];
          }
        );

        const executor = new StreamExecutor(hooks, requestContext);
        const result = await executor.processChunk({ data: 'test' });

        expect(result).toHaveLength(1);
        expect(result[0].sync).toBe(true);
        expect(result[0].async).toBe(true);
        expect(callOrder).toEqual(['sync', 'async']);
      });

      test('should handle multiple sync taps efficiently', async () => {
        const hooks = createPluginHooks();
        const executionTimes: number[] = [];

        // Register 5 sync taps
        for (let i = 0; i < 5; i++) {
          hooks.onStreamChunk.tap(
            { name: `sync-plugin-${i}`, stage: i },
            (chunk, ctx) => {
              executionTimes.push(Date.now());
              return [{ ...chunk, [`step${i}`]: true }];
            }
          );
        }

        const executor = new StreamExecutor(hooks, requestContext);
        const startTime = Date.now();

        // Process 100 chunks
        for (let i = 0; i < 100; i++) {
          await executor.processChunk({ id: i });
        }

        const endTime = Date.now();
        const totalTime = endTime - startTime;

        // With sync-first optimization, processing should be fast
        // 100 chunks * 5 plugins should complete in < 100ms
        expect(totalTime).toBeLessThan(100);
      });
    });

    describe('Context reuse', () => {
      test('should reuse context object across processChunk calls', async () => {
        const hooks = createPluginHooks();
        const capturedContexts: StreamChunkContext[] = [];

        hooks.onStreamChunk.tap(
          { name: 'context-capture', stage: 0 },
          (chunk, ctx) => {
            capturedContexts.push(ctx);
            return [chunk];
          }
        );

        const executor = new StreamExecutor(hooks, requestContext);

        await executor.processChunk({ id: 1 });
        await executor.processChunk({ id: 2 });
        await executor.processChunk({ id: 3 });

        // All captured contexts should be the same object reference
        expect(capturedContexts[0]).toBe(capturedContexts[1]);
        expect(capturedContexts[1]).toBe(capturedContexts[2]);

        // But the chunkIndex should be updated
        expect(capturedContexts[0].chunkIndex).toBe(2); // Last value after all updates
      });

      test('should update context fields correctly', async () => {
        const hooks = createPluginHooks();
        const capturedStates: { chunkIndex: number; isFirstChunk: boolean; isLastChunk: boolean }[] = [];

        hooks.onStreamChunk.tap(
          { name: 'state-capture', stage: 0 },
          (chunk, ctx) => {
            // Capture current state (copy values, not reference)
            capturedStates.push({
              chunkIndex: ctx.chunkIndex,
              isFirstChunk: ctx.isFirstChunk,
              isLastChunk: ctx.isLastChunk
            });
            return [chunk];
          }
        );

        const executor = new StreamExecutor(hooks, requestContext);

        await executor.processChunk({ id: 1 });
        await executor.processChunk({ id: 2 });
        executor.markLastChunk();
        await executor.processChunk({ id: 3 });

        expect(capturedStates[0]).toEqual({ chunkIndex: 0, isFirstChunk: true, isLastChunk: false });
        expect(capturedStates[1]).toEqual({ chunkIndex: 1, isFirstChunk: false, isLastChunk: false });
        expect(capturedStates[2]).toEqual({ chunkIndex: 2, isFirstChunk: false, isLastChunk: true });
      });
    });

    describe('Zero-overhead passthrough', () => {
      test('should return passthrough stream when no callbacks registered', async () => {
        const hooks = createPluginHooks();
        // No callbacks registered
        const stream = createPluginTransformStream(hooks, requestContext);

        const input = [
          { data: 'chunk1' },
          { data: 'chunk2' },
          { data: 'chunk3' }
        ];

        const output: any[] = [];

        const readable = new ReadableStream({
          start(controller) {
            for (const chunk of input) {
              controller.enqueue(chunk);
            }
            controller.close();
          }
        });

        const transformed = readable.pipeThrough(stream);
        const reader = transformed.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output.push(value);
        }

        // Should passthrough all chunks unchanged
        expect(output).toEqual(input);
      });

      test('should use full processing when onStreamChunk has callbacks', async () => {
        const hooks = createPluginHooks();
        hooks.onStreamChunk.tap(
          { name: 'transform', stage: 0 },
          (chunk, ctx) => [{ ...chunk, transformed: true }]
        );

        const stream = createPluginTransformStream(hooks, requestContext);

        const input = [{ data: 'test' }];
        const output: any[] = [];

        const readable = new ReadableStream({
          start(controller) {
            for (const chunk of input) {
              controller.enqueue(chunk);
            }
            controller.close();
          }
        });

        const transformed = readable.pipeThrough(stream);
        const reader = transformed.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output.push(value);
        }

        expect(output[0].transformed).toBe(true);
      });

      test('should use full processing when only onFlushStream has callbacks', async () => {
        const hooks = createPluginHooks();
        // Only onFlushStream has callback, no onStreamChunk
        hooks.onFlushStream.tapPromise(
          { name: 'flush-only' },
          async (chunks, ctx) => {
            return [...chunks, { flushed: true }];
          }
        );

        const stream = createPluginTransformStream(hooks, requestContext);

        const input = [{ data: 'test' }];
        const output: any[] = [];

        const readable = new ReadableStream({
          start(controller) {
            for (const chunk of input) {
              controller.enqueue(chunk);
            }
            controller.close();
          }
        });

        const transformed = readable.pipeThrough(stream);
        const reader = transformed.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output.push(value);
        }

        // Should include both original chunk and flushed chunk
        expect(output).toHaveLength(2);
        expect(output[0].data).toBe('test');
        expect(output[1].flushed).toBe(true);
      });
    });
  });
});
