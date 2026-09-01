import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import type { PluginRuntimeOrchestratorStatusReport } from '../plugin-runtime-orchestrator';
import { resolveEffectiveRouteEndpoints, resolveRouteService } from '../utils/endpoint-resolver';

function addBindings(names: Set<string>, bindings: readonly (PluginConfig | string)[] | undefined): void {
  for (const binding of bindings ?? []) {
    if (typeof binding === 'string') names.add(binding);
    else if (binding.enabled !== false) names.add(binding.name);
  }
}

export function requiredPluginNames(config: AppConfig): readonly string[] {
  const names = new Set<string>();
  addBindings(names, config.plugins);
  for (const route of config.routes) {
    addBindings(names, route.plugins);
    addBindings(names, resolveRouteService(config, route)?.plugins);
    for (const endpoint of resolveEffectiveRouteEndpoints(route, config.services)) {
      addBindings(names, endpoint.plugins);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export type PluginReadiness = {
  readonly serving: readonly string[];
  readonly failed: readonly string[];
};

export function derivePluginReadiness(
  required: readonly string[],
  generation: number,
  report: PluginRuntimeOrchestratorStatusReport,
): PluginReadiness {
  const serving = [...new Set(report.plugins
    .filter(({ generation: entryGeneration, state }) =>
      report.generation === generation
      && entryGeneration === generation
      && state.runtime.servingScopes.length > 0
      && state.runtime.currentGeneration === generation
      && state.lifecycle === 'serving'
      && state.states.scopedServing === 'serving'
      && state.runtime.servingGeneration === generation
    )
    .filter(({ sources }) => sources.runtime)
    .map(({ pluginName }) => pluginName))]
    .sort((left, right) => left.localeCompare(right));
  const servingNames = new Set(serving);
  return {
    serving,
    failed: required.filter((name) => !servingNames.has(name)),
  };
}
