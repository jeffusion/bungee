/**
 * Internal catalog representation for models-dev.
 *
 * It is derived from the full models.dev JSON with no trimming: providers without
 * price data are kept, every model field stays addressable and `provider.api` is
 * preserved for URL-based provider resolution. This module is provider-internal;
 * consumers only see the public `contract.ts` service.
 */

import type {
  ModelsDevCatalogStatus,
  ModelsDevModelMatch,
  ModelsDevModelOption,
  ModelsDevModelPage,
  ModelsDevProviderMatch,
  ModelsDevProviderSummary,
} from '../contract';

export const MAX_PROVIDERS = 4_096;
export const MAX_MODELS_PER_PROVIDER = 16_384;
export const MAX_MODEL_OPTION_PAGE_SIZE = 100;
/** Bounded full-catalog scan budget (the real catalog has ~8.4k models). */
export const MAX_RESOLVE_CANDIDATES = 20_000;

export interface NormalizedPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly tiered: boolean;
}

interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly price: NormalizedPrice | null;
  /** Raw model entry, retained so every original field stays reachable. */
  readonly raw: unknown;
}

interface CatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly api: string | null;
  readonly apiHost: string | null;
  readonly apiPathSegments: readonly string[] | null;
  readonly models: Map<string, CatalogModel>;
  readonly raw: unknown;
}

export interface CatalogIndex {
  readonly version: number;
  readonly fetchedAt: number;
  readonly providers: readonly CatalogProvider[];
  readonly byProvider: ReadonlyMap<string, CatalogProvider>;
  readonly modelCount: number;
}

export interface CatalogRecord {
  readonly version: number;
  readonly fetchedAt: number;
  readonly catalog: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Preserve base prices, note tiered pricing without expanding it. */
export function normalizePrice(cost: unknown): NormalizedPrice | null {
  if (!isRecord(cost)) return null;
  const input = finiteNonNegative(cost.input);
  const output = finiteNonNegative(cost.output);
  if (input === null || output === null) return null;
  const tiered = 'tiers' in cost || 'context_over_200k' in cost;
  return Object.freeze({
    input,
    output,
    cacheRead: finiteNonNegative(cost.cache_read),
    cacheWrite: finiteNonNegative(cost.cache_write),
    tiered,
  });
}

/** Split an API base into lowercase host + path segments; `${...}` segments are wildcards. */
function parseApiBase(api: unknown): { host: string; pathSegments: string[] } | null {
  if (typeof api !== 'string' || api.length === 0 || api.length > 2_048) return null;
  let parsed: URL;
  try { parsed = new URL(api.replace(/\$\{[^}]*\}/g, 'wildcard')); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  const pathSegments = parsed.pathname.split('/').filter(Boolean).map(segment => segment.toLowerCase());
  return { host, pathSegments };
}

function pathMatches(template: readonly string[], request: readonly string[]): boolean {
  if (template.length > request.length) return false;
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== '*' && template[index] !== request[index]) return false;
  }
  return true;
}

/** Build the immutable index; unknown shapes are skipped, never guessed. */
export function buildCatalogIndex(record: CatalogRecord): CatalogIndex {
  if (!isRecord(record.catalog)) throw new Error('models-dev catalog record is invalid');
  const providers: CatalogProvider[] = [];
  const byProvider = new Map<string, CatalogProvider>();
  let modelCount = 0;
  for (const [providerKey, providerValue] of Object.entries(record.catalog)) {
    if (!isRecord(providerValue)) continue;
    if (providers.length >= MAX_PROVIDERS) throw new Error('models-dev catalog exceeds the provider budget');
    const id = typeof providerValue.id === 'string' && providerValue.id.trim() ? providerValue.id.trim() : providerKey.trim();
    if (!id || id.length > 256) continue;
    const name = typeof providerValue.name === 'string' && providerValue.name.trim() ? providerValue.name.trim() : id;
    const parsedApi = parseApiBase(providerValue.api);
    const models = new Map<string, CatalogModel>();
    if (isRecord(providerValue.models)) {
      for (const [modelKey, modelValue] of Object.entries(providerValue.models)) {
        if (!isRecord(modelValue)) continue;
        if (models.size >= MAX_MODELS_PER_PROVIDER) throw new Error('models-dev catalog exceeds the model budget');
        const modelId = typeof modelValue.id === 'string' && modelValue.id.trim() ? modelValue.id.trim() : modelKey.trim();
        if (!modelId || modelId.length > 512) continue;
        const modelName = typeof modelValue.name === 'string' && modelValue.name.trim() ? modelValue.name.trim() : modelId;
        models.set(modelId, Object.freeze({ id: modelId, name: modelName, price: normalizePrice(modelValue.cost), raw: modelValue }));
        modelCount += 1;
      }
    }
    const provider: CatalogProvider = Object.freeze({
      id, name, api: typeof providerValue.api === 'string' ? providerValue.api : null,
      apiHost: parsedApi?.host ?? null,
      apiPathSegments: parsedApi === null ? null : Object.freeze(parsedApi.pathSegments.map(segment => segment.includes('wildcard') ? '*' : segment)),
      models, raw: providerValue,
    });
    providers.push(provider);
    if (!byProvider.has(id)) byProvider.set(id, provider);
  }
  providers.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({ version: record.version, fetchedAt: record.fetchedAt, providers: Object.freeze(providers), byProvider, modelCount });
}

export function emptyStatus(): ModelsDevCatalogStatus {
  return Object.freeze({ state: 'empty', version: null, fetchedAt: null, providerCount: 0, modelCount: 0, error: null });
}

export function statusOf(index: CatalogIndex | null, state: 'ready' | 'stale' | 'failed', error: string | null): ModelsDevCatalogStatus {
  if (index === null) return Object.freeze({ state: error === null ? 'empty' : 'failed', version: null, fetchedAt: null, providerCount: 0, modelCount: 0, error });
  return Object.freeze({ state, version: index.version, fetchedAt: index.fetchedAt, providerCount: index.providers.length, modelCount: index.modelCount, error });
}

/** One real upstream URL resolved through the full catalog's `provider.api`. */
export function resolveProviderFromUrl(index: CatalogIndex | null, rawUrl: string): ModelsDevProviderMatch | null {
  if (index === null || typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8_192) return null;
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean).map(segment => segment.toLowerCase());
  const matches: string[] = [];
  for (const provider of index.providers) {
    if (provider.apiHost !== host || provider.apiPathSegments === null) continue;
    if (!pathMatches(provider.apiPathSegments, segments)) continue;
    matches.push(provider.id);
    if (matches.length > 1) return null; // Ambiguity is never guessed.
  }
  return matches.length === 1 ? Object.freeze({ provider: matches[0]! }) : null;
}

function catalogModelIn(provider: CatalogProvider, modelId: string): ModelsDevModelMatch | null {
  const model = provider.models.get(modelId);
  if (model === undefined || model.price === null) return null;
  return Object.freeze({
    provider: provider.id, model: model.id,
    input: model.price.input, output: model.price.output,
    cacheRead: model.price.cacheRead, cacheWrite: model.price.cacheWrite,
    tiered: model.price.tiered,
  });
}

function providerPrefix(model: string): { provider: string; modelId: string } | null {
  const colon = model.indexOf(':');
  const slash = model.indexOf('/');
  const index = [colon, slash].filter(value => value > 0).sort((left, right) => left - right)[0];
  if (index === undefined) return null;
  const provider = model.slice(0, index);
  const modelId = model.slice(index + 1);
  return provider && modelId ? { provider, modelId } : null;
}

/**
 * Exact, unambiguous resolution. Priority: explicit catalog provider hint
 * (resolved from the hint itself or the URL), a known provider prefix, then a
 * UNIQUE exact model match across the catalog. Case-sensitive throughout.
 */
export function resolveModelInCatalog(index: CatalogIndex | null, input: { model: string; pricingProvider?: string; url?: string }): ModelsDevModelMatch | null {
  if (index === null || typeof input.model !== 'string' || input.model.length === 0 || input.model.length > 512) return null;
  const model = input.model;
  const hintProvider = typeof input.pricingProvider === 'string' && input.pricingProvider.length > 0 && input.pricingProvider.length <= 512
    ? input.pricingProvider
    : undefined;

  if (hintProvider !== undefined) {
    const direct = index.byProvider.get(hintProvider);
    if (direct !== undefined) {
      // An explicit provider that does not carry the model is unknown, not a cue
      // to guess another provider.
      return catalogModelIn(direct, model);
    }
    if (hintProvider.includes('://') || hintProvider.includes('/')) {
      const resolved = resolveProviderFromUrl(index, hintProvider);
      return resolved === null ? null : catalogModelIn(index.byProvider.get(resolved.provider)!, model);
    }
    // An explicit provider that is not in the catalog is unknown, never guessed.
    return null;
  }

  if (input.url !== undefined && input.url.length > 0) {
    const resolved = resolveProviderFromUrl(index, input.url);
    if (resolved !== null) return catalogModelIn(index.byProvider.get(resolved.provider)!, model);
  }

  const prefixed = providerPrefix(model);
  if (prefixed !== null) {
    const provider = index.byProvider.get(prefixed.provider);
    if (provider !== undefined) {
      const match = catalogModelIn(provider, prefixed.modelId);
      if (match !== null) return match;
    }
  }

  let found: ModelsDevModelMatch | null = null;
  let candidates = 0;
  for (const provider of index.providers) {
    if (!provider.models.has(model)) continue;
    const match = catalogModelIn(provider, model);
    if (match === null) continue;
    candidates += 1;
    if (candidates > 1) return null; // Same id under several providers: ambiguous.
    found = match;
  }
  return found;
}

export function providerSummaries(index: CatalogIndex | null): readonly ModelsDevProviderSummary[] {
  if (index === null) return Object.freeze([]);
  return Object.freeze(index.providers.map(provider => Object.freeze({
    provider: provider.id, name: provider.name, api: provider.api, modelCount: provider.models.size,
  })));
}

export function modelOptions(index: CatalogIndex | null, input: { provider?: string; search?: string; page?: number; pageSize?: number } = {}): ModelsDevModelPage {
  const pageSize = Math.min(Math.max(1, Math.trunc(input.pageSize ?? 50)), MAX_MODEL_OPTION_PAGE_SIZE);
  const requestedPage = Math.max(1, Math.trunc(input.page ?? 1));
  if (index === null) return Object.freeze({ models: Object.freeze([]), total: 0, page: 1, pageSize });
  const providerFilter = input.provider;
  const search = input.search;
  const needle = typeof search === 'string' && search.length > 0 ? search.toLocaleLowerCase() : null;
  const providers = providerFilter === undefined ? index.providers : index.providers.filter(provider => provider.id === providerFilter);
  const matchesSearch = (provider: CatalogProvider, model: CatalogModel): boolean => needle === null
    || `${model.id}\n${model.name}\n${provider.id}\n${provider.name}`.toLocaleLowerCase().includes(needle);
  let total = 0;
  for (const provider of providers) {
    if (needle === null) total += provider.models.size;
    else for (const model of provider.models.values()) if (matchesSearch(provider, model)) total++;
    if (total > MAX_RESOLVE_CANDIDATES) throw new Error('models-dev model option scan exceeded the budget');
  }
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, lastPage);
  let skip = (page - 1) * pageSize;
  const models: ModelsDevModelOption[] = [];
  for (const provider of providers) {
    if (needle === null && skip >= provider.models.size) { skip -= provider.models.size; continue; }
    for (const model of provider.models.values()) {
      if (!matchesSearch(provider, model)) continue;
      if (skip > 0) { skip--; continue; }
      models.push({ provider: provider.id, providerName: provider.name, model: model.id, name: model.name });
      if (models.length === pageSize) break;
    }
    if (models.length === pageSize) break;
  }
  return Object.freeze({ models: Object.freeze(models), total, page, pageSize });
}
