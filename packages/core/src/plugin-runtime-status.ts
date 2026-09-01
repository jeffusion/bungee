import { type PluginRegistry } from './plugin-registry';
import {
  createPluginRegistryStateSnapshot,
  createPluginRuntimeStateSnapshot,
  freezePluginRuntimeState,
  type FrozenPluginRuntimeState,
  type PluginRegistryStateSnapshot,
  type PluginRuntimeStateSnapshot,
} from './plugin-runtime-state-machine';
import type { ScopedPluginRegistry } from './scoped-plugin-registry';

export interface PluginRuntimeOrchestratorStatusEntry {
  pluginName: string;
  generation: number;
  state: FrozenPluginRuntimeState;
  sources: { registry: boolean; runtime: boolean };
}

export interface PluginRuntimeOrchestratorStatusReport {
  generation: number;
  appliedAt: string | null;
  plugins: PluginRuntimeOrchestratorStatusEntry[];
  summary: { total: number; serving: number; disabled: number; degraded: number; quarantined: number };
}

export interface DrainingScopedRegistryEntry {
  registry: ScopedPluginRegistry;
  generation: number;
}

interface RuntimeSnapshotWithGeneration {
  generation: number;
  snapshot: PluginRuntimeStateSnapshot;
}

interface MergedRuntimeObservation {
  snapshot: PluginRuntimeStateSnapshot;
  servingGeneration: number | null;
  drainingGenerations: number[];
  servingScopes: PluginRuntimeStateSnapshot['servingScopes'];
  failedGeneration: number | null;
}

export function buildPluginRuntimeStatusReport(
  pluginRegistry: PluginRegistry | null,
  scopedRegistry: ScopedPluginRegistry | null,
  drainingRegistries: DrainingScopedRegistryEntry[],
  generation: number,
  appliedAt: number | null,
  activatedPluginNames: ReadonlySet<string>,
): PluginRuntimeOrchestratorStatusReport {
  const registrySnapshots = pluginRegistry?.getAllPluginStateSnapshots() ?? new Map<string, PluginRegistryStateSnapshot>();
  const runtimeSnapshots = scopedRegistry?.getAllPluginRuntimeStateSnapshots() ?? new Map<string, PluginRuntimeStateSnapshot>();
  const drainingSnapshots = drainingRegistries.map((entry) => ({
    generation: entry.generation,
    snapshots: entry.registry.getAllPluginRuntimeStateSnapshots(),
  }));
  const pluginNames = new Set([
    ...registrySnapshots.keys(),
    ...runtimeSnapshots.keys(),
    ...drainingSnapshots.flatMap(({ snapshots }) => Array.from(snapshots.keys())),
  ]);
  const plugins = Array.from(pluginNames).sort((left, right) => left.localeCompare(right)).map((pluginName) => {
    const runtime = mergeRuntimeSnapshots(
      pluginName,
      { generation, snapshot: runtimeSnapshots.get(pluginName) ?? createPluginRuntimeStateSnapshot({ pluginName }) },
      drainingSnapshots.flatMap(({ generation: drainingGeneration, snapshots }) => {
        const snapshot = snapshots.get(pluginName);
        return snapshot ? [{ generation: drainingGeneration, snapshot }] : [];
      }),
    );
    const registry = registrySnapshots.get(pluginName)
      ?? synthesizeRegistrySnapshotFromRuntime(pluginName, activatedPluginNames.has(pluginName), runtime.snapshot);
    return {
      pluginName,
      generation,
      state: freezePluginRuntimeState(registry, runtime.snapshot, {
        currentGeneration: generation,
        servingGeneration: runtime.servingGeneration,
        drainingGenerations: runtime.drainingGenerations,
        servingScopes: runtime.servingScopes,
        failedGeneration: runtime.failedGeneration,
      }),
      sources: {
        registry: registrySnapshots.has(pluginName),
        runtime: runtime.snapshot.loadState !== 'not-loaded' || runtime.servingScopes.length > 0,
      },
    } satisfies PluginRuntimeOrchestratorStatusEntry;
  });
  return {
    generation,
    appliedAt: appliedAt ? new Date(appliedAt).toISOString() : null,
    plugins,
    summary: {
      total: plugins.length,
      serving: plugins.filter((plugin) => plugin.state.lifecycle === 'serving').length,
      disabled: plugins.filter((plugin) => plugin.state.lifecycle === 'disabled').length,
      degraded: plugins.filter((plugin) => plugin.state.lifecycle === 'degraded').length,
      quarantined: plugins.filter((plugin) => plugin.state.lifecycle === 'quarantined').length,
    },
  };
}

function synthesizeRegistrySnapshotFromRuntime(
  pluginName: string,
  activated: boolean,
  runtime?: PluginRuntimeStateSnapshot,
): PluginRegistryStateSnapshot {
  const validation = runtime?.loadState === 'quarantined'
    ? 'quarantined'
    : runtime?.loadState === 'degraded' ? 'degraded' : 'validated';
  return createPluginRegistryStateSnapshot({
    pluginName,
    discovery: 'discovered',
    validation,
    persistedEnabled: activated ? 'enabled' : 'disabled',
    failureReason: runtime?.failureReason,
  });
}

function mergeRuntimeSnapshots(
  pluginName: string,
  active: RuntimeSnapshotWithGeneration,
  draining: RuntimeSnapshotWithGeneration[],
): MergedRuntimeObservation {
  const loaded = draining.filter(({ snapshot }) => snapshot.loadState === 'loaded')
    .sort((left, right) => right.generation - left.generation);
  const serving = loaded[0];
  const drainingGenerations = loaded.map(({ generation }) => generation);
  if (active.snapshot.loadState === 'loaded') {
    return { snapshot: active.snapshot, servingGeneration: active.generation, drainingGenerations,
      servingScopes: active.snapshot.servingScopes, failedGeneration: null };
  }
  if (active.snapshot.loadState !== 'not-loaded') {
    return { snapshot: active.snapshot, servingGeneration: serving?.generation ?? null, drainingGenerations,
      servingScopes: serving?.snapshot.servingScopes ?? [], failedGeneration: active.generation };
  }
  const failure = draining.find(({ snapshot }) => snapshot.loadState !== 'not-loaded');
  if (failure) {
    return {
      snapshot: createPluginRuntimeStateSnapshot({ pluginName, loadState: failure.snapshot.loadState,
        servingScopes: [], failureReason: failure.snapshot.failureReason, failureCode: failure.snapshot.failureCode }),
      servingGeneration: serving?.generation ?? null,
      drainingGenerations,
      servingScopes: serving?.snapshot.servingScopes ?? [],
      failedGeneration: failure.generation,
    };
  }
  return { snapshot: active.snapshot, servingGeneration: null, drainingGenerations: [], servingScopes: [], failedGeneration: null };
}
