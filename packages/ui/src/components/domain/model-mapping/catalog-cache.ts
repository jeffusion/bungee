import type { PluginModelCatalogResponse } from '$api/plugins';

export async function getCachedPluginModelCatalog(
  fetcher: (pluginName: string, provider?: string) => Promise<PluginModelCatalogResponse>,
  pluginName: string,
  provider?: string
): Promise<PluginModelCatalogResponse> {
  return await fetcher(pluginName, provider);
}

export function resetPluginModelCatalogCache(): void {
}
