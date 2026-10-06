import type { PriceModelOption } from '../server/model-mappings';

export interface PricingModelPage { models: PriceModelOption[]; total: number; page: number; pageSize: number }

/** A partial catalog must never be published as the full set of selectable targets. */
export async function loadPricingModels(
  load: (path: string, signal: AbortSignal) => Promise<PricingModelPage>,
  signal: AbortSignal,
): Promise<PriceModelOption[]> {
  const models: PriceModelOption[] = [];
  for (let page = 1; ; page++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await load(`/pricing/models?page=${page}&pageSize=100`, signal);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (result.page !== page || result.pageSize < 1) throw new Error('Incomplete price catalog');
    models.push(...result.models);
    if (page * result.pageSize >= result.total) return models;
    if (!result.models.length) throw new Error('Incomplete price catalog');
  }
}
