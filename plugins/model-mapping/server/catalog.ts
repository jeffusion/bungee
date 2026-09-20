import { fetchModels, listModels, type FetchLike } from 'tokenlens';
import type { ModelCatalog, ProviderInfo, ProviderModel } from 'tokenlens';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';

export type ModelOption = { value: string; label: string; description: string; provider?: string };
export type ModelCatalogSource = 'stored' | 'static';
export type ModelCatalogStatus = {
  source: ModelCatalogSource;
  fetchedAt: number | null;
  modelCount: number;
  providerCount: number;
  models: ModelOption[];
  providers: string[];
};

type StoredModelCatalog = {
  fetchedAt: number;
  models: ModelOption[];
};

const MODEL_CATALOG_STORAGE_KEY = 'catalog:v1:data';
const MAX_CATALOG_BODY_BYTES = 512 * 1024;
const MAX_CATALOG_ITEMS = 4096;
const MAX_CATALOG_STRING_BYTES = 512;
const textEncoder = new TextEncoder();

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && textEncoder.encode(value).byteLength <= MAX_CATALOG_STRING_BYTES;
}

async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('catalog request cancelled');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('catalog body limit exceeded');
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('catalog request cancelled');
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_CATALOG_BODY_BYTES) {
        await reader.cancel();
        throw new Error('catalog body limit exceeded');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

const boundedFetch: FetchLike = async (input, init) => {
  const signal = init?.signal as AbortSignal | undefined;
  const response = await globalThis.fetch(input, { signal });
  const body = await readBoundedBody(response, signal);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
};

function providerFromModelId(id: string): string {
  const separatorIndex = id.indexOf(':');
  return separatorIndex > 0 ? id.slice(0, separatorIndex).trim() : '';
}

export function getKnownProviderPrefixes(): Set<string> {
  return new Set(listModels({}).map((model) => providerFromModelId(model.id)).filter(Boolean));
}

function parseCanonicalModelId(model: string): { provider: string; model: string } | null {
  const trimmed = model.trim();
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return null;

  const provider = trimmed.slice(0, separatorIndex).trim();
  const modelId = trimmed.slice(separatorIndex + 1).trim();
  return provider && modelId ? { provider, model: modelId } : null;
}

function toSelectableModelId(modelId: string, providerHint: string, knownProviders: ReadonlySet<string>): string {
  const trimmedModelId = modelId.trim();
  const trimmedProviderHint = providerHint.trim();
  if (trimmedProviderHint && trimmedModelId.startsWith(`${trimmedProviderHint}:`) && trimmedModelId.length > trimmedProviderHint.length + 1) {
    return trimmedModelId.slice(trimmedProviderHint.length + 1);
  }

  const canonical = parseCanonicalModelId(trimmedModelId);
  return canonical && knownProviders.has(canonical.provider) ? canonical.model : trimmedModelId;
}

function getProviderModelEntries(providerInfo: ProviderInfo | undefined): Array<[string, ProviderModel]> {
  if (!providerInfo || typeof providerInfo !== 'object' || !providerInfo.models || typeof providerInfo.models !== 'object') return [];
  return Object.entries(providerInfo.models).filter((entry): entry is [string, ProviderModel] => {
    const model = entry[1];
    return Boolean(model && typeof model === 'object');
  });
}

function flattenFreshCatalog(catalog: ModelCatalog, knownProviders: Set<string>): ModelOption[] {
  const rows: Array<{ dedupeKey: string; value: string; label: string; description: string; provider: string; sortKey: string }> = [];
  let itemCount = 0;

  for (const [provider, providerInfo] of Object.entries(catalog)) {
    if (!isBoundedString(provider)) throw new Error('catalog string limit exceeded');
    const normalizedProvider = provider.trim();
    if (!normalizedProvider) continue;
    knownProviders.add(normalizedProvider);

    const entries = getProviderModelEntries(providerInfo);
    itemCount += entries.length;
    if (itemCount > MAX_CATALOG_ITEMS) throw new Error('catalog item limit exceeded');
    for (const [modelKey, model] of entries) {
      if (!isBoundedString(modelKey)) throw new Error('catalog string limit exceeded');
      for (const value of [model.id, model.name, model.last_updated, model.release_date]) {
        if (value !== undefined && !isBoundedString(value)) throw new Error('catalog string limit exceeded');
      }
      const modelId = (typeof model.id === 'string' ? model.id.trim() : '') || modelKey.trim();
      if (!modelId) continue;
      const canonicalModelId = modelId.includes(':') ? modelId : `${normalizedProvider}:${modelId}`;
      const canonical = parseCanonicalModelId(canonicalModelId);
      const canonicalProvider = canonical?.provider || normalizedProvider;
      const bareModelId = canonical?.model || modelId;
      knownProviders.add(canonicalProvider);
      const context = typeof model.limit?.context === 'number' ? model.limit.context : undefined;
      rows.push({
        dedupeKey: canonicalModelId,
        value: toSelectableModelId(canonicalModelId, normalizedProvider, knownProviders),
        label: (typeof model.name === 'string' ? model.name.trim() : '') || bareModelId,
        description: [canonicalProvider, context ? `ctx ${context}` : ''].filter(Boolean).join(' · '),
        provider: canonicalProvider,
        sortKey: typeof model.last_updated === 'string' && model.last_updated
          ? model.last_updated
          : typeof model.release_date === 'string' ? model.release_date : '',
      });
    }
  }

  rows.sort((left, right) => right.sortKey.localeCompare(left.sortKey) || left.dedupeKey.localeCompare(right.dedupeKey));
  const dedup = new Map<string, ModelOption>();
  for (const row of rows) {
    if (!dedup.has(row.dedupeKey)) {
      dedup.set(row.dedupeKey, { value: row.value, label: row.label, description: row.description, provider: row.provider });
    }
  }
  return [...dedup.values()];
}

export function buildStaticAllModels(): ModelOption[] {
  const knownProviders = getKnownProviderPrefixes();
  const dedup = new Map<string, ModelOption>();
  for (const model of listModels({})) {
    const canonicalModelId = model.id.trim();
    if (!canonicalModelId || dedup.has(canonicalModelId)) continue;
    const canonical = parseCanonicalModelId(canonicalModelId);
    const provider = canonical?.provider ?? '';
    const bareModelId = canonical?.model ?? canonicalModelId;
    if (provider) knownProviders.add(provider);
    const contextMax = model.context?.combinedMax ?? model.context?.inputMax;
    dedup.set(canonicalModelId, {
      value: toSelectableModelId(canonicalModelId, provider, knownProviders),
      label: model.displayName || bareModelId,
      description: [provider, contextMax ? `ctx ${contextMax}` : ''].filter(Boolean).join(' · '),
      provider,
    });
  }
  return [...dedup.values()];
}

function isModelOption(value: unknown): value is ModelOption {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return typeof model.value === 'string' && typeof model.label === 'string' && typeof model.description === 'string'
    && (model.provider === undefined || typeof model.provider === 'string');
}

async function loadStoredModelCatalog(storage: PluginStorage): Promise<StoredModelCatalog | null> {
  const stored = await storage.get<unknown>(MODEL_CATALOG_STORAGE_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const value = stored as Record<string, unknown>;
  if (typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0 || !Array.isArray(value.models)) return null;
  if (value.models.length > MAX_CATALOG_ITEMS || !value.models.every((model) => isModelOption(model)
    && isBoundedString(model.value)
    && isBoundedString(model.label)
    && isBoundedString(model.description)
    && (model.provider === undefined || isBoundedString(model.provider)))) return null;
  return { fetchedAt: value.fetchedAt as number, models: value.models };
}

function summarizeCatalog(source: ModelCatalogSource, models: ModelOption[], fetchedAt: number | null): ModelCatalogStatus {
  const providers = [...new Set(models.map((model) => model.provider).filter((provider): provider is string => Boolean(provider)))].sort();
  return { source, fetchedAt, modelCount: models.length, providerCount: providers.length, models, providers };
}

export async function getModelMappingCatalogStatus(storage: PluginStorage): Promise<ModelCatalogStatus> {
  const stored = await loadStoredModelCatalog(storage);
  return stored ? summarizeCatalog('stored', stored.models, stored.fetchedAt) : summarizeCatalog('static', buildStaticAllModels(), null);
}

export async function refreshStoredModelMappingCatalog(storage: PluginStorage, signal?: AbortSignal): Promise<ModelCatalogStatus> {
  const catalog = await fetchModels({ signal, fetch: boundedFetch });
  if (signal?.aborted) throw new Error('refresh cancelled');
  const stored: StoredModelCatalog = { fetchedAt: Date.now(), models: flattenFreshCatalog(catalog, getKnownProviderPrefixes()) };
  await storage.set(MODEL_CATALOG_STORAGE_KEY, stored);
  return summarizeCatalog('stored', stored.models, stored.fetchedAt);
}
