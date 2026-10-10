import { PluginDependencyGraph } from './plugin-dependencies';
import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import type { PluginRegistry } from './plugin-registry';
import { resolveEffectiveRouteEndpoints } from './utils/endpoint-resolver';

// Host-only identity: persisted configuration cannot opt out of validation.
const automaticProviders = new WeakSet<PluginConfig>();
export function isAutomaticGlobalProvider(config: PluginConfig): boolean {
  return automaticProviders.has(config);
}

export function createRuntimeEligibleConfig(
  config: AppConfig,
  registry: PluginRegistry,
  activatedPluginNames: ReadonlySet<string>,
): AppConfig {
  const dependencies = new PluginDependencyGraph(registry.getAllPluginManifests().values());
  dependencies.assertClosed(activatedPluginNames);
  const globalManifests = [...registry.getAllPluginManifests().values()]
    .filter((manifest) => manifest.runtimeScope === 'global' || manifest.runtimeScope === 'global-and-scoped');
  const globalNames = new Set(globalManifests.filter(manifest => manifest.runtimeScope === 'global').map(manifest => manifest.name));
  const providerNames = new Set(globalManifests.map(manifest => manifest.name));
  const isRuntimeEligible = (pluginConfig: PluginConfig | string): boolean => {
    const normalized = typeof pluginConfig === 'string'
      ? { name: pluginConfig, enabled: true }
      : { ...pluginConfig, enabled: pluginConfig.enabled ?? true };
    if (!normalized.name || normalized.enabled === false) return false;
    const snapshot = registry.getPluginStateSnapshot(normalized.name);
    return activatedPluginNames.has(normalized.name)
      && (snapshot === undefined || snapshot.validation === 'validated');
  };

  const scopedEligible = (binding: PluginConfig | string): boolean =>
    !globalNames.has(typeof binding === 'string' ? binding : binding.name) && isRuntimeEligible(binding);
  const dependencyOrder = new Map(dependencies.closure(activatedPluginNames).map((name, index) => [name, index]));
  const globalPlugins: PluginConfig[] = globalManifests
    .filter((manifest) => isRuntimeEligible({ name: manifest.name }) && (manifest.capabilities === undefined || manifest.capabilities.includes('hooks')))
    .sort((left, right) => dependencyOrder.get(left.name)! - dependencyOrder.get(right.name)!)
    .map((manifest) => {
      const declared = (config.plugins || []).find((binding) =>
        (typeof binding === 'string' ? binding : binding.name) === manifest.name
        && (manifest.runtimeScope !== 'global-and-scoped' || isRuntimeEligible(binding)));
      const provider: PluginConfig = {
        ...(typeof declared === 'object' ? declared : {}),
        name: manifest.name,
        path: manifest.mainPath,
        enabled: true,
      };
      if (declared === undefined && manifest.runtimeScope === 'global-and-scoped') automaticProviders.add(provider);
      return provider;
    });

  const services = (config.services || []).map((service) => ({
    ...service,
    ...(service.plugins && { plugins: service.plugins.filter(scopedEligible) }),
    endpoints: (service.endpoints || []).map((endpoint) => ({
      ...endpoint,
      plugins: (endpoint.plugins || []).filter(scopedEligible),
    })),
  }));

  return {
    ...config,
    plugins: [...(config.plugins || []).filter(binding => !providerNames.has(typeof binding === 'string' ? binding : binding.name) && isRuntimeEligible(binding)), ...globalPlugins],
    services,
    routes: (config.routes || []).map((route) => ({
      ...route,
      plugins: (route.plugins || []).filter(scopedEligible),
      // Keep service references intact; scoped initialization resolves them once.
      ...(route.endpoints !== undefined && {
        endpoints: route.endpoints.map((endpoint) => ({
          ...endpoint,
          plugins: (endpoint.plugins || []).filter(scopedEligible),
        })),
      }),
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
