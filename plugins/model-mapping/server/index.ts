import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';
import { fetchModels, listModels } from 'tokenlens';
import type { ModelCatalog, ProviderInfo, ProviderModel } from 'tokenlens';
import { logger } from '../../../packages/core/src/logger';

interface ModelMappingOptions {
  modelMappings?: Array<{
    source: string;
    target: string;
  }> | Record<string, string>;
}

type ModelOption = { value: string; label: string; description: string; provider?: string };
type ModelCatalogSource = 'fresh' | 'static';
type ModelCatalogResponse = { provider: string; models: ModelOption[]; source: ModelCatalogSource };

const STATIC_MODEL_CATALOG = listModels({});
const KNOWN_PROVIDER_PREFIXES = new Set(
  STATIC_MODEL_CATALOG
    .map((model) => {
      const separatorIndex = model.id.indexOf(':');
      if (separatorIndex <= 0) {
        return '';
      }
      return model.id.slice(0, separatorIndex).trim();
    })
    .filter((provider) => provider.length > 0)
);

export const ModelMappingPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'model-mapping';
    static readonly version = '1.0.0';

    options: ModelMappingOptions;
    modelMappingMap = new Map<string, string>();

    constructor(options?: ModelMappingOptions) {
      this.options = options ?? {};
      this.modelMappingMap = this.buildModelMappingMap(this.options.modelMappings);
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tapPromise(
        { name: 'model-mapping', stage: -10 },
        async (ctx) => {
          this.applyModelMapping(ctx);
          return ctx;
        }
      );
    }

    async reset(): Promise<void> {
    }

    async getModels(_req: Request): Promise<Response> {
      try {
        const models = await this.getFreshAllModels();
        const payload: ModelCatalogResponse = {
          provider: '',
          models,
          source: 'fresh'
        };
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error: unknown) {
        logger.warn({ error }, 'Failed to fetch online tokenlens catalog, using static fallback');
        const payload: ModelCatalogResponse = {
          provider: '',
          models: this.getStaticAllModels(),
          source: 'static'
        };
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    private async getFreshAllModels(): Promise<ModelOption[]> {
      const catalog = await fetchModels();
      return this.flattenFreshCatalog(catalog);
    }

    private flattenFreshCatalog(catalog: ModelCatalog): ModelOption[] {
      const rows: Array<{ dedupeKey: string; value: string; label: string; description: string; provider: string; sortKey: string }> = [];

      for (const [provider, providerInfo] of Object.entries(catalog)) {
        const normalizedProvider = provider.trim();
        if (!normalizedProvider) {
          continue;
        }

        KNOWN_PROVIDER_PREFIXES.add(normalizedProvider);

        const modelEntries = this.getProviderModelEntries(providerInfo);
        for (const [modelKey, model] of modelEntries) {
          const modelId = this.resolveFreshModelId(model, modelKey);
          if (!modelId) {
            continue;
          }

          const canonicalModelId = modelId.includes(':') ? modelId : `${normalizedProvider}:${modelId}`;
          const canonicalParsed = this.parseCanonicalModelId(canonicalModelId);
          const canonicalProvider = canonicalParsed?.provider || normalizedProvider;
          const bareModelId = canonicalParsed?.model || modelId;
          const selectableModelId = this.toSelectableModelId(canonicalModelId, normalizedProvider);

          KNOWN_PROVIDER_PREFIXES.add(canonicalProvider);

          const context = typeof model.limit?.context === 'number' ? model.limit.context : undefined;
          const descriptionParts = [canonicalProvider, context ? `ctx ${context}` : ''].filter(Boolean);
          const sortKey = this.resolveFreshModelSortKey(model);

          rows.push({
            dedupeKey: canonicalModelId,
            value: selectableModelId,
            label: this.resolveFreshModelLabel(model, bareModelId),
            description: descriptionParts.join(' · '),
            provider: canonicalProvider,
            sortKey
          });
        }
      }

      rows.sort((a, b) => {
        const byDate = b.sortKey.localeCompare(a.sortKey);
        if (byDate !== 0) {
          return byDate;
        }
        return a.dedupeKey.localeCompare(b.dedupeKey);
      });

      const dedup = new Map<string, ModelOption>();
      for (const row of rows) {
        if (!dedup.has(row.dedupeKey)) {
          dedup.set(row.dedupeKey, {
            value: row.value,
            label: row.label,
            description: row.description,
            provider: row.provider
          });
        }
      }

      return Array.from(dedup.values());
    }

    private getProviderModelEntries(providerInfo: ProviderInfo | undefined): Array<[string, ProviderModel]> {
      if (!providerInfo || typeof providerInfo !== 'object') {
        return [];
      }

      const modelMap = providerInfo.models;
      if (!modelMap || typeof modelMap !== 'object') {
        return [];
      }

      return Object.entries(modelMap).filter((entry): entry is [string, ProviderModel] => {
        const model = entry[1];
        return Boolean(model && typeof model === 'object');
      });
    }

    private resolveFreshModelId(model: ProviderModel, modelKey: string): string {
      const fromModelId = typeof model.id === 'string' ? model.id.trim() : '';
      if (fromModelId) {
        return fromModelId;
      }

      const fromModelKey = modelKey.trim();
      return fromModelKey;
    }

    private resolveFreshModelLabel(model: ProviderModel, fallback: string): string {
      const name = typeof model.name === 'string' ? model.name.trim() : '';
      return name || fallback;
    }

    private resolveFreshModelSortKey(model: ProviderModel): string {
      const lastUpdated = typeof model.last_updated === 'string' ? model.last_updated : '';
      if (lastUpdated) {
        return lastUpdated;
      }

      const releaseDate = typeof model.release_date === 'string' ? model.release_date : '';
      return releaseDate;
    }

    private getStaticAllModels(): ModelOption[] {
      const dedup = new Map<string, ModelOption>();
      for (const model of STATIC_MODEL_CATALOG) {
        const canonicalModelId = model.id.trim();
        if (!canonicalModelId || dedup.has(canonicalModelId)) {
          continue;
        }

        const separatorIndex = canonicalModelId.indexOf(':');
        const hasProviderPrefix = separatorIndex > 0;
        const provider = hasProviderPrefix ? canonicalModelId.slice(0, separatorIndex) : '';
        const bareModelId = hasProviderPrefix ? canonicalModelId.slice(separatorIndex + 1) : canonicalModelId;

        if (provider) {
          KNOWN_PROVIDER_PREFIXES.add(provider);
        }

        const contextMax = model.context?.combinedMax ?? model.context?.inputMax;
        const descriptionParts = [provider, contextMax ? `ctx ${contextMax}` : ''].filter(Boolean);
        const selectableModelId = this.toSelectableModelId(canonicalModelId, provider);
        dedup.set(canonicalModelId, {
          value: selectableModelId,
          label: model.displayName || bareModelId,
          description: descriptionParts.join(' · '),
          provider
        });
      }

      return Array.from(dedup.values());
    }

    private buildModelMappingMap(input: ModelMappingOptions['modelMappings']): Map<string, string> {
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

      const normalizedMappedModel = this.normalizeMappedTargetModel(mappedModel);
      if (!normalizedMappedModel || normalizedMappedModel === currentModel) return;

      body.model = normalizedMappedModel;
      logger.debug(
        {
          fromModel: currentModel,
          toModel: normalizedMappedModel
        },
        'Model mapping applied'
      );
    }

    private resolveMappedModel(currentModel: string): string | undefined {
      const exactMappedModel = this.modelMappingMap.get(currentModel);
      if (exactMappedModel) {
        return exactMappedModel;
      }

      const canonicalMappedModel = this.findCanonicalSuffixMappedModel(currentModel);
      if (canonicalMappedModel) {
        return canonicalMappedModel;
      }

      const strippedModel = this.stripModelRevisionSuffix(currentModel);
      if (strippedModel !== currentModel) {
        const strippedMappedModel = this.modelMappingMap.get(strippedModel);
        if (strippedMappedModel) {
          return strippedMappedModel;
        }

        const strippedCanonicalMappedModel = this.findCanonicalSuffixMappedModel(strippedModel);
        if (strippedCanonicalMappedModel) {
          return strippedCanonicalMappedModel;
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

    private findCanonicalSuffixMappedModel(model: string): string | undefined {
      let candidate: string | undefined;

      for (const [source, target] of this.modelMappingMap.entries()) {
        const canonicalSource = this.parseCanonicalModelId(source);
        if (!canonicalSource) {
          continue;
        }

        if (canonicalSource.model !== model) {
          continue;
        }

        if (candidate === undefined) {
          candidate = target;
          continue;
        }

        if (candidate !== target) {
          return undefined;
        }
      }

      return candidate;
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

    private normalizeMappedTargetModel(model: string): string {
      const trimmed = model.trim();
      const canonical = this.parseCanonicalModelId(trimmed);
      if (!canonical) {
        return trimmed;
      }

      if (KNOWN_PROVIDER_PREFIXES.has(canonical.provider)) {
        return canonical.model;
      }

      return trimmed;
    }

    private toSelectableModelId(modelId: string, providerHint: string): string {
      const trimmedModelId = modelId.trim();
      const trimmedProviderHint = providerHint.trim();

      if (trimmedProviderHint && trimmedModelId.startsWith(`${trimmedProviderHint}:`) && trimmedModelId.length > trimmedProviderHint.length + 1) {
        return trimmedModelId.slice(trimmedProviderHint.length + 1);
      }

      const canonical = this.parseCanonicalModelId(trimmedModelId);
      if (!canonical) {
        return trimmedModelId;
      }

      if (KNOWN_PROVIDER_PREFIXES.has(canonical.provider)) {
        return canonical.model;
      }

      return trimmedModelId;
    }

    private parseCanonicalModelId(model: string): { provider: string; model: string } | null {
      const trimmed = model.trim();
      const separatorIndex = trimmed.indexOf(':');
      if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
        return null;
      }

      const provider = trimmed.slice(0, separatorIndex).trim();
      const modelId = trimmed.slice(separatorIndex + 1).trim();
      if (!provider || !modelId) {
        return null;
      }

      return { provider, model: modelId };
    }
  }
);

export default ModelMappingPlugin;
