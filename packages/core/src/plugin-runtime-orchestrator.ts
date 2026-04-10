import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { EditorModelCatalogCache } from './editor-model-catalog-cache';
import { logger } from './logger';
import { PluginRegistry } from './plugin-registry';
import {
  createPluginRegistryStateSnapshot,
  createPluginRuntimeStateSnapshot,
  freezePluginRuntimeState,
  type FrozenPluginRuntimeState,
  type PluginRegistryStateSnapshot,
  type PluginRuntimeStateSnapshot,
} from './plugin-runtime-state-machine';
import {
  ScopedPluginRegistry,
  destroyScopedPluginRegistry,
  getScopedPluginRegistry,
  setScopedPluginRegistry,
} from './scoped-plugin-registry';

export interface PluginRuntimeOrchestratorStatusEntry {
  pluginName: string;
  generation: number;
  state: FrozenPluginRuntimeState;
  sources: {
    registry: boolean;
    runtime: boolean;
  };
}

export interface PluginRuntimeOrchestratorStatusReport {
  generation: number;
  appliedAt: string | null;
  plugins: PluginRuntimeOrchestratorStatusEntry[];
  summary: {
    total: number;
    serving: number;
    disabled: number;
    degraded: number;
    quarantined: number;
  };
}

export interface PluginRuntimeOrchestratorDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface PluginRuntimeOrchestratorApplyResult {
  generation: number;
  diff: PluginRuntimeOrchestratorDiff;
  runtime: {
    success: number;
    failed: number;
  };
  status: PluginRuntimeOrchestratorStatusReport;
}

interface DrainingScopedRegistryEntry {
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

export class PluginRuntimeOrchestrator {
  private pluginRegistry: PluginRegistry | null = null;
  private scopedRegistry: ScopedPluginRegistry | null = null;
  private generation = 0;
  private appliedAt: number | null = null;
  private editorModelCatalogCache: EditorModelCatalogCache | null = null;
  private drainingScopedRegistries: DrainingScopedRegistryEntry[] = [];
  private pendingScopedRegistryDestroyers = new Set<Timer>();
  private lastStatus: PluginRuntimeOrchestratorStatusReport = {
    generation: 0,
    appliedAt: null,
    plugins: [],
    summary: {
      total: 0,
      serving: 0,
      disabled: 0,
      degraded: 0,
      quarantined: 0,
    },
  };

  constructor(
    private readonly configBasePath: string = process.cwd(),
    private readonly db?: Database,
  ) {
    this.editorModelCatalogCache = this.db ? new EditorModelCatalogCache(this.db) : null;
  }

  getPluginRegistry(): PluginRegistry | null {
    return this.pluginRegistry;
  }

  getScopedRegistry(): ScopedPluginRegistry | null {
    return this.scopedRegistry;
  }

  getEditorModelCatalogCache(): EditorModelCatalogCache | null {
    return this.editorModelCatalogCache;
  }

  getStatusReport(): PluginRuntimeOrchestratorStatusReport {
    if (this.pluginRegistry || this.scopedRegistry || this.drainingScopedRegistries.length > 0) {
      this.lastStatus = this.buildStatusReport();
    }

    return {
      ...this.lastStatus,
      plugins: this.lastStatus.plugins.map((plugin) => ({
        ...plugin,
        state: {
          ...plugin.state,
          authorities: { ...plugin.state.authorities },
          states: { ...plugin.state.states },
          runtime: {
            servingScopes: plugin.state.runtime.servingScopes.map((scope) => ({ ...scope })),
            currentGeneration: plugin.state.runtime.currentGeneration,
            servingGeneration: plugin.state.runtime.servingGeneration,
            drainingGenerations: [...plugin.state.runtime.drainingGenerations],
          },
          reasons: { ...plugin.state.reasons },
          failures: {
            validation: plugin.state.failures.validation ? { ...plugin.state.failures.validation } : undefined,
            runtime: plugin.state.failures.runtime ? { ...plugin.state.failures.runtime } : undefined,
          },
        },
        sources: { ...plugin.sources },
      })),
      summary: { ...this.lastStatus.summary },
    };
  }

  async applyConfig(config: AppConfig): Promise<PluginRuntimeOrchestratorApplyResult> {
    const previousStatus = this.getStatusReport();

    const previousPluginRegistry = this.pluginRegistry;
    const previousScopedRegistry = this.scopedRegistry ?? getScopedPluginRegistry();
    const nextPluginRegistry = new PluginRegistry(this.configBasePath, this.db);
    let nextScopedRegistry: ScopedPluginRegistry | null = null;

    try {
      logger.info('🔍 Orchestrator scanning plugin directories...');
      await nextPluginRegistry.scanAndLoadAllPlugins();

      const declaredPlugins = collectDeclaredPluginConfigs(config);
      if (declaredPlugins.length > 0) {
        logger.info({ declaredPlugins: declaredPlugins.length }, '🔄 Orchestrator reconciling declared plugin metadata');
        await nextPluginRegistry.loadPlugins(declaredPlugins);
      }

      const runtimeConfig = createRuntimeEligibleConfig(config, nextPluginRegistry);

      nextScopedRegistry = new ScopedPluginRegistry(this.configBasePath);
      const runtimeResult = await nextScopedRegistry.initializeFromConfig(runtimeConfig);

      setScopedPluginRegistry(nextScopedRegistry);
      this.pluginRegistry = nextPluginRegistry;
      this.scopedRegistry = nextScopedRegistry;

      if (previousPluginRegistry) {
        await previousPluginRegistry.unloadAll();
      }

        if (previousScopedRegistry && previousScopedRegistry !== nextScopedRegistry) {
          this.scheduleScopedRegistryDestroy(
            previousScopedRegistry,
            previousStatus.generation,
            previousScopedRegistry.getHotReloadDestroyDelayMs(),
          );
        }

      this.generation += 1;
      this.appliedAt = Date.now();
      this.lastStatus = this.buildStatusReport();

      const diff = diffStatusReports(previousStatus, this.lastStatus);
      logger.info(
        {
          generation: this.generation,
          diff,
          runtimeResult,
          statusSummary: this.lastStatus.summary,
          pluginFailures: summarizePluginFailures(this.lastStatus),
        },
        'Plugin runtime orchestrator applied config',
      );

      return {
        generation: this.generation,
        diff,
        runtime: runtimeResult,
        status: this.getStatusReport(),
      };
    } catch (error) {
      if (nextScopedRegistry) {
        await nextScopedRegistry.destroy();
      }
      await nextPluginRegistry.unloadAll();
      throw error;
    }
  }

  async destroy(): Promise<void> {
    for (const destroyer of this.pendingScopedRegistryDestroyers) {
      clearTimeout(destroyer);
    }
    this.pendingScopedRegistryDestroyers.clear();
    this.drainingScopedRegistries = [];

    await this.resetRuntime();
    this.lastStatus = {
      generation: this.generation,
      appliedAt: this.appliedAt ? new Date(this.appliedAt).toISOString() : null,
      plugins: [],
      summary: {
        total: 0,
        serving: 0,
        disabled: 0,
        degraded: 0,
        quarantined: 0,
      },
    };
  }

  private async resetRuntime(): Promise<void> {
    if (getScopedPluginRegistry()) {
      await destroyScopedPluginRegistry();
    } else if (this.scopedRegistry) {
      await this.scopedRegistry.destroy();
      setScopedPluginRegistry(null);
    }

    if (this.pluginRegistry) {
      await this.pluginRegistry.unloadAll();
      this.pluginRegistry = null;
    }

    this.scopedRegistry = null;
  }

  private scheduleScopedRegistryDestroy(registry: ScopedPluginRegistry, generation: number, delayMs: number): void {
    this.drainingScopedRegistries.push({ registry, generation });

    const destroyer = setTimeout(async () => {
      this.pendingScopedRegistryDestroyers.delete(destroyer);

      try {
        await registry.destroy();
        this.drainingScopedRegistries = this.drainingScopedRegistries
          .filter((entry) => entry.registry !== registry);
      } catch (error) {
        logger.error({ error }, 'Failed to destroy previous scoped plugin registry after reconcile');
      }
    }, Math.max(0, delayMs));

    this.pendingScopedRegistryDestroyers.add(destroyer);
  }

  private buildStatusReport(): PluginRuntimeOrchestratorStatusReport {
    const registrySnapshots = this.pluginRegistry?.getAllPluginStateSnapshots() ?? new Map<string, PluginRegistryStateSnapshot>();
    const runtimeSnapshots = this.scopedRegistry?.getAllPluginRuntimeStateSnapshots() ?? new Map<string, PluginRuntimeStateSnapshot>();
    const drainingRuntimeSnapshots = this.drainingScopedRegistries
      .map(({ generation, registry }) => ({
        generation,
        snapshots: registry.getAllPluginRuntimeStateSnapshots(),
      }));
    const pluginNames = new Set<string>([
      ...registrySnapshots.keys(),
      ...runtimeSnapshots.keys(),
      ...drainingRuntimeSnapshots.flatMap(({ snapshots }) => Array.from(snapshots.keys())),
    ]);

    const plugins = Array.from(pluginNames)
      .sort((left, right) => left.localeCompare(right))
      .map((pluginName) => {
        const runtimeSnapshot = mergeRuntimeSnapshots(
          pluginName,
          {
            generation: this.generation,
            snapshot: runtimeSnapshots.get(pluginName) ?? createPluginRuntimeStateSnapshot({ pluginName }),
          },
          drainingRuntimeSnapshots
            .map(({ generation, snapshots }) => {
              const snapshot = snapshots.get(pluginName);
              return snapshot ? { generation, snapshot } : null;
            })
            .filter((snapshot): snapshot is RuntimeSnapshotWithGeneration => Boolean(snapshot)),
        );
        const registrySnapshot = registrySnapshots.get(pluginName)
          ?? synthesizeRegistrySnapshotFromRuntime(pluginName, runtimeSnapshot.snapshot);

        return {
          pluginName,
          generation: this.generation,
          state: freezePluginRuntimeState(registrySnapshot, runtimeSnapshot.snapshot, {
            currentGeneration: this.generation,
            servingGeneration: runtimeSnapshot.servingGeneration,
            drainingGenerations: runtimeSnapshot.drainingGenerations,
            servingScopes: runtimeSnapshot.servingScopes,
            failedGeneration: runtimeSnapshot.failedGeneration,
          }),
          sources: {
            registry: registrySnapshots.has(pluginName),
            runtime: runtimeSnapshot.snapshot.loadState !== 'not-loaded'
              || runtimeSnapshot.servingScopes.length > 0,
          },
        } satisfies PluginRuntimeOrchestratorStatusEntry;
      });

    return {
      generation: this.generation,
      appliedAt: this.appliedAt ? new Date(this.appliedAt).toISOString() : null,
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
}

function createRuntimeEligibleConfig(config: AppConfig, registry: PluginRegistry): AppConfig {
  const isRuntimeEligible = (pluginConfig: PluginConfig | string): boolean => {
    const normalized = typeof pluginConfig === 'string'
      ? { name: pluginConfig, enabled: true }
      : {
        ...pluginConfig,
        enabled: pluginConfig.enabled ?? true,
      };
    const pluginName = normalized.name;
    if (!pluginName || normalized.enabled === false) {
      return false;
    }

    const snapshot = registry.getPluginStateSnapshot(pluginName);
    if (!snapshot) {
      return true;
    }

    return snapshot.validation === 'validated' && snapshot.persistedEnabled === 'enabled';
  };

  return {
    ...config,
    plugins: (config.plugins || []).filter(isRuntimeEligible),
    routes: (config.routes || []).map((route) => ({
      ...route,
      plugins: (route.plugins || []).filter(isRuntimeEligible),
      upstreams: (route.upstreams || []).map((upstream) => ({
        ...upstream,
        plugins: (upstream.plugins || []).filter(isRuntimeEligible),
      })),
    })),
  };
}

function collectDeclaredPluginConfigs(config: AppConfig): PluginConfig[] {
  const deduped = new Map<string, PluginConfig>();

  const addPluginConfig = (pluginConfig: PluginConfig | string) => {
    const normalized = typeof pluginConfig === 'string'
      ? { name: pluginConfig, enabled: true }
      : {
        ...pluginConfig,
        enabled: pluginConfig.enabled ?? true,
      };
    const key = `${normalized.name || 'unknown'}::${normalized.path || ''}`;
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  };

  for (const pluginConfig of config.plugins || []) {
    addPluginConfig(pluginConfig);
  }

  for (const route of config.routes || []) {
    for (const pluginConfig of route.plugins || []) {
      addPluginConfig(pluginConfig);
    }

    for (const upstream of route.upstreams || []) {
      for (const pluginConfig of upstream.plugins || []) {
        addPluginConfig(pluginConfig);
      }
    }
  }

  return Array.from(deduped.values());
}

function synthesizeRegistrySnapshotFromRuntime(
  pluginName: string,
  runtimeSnapshot?: PluginRuntimeStateSnapshot,
): PluginRegistryStateSnapshot {
  const validation = runtimeSnapshot?.loadState === 'quarantined'
    ? 'quarantined'
    : runtimeSnapshot?.loadState === 'degraded'
      ? 'degraded'
      : 'validated';
  const persistedEnabled = runtimeSnapshot && runtimeSnapshot.loadState !== 'not-loaded'
    ? 'enabled'
    : 'unknown';

  return createPluginRegistryStateSnapshot({
    pluginName,
    discovery: 'discovered',
    validation,
    persistedEnabled,
    failureReason: runtimeSnapshot?.failureReason,
  });
}

function mergeRuntimeSnapshots(
  pluginName: string,
  activeSnapshot: RuntimeSnapshotWithGeneration,
  drainingSnapshots: RuntimeSnapshotWithGeneration[] = [],
): MergedRuntimeObservation {
  const loadedDrainingSnapshots = drainingSnapshots
    .filter(({ snapshot }) => snapshot.loadState === 'loaded')
    .sort((left, right) => right.generation - left.generation);
  const loadedDrainingSnapshot = loadedDrainingSnapshots[0];
  const drainingGenerations = loadedDrainingSnapshots.map(({ generation }) => generation);

  if (activeSnapshot.snapshot.loadState === 'loaded') {
    return {
      snapshot: activeSnapshot.snapshot,
      servingGeneration: activeSnapshot.generation,
      drainingGenerations,
      servingScopes: activeSnapshot.snapshot.servingScopes,
      failedGeneration: null,
    };
  }

  if (activeSnapshot.snapshot.loadState !== 'not-loaded') {
    return {
      snapshot: activeSnapshot.snapshot,
      servingGeneration: loadedDrainingSnapshot?.generation ?? null,
      drainingGenerations,
      servingScopes: loadedDrainingSnapshot?.snapshot.servingScopes ?? [],
      failedGeneration: activeSnapshot.generation,
    };
  }

  const drainingFailure = drainingSnapshots.find(({ snapshot }) => snapshot.loadState !== 'not-loaded');
  if (drainingFailure) {
    return {
      snapshot: createPluginRuntimeStateSnapshot({
        pluginName,
        loadState: drainingFailure.snapshot.loadState,
        servingScopes: [],
        failureReason: drainingFailure.snapshot.failureReason,
        failureCode: drainingFailure.snapshot.failureCode,
      }),
      servingGeneration: loadedDrainingSnapshot?.generation ?? null,
      drainingGenerations,
      servingScopes: loadedDrainingSnapshot?.snapshot.servingScopes ?? [],
      failedGeneration: drainingFailure.generation,
    };
  }

  return {
    snapshot: activeSnapshot.snapshot,
    servingGeneration: null,
    drainingGenerations: [],
    servingScopes: [],
    failedGeneration: null,
  };
}

function diffStatusReports(
  previousStatus: PluginRuntimeOrchestratorStatusReport,
  nextStatus: PluginRuntimeOrchestratorStatusReport,
): PluginRuntimeOrchestratorDiff {
  const previousPlugins = new Map(previousStatus.plugins.map((plugin) => [plugin.pluginName, plugin]));
  const nextPlugins = new Map(nextStatus.plugins.map((plugin) => [plugin.pluginName, plugin]));

  const added = Array.from(nextPlugins.keys()).filter((pluginName) => !previousPlugins.has(pluginName));
  const removed = Array.from(previousPlugins.keys()).filter((pluginName) => !nextPlugins.has(pluginName));
  const changed = Array.from(nextPlugins.entries())
    .filter(([pluginName, nextPlugin]) => {
      const previousPlugin = previousPlugins.get(pluginName);
      if (!previousPlugin) {
        return false;
      }

      return serializeComparableState(previousPlugin) !== serializeComparableState(nextPlugin);
    })
    .map(([pluginName]) => pluginName);

  return { added, removed, changed };
}

function serializeComparableState(plugin: PluginRuntimeOrchestratorStatusEntry): string {
  return JSON.stringify({
    lifecycle: plugin.state.lifecycle,
    states: plugin.state.states,
    runtime: plugin.state.runtime,
    reasons: plugin.state.reasons,
    failures: plugin.state.failures,
    sources: plugin.sources,
  });
}

function summarizePluginFailures(status: PluginRuntimeOrchestratorStatusReport) {
  return status.plugins
    .filter((plugin) => plugin.state.failures.validation || plugin.state.failures.runtime)
    .map((plugin) => ({
      pluginName: plugin.pluginName,
      currentGeneration: plugin.state.runtime.currentGeneration,
      servingGeneration: plugin.state.runtime.servingGeneration,
      drainingGenerations: plugin.state.runtime.drainingGenerations,
      validationFailure: plugin.state.failures.validation,
      runtimeFailure: plugin.state.failures.runtime,
    }));
}
