import { fetchModels, type FetchLike } from 'tokenlens/fetch';
import { costFromUsage } from 'tokenlens/helpers';
import type { ModelCatalog } from 'tokenlens';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import { PRICE_CACHE_KEY, PRICE_STATUS_KEY, pricedCatalog, type PriceCache, type PriceStatus } from './price-catalog';
import { readPriceModelMappings, type PriceModelMapping } from './model-mappings';

export type DirectPricingProvider = 'openai' | 'anthropic' | 'google' | 'xai';

export interface TokenStatsPricingInput {
  readonly model?: string;
  readonly provider?: DirectPricingProvider;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

const DIRECT_HOSTS: Readonly<Record<string, DirectPricingProvider>> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
  'api.x.ai': 'xai',
};
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_REFRESH_MS = 60 * 60 * 1_000;

export function directPricingProviderFromUrl(url: URL): DirectPricingProvider | undefined {
  return DIRECT_HOSTS[url.hostname.toLowerCase()];
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function exactModel(
  model: string,
  providerHint: DirectPricingProvider | undefined,
  catalog: ModelCatalog,
): { provider: string; modelId: string; entry: NonNullable<ModelCatalog[string]['models'][string]> } | undefined {
  const delimiterIndex = [model.indexOf(':'), model.indexOf('/')].filter((index) => index > 0).sort((a, b) => a - b)[0];
  const prefixedProvider = delimiterIndex === undefined ? undefined : model.slice(0, delimiterIndex);
  // Only a known provider prefix is stripped. Catalog IDs can themselves contain '/'.
  if (prefixedProvider && Object.hasOwn(catalog, prefixedProvider)) {
    return catalogModel(catalog, prefixedProvider, model.slice(delimiterIndex! + 1));
  }
  if (providerHint === undefined) {
    const matches = Object.keys(catalog).filter((provider) => catalogModel(catalog, provider, model));
    if (matches.length !== 1) return undefined;
    const provider = matches[0]!;
    return catalogModel(catalog, provider, model);
  }
  return catalogModel(catalog, providerHint, model);
}

function catalogModel(catalog: ModelCatalog, provider: string, modelId: string) {
  if (!Object.hasOwn(catalog, provider)) return undefined;
  const models = catalog[provider]?.models;
  if (!models || !Object.hasOwn(models, modelId)) return undefined;
  return { provider, modelId, entry: models[modelId]! };
}

function hasTieredPricing(cost: Record<string, unknown>): boolean {
  return Object.keys(cost).some((key) => /context|tier|over_\d/i.test(key));
}

export function calculateTokenStatsCost(catalog: ModelCatalog | undefined, input: TokenStatsPricingInput, mappings: readonly PriceModelMapping[] = []): number | null {
  const { model, inputTokens, outputTokens } = input;
  if (!catalog || !model || !Number.isSafeInteger(inputTokens) || inputTokens! < 0
    || !Number.isSafeInteger(outputTokens) || outputTokens! < 0) return null;
  const mapping = mappings.find(item => item.source === model);
  // Explicit aliases override host hints and direct matches; a missing target stays unknown.
  const match = mapping ? catalogModel(catalog, mapping.provider, mapping.model) : exactModel(model, input.provider, catalog);
  if (!match) return null;

  const rawCost = match.entry.cost as Record<string, unknown> | undefined;
  if (!rawCost || !isNonNegativeNumber(rawCost.input) || !isNonNegativeNumber(rawCost.output)) return null;
  if (hasTieredPricing(rawCost) && inputTokens! >= 200_000) return null;

  const cacheReads = input.cacheReadTokens ?? 0;
  const cacheWrites = input.cacheWriteTokens ?? 0;
  if (!Number.isSafeInteger(cacheReads) || cacheReads < 0
    || !Number.isSafeInteger(cacheWrites) || cacheWrites < 0
    || cacheReads + cacheWrites > inputTokens!) return null;
  if (cacheReads > 0 && !isNonNegativeNumber(rawCost.cache_read)) return null;
  if (cacheWrites > 0 && !isNonNegativeNumber(rawCost.cache_write)) return null;

  const restrictedCatalog: ModelCatalog = {
    [match.provider]: { ...catalog[match.provider]!, models: { [match.modelId]: match.entry } },
  };
  try {
    const cost = costFromUsage({
      id: `${match.provider}:${match.modelId}`,
      catalog: restrictedCatalog,
      usage: {
        input: inputTokens! - cacheReads - cacheWrites,
        output: outputTokens!,
        ...(cacheReads > 0 ? { cacheReads } : {}),
        ...(cacheWrites > 0 ? { cacheWrites } : {}),
      },
    });
    return isNonNegativeNumber(cost) ? cost : null;
  } catch {
    return null;
  }
}

export class TokenStatsPricing {
  private catalog: ModelCatalog | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<boolean> | undefined;
  private controller: AbortController | undefined;
  private initialLoadStarted = false;
  private initialLoadReady: Promise<void> = Promise.resolve();
  private cacheTimestamp: number | null = null;
  private mappings: PriceModelMapping[] | undefined = [];

  constructor(private readonly options: {
    fetch?: FetchLike;
    timeoutMs?: number;
    refreshMs?: number;
    storage?: PluginStorage;
  } = {}) {}

  start(): void {
    if (this.options.storage) { this.initialLoadReady = this.readCache(); return; }
    if (this.interval !== undefined) return;
    void this.refresh();
    this.interval = setInterval(() => { void this.refresh(); }, this.options.refreshMs ?? DEFAULT_REFRESH_MS);
  }

  stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    this.controller?.abort();
  }

  async refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const task = this.loadCatalog();
    this.inFlight = task;
    if (!this.initialLoadStarted) {
      this.initialLoadStarted = true;
      this.initialLoadReady = this.waitForInitialLoad(task);
    }
    try { return await task; }
    finally { if (this.inFlight === task) this.inFlight = undefined; }
  }

  ready(): Promise<void> {
    if (this.options.storage) return this.readCache();
    return this.initialLoadReady;
  }

  private async readCache(): Promise<void> {
    // Read aliases independently: editing/removing one must work without refreshing prices.
    try {
      this.mappings = await readPriceModelMappings(this.options.storage!);
    } catch { this.mappings = undefined; } // Read/parse failures must not select a fallback price.
    try {
      const status = await this.options.storage!.get<PriceStatus>(PRICE_STATUS_KEY);
      if (this.catalog && status?.lastSuccessAt === this.cacheTimestamp) return;
      const cache = await this.options.storage!.get<PriceCache>(PRICE_CACHE_KEY);
      if (cache?.version !== 1 || !Number.isFinite(cache.fetchedAt) || cache.fetchedAt === this.cacheTimestamp) return;
      this.catalog = pricedCatalog(cache.catalog);
      this.cacheTimestamp = cache.fetchedAt;
    } catch { /* Keep the last valid in-memory catalog if storage is temporarily unavailable. */ }
  }

  estimate(input: TokenStatsPricingInput): number | null {
    if (!this.mappings) return null;
    return calculateTokenStatsCost(this.catalog, input, this.mappings);
  }

  private async loadCatalog(): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const fetch = fetchModels(this.options.fetch
        ? { fetch: this.options.fetch, signal: controller.signal }
        : { signal: controller.signal });
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('TokenLens catalog request timed out'));
        }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      });
      const catalog = await Promise.race([fetch, timeoutFailure]);
      if (!catalog || typeof catalog !== 'object') return false;
      this.catalog = catalog;
      return true;
    } catch {
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async waitForInitialLoad(task: Promise<boolean>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => { timeout = setTimeout(resolve, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
