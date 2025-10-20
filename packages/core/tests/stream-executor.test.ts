import { describe, test, expect, beforeEach } from 'bun:test';
import { StreamExecutor, createPluginTransformStream } from '../src/stream-executor';
import type { Plugin, StreamChunkContext } from '../src/plugin.types';

// 测试用的 Mock Plugins

/**
 * 简单的 1:1 转换 Plugin
 */
class SimpleTransformPlugin implements Plugin {
  name = 'simple-transform';

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    return [{
      ...chunk,
      transformedBy: this.name,
      index: ctx.chunkIndex
    }];
  }
}

/**
 * 缓冲 Plugin (N:0)
 * 收集 chunks，只在最后输出
 */
class BufferingPlugin implements Plugin {
  name = 'buffering';

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
    // 将 chunk 存储到 state 中
    if (!ctx.streamState.has('buffered')) {
      ctx.streamState.set('buffered', []);
    }
    const buffered = ctx.streamState.get('buffered') as any[];
    buffered.push(chunk);

    // 不输出任何东西（缓冲）
    return [];
  }

  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    // 在流结束时输出所有缓冲的 chunks
    const buffered = ctx.streamState.get('buffered') || [];
    return buffered;
  }
}

/**
 * 拆分 Plugin (1:M)
 * 将一个 chunk 拆分成多个
 */
class SplittingPlugin implements Plugin {
  name = 'splitting';

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
    // 将一个 chunk 拆分成 3 个
    return [
      { ...chunk, part: 1 },
      { ...chunk, part: 2 },
      { ...chunk, part: 3 }
    ];
  }
}

/**
 * 批处理 Plugin (N:M)
 * 每 2 个输入合并成 1 个输出
 */
class BatchingPlugin implements Plugin {
  name = 'batching';

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
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

  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    // 输出剩余的 chunk
    const batch = ctx.streamState.get('batch') || [];
    if (batch.length > 0) {
      return [{
        type: 'merged',
        chunks: batch
      }];
    }
    return [];
  }
}

/**
 * 过滤 Plugin
 * 跳过特定条件的 chunks
 */
class FilteringPlugin implements Plugin {
  name = 'filtering';

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
    // 过滤掉 skip === true 的 chunks
    if (chunk.skip === true) {
      return [];
    }
    return [chunk];
  }
}

/**
 * 不处理的 Plugin
 * 返回 null 表示原样输出
 */
class PassthroughPlugin implements Plugin {
  name = 'passthrough';

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    // 返回 null 表示不处理，原样输出
    return null;
  }
}

describe('StreamExecutor', () => {
  let requestLog: any;

  beforeEach(() => {
    requestLog = {
      id: 'test-request-123',
      method: 'POST',
      path: '/test'
    };
  });

  describe('processChunk', () => {
    test('should process chunk with simple transform plugin', async () => {
      const plugins = [new SimpleTransformPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

      const chunk = { data: 'test' };
      const result = await executor.processChunk(chunk);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        data: 'test',
        transformedBy: 'simple-transform',
        index: 0
      });
    });

    test('should handle passthrough plugin', async () => {
      const plugins = [new PassthroughPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

      const chunk = { data: 'test' };
      const result = await executor.processChunk(chunk);

      expect(result).toEqual([chunk]);
    });

    test('should handle buffering plugin (N:0)', async () => {
      const plugins = [new BufferingPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

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

    test('should handle splitting plugin (1:M)', async () => {
      const plugins = [new SplittingPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

      const chunk = { data: 'original' };
      const result = await executor.processChunk(chunk);

      expect(result).toHaveLength(3);
      expect(result).toEqual([
        { data: 'original', part: 1 },
        { data: 'original', part: 2 },
        { data: 'original', part: 3 }
      ]);
    });

    test('should handle batching plugin (N:M)', async () => {
      const plugins = [new BatchingPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

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

    test('should handle filtering plugin', async () => {
      const plugins = [new FilteringPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

      const result1 = await executor.processChunk({ data: 'keep' });
      const result2 = await executor.processChunk({ data: 'remove', skip: true });
      const result3 = await executor.processChunk({ data: 'keep2' });

      expect(result1).toEqual([{ data: 'keep' }]);
      expect(result2).toEqual([]);
      expect(result3).toEqual([{ data: 'keep2' }]);
    });

    test('should chain multiple plugins', async () => {
      // 链式处理：简单转换 -> 拆分
      const plugins = [
        new SimpleTransformPlugin(),
        new SplittingPlugin()
      ];
      const executor = new StreamExecutor(plugins, requestLog);

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
      const plugins = [new SimpleTransformPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

      const result1 = await executor.processChunk({ data: 'chunk1' });
      const result2 = await executor.processChunk({ data: 'chunk2' });
      const result3 = await executor.processChunk({ data: 'chunk3' });

      expect(result1[0].index).toBe(0);
      expect(result2[0].index).toBe(1);
      expect(result3[0].index).toBe(2);
    });

    test('should provide isFirstChunk and isLastChunk flags', async () => {
      let capturedContexts: StreamChunkContext[] = [];

      class ContextCapturingPlugin implements Plugin {
        name = 'context-capturing';

        async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
          capturedContexts.push({ ...ctx });
          return [chunk];
        }
      }

      const plugins = [new ContextCapturingPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

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
    test('should call flushStream for all plugins', async () => {
      const flushCalls: string[] = [];

      class TrackingPlugin implements Plugin {
        name: string;

        constructor(name: string) {
          this.name = name;
        }

        async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
          return [chunk];
        }

        async flushStream(ctx: StreamChunkContext): Promise<any[]> {
          flushCalls.push(this.name);
          return [];
        }
      }

      const plugins = [
        new TrackingPlugin('plugin1'),
        new TrackingPlugin('plugin2'),
        new TrackingPlugin('plugin3')
      ];
      const executor = new StreamExecutor(plugins, requestLog);

      await executor.flush();

      expect(flushCalls).toEqual(['plugin1', 'plugin2', 'plugin3']);
    });

    test('should process flushed chunks through remaining plugins', async () => {
      // BufferingPlugin 缓冲所有 chunks，在 flush 时输出
      // SimpleTransformPlugin 应该处理这些 flushed chunks
      const plugins = [
        new BufferingPlugin(),
        new SimpleTransformPlugin()
      ];
      const executor = new StreamExecutor(plugins, requestLog);

      await executor.processChunk({ data: 'chunk1' });
      await executor.processChunk({ data: 'chunk2' });

      const flushed = await executor.flush();

      // BufferingPlugin 的 flush 输出被 SimpleTransformPlugin 处理
      expect(flushed).toHaveLength(2);
      expect(flushed[0].transformedBy).toBe('simple-transform');
      expect(flushed[1].transformedBy).toBe('simple-transform');
    });
  });

  describe('createPluginTransformStream', () => {
    test('should create a transform stream that processes chunks', async () => {
      const plugins = [new SimpleTransformPlugin()];
      const stream = createPluginTransformStream(plugins, requestLog);

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
      const plugins = [new BufferingPlugin()];
      const stream = createPluginTransformStream(plugins, requestLog);

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

      // BufferingPlugin 在 flush 时才输出所有 chunks
      expect(output).toHaveLength(3);
      expect(output).toEqual([
        { data: 'chunk1' },
        { data: 'chunk2' },
        { data: 'chunk3' }
      ]);
    });

    test('should handle splitting plugin in stream', async () => {
      const plugins = [new SplittingPlugin()];
      const stream = createPluginTransformStream(plugins, requestLog);

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
      class ErrorPlugin implements Plugin {
        name = 'error-plugin';

        async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
          if (chunk.throwError) {
            throw new Error('Test error');
          }
          return [chunk];
        }
      }

      const plugins = [new ErrorPlugin()];
      const stream = createPluginTransformStream(plugins, requestLog);

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
  });

  describe('cleanup', () => {
    test('should clear stream states on cleanup', async () => {
      const plugins = [new BufferingPlugin()];
      const executor = new StreamExecutor(plugins, requestLog);

      await executor.processChunk({ data: 'chunk1' });

      executor.cleanup();

      // 清理后，streamStates 应该被清空
      // 我们无法直接访问私有字段，但可以通过行为验证
      // flush 应该不会输出任何东西
      const flushed = await executor.flush();
      expect(flushed).toEqual([]);
    });
  });
});
