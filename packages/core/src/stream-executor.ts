import type { Plugin, StreamChunkContext } from './plugin.types';
import { logger } from './logger';

/**
 * 创建 SSE 解析器 TransformStream
 * 将 SSE 文本流解析为 JSON 对象
 */
export function createSSEParserStream(): TransformStream<Uint8Array, any> {
  let buffer = '';
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一个不完整的行

      let currentEvent: string | null = null;
      let currentData = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.substring(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.substring(6);
        } else if (line === '') {
          // 空行表示事件结束
          if (currentData) {
            try {
              // 处理 [DONE] 信号
              if (currentData.trim() === '[DONE]') {
                controller.enqueue({ type: '[DONE]', event: currentEvent });
              } else {
                const parsed = JSON.parse(currentData);
                // 添加 event 字段（如果有）
                if (currentEvent) {
                  parsed._event = currentEvent;
                }
                controller.enqueue(parsed);
              }
            } catch (e) {
              logger.warn({ data: currentData, error: e }, 'Failed to parse SSE data');
            }
            currentData = '';
            currentEvent = null;
          }
        }
      }
    },

    flush(controller) {
      // 处理缓冲区中剩余的数据
      if (buffer.trim()) {
        try {
          if (buffer.trim() === '[DONE]') {
            controller.enqueue({ type: '[DONE]' });
          } else if (buffer.startsWith('data: ')) {
            const data = buffer.substring(6);
            const parsed = JSON.parse(data);
            controller.enqueue(parsed);
          }
        } catch (e) {
          logger.warn({ buffer, error: e }, 'Failed to parse remaining SSE data');
        }
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
 * 负责执行 plugins 的流式转换逻辑，支持 N:M 转换
 */
export class StreamExecutor {
  private plugins: Plugin[];
  private streamStates: Map<string, Map<string, any>>; // pluginName -> state Map
  private chunkIndex: number = 0;
  private isFirstChunk: boolean = true;
  private isLastChunk: boolean = false;
  private requestLog: any;

  constructor(plugins: Plugin[], requestLog: any) {
    this.plugins = plugins.filter(p => p.processStreamChunk || p.flushStream);
    this.streamStates = new Map();
    this.requestLog = requestLog;

    // 为每个 plugin 初始化 state map
    for (const plugin of this.plugins) {
      this.streamStates.set(plugin.name, new Map());
    }
  }

  /**
   * 处理单个 chunk，应用所有 plugins 的转换
   * 支持 N:M 转换（一个输入可以产生 0 到多个输出）
   */
  async processChunk(chunk: any): Promise<any[]> {
    let chunks = [chunk];

    // 依次应用每个 plugin 的转换
    for (const plugin of this.plugins) {
      if (!plugin.processStreamChunk) {
        continue;
      }

      const streamState = this.streamStates.get(plugin.name)!;
      const newChunks: any[] = [];

      // 对每个输入 chunk 应用转换
      for (const inputChunk of chunks) {
        const context: StreamChunkContext = {
          chunkIndex: this.chunkIndex,
          isFirstChunk: this.isFirstChunk,
          isLastChunk: this.isLastChunk,
          streamState,
          request: this.requestLog
        };

        try {
          const result = await plugin.processStreamChunk(inputChunk, context);

          if (result === null || result === undefined) {
            // 不处理，原样输出
            newChunks.push(inputChunk);
          } else if (Array.isArray(result)) {
            // N:M 转换
            // [] = 缓冲（不输出）
            // [item] = 1:1 转换
            // [item1, item2, ...] = 1:M 拆分
            newChunks.push(...result);
          } else {
            logger.warn(
              { pluginName: plugin.name, result },
              'processStreamChunk must return an array or null, got unexpected type'
            );
            newChunks.push(inputChunk);
          }
        } catch (error) {
          logger.error(
            { error, pluginName: plugin.name, chunk: inputChunk },
            'Error in processStreamChunk'
          );
          // 出错时原样输出
          newChunks.push(inputChunk);
        }
      }

      chunks = newChunks;
    }

    this.chunkIndex++;
    this.isFirstChunk = false;

    return chunks;
  }

  /**
   * 标记最后一个 chunk
   */
  markLastChunk(): void {
    this.isLastChunk = true;
  }

  /**
   * 刷新所有 plugins 的缓冲区
   * 在流结束时调用，输出缓冲的 chunks
   */
  async flush(): Promise<any[]> {
    let chunks: any[] = [];

    // 依次执行每个 plugin 的 flush
    for (const plugin of this.plugins) {
      if (!plugin.flushStream) {
        continue;
      }

      const streamState = this.streamStates.get(plugin.name)!;
      const context: StreamChunkContext = {
        chunkIndex: this.chunkIndex,
        isFirstChunk: false,
        isLastChunk: true,
        streamState,
        request: this.requestLog
      };

      try {
        const result = await plugin.flushStream(context);

        if (result && Array.isArray(result)) {
          // 将 flush 返回的 chunks 继续传递给后续 plugins 处理
          for (const chunk of result) {
            const processed = await this.processPluginsAfter(plugin.name, chunk, context);
            chunks.push(...processed);
          }
        }
      } catch (error) {
        logger.error(
          { error, pluginName: plugin.name },
          'Error in flushStream'
        );
      }
    }

    return chunks;
  }

  /**
   * 将 chunk 传递给指定 plugin 之后的所有 plugins 处理
   * 用于 flush 时正确处理 plugin 链
   */
  private async processPluginsAfter(
    afterPluginName: string,
    chunk: any,
    context: StreamChunkContext
  ): Promise<any[]> {
    let chunks = [chunk];
    let foundPlugin = false;

    for (const plugin of this.plugins) {
      if (plugin.name === afterPluginName) {
        foundPlugin = true;
        continue;
      }

      if (!foundPlugin || !plugin.processStreamChunk) {
        continue;
      }

      const streamState = this.streamStates.get(plugin.name)!;
      const newChunks: any[] = [];

      for (const inputChunk of chunks) {
        const pluginContext: StreamChunkContext = {
          ...context,
          streamState
        };

        try {
          const result = await plugin.processStreamChunk(inputChunk, pluginContext);

          if (result === null || result === undefined) {
            newChunks.push(inputChunk);
          } else if (Array.isArray(result)) {
            newChunks.push(...result);
          } else {
            newChunks.push(inputChunk);
          }
        } catch (error) {
          logger.error(
            { error, pluginName: plugin.name },
            'Error processing chunk after flush'
          );
          newChunks.push(inputChunk);
        }
      }

      chunks = newChunks;
    }

    return chunks;
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.streamStates.clear();
  }
}

/**
 * 创建用于流式转换的 TransformStream
 */
export function createPluginTransformStream(
  plugins: Plugin[],
  requestLog: any
): TransformStream<any, any> {
  const executor = new StreamExecutor(plugins, requestLog);

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
      } finally {
        executor.cleanup();
      }
    }
  });
}
