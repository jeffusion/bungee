import type { PluginRuntimeOrchestratorStatusEntry, PluginRuntimeOrchestratorStatusReport } from './plugin-runtime-status';

export interface PluginRuntimeOrchestratorDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffStatusReports(
  previous: PluginRuntimeOrchestratorStatusReport,
  next: PluginRuntimeOrchestratorStatusReport,
): PluginRuntimeOrchestratorDiff {
  const previousPlugins = new Map(previous.plugins.map((plugin) => [plugin.pluginName, plugin]));
  const nextPlugins = new Map(next.plugins.map((plugin) => [plugin.pluginName, plugin]));
  const added = Array.from(nextPlugins.keys()).filter((name) => !previousPlugins.has(name));
  const removed = Array.from(previousPlugins.keys()).filter((name) => !nextPlugins.has(name));
  const changed = Array.from(nextPlugins.entries()).filter(([name, plugin]) => {
    const previousPlugin = previousPlugins.get(name);
    return previousPlugin !== undefined && comparable(previousPlugin) !== comparable(plugin);
  }).map(([name]) => name);
  return { added, removed, changed };
}

export function summarizePluginFailures(status: PluginRuntimeOrchestratorStatusReport) {
  return status.plugins.filter((plugin) => plugin.state.failures.validation || plugin.state.failures.runtime)
    .map((plugin) => ({
      pluginName: plugin.pluginName,
      currentGeneration: plugin.state.runtime.currentGeneration,
      servingGeneration: plugin.state.runtime.servingGeneration,
      drainingGenerations: plugin.state.runtime.drainingGenerations,
      validationFailure: plugin.state.failures.validation,
      runtimeFailure: plugin.state.failures.runtime,
    }));
}

function comparable(plugin: PluginRuntimeOrchestratorStatusEntry): string {
  return JSON.stringify({
    lifecycle: plugin.state.lifecycle,
    states: plugin.state.states,
    runtime: plugin.state.runtime,
    reasons: plugin.state.reasons,
    failures: plugin.state.failures,
    sources: plugin.sources,
  });
}
