import type { AppConfig, Endpoint, ModificationRules, PluginConfig, RouteConfig, Service } from '@jeffusion/bungee-types';
import { deepMergeRules } from '../worker/rules/deep-merge';

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

export function extractModificationRules(endpoint: Endpoint): ModificationRules { return endpoint.request ?? {}; }
export function deepMergeEndpoint(base: Endpoint, override: Endpoint): Endpoint {
  const merged: Endpoint = { ...base, ...override };
  if (base.request !== undefined || override.request !== undefined) merged.request = deepMergeRules(base.request ?? {},override.request ?? {});
  if (base.response !== undefined || override.response !== undefined) merged.response = deepMergeRules(base.response ?? {},override.response ?? {});
  const plugins = mergePluginArrays(base.plugins,override.plugins);
  if (plugins !== undefined) merged.plugins = plugins; else delete merged.plugins;
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
    // URL equality does not imply account identity. Only legacy ID-less
    // endpoints use target matching; identified endpoints merge by ID.
    const existingIndex = merged.findIndex((candidate) => endpoint.id !== undefined
      ? candidate.id === endpoint.id
      : candidate.id === undefined && candidate.target === endpoint.target);
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
