import type { PluginModelCatalogResponse } from '../../api/plugins';

type CatalogCacheEntry = {
  response: PluginModelCatalogResponse;
  expiresAt: number;
};

const OPTION_CACHE_TTL_MS = 10 * 60 * 1000;

const optionCache = new Map<string, CatalogCacheEntry>();
const inFlightRequests = new Map<string, Promise<PluginModelCatalogResponse>>();

function buildCacheKey(pluginName: string, provider?: string): string {
  const normalizedPlugin = pluginName.trim();
  const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
  return `${normalizedPlugin}::${normalizedProvider}`;
}

export async function getCachedPluginModelCatalog(
  fetcher: (pluginName: string, provider?: string) => Promise<PluginModelCatalogResponse>,
  pluginName: string,
  provider?: string
): Promise<PluginModelCatalogResponse> {
  const cacheKey = buildCacheKey(pluginName, provider);
  const cached = optionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response;
  }

  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) {
    return await inFlight;
  }

  const request = (async () => {
    try {
      const response = await fetcher(pluginName, provider);
      optionCache.set(cacheKey, {
        response,
        expiresAt: Date.now() + OPTION_CACHE_TTL_MS
      });
      return response;
    } catch (error) {
      optionCache.delete(cacheKey);
      throw error;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, request);
  return await request;
}

export function resetPluginModelCatalogCache(): void {
  optionCache.clear();
  inFlightRequests.clear();
}
