import type { Plugin } from '@jeffusion/bungee-core/plugin';
import { definePlugin } from '@jeffusion/bungee-core/plugin';
import type { MutableRequestContext, PluginHooks, PluginInitContext } from '@jeffusion/bungee-core/plugin';
import { logger } from '@jeffusion/bungee-core/plugin';
import { MODELS_DEV_CATALOG_CONTRACT_VERSION, MODELS_DEV_CATALOG_SERVICE_ID, type ModelsDevCatalogService } from '../../models-dev/contract';

interface ModelMappingOptions {
  modelMappings?: Array<{ source: string; target: string }> | Record<string, string>;
}

const MODEL_MAPPING_PLUGIN_NAME = 'model-mapping';

class ModelMappingPluginImpl implements Plugin {
  static readonly name = MODEL_MAPPING_PLUGIN_NAME;
  static readonly version = '1.0.0';

  private readonly modelMappingMap: Map<string, string>;
  private knownProviderPrefixes = new Set<string>();

  constructor(options?: ModelMappingOptions) {
    this.modelMappingMap = this.buildModelMappingMap(options?.modelMappings);
  }

  async init(context: PluginInitContext): Promise<void> {
    if (context.services === undefined) return;
    let catalog: ModelsDevCatalogService | null = null;
    try {
      catalog = context.services.consume<ModelsDevCatalogService>(
        'models-dev', MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_CONTRACT_VERSION,
      );
    } catch { catalog = null; }
    if (catalog === null) return;
    this.knownProviderPrefixes = new Set(catalog.providers().map(provider => provider.provider));
  }
  bodyRequirements(context: import('@jeffusion/bungee-core/plugin').PluginBodyRequirementContext): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements {
    return { request: this.modelMappingMap.size === 0 || /^(GET|HEAD)$/i.test(context.method) || this.extractModelFromUrlPath(context.url.pathname) ? 'none' : 'json-write' };
  }

  register(hooks: PluginHooks): void {
    hooks.onBeforeRequest.tapPromise(
      { name: 'model-mapping', stage: -10 },
      async (ctx) => {
        this.applyModelMapping(ctx);
        return ctx;
      },
    );
  }

  private buildModelMappingMap(input: ModelMappingOptions['modelMappings']): Map<string, string> {
    const map = new Map<string, string>();
    if (!input) return map;

    if (Array.isArray(input)) {
      for (const item of input) {
        const source = typeof item?.source === 'string' ? item.source.trim() : '';
        const target = typeof item?.target === 'string' ? item.target.trim() : '';
        if (source && target) map.set(source, target);
      }
      return map;
    }

    for (const [source, target] of Object.entries(input)) {
      const sourceKey = source.trim();
      const targetValue = typeof target === 'string' ? target.trim() : '';
      if (sourceKey && targetValue) map.set(sourceKey, targetValue);
    }
    return map;
  }

  private applyModelMapping(ctx: MutableRequestContext): void {
    if (this.modelMappingMap.size === 0) return;
    const modelInfo = this.extractModelFromContext(ctx);
    if (!modelInfo) return;

    const { model: currentModel, source } = modelInfo;
    const mappedModel = this.resolveMappedModel(currentModel);
    if (!mappedModel || mappedModel === currentModel) return;

    const normalizedMappedModel = this.normalizeMappedTargetModel(mappedModel);
    if (!normalizedMappedModel || normalizedMappedModel === currentModel) return;

    if (source === 'body' && ctx.body && typeof ctx.body === 'object') {
      (ctx.body as Record<string, unknown>).model = normalizedMappedModel;
    } else if (source === 'url') {
      this.updateModelInUrlPath(ctx.url, currentModel, normalizedMappedModel);
    }

    logger.debug({ fromModel: currentModel, toModel: normalizedMappedModel, source }, 'Model mapping applied');
  }

  private extractModelFromContext(ctx: MutableRequestContext): { model: string; source: 'body' | 'url' } | null {
    const urlModel = this.extractModelFromUrlPath(ctx.url.pathname);
    if (urlModel) return { model: urlModel, source: 'url' };
    if (ctx.body && typeof ctx.body === 'object') {
      const bodyModel = (ctx.body as Record<string, unknown>).model;
      if (typeof bodyModel === 'string' && bodyModel.trim()) return { model: bodyModel.trim(), source: 'body' };
    }

    return null;
  }

  private extractModelFromUrlPath(pathname: string): string | null {
    const match = pathname.match(/^\/v1(?:beta)?\/models\/([^/:]+)(?::|(?:\/(?:generateContent|streamGenerateContent)))/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }

  private updateModelInUrlPath(url: URL, oldModel: string, newModel: string): void {
    const encodedNewModel = encodeURIComponent(newModel);
    const encodedOldModel = encodeURIComponent(oldModel);
    url.pathname = url.pathname.includes(encodedOldModel)
      ? url.pathname.replace(encodedOldModel, encodedNewModel)
      : url.pathname.replace(oldModel, encodedNewModel);
  }

  private resolveMappedModel(currentModel: string): string | undefined {
    const exactMappedModel = this.modelMappingMap.get(currentModel);
    if (exactMappedModel) return exactMappedModel;

    const canonicalMappedModel = this.findCanonicalSuffixMappedModel(currentModel);
    if (canonicalMappedModel) return canonicalMappedModel;

    const strippedModel = this.stripModelRevisionSuffix(currentModel);
    if (strippedModel !== currentModel) {
      const strippedMappedModel = this.modelMappingMap.get(strippedModel);
      if (strippedMappedModel) return strippedMappedModel;
      const strippedCanonicalMappedModel = this.findCanonicalSuffixMappedModel(strippedModel);
      if (strippedCanonicalMappedModel) return strippedCanonicalMappedModel;
    }

    return this.findLongestPrefixMappedModel(currentModel)
      ?? (strippedModel !== currentModel ? this.findLongestPrefixMappedModel(strippedModel) : undefined);
  }

  private findCanonicalSuffixMappedModel(model: string): string | undefined {
    let candidate: string | undefined;
    for (const [source, target] of this.modelMappingMap.entries()) {
      const canonicalSource = this.parseCanonicalModelId(source);
      if (!canonicalSource || canonicalSource.model !== model) continue;
      if (candidate === undefined) candidate = target;
      else if (candidate !== target) return undefined;
    }
    return candidate;
  }

  private stripModelRevisionSuffix(model: string): string {
    const matched = model.trim().match(/^(.*)-\d{8}$/);
    return matched?.[1] || model.trim();
  }

  private findLongestPrefixMappedModel(model: string): string | undefined {
    let matchedSource = '';
    let mappedModel: string | undefined;
    for (const [source, target] of this.modelMappingMap.entries()) {
      if (!source || source === model || !model.startsWith(`${source}-`)) continue;
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
    return canonical && this.knownProviderPrefixes.has(canonical.provider) ? canonical.model : trimmed;
  }

  private parseCanonicalModelId(model: string): { provider: string; model: string } | null {
    const trimmed = model.trim();
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return null;
    const provider = trimmed.slice(0, separatorIndex).trim();
    const modelId = trimmed.slice(separatorIndex + 1).trim();
    return provider && modelId ? { provider, model: modelId } : null;
  }
}

export const ModelMappingPlugin = definePlugin(ModelMappingPluginImpl);

export default ModelMappingPlugin;
