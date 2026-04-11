/**
 * AI Transformer Plugin
 *
 * 统一的 AI 格式转换插件，通过配置支持多种转换方向
 *
 * 使用方式：
 * ```json
 * {
 *   "name": "ai-transformer",
 *   "options": {
 *     "from": "anthropic",
 *     "to": "openai"
 *   }
 * }
 * ```
 *
 * 支持的转换方向：
 * - anthropic ↔ openai
 * - anthropic ↔ gemini
 * - openai ↔ gemini
 */

import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';
import {
  type AIConverter,
  ProtocolTransformerRegistry as TransformerRegistry,
  registerDefaultProtocolConverters
} from '@jeffusion/bungee-llms/plugin-api';
import { logger } from '../../../packages/core/src/logger';

/**
 * AI Transformer Plugin Options
 */
interface AITransformerOptions {
  from: string;
  to: string;

  anthropicToOpenAIApiMode?: 'chat_completions' | 'responses';
}

type MaybeAITransformerOptions = AITransformerOptions | undefined;

/**
 * AI Transformer Plugin
 *
 * 通过配置动态选择转换器，实现统一的转换接口
 */
class AITransformerPluginImpl implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'ai-transformer';
    static readonly version = '2.0.0';

    converter: AIConverter;
    options: AITransformerOptions;

    constructor(options: MaybeAITransformerOptions) {
      const hasNoRouteDirection = !options || (!options.from && !options.to);
      if (hasNoRouteDirection) {
        this.options = { from: '', to: '' };
        this.converter = { from: '', to: '' };
        return;
      }

      if (!options.from || !options.to) {
        throw new Error(
          'AITransformerPlugin requires both "from" and "to" in options.\n' +
          'Example: { "from": "anthropic", "to": "openai" }\n\n' +
          'Available formats: anthropic, openai, gemini'
        );
      }

      this.options = options;

      try {
        this.converter = TransformerRegistry.get(options.from, options.to);
        this.converter.setRuntimeOptions?.(options);

        if (options.from === 'anthropic' && options.to === 'openai') {
          const converterWithMode = this.converter as AIConverter & { setApiMode?: (mode: unknown) => void };
          converterWithMode.setApiMode?.(options.anthropicToOpenAIApiMode);
        }

        logger.info(
          { from: options.from, to: options.to },
          'AI transformer initialized'
        );
      } catch (error) {
        logger.error(
          { error, from: options.from, to: options.to },
          'Failed to initialize AI transformer'
        );
        throw error;
      }
    }

  /**
   * 注册插件 hooks
   */
  register(hooks: PluginHooks): void {
    // 1. 请求前处理：转换请求格式
    if (this.converter.onBeforeRequest) {
      hooks.onBeforeRequest.tapPromise(
        { name: 'ai-transformer', stage: 0 },
        async (ctx) => {
          try {
            await this.converter.onBeforeRequest!(ctx);
            logger.debug(
              { from: this.options.from, to: this.options.to, path: ctx.url.pathname },
              'Request transformed'
            );
          } catch (error) {
            logger.error(
              { error, from: this.options.from, to: this.options.to },
              'Error transforming request'
            );
            throw error;
          }
          return ctx;
        }
      );
    }

    // 2. 响应处理：转换响应格式
    if (this.converter.onResponse) {
      hooks.onResponse.tapPromise(
        { name: 'ai-transformer' },
        async (response, ctx) => {
          try {
            const result = await this.converter.onResponse!(ctx);
            if (result) {
              logger.debug(
                { from: this.options.from, to: this.options.to },
                'Response transformed'
              );
              return result;
            }
            return response;
          } catch (error) {
            logger.error(
              { error, from: this.options.from, to: this.options.to },
              'Error transforming response'
            );
            throw error;
          }
        }
      );
    }

    // 3. 流式响应块处理：转换流数据格式
    if (this.converter.processStreamChunk) {
      hooks.onStreamChunk.tapPromise(
        { name: 'ai-transformer', stage: 0 },
        async (chunk, ctx) => {
          try {
            const result = await this.converter.processStreamChunk!(chunk, ctx);
            return result;
          } catch (error) {
            logger.error(
              { error, from: this.options.from, to: this.options.to },
              'Error processing stream chunk'
            );
            throw error;
          }
        }
      );
    }

    // 4. 流结束时刷新缓冲区
    if (this.converter.flushStream) {
      hooks.onFlushStream.tapPromise(
        { name: 'ai-transformer' },
        async (chunks, ctx) => {
          try {
            const flushed = await this.converter.flushStream!(ctx);
            // 合并已有的 chunks 和新刷新的 chunks
            return [...chunks, ...flushed];
          } catch (error) {
            logger.error(
              { error, from: this.options.from, to: this.options.to },
              'Error flushing stream'
            );
            throw error;
          }
        }
      );
    }
  }

  /**
   * 重置插件状态（对象池复用时调用）
   */
    async reset(): Promise<void> {
      // Transformer 是无状态的，不需要重置
    }

}

export const AITransformerPlugin = definePlugin(AITransformerPluginImpl);

// 注册所有内置 converters
registerDefaultProtocolConverters();

export default AITransformerPlugin;
