/**
 * Token-stats pricing.
 *
 * There is no download, scheduler or cache here: prices come from the models-dev
 * public catalog service, and only the explicit alias mappings are owned by
 * token-stats. Protocol detection and price-provider identification are separate:
 * explicit mappings remain strict; automatic pricing uses the catalog's bounded
 * estimate lookups, including normalized names and original-lab reference prices.
 */

import type { ModelsDevCatalogService, ModelsDevModelMatch } from '../../models-dev/contract';
import type { PriceModelMapping } from './model-mappings';

export interface TokenStatsPricingInput {
  readonly model?: string;
  readonly provider?: string;
  /** Real upstream URL, when the caller has it; used only for provider.api matching. */
  readonly url?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

const TOKENS_PER_UNIT = 1_000_000;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function costOf(match: ModelsDevModelMatch, input: TokenStatsPricingInput): number | null {
  const inputTokens = input.inputTokens;
  const outputTokens = input.outputTokens;
  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) return null;
  const cacheReads = input.cacheReadTokens ?? 0;
  const cacheWrites = input.cacheWriteTokens ?? 0;
  if (!isNonNegativeInteger(cacheReads) || !isNonNegativeInteger(cacheWrites)
    || cacheReads + cacheWrites > inputTokens) return null;
  let rates: Pick<ModelsDevModelMatch, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> = match;
  // Bands are ascending and apply to the entire request, including cached input.
  for (const tier of match.contextTiers ?? []) {
    if (inputTokens < tier.minimumInputTokens) break;
    rates = tier;
  }
  const cacheRead = rates.cacheRead ?? match.cacheRead ?? rates.input;
  const cacheWrite = rates.cacheWrite ?? match.cacheWrite ?? rates.input;
  const baseInput = inputTokens - cacheReads - cacheWrites;
  const total =
    baseInput * rates.input
    + outputTokens * rates.output
    + cacheReads * cacheRead
    + cacheWrites * cacheWrite;
  const cost = total / TOKENS_PER_UNIT;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * Resolve one price. Explicit aliases are exact and case-sensitive and take
 * priority over every inferred match; a missing alias target stays unknown rather
 * than falling back to another provider.
 */
export function calculateTokenStatsCost(
  catalog: ModelsDevCatalogService | null,
  input: TokenStatsPricingInput,
  mappings: readonly PriceModelMapping[] = [],
): number | null {
  if (catalog === null || typeof input.model !== 'string' || input.model.length === 0) return null;
  const mapping = mappings.find(item => item.source === input.model);
  if (mapping !== undefined) {
    const target = catalog.resolveModel({ model: mapping.model, pricingProvider: mapping.provider });
    return target === null ? null : costOf(target, input);
  }
  const match = catalog.resolveModel({
    model: input.model,
    mode: 'estimate',
    ...(input.provider === undefined ? {} : { pricingProvider: input.provider }),
    ...(input.url === undefined ? {} : { url: input.url }),
  });
  return match === null ? null : costOf(match, input);
}

/** Reads the models-dev catalog service and applies token-stats aliases. */
export class TokenStatsPricing {
  private mappings: PriceModelMapping[] | undefined = [];

  constructor(private readonly catalog: ModelsDevCatalogService | null) {}

  /** Alias read failures must keep pricing unknown, not select a fallback price. */
  setMappings(mappings: PriceModelMapping[] | undefined): void { this.mappings = mappings; }

  hasMappings(): boolean { return this.mappings !== undefined; }

  estimate(input: TokenStatsPricingInput): number | null {
    if (this.mappings === undefined) return null;
    return calculateTokenStatsCost(this.catalog, input, this.mappings);
  }

  /** Catalog availability is reported separately; nothing is awaited here. */
  ready(): Promise<void> { return Promise.resolve(); }
}
