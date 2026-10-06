/**
 * model-mapping catalog adapter.
 *
 * model-mapping no longer downloads or caches a catalog. It reads the models-dev
 * public service (control or worker process) and reshapes the result for its own
 * mapping UI. There is no second refresh entry and no offline catalogue fallback.
 */

import type { ModelsDevCatalogService } from '../../models-dev/contract';

export type ModelOption = { value: string; label: string; description: string; provider?: string };
export type ModelCatalogSource = 'catalog';
export type ModelCatalogStatus = {
  source: ModelCatalogSource;
  fetchedAt: number | null;
  modelCount: number;
  providerCount: number;
  models: ModelOption[];
  providers: string[];
  matchedCount: number;
  page: number;
  pageSize: number;
};

export const MODEL_CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_QUERY_BYTES = 512;

const encoder = new TextEncoder();

export function catalogQueryIsValid(options: { provider?: string; search?: string; page?: number }): boolean {
  const page = options.page ?? 1;
  return Number.isSafeInteger(page) && page >= 1
    && (options.provider === undefined || options.provider.length <= MAX_CATALOG_QUERY_BYTES)
    && (options.search === undefined || options.search.length <= MAX_CATALOG_QUERY_BYTES);
}

/** Reshape the models-dev read surface into the catalog status the mapping UI consumes. */
export function buildModelCatalogStatus(
  service: ModelsDevCatalogService,
  options: { provider?: string; search?: string; page?: number } = {},
): ModelCatalogStatus {
  const page = options.page ?? 1;
  const result = service.modelOptions({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.search === undefined ? {} : { search: options.search }),
    page,
    pageSize: MODEL_CATALOG_PAGE_SIZE,
  });
  const status = service.status();
  const providers = service.providers().map(provider => provider.provider);
  return {
    source: 'catalog',
    fetchedAt: status.fetchedAt,
    modelCount: status.modelCount,
    providerCount: status.providerCount,
    providers,
    matchedCount: result.total,
    page: result.page,
    pageSize: result.pageSize,
    models: result.models.map(model => ({
      value: model.model,
      label: model.name,
      description: model.providerName,
      provider: model.provider,
    })),
  };
}

export { encoder as modelCatalogEncoder };
