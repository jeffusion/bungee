import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { MutableRequestContext, PluginHooks } from '../../../packages/core/src/hooks';
import { logger } from '../../../packages/core/src/logger';
import { getKnownProviderPrefixes } from './catalog';

interface ModelMappingOptions {
  modelMappings?: Array<{ source: string; target: string }> | Record<string, string>;
}

const MODEL_MAPPING_PLUGIN_NAME = 'model-mapping';

class ModelMappingPluginImpl implements Plugin {
  static readonly name = MODEL_MAPPING_PLUGIN_NAME;
  static readonly version = '1.0.0';

  private readonly modelMappingMap: Map<string, string>;
  private readonly knownProviderPrefixes = getKnownProviderPrefixes();

  constructor(options?: ModelMappingOptions) {
    this.modelMappingMap = this.buildModelMappingMap(options?.modelMappings);
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
    if (ctx.body && typeof ctx.body === 'object') {
      const bodyModel = (ctx.body as Record<string, unknown>).model;
      if (typeof bodyModel === 'string' && bodyModel.trim()) return { model: bodyModel.trim(), source: 'body' };
    }

    const urlModel = this.extractModelFromUrlPath(ctx.url.pathname);
    return urlModel ? { model: urlModel, source: 'url' } : null;
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
