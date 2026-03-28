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
import { fetchModels, listModels } from 'tokenlens';

/**
 * AI Transformer Plugin Options
 */
interface AITransformerOptions {
  /**
   * 源格式标识符（如 'anthropic', 'openai', 'gemini'）
   */
  from: string;

  /**
   * 目标格式标识符（如 'anthropic', 'openai', 'gemini'）
   */
  to: string;

  modelMappings?: Array<{
    source: string;
    target: string;
  }> | Record<string, string>;

  anthropicToOpenAIApiMode?: 'chat_completions' | 'responses';
}

type MaybeAITransformerOptions = AITransformerOptions | undefined;

type ModelOption = { value: string; label: string; description: string };
type ModelCatalogSource = 'fresh' | 'static';
type ModelCatalogCache = { expiresAt: number; models: ModelOption[]; source: ModelCatalogSource };
type ModelCatalogResponse = { provider: string; models: ModelOption[]; source: ModelCatalogSource };

const MODEL_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const modelCatalogCache = new Map<string, ModelCatalogCache>();

/**
 * AI Transformer Plugin
 *
 * 通过配置动态选择转换器，实现统一的转换接口
 */
export const AITransformerPlugin = definePlugin(
  class implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'ai-transformer';
    static readonly version = '2.0.0';

    converter: AIConverter;
    options: AITransformerOptions;
    modelMappingMap = new Map<string, string>();

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
      this.modelMappingMap = this.buildModelMappingMap(options.modelMappings);

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
            this.applyModelMapping(ctx);
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

    async getModels(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const provider = url.searchParams.get('provider');

        if (!provider) {
          return new Response(
            JSON.stringify({ error: 'provider query parameter is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const normalizedProvider = provider === 'gemini' ? 'google' : provider;
        const cached = modelCatalogCache.get(normalizedProvider);
        if (cached && cached.expiresAt > Date.now()) {
          const payload: ModelCatalogResponse = {
            provider,
            models: cached.models,
            source: cached.source
          };
          return new Response(
            JSON.stringify(payload),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }

        let models: ModelOption[] = [];
        let source: ModelCatalogSource = 'fresh';
        try {
          models = await this.getFreshProviderModels(normalizedProvider);
        } catch (error) {
          logger.warn({ error, provider: normalizedProvider }, 'Failed to fetch fresh model catalog, falling back to static catalog');
        }
        if (models.length === 0) {
          source = 'static';
          models = this.getStaticProviderModels(normalizedProvider);
          logger.warn({ provider: normalizedProvider }, 'Using static tokenlens model catalog fallback');
        }

        modelCatalogCache.set(normalizedProvider, {
          expiresAt: Date.now() + MODEL_CATALOG_CACHE_TTL_MS,
          models,
          source
        });

        const payload: ModelCatalogResponse = {
          provider,
          models,
          source
        };

        return new Response(
          JSON.stringify(payload),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (error: unknown) {
        logger.warn({ error }, 'Failed to load ai-transformer model catalog');
        const payload: ModelCatalogResponse = {
          provider: '',
          models: [],
          source: 'static'
        };
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    private async getFreshProviderModels(provider: string): Promise<ModelOption[]> {
      const providerInfo = await fetchModels({ provider });
      if (!providerInfo || typeof providerInfo !== 'object' || !('models' in providerInfo)) {
        return [];
      }

      const modelMap = (providerInfo as { models?: Record<string, { id?: string; name?: string; limit?: { context?: number }; last_updated?: string; release_date?: string }> }).models;
      if (!modelMap || typeof modelMap !== 'object') {
        return [];
      }

      const rows = Object.values(modelMap)
        .map((model) => {
          const rawId = typeof model.id === 'string' ? model.id : '';
          const rawName = typeof model.name === 'string' ? model.name : '';
          const providerPrefix = `${provider}:`;
          const value = rawId.trim().startsWith(providerPrefix)
            ? rawId.trim().slice(providerPrefix.length)
            : rawId.trim();
          if (!value) return null;

          const context = typeof model.limit?.context === 'number' ? model.limit.context : undefined;
          const description = context ? `ctx ${context}` : '';
          const sortKey = (typeof model.last_updated === 'string' ? model.last_updated : '') || (typeof model.release_date === 'string' ? model.release_date : '');

          return {
            value,
            label: rawName.trim() || value,
            description,
            sortKey
          };
        })
        .filter((row): row is { value: string; label: string; description: string; sortKey: string } => row !== null)
        .sort((a, b) => b.sortKey.localeCompare(a.sortKey));

      const dedup = new Map<string, ModelOption>();
      for (const row of rows) {
        if (!dedup.has(row.value)) {
          dedup.set(row.value, {
            value: row.value,
            label: row.label,
            description: row.description
          });
        }
      }

      return Array.from(dedup.values());
    }

    private getStaticProviderModels(provider: string): ModelOption[] {
      const fallbackModels = listModels({ provider });

      const dedup = new Map<string, ModelOption>();
      for (const model of fallbackModels) {
        const providerPrefix = `${provider}:`;
        const modelId = model.id.startsWith(providerPrefix) ? model.id.slice(providerPrefix.length) : model.id;
        if (!modelId || dedup.has(modelId)) continue;

        const contextMax = model.context?.combinedMax ?? model.context?.inputMax;
        dedup.set(modelId, {
          value: modelId,
          label: model.displayName || modelId,
          description: contextMax ? `ctx ${contextMax}` : ''
        });
      }

      return Array.from(dedup.values());
    }

    private buildModelMappingMap(input: AITransformerOptions['modelMappings']): Map<string, string> {
      const map = new Map<string, string>();

      if (!input) return map;

      if (Array.isArray(input)) {
        for (const item of input) {
          const source = typeof item?.source === 'string' ? item.source.trim() : '';
          const target = typeof item?.target === 'string' ? item.target.trim() : '';
          if (source && target) {
            map.set(source, target);
          }
        }
        return map;
      }

      if (typeof input === 'object') {
        for (const [source, target] of Object.entries(input)) {
          const sourceKey = source.trim();
          const targetValue = typeof target === 'string' ? target.trim() : '';
          if (sourceKey && targetValue) {
            map.set(sourceKey, targetValue);
          }
        }
      }

      return map;
    }

    private applyModelMapping(ctx: { body?: unknown }): void {
      if (this.modelMappingMap.size === 0) return;
      if (!ctx.body || typeof ctx.body !== 'object') return;

      const body = ctx.body as Record<string, unknown>;
      const currentModel = typeof body.model === 'string' ? body.model.trim() : '';
      if (!currentModel) return;

      const mappedModel = this.resolveMappedModel(currentModel);
      if (!mappedModel || mappedModel === currentModel) return;

      body.model = mappedModel;
      logger.debug(
        {
          from: this.options.from,
          to: this.options.to,
          fromModel: currentModel,
          toModel: mappedModel
        },
        'AI transformer model mapped'
      );
    }

    private resolveMappedModel(currentModel: string): string | undefined {
      const exactMappedModel = this.modelMappingMap.get(currentModel);
      if (exactMappedModel) {
        return exactMappedModel;
      }

      const strippedModel = this.stripModelRevisionSuffix(currentModel);
      if (strippedModel !== currentModel) {
        const strippedMappedModel = this.modelMappingMap.get(strippedModel);
        if (strippedMappedModel) {
          return strippedMappedModel;
        }
      }

      const prefixMappedModel = this.findLongestPrefixMappedModel(currentModel);
      if (prefixMappedModel) {
        return prefixMappedModel;
      }

      if (strippedModel !== currentModel) {
        return this.findLongestPrefixMappedModel(strippedModel);
      }

      return undefined;
    }

    private stripModelRevisionSuffix(model: string): string {
      const trimmed = model.trim();
      const revisionSuffix = /^(.*)-\d{8}$/;
      const matched = trimmed.match(revisionSuffix);
      if (!matched || !matched[1]) {
        return trimmed;
      }

      return matched[1];
    }

    private findLongestPrefixMappedModel(model: string): string | undefined {
      let matchedSource = '';
      let mappedModel: string | undefined;

      for (const [source, target] of this.modelMappingMap.entries()) {
        if (!source || source === model) {
          continue;
        }

        if (!model.startsWith(`${source}-`)) {
          continue;
        }

        if (source.length > matchedSource.length) {
          matchedSource = source;
          mappedModel = target;
        }
      }

      return mappedModel;
    }
}
);

// 注册所有内置 converters
registerDefaultProtocolConverters();

export default AITransformerPlugin;
