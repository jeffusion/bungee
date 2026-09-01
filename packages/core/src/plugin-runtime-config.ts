import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import type { PluginRegistry } from './plugin-registry';
import { resolveEffectiveRouteEndpoints } from './utils/endpoint-resolver';

export function createRuntimeEligibleConfig(
  config: AppConfig,
  registry: PluginRegistry,
  activatedPluginNames: ReadonlySet<string>,
): AppConfig {
  const isRuntimeEligible = (pluginConfig: PluginConfig | string): boolean => {
    const normalized = typeof pluginConfig === 'string'
      ? { name: pluginConfig, enabled: true }
      : { ...pluginConfig, enabled: pluginConfig.enabled ?? true };
    if (!normalized.name || normalized.enabled === false) return false;
    const snapshot = registry.getPluginStateSnapshot(normalized.name);
    return activatedPluginNames.has(normalized.name)
      && (snapshot === undefined || snapshot.validation === 'validated');
  };

  const services = (config.services || []).map((service) => ({
    ...service,
    ...(service.plugins && { plugins: service.plugins.filter(isRuntimeEligible) }),
    endpoints: service.endpoints || [],
  }));

  return {
    ...config,
    plugins: (config.plugins || []).filter(isRuntimeEligible),
    services,
    routes: (config.routes || []).map((route) => ({
      ...route,
      plugins: (route.plugins || []).filter(isRuntimeEligible),
      endpoints: resolveEffectiveRouteEndpoints(route, services).map((endpoint) => ({
        ...endpoint,
        plugins: (endpoint.plugins || []).filter(isRuntimeEligible),
      })),
    })),
  };
}

export function collectDeclaredPluginConfigs(config: AppConfig): PluginConfig[] {
  const deduped = new Map<string, PluginConfig>();
  const add = (pluginConfig: PluginConfig | string): void => {
    const normalized = typeof pluginConfig === 'string'
      ? { name: pluginConfig, enabled: true }
      : { ...pluginConfig, enabled: pluginConfig.enabled ?? true };
    const key = `${normalized.name || 'unknown'}::${normalized.path || ''}`;
    const existing = deduped.get(key);
    if (existing === undefined) deduped.set(key, normalized);
    else if (existing.enabled === false && normalized.enabled !== false) {
      deduped.set(key, { ...existing, enabled: true });
    }
  };

  for (const plugin of config.plugins || []) add(plugin);
  for (const route of config.routes || []) {
    for (const plugin of route.plugins || []) add(plugin);
    for (const endpoint of resolveEffectiveRouteEndpoints(route, config.services)) {
      for (const plugin of endpoint.plugins || []) add(plugin);
    }
  }
  for (const service of config.services || []) {
    for (const plugin of service.plugins || []) add(plugin);
  }
  return Array.from(deduped.values());
}
