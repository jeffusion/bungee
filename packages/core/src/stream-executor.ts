import type { PluginHooks, StreamChunkContext, RequestContext } from './hooks';
import { logger } from './logger';

/**
 * 创建 SSE 解析器 TransformStream
 * 将 SSE 文本流解析为 JSON 对象
 */
export function createSSEParserStream(): TransformStream<Uint8Array, any> {
  let buffer = '';
  const decoder = new TextDecoder();
  let currentEvent: string | null = null;
  let currentDataLines: string[] = [];

  const resetCurrent = () => {
    currentEvent = null;
    currentDataLines = [];
  };

  const enqueueCurrent = (controller: TransformStreamDefaultController<any>) => {
    if (currentDataLines.length === 0) {
      resetCurrent();
      return;
    }

    const currentData = currentDataLines.join('\n');
    try {
      if (currentData.trim() === '[DONE]') {
        controller.enqueue({ type: '[DONE]', event: currentEvent });
      } else {
        const parsed = JSON.parse(currentData);
        if (currentEvent) {
          parsed._event = currentEvent;
        }
        controller.enqueue(parsed);
      }
    } catch (e) {
      logger.warn({ data: currentData, error: e }, 'Failed to parse SSE data');
    }

    resetCurrent();
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一个不完整的行

      for (const line of lines) {
        const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;

        if (normalizedLine.startsWith('event:')) {
          currentEvent = normalizedLine.slice(6).trim();
        } else if (normalizedLine.startsWith('data:')) {
          currentDataLines.push(normalizedLine.slice(5).trimStart());
        } else if (normalizedLine === '') {
          enqueueCurrent(controller);
        }
      }
    },

    flush(controller) {
      if (buffer.length > 0) {
        const normalizedLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        if (normalizedLine.startsWith('event:')) {
          currentEvent = normalizedLine.slice(6).trim();
        } else if (normalizedLine.startsWith('data:')) {
          currentDataLines.push(normalizedLine.slice(5).trimStart());
        }
      }

      // 处理缓冲区中剩余的数据
      if (currentDataLines.length > 0) {
        enqueueCurrent(controller);
      }
    }
  });
}

/**
 * 创建 SSE 序列化器 TransformStream
 * 将 JSON 对象序列化为 SSE 文本流
 *
 * 符合 W3C SSE 标准：
 * - 如果 chunk 包含 type 字段，输出 `event: <type>` 行
 * - 总是输出 `data: <json>` 行
 *
 * 主要用于 Anthropic 格式（message_start, content_block_delta 等）
 * OpenAI/Gemini 格式无 type 字段，不受影响
 */
export function createSSESerializerStream(): TransformStream<any, Uint8Array> {
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      if (!chunk) return;

      // 处理 [DONE] 信号
      if (chunk.type === '[DONE]') {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        return;
      }

      // W3C SSE 标准：如果 chunk 包含 type 字段，输出对应的 event 行
      // 主要用于 Anthropic 格式（message_start, content_block_delta 等）
      // OpenAI/Gemini 格式无 type 字段，不受影响
      if (chunk.type && typeof chunk.type === 'string') {
        controller.enqueue(encoder.encode(`event: ${chunk.type}\n`));
      }

      // 序列化为 SSE 格式
      const data = JSON.stringify(chunk);
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
    }
  });
}


/**
 * 流式执行器
 * 使用 Hook 系统执行流式转换，支持 N:M 转换
 *
 * 性能优化：
 * - Context 复用：StreamChunkContext 只创建一次，每次更新字段
 * - 减少对象创建和 GC 压力
 */
export class StreamExecutor {
  private hooks: PluginHooks;
  private streamState: Map<string, any> = new Map();
  private chunkIndex: number = 0;
  private isFirstChunk: boolean = true;
  private isLastChunk: boolean = false;
  private requestContext: RequestContext;

  // 复用的 context 对象，避免每次 processChunk 都创建新对象
  private ctx: StreamChunkContext;

  constructor(hooks: PluginHooks, requestContext: RequestContext) {
    this.hooks = hooks;
    this.requestContext = requestContext;

    // 初始化复用的 context
    this.ctx = {
      ...requestContext,
      chunkIndex: 0,
      isFirstChunk: true,
      isLastChunk: false,
      streamState: this.streamState,
      request: requestContext,
    };
  }

  /**
   * 更新 context 字段（复用对象，只更新变化的字段）
   */
  private updateContext(): void {
    this.ctx.chunkIndex = this.chunkIndex;
    this.ctx.isFirstChunk = this.isFirstChunk;
    this.ctx.isLastChunk = this.isLastChunk;
  }

  /**
   * 处理单个 chunk，应用所有插件的转换
   * 支持 N:M 转换（一个输入可以产生 0 到多个输出）
   */
  async processChunk(chunk: any): Promise<any[]> {
    // 更新 context 字段（复用对象）
    this.updateContext();

    try {
      // 使用 Hook 系统处理 chunk
      // AsyncSeriesMapHook 会依次调用所有注册的回调，每个回调可以返回 0 到多个输出
      const results = await this.hooks.onStreamChunk.promise(chunk, this.ctx);
      return results;
    } catch (error) {
      logger.error({ error, chunk }, 'Error in onStreamChunk hook');
      if (this.ctx.strict) {
        throw error;
      }
      // 出错时原样输出
      return [chunk];
    } finally {
      this.chunkIndex++;
      this.isFirstChunk = false;
    }
  }

  /**
   * 标记最后一个 chunk
   */
  markLastChunk(): void {
    this.isLastChunk = true;
  }

  /**
   * 刷新所有插件的缓冲区
   * 在流结束时调用，输出缓冲的 chunks
   */
  async flush(): Promise<any[]> {
    // 更新 context 字段（复用对象）
    this.updateContext();

    try {
      // 使用 Hook 系统刷新缓冲区
      // AsyncSeriesWaterfallHook 会依次调用所有注册的回调
      // 每个回调接收上一个回调的输出，返回处理后的 chunks
      const results = await this.hooks.onFlushStream.promise([], this.ctx);
      return results;
    } catch (error) {
      logger.error({ error }, 'Error in onFlushStream hook');
      if (this.ctx.strict) {
        throw error;
      }
      return [];
    }
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.streamState.clear();
  }

  /**
   * 检查是否有流式处理的回调注册
   */
  hasStreamCallbacks(): boolean {
    return this.hooks.onStreamChunk.hasCallbacks();
  }
}

/**
 * 创建用于流式转换的 TransformStream
 *
 * 性能优化：
 * - 零开销透传：如果没有注册任何 onStreamChunk 回调，直接返回透传 stream
 * - 避免不必要的函数调用和对象创建
 */
export function createPluginTransformStream(
  hooks: PluginHooks,
  requestContext: RequestContext
): TransformStream<any, any> {
  // 零开销透传：没有注册任何 stream chunk 回调时，直接透传
  if (!hooks.onStreamChunk.hasCallbacks() && !hooks.onFlushStream.hasCallbacks()) {
    return new TransformStream();
  }

  const executor = new StreamExecutor(hooks, requestContext);

  return new TransformStream({
    async transform(chunk, controller) {
      try {
        const outputChunks = await executor.processChunk(chunk);

        // 输出所有转换后的 chunks
        for (const outputChunk of outputChunks) {
          controller.enqueue(outputChunk);
        }
      } catch (error) {
        logger.error({ error, chunk }, 'Error in plugin transform stream');
        if ((requestContext as RequestContext & { strict?: boolean }).strict) {
          throw error;
        }
        // 出错时原样输出
        controller.enqueue(chunk);
      }
    },

    async flush(controller) {
      try {
        // 标记最后一个 chunk（用于下一次 processChunk 调用，如果有的话）
        executor.markLastChunk();

        // 刷新所有缓冲区
        const bufferedChunks = await executor.flush();

        // 输出缓冲的 chunks
        for (const chunk of bufferedChunks) {
          controller.enqueue(chunk);
        }
      } catch (error) {
        logger.error({ error }, 'Error flushing plugin stream');
        if ((requestContext as RequestContext & { strict?: boolean }).strict) {
          throw error;
        }
      } finally {
        executor.cleanup();
      }
    }
  });
}
