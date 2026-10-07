import { protocolSSEOutput } from '@jeffusion/bungee-core/plugin';
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

import type { Plugin } from '@jeffusion/bungee-core/plugin';
import { definePlugin } from '@jeffusion/bungee-core/plugin';
import type { PluginHooks } from '@jeffusion/bungee-core/plugin';
import {
  type AIConverter,
  ProtocolTransformerRegistry as TransformerRegistry,
  registerDefaultProtocolConverters
} from '@jeffusion/bungee-llms/plugin-api';
import { logger } from '@jeffusion/bungee-core/plugin';

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
    private readonly activeRequests = new Set<string>();

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
  bodyRequirements(context: import('@jeffusion/bungee-core/plugin').PluginBodyRequirementContext): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements {
      const path = context.url.pathname;
      const matched = this.options.from === 'anthropic' ? (['/v1/messages', '/messages'].includes(path) || path.endsWith('/messages/count_tokens')) : this.options.from === 'openai' ? ['/v1/chat/completions', '/v1/responses'].includes(path) : this.options.from === 'gemini' ? /(?:generateContent|streamGenerateContent)$/.test(path) : false;
      return this.options.from && this.options.to && this.options.from !== this.options.to && context.method.toUpperCase() === 'POST' && matched ? { request: 'json-write', response: ['json', 'sse-json'] } : { request: 'none' };
    }

  register(hooks: PluginHooks): void {
    hooks.onFinally.tap('ai-transformer-cleanup', ctx => { this.activeRequests.delete(ctx.requestId); });
    // 1. 请求前处理：转换请求格式
    if (this.converter.onBeforeRequest) {
      hooks.onBeforeRequest.tapPromise(
        { name: 'ai-transformer', stage: 0 },
        async (ctx) => {
          if (this.bodyRequirements({ ...ctx, stage: 'selected' }).request === 'none') return ctx;
          this.activeRequests.add(ctx.requestId);
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
          if (!this.activeRequests.has(ctx.requestId)) return response;
          try {
            const result = await this.converter.onResponse!({ ...ctx, response, bodyHandle: ctx.bodyHandle! });
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
        async (envelope, ctx) => {
          if (!this.activeRequests.has(ctx.requestId) || envelope.json === undefined) return null;
          try {
            const result = await this.converter.processStreamChunk!(structuredClone(envelope.json), { ...ctx, sseEvent: envelope });
            return result ? protocolSSEOutput(result, this.options.from, envelope) : null;
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
          if (!this.activeRequests.has(ctx.requestId)) return chunks;
          try {
            const flushed = await this.converter.flushStream!(ctx);
            // 合并已有的 chunks 和新刷新的 chunks
            return [...chunks, ...protocolSSEOutput(flushed, this.options.from)];
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
