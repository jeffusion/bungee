import type { PriceModelOption } from '../server/model-mappings';
import { createModelSearch, type ModelPage, type ModelSearchState } from './model-search';

export type PricingModelPage = ModelPage<PriceModelOption>;
export type PricingModelSearchState = ModelSearchState<PriceModelOption>;

/** Fetches only the requested provider/search page, never the full catalog. */
export function createPricingModelSearch(
  load: (path: string, signal: AbortSignal) => Promise<PricingModelPage>,
  publish: (state: PricingModelSearchState) => void,
  delayMs = 250,
) {
  return createModelSearch(load, publish, (query: { provider: string; search: string }, page) => {
    const params = new URLSearchParams({ provider: query.provider, search: query.search, page: String(page), pageSize: '50' });
    return `/pricing/models?${params}`;
  }, delayMs);
}
