import { fetchModels, type FetchLike } from 'tokenlens/fetch';
import type { ModelCatalog } from 'tokenlens';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';

export const PRICE_SETTINGS_KEY = 'pricing:settings:v1';
export const PRICE_CACHE_KEY = 'pricing:catalog:v1';
export const PRICE_STATUS_KEY = 'pricing:status:v1';
export const PRICE_SOURCE = 'https://models.dev/api.json';
export interface PriceSettings {
  autoRefresh: boolean;
  intervalMinutes: number;
  timeoutSeconds: number;
}
export interface PriceCache { version: 1; fetchedAt: number; catalog: ModelCatalog }
export interface PriceStatus {
  settings: PriceSettings;
  source: string;
  refreshing: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextRefreshAt: number | null;
  lastError: 'timeout' | 'network' | 'invalid_catalog' | 'storage' | null;
  consecutiveFailures: number;
  modelCount: number;
  providerCount: number;
}
export const DEFAULT_PRICE_SETTINGS: PriceSettings = { autoRefresh: true, intervalMinutes: 60, timeoutSeconds: 15 };

export function parsePriceSettings(value: unknown): PriceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['autoRefresh', 'intervalMinutes', 'timeoutSeconds'].includes(key))
    || typeof v.autoRefresh !== 'boolean'
    || !Number.isInteger(v.intervalMinutes) || (v.intervalMinutes as number) < 1 || (v.intervalMinutes as number) > 1440
    || !Number.isInteger(v.timeoutSeconds) || (v.timeoutSeconds as number) < 5 || (v.timeoutSeconds as number) > 60) {
    throw new Error('invalid_input');
  }
  return { autoRefresh: v.autoRefresh, intervalMinutes: v.intervalMinutes as number, timeoutSeconds: v.timeoutSeconds as number };
}

// Cache only direct providers with usable prices, preserving context tiers and cache prices.
export function pricedCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== 'object') throw new Error('invalid_catalog');
  const input = value as ModelCatalog;
  const output: ModelCatalog = {};
  let count = 0;
  for (const id of ['openai', 'anthropic', 'google', 'xai']) {
    const provider = input[id];
    if (!provider?.models || typeof provider.models !== 'object') continue;
    const models: ModelCatalog[string]['models'] = {};
    for (const [modelId, model] of Object.entries(provider.models)) {
      const cost = model?.cost;
      if (!cost || typeof cost.input !== 'number' || !Number.isFinite(cost.input) || cost.input < 0
        || typeof cost.output !== 'number' || !Number.isFinite(cost.output) || cost.output < 0) continue;
      if (++count > 10_000) throw new Error('invalid_catalog');
      Object.defineProperty(models, modelId, { value: { id: modelId, name: model.name, cost }, enumerable: true });
    }
    if (Object.keys(models).length) output[id] = { id, name: provider.name, models } as ModelCatalog[string];
  }
  if (!count) throw new Error('invalid_catalog');
  return output;
}

export interface PriceCatalogOptions {
  fetch?: FetchLike;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** One control-process owner; workers consume the same persisted catalog. */
export class PriceCatalogManager {
  private state: PriceStatus = {
    settings: { ...DEFAULT_PRICE_SETTINGS }, source: PRICE_SOURCE, refreshing: false,
    lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, lastError: null,
    consecutiveFailures: 0, modelCount: 0, providerCount: 0,
  };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private inFlight: Promise<void> | undefined;
  private initialization: Promise<void> | undefined;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly storage: PluginStorage, private readonly options: PriceCatalogOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    await (this.initialization ??= this.restore());
  }

  status(): PriceStatus { return structuredClone(this.state); }

  private async restore(): Promise<void> {
    const settings = await this.storage.get<unknown>(PRICE_SETTINGS_KEY);
    if (settings !== null) {
      try { this.state.settings = parsePriceSettings(settings); } catch { /* Recover invalid configuration with defaults. */ }
    }
    const previous = await this.storage.get<PriceStatus>(PRICE_STATUS_KEY);
    if (previous) {
      if (typeof previous.lastAttemptAt === 'number' && Number.isFinite(previous.lastAttemptAt)) this.state.lastAttemptAt = previous.lastAttemptAt;
      if (['timeout', 'network', 'invalid_catalog', 'storage'].includes(previous.lastError as string)) this.state.lastError = previous.lastError;
      if (Number.isSafeInteger(previous.consecutiveFailures) && previous.consecutiveFailures >= 0) this.state.consecutiveFailures = previous.consecutiveFailures;
    }
    const cache = await this.storage.get<PriceCache>(PRICE_CACHE_KEY);
    if (cache?.version === 1 && Number.isFinite(cache.fetchedAt)) {
      try {
        const catalog = pricedCatalog(cache.catalog);
        this.state.lastSuccessAt = cache.fetchedAt;
        this.count(catalog);
      } catch { this.state.lastError = 'invalid_catalog'; }
    }
    if (this.stopped) return;
    this.schedule();
    await this.persist();
  }

  async configure(settings: PriceSettings): Promise<PriceStatus> {
    await this.start();
    if (this.stopped) throw new Error('disposed');
    const parsed = parsePriceSettings(settings);
    await this.storage.set(PRICE_SETTINGS_KEY, parsed);
    this.state.settings = parsed;
    this.schedule();
    await this.persist();
    return this.status();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    this.state.nextRefreshAt = null;
    this.state.refreshing = true;
    this.state.lastAttemptAt = this.now();
    const task = this.load().finally(() => {
      if (this.inFlight === task) this.inFlight = undefined;
    });
    this.inFlight = task;
    return task;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.controller?.abort();
  }

  private count(catalog: ModelCatalog): void {
    this.state.providerCount = Object.keys(catalog).length;
    this.state.modelCount = Object.values(catalog).reduce((total, provider) => total + Object.keys(provider.models).length, 0);
  }

  private async load(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let timedOut = false;
    let phase: 'network' | 'storage' | 'invalid_catalog' = 'storage';
    try {
      await this.persist();
      if (this.stopped) return;
      phase = 'network';
      const failure = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.state.settings.timeoutSeconds * 1000);
      });
      const fetched = await Promise.race([
        fetchModels({ ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal: controller.signal }), failure,
      ]);
      if (this.stopped) return;
      phase = 'invalid_catalog';
      const catalog = pricedCatalog(fetched);
      const fetchedAt = Math.max(this.now(), (this.state.lastSuccessAt ?? -1) + 1);
      phase = 'storage';
      await this.storage.set(PRICE_CACHE_KEY, { version: 1, fetchedAt, catalog } satisfies PriceCache);
      if (this.stopped) return;
      this.state.lastSuccessAt = fetchedAt;
      this.count(catalog);
      this.state.lastError = null;
      this.state.consecutiveFailures = 0;
    } catch {
      if (this.stopped) return;
      this.state.lastError = timedOut ? 'timeout' : phase;
      this.state.consecutiveFailures++;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (this.controller === controller) this.controller = undefined;
      this.state.refreshing = false;
      if (!this.stopped) {
        this.schedule();
        try { await this.persist(); } catch { this.state.lastError = 'storage'; }
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) (this.options.cancel ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    this.state.nextRefreshAt = null;
    if (this.stopped || this.state.refreshing || !this.state.settings.autoRefresh) return;
    const interval = this.state.settings.intervalMinutes * 60_000;
    const due = this.state.consecutiveFailures
      ? this.now() + Math.min(interval, 60_000 * Math.min(15, 2 ** Math.min(this.state.consecutiveFailures - 1, 4)))
      : this.state.lastSuccessAt === null ? this.now() : Math.max(this.now(), this.state.lastSuccessAt + interval);
    this.state.nextRefreshAt = due;
    this.timer = (this.options.schedule ?? setTimeout)(() => { void this.refresh(); }, Math.max(0, due - this.now()));
  }

  private persist(): Promise<void> { return this.storage.set(PRICE_STATUS_KEY, this.status()); }
}
