import type { PluginStorage, Plugin, TokenStatsAttempt } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks, PluginInitContext, PluginLogger } from '../../../packages/core/src/hooks';
import {
  TOKEN_METERING_SERVICE_ID, TOKEN_METERING_CONTRACT_VERSION, type TokenMeteringService, type TokenMeteringResult,
  TOKEN_PRICING_SERVICE_ID, TOKEN_PRICING_CONTRACT_VERSION, type TokenPricingService,
} from '../../../packages/core/src/plugin-services';
import { withReportingWriteTimeout } from './storage';
import { TokenStatsRepository, REPORTING_INCOMPLETE_KEY } from './repository';
import { TokenStatsPricing } from './pricing';
import type { PriceModelMapping } from './model-mappings';
import { MODELS_DEV_CATALOG_CONTRACT_VERSION, MODELS_DEV_CATALOG_SERVICE_ID, type ModelsDevCatalogService } from '../../models-dev/contract';

const MAPPING_REFRESH_INTERVAL_MS = 10_000;

function rowFromResult(result: TokenMeteringResult): TokenStatsAttempt {
  // Preserve reporting's historical official-only policy for interrupted attempts.
  const inputKnown = result.outcome === 'completed' || result.inputSource === 'official';
  const outputKnown = result.outcome === 'completed' || result.outputSource === 'official';
  const source = (value: TokenMeteringResult['inputSource']): TokenStatsAttempt['input_source'] =>
    value === 'official' ? 'usage' : value === 'none' ? 'unknown' : value;
  return {
    key_id: result.keyId ?? null, attempt_id: result.attemptId, request_id: result.requestId, finished_at_ms: result.finishedAtMs,
    route_id: result.routeId || 'unknown', upstream_id: result.upstreamId || 'unknown', provider: result.provider,
    outcome: result.observationIncomplete && result.outcome === 'completed' ? 'failed' : result.outcome, model: result.model || 'unknown',
    input_tokens: inputKnown ? result.inputTokens ?? null : null, output_tokens: outputKnown ? result.outputTokens ?? null : null,
    input_source: inputKnown ? source(result.inputSource) : 'unknown', output_source: outputKnown ? source(result.outputSource) : 'unknown',
    cache_read_tokens: result.cacheReadTokens ?? null, cache_write_tokens: result.cacheWriteTokens ?? null,
    cost_usd: null, observation_incomplete: result.observationIncomplete,
  };
}

/** One bounded result cache shared by reporting and required budget consumers. */
export class TokenStatsPricingService implements TokenPricingService {
  private readonly results = new Map<string, ReturnType<TokenPricingService['price']>>();
  constructor(private readonly pricing: TokenStatsPricing) {}
  readonly canPrice: TokenPricingService['canPrice'] = async input => {
    return this.pricing.estimate({ model: input.model, provider: input.pricingProvider, inputTokens: 0, outputTokens: 0 }) !== null;
  };
  readonly price: TokenPricingService['price'] = result => {
    // Include settlement revision and all pricing inputs; revised usage must be priced again.
    const row = rowFromResult(result);
    const key = JSON.stringify([result.requestId, result.attemptId, result.settlementVersion, result.model, result.pricingProvider,
      row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens]);
    const existing = this.results.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(async () => {
      const raw = this.pricing.estimate({
        model: result.model, provider: result.pricingProvider,
        inputTokens: row.input_tokens ?? undefined, outputTokens: row.output_tokens ?? undefined,
        cacheReadTokens: result.cacheReadTokens, cacheWriteTokens: result.cacheWriteTokens,
      });
      const nano = raw === null || !Number.isFinite(raw) || raw < 0 ? null : Math.round(raw * 1e9);
      const costNanoUsd = nano !== null && Number.isSafeInteger(nano) && nano >= 0 ? nano : null;
      return Object.freeze({ costNanoUsd, costUsd: costNanoUsd === null ? null : costNanoUsd / 1e9 });
    });
    this.results.set(key, pending);
    if (this.results.size > 2048) this.results.delete(this.results.keys().next().value!);
    return pending;
  };
}

/** In-memory alias view with a bounded background refresh: never SQL per request. */
class MappingCache {
  private mappings: PriceModelMapping[] | undefined = undefined;
  private loadedAt = 0;
  private inFlight = false;

  constructor(private readonly load: () => Promise<PriceModelMapping[]>) {}

  current(): PriceModelMapping[] | undefined { return this.mappings; }

  async refresh(now = Date.now()): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      this.mappings = await this.load();
      this.loadedAt = now;
    } catch {
      // A read/parse failure must keep pricing unknown, never select a fallback.
      this.mappings = undefined;
    } finally {
      this.inFlight = false;
    }
  }

  maybeRefresh(now = Date.now()): void {
    if (this.inFlight || now - this.loadedAt < MAPPING_REFRESH_INTERVAL_MS) return;
    void this.refresh(now);
  }
}

export const TokenStatsPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'token-stats';
    static readonly version = '4.0.0';
    storage!: PluginStorage;
    logger!: PluginLogger;
    repository!: TokenStatsRepository;
    pricing!: TokenStatsPricing;
    reportingIncomplete = false;
    private unsubscribe?: () => void;
    private mappingRefresh?: ReturnType<typeof setInterval>;

    private markReportingIncomplete(): void {
      if (this.reportingIncomplete) return;
      this.reportingIncomplete = true;
      setTimeout(() => {
        const reportFailure = (error: unknown) => {
          try { this.logger.error('Unable to persist reporting incomplete status', { error: String(error) }); } catch {}
        };
        try {
          const persist = () => this.storage.set(REPORTING_INCOMPLETE_KEY, true);
          const pending = this.storage.observation
            ? this.storage.observation.withDatabase(db => withReportingWriteTimeout(db, persist))
            : persist();
          void pending.catch(reportFailure);
        } catch (error) { reportFailure(error); }
      }, 0);
    }

    constructor(_config: Record<string, unknown> = {}, private readonly pricingFactory?: () => TokenStatsPricing) {}

    private applyMappings(mappings: PriceModelMapping[] | undefined): void {
      // Fixture doubles may not implement the extended surface; the real class does.
      if (typeof this.pricing.setMappings === 'function') this.pricing.setMappings(mappings);
    }

    async init(context: PluginInitContext): Promise<void> {
      if (!context.services) throw new Error('token-stats requires token-metering service');
      const metering = context.services.consume<TokenMeteringService>('token-metering', TOKEN_METERING_SERVICE_ID, TOKEN_METERING_CONTRACT_VERSION);
      // The catalog is optional for metering: without it token-stats still records
      // usage, but costs stay unknown instead of being blocked on a catalog.
      let catalog: ModelsDevCatalogService | null = null;
      try {
        catalog = context.services.consume<ModelsDevCatalogService>(
          'models-dev', MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_CONTRACT_VERSION,
        );
      } catch { catalog = null; }
      this.storage = context.storage.uncached?.() ?? context.storage;
      this.logger = context.logger;
      this.repository = new TokenStatsRepository(context.storage);
      this.pricing = this.pricingFactory?.() ?? new TokenStatsPricing(catalog);
      const mappings = new MappingCache(() => this.repository.mappings());
      await mappings.refresh();
      this.applyMappings(mappings.current());
      const pricingService = new TokenStatsPricingService(this.pricing);
      context.services.publish(TOKEN_PRICING_SERVICE_ID, TOKEN_PRICING_CONTRACT_VERSION, { canPrice: pricingService.canPrice, price: pricingService.price });
      this.unsubscribe = metering.subscribe({
        onResult: result => {
          const row = rowFromResult(result);
          // Pick up alias edits without paying SQL per request.
          mappings.maybeRefresh();
          this.applyMappings(mappings.current());
          const price = pricingService.price(result);
          void price.catch(() => {});
          const accepted = this.repository.enqueueAttempt(async () => {
            try {
              return { ...row, cost_usd: (await price).costUsd };
            } catch (error) { this.markReportingIncomplete(); throw error; }
          }, {
            onFailure: () => this.markReportingIncomplete(),
            warn: (message, metadata) => { this.markReportingIncomplete(); this.logger.warn(message, metadata); },
            error: (message, metadata) => { this.markReportingIncomplete(); this.logger.error(message, metadata); },
          });
          if (!accepted) this.markReportingIncomplete();
        },
        onFailure: () => { this.markReportingIncomplete(); },
      });
      this.mappingRefresh = setInterval(() => { void mappings.refresh().then(() => this.applyMappings(mappings.current())); }, MAPPING_REFRESH_INTERVAL_MS);
      if (typeof this.mappingRefresh.unref === 'function') this.mappingRefresh.unref();
      context.services.onDispose(() => { this.unsubscribe?.(); this.unsubscribe = undefined; });
      this.logger.info('TokenStatsPlugin initialized');
    }

    register(_hooks: PluginHooks): void {}

    async onDestroy(): Promise<void> {
      this.unsubscribe?.(); this.unsubscribe = undefined;
      if (this.mappingRefresh !== undefined) clearInterval(this.mappingRefresh);
      this.mappingRefresh = undefined;
      this.logger?.info('TokenStatsPlugin destroyed');
    }
  },
);
export default TokenStatsPlugin;
