import type { ConfigurationRoute, PluginBinding, PluginConfigValue } from '@jeffusion/bungee-types';
import { cloneDeep, isEqual } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import { ConfigurationStaleError, getConfigSnapshot } from '$api/config';
import { saveLogicalConfiguration } from '$api/configuration-save';
import { configurationWrite } from '$stores/configuration-write';
import { get } from 'svelte/store';
import { compileRedactionRules } from '../rules';

const pluginName = 'request-body-redaction';
export { configurationWrite as redactionConfigurationWrite };

export interface RedactionRouteBinding {
  id: string;
  path: string;
  binding: { id: string; enabled: boolean; rules: unknown } | null;
}

export class RedactionRouteConflictError extends Error {}

function project(route: ConfigurationRoute): RedactionRouteBinding {
  const binding = route.plugins.find(plugin => plugin.name === pluginName);
  return {
    id: route.id,
    path: route.path,
    binding: binding ? { id: binding.id, enabled: binding.enabled, rules: binding.options?.rules } : null,
  };
}

export async function loadRedactionRoutes(): Promise<RedactionRouteBinding[]> {
  return (await getConfigSnapshot()).config.logical_configuration.routes.map(project);
}

export async function saveRedactionRouteBinding(
  baseline: RedactionRouteBinding, rules: unknown[] | null,
): Promise<RedactionRouteBinding> {
  baseline = cloneDeep(baseline);
  // Preserve omitted replacements and avoid reading a reactive draft after the await.
  const nextRules = rules === null ? null : JSON.parse(JSON.stringify(rules)) as PluginConfigValue[];
  if (nextRules !== null && !compileRedactionRules(nextRules)) throw new Error('invalid_redaction_rules');
  const snapshot = await getConfigSnapshot();
  const logical = snapshot.config.logical_configuration;
  const route = logical.routes.find(candidate => candidate.id === baseline.id);
  if (!route || !snapshot.config.plugin_activations.some(plugin => plugin.plugin_name === pluginName)
    || !isEqual(project(route), baseline)) throw new RedactionRouteConflictError();
  const current = route.plugins.filter(plugin => plugin.name === pluginName);
  if (current.length > 1) throw new RedactionRouteConflictError();

  const replacement: PluginBinding | null = nextRules === null ? null : {
    name: pluginName,
    id: current[0]?.id ?? uuidv4(),
    position: current[0]?.position ?? route.plugins.reduce((max, plugin) => Math.max(max, plugin.position), -1) + 1,
    enabled: true,
    options: { ...current[0]?.options, rules: nextRules },
  };
  const plugins = current.length
    ? route.plugins.flatMap(plugin => plugin.id !== current[0]?.id ? [plugin] : replacement ? [replacement] : [])
    : replacement ? [...route.plugins, replacement] : route.plugins;
  const nextRoute = { ...route, plugins };
  const { pending, corrupt } = get(configurationWrite);
  if (corrupt || pending && !pending.accepted) throw new Error('configuration_write_unconfirmed');
  try {
    await saveLogicalConfiguration(snapshot, { ...logical, routes: logical.routes.map(item => item.id === route.id ? nextRoute : item) });
  } catch (error) {
    if (error instanceof ConfigurationStaleError) throw new RedactionRouteConflictError();
    throw error;
  }
  return project(nextRoute);
}
