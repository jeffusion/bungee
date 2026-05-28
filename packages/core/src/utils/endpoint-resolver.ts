import type { AppConfig, Endpoint, ModificationRules, PluginConfig, RouteConfig, Service } from '@jeffusion/bungee-types';
import { deepMergeRules } from '../worker/rules/modifier';

type EndpointPlugin = PluginConfig | string;

function pluginName(plugin: EndpointPlugin): string {
  return typeof plugin === 'string' ? plugin : plugin.name;
}

export function mergePluginArrays(
  basePlugins?: EndpointPlugin[],
  overridePlugins?: EndpointPlugin[],
): EndpointPlugin[] | undefined {
  if (basePlugins === undefined && overridePlugins === undefined) {
    return undefined;
  }

  const merged = [...(basePlugins ?? [])];
  const indexByName = new Map<string, number>();

  for (const [index, plugin] of merged.entries()) {
    indexByName.set(pluginName(plugin), index);
  }

  for (const plugin of overridePlugins ?? []) {
    const name = pluginName(plugin);
    const existingIndex = indexByName.get(name);
    if (existingIndex === undefined) {
      indexByName.set(name, merged.length);
      merged.push(plugin);
    } else {
      merged[existingIndex] = plugin;
    }
  }

  return merged;
}

export function extractModificationRules(endpoint: Endpoint): ModificationRules {
  const rules: ModificationRules = {};
  if (endpoint.headers !== undefined) {
    rules.headers = endpoint.headers;
  }
  if (endpoint.body !== undefined) {
    rules.body = endpoint.body;
  }
  if (endpoint.query !== undefined) {
    rules.query = endpoint.query;
  }
  return rules;
}

function applyModificationRules(endpoint: Endpoint, rules: ModificationRules): Endpoint {
  const merged = { ...endpoint };
  if (rules.headers !== undefined) {
    merged.headers = rules.headers;
  } else {
    delete merged.headers;
  }
  if (rules.body !== undefined) {
    merged.body = rules.body;
  } else {
    delete merged.body;
  }
  if (rules.query !== undefined) {
    merged.query = rules.query;
  } else {
    delete merged.query;
  }
  return merged;
}

export function deepMergeEndpoint(base: Endpoint, override: Endpoint): Endpoint {
  const plugins = mergePluginArrays(base.plugins, override.plugins);
  const rules = deepMergeRules(extractModificationRules(base), extractModificationRules(override));
  const merged = applyModificationRules({ ...base, ...override }, rules);
  if (plugins !== undefined) {
    merged.plugins = plugins;
  } else {
    delete merged.plugins;
  }
  return merged;
}

export function resolveEffectiveRouteEndpoints(route: RouteConfig, services?: Service[]): Endpoint[] {
  const service = route.service
    ? services?.find((candidate) => candidate.name === route.service)
    : undefined;

  if (!service) {
    return route.endpoints ?? [];
  }

  const merged = [...service.endpoints];
  for (const endpoint of route.endpoints ?? []) {
    const existingIndex = merged.findIndex((candidate) => candidate.target === endpoint.target);
    if (existingIndex >= 0) {
      merged[existingIndex] = deepMergeEndpoint(merged[existingIndex], endpoint);
    } else {
      merged.push(endpoint);
    }
  }
  return merged;
}

export function resolveRouteService(config: AppConfig, route: RouteConfig): Service | undefined {
  return route.service ? config.services?.find((service) => service.name === route.service) : undefined;
}
