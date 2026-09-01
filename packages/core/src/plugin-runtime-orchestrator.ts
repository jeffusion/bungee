import type { AppConfig } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { logger } from './logger';
import { PluginRegistry } from './plugin-registry';
import {
  ScopedPluginRegistry,
  destroyScopedPluginRegistry,
  getScopedPluginRegistry,
  setScopedPluginRegistry,
} from './scoped-plugin-registry';
import { collectDeclaredPluginConfigs, createRuntimeEligibleConfig } from './plugin-runtime-config';
import { diffStatusReports, summarizePluginFailures, type PluginRuntimeOrchestratorDiff } from './plugin-runtime-diff';
import {
  buildPluginRuntimeStatusReport,
  type DrainingScopedRegistryEntry,
  type PluginRuntimeOrchestratorStatusReport,
} from './plugin-runtime-status';

export type { PluginRuntimeOrchestratorDiff } from './plugin-runtime-diff';
export type { PluginRuntimeOrchestratorStatusEntry, PluginRuntimeOrchestratorStatusReport } from './plugin-runtime-status';

export interface PluginRuntimeOrchestratorApplyResult {
  generation: number;
  diff: PluginRuntimeOrchestratorDiff;
  runtime: {
    success: number;
    failed: number;
  };
  status: PluginRuntimeOrchestratorStatusReport;
}

export class PluginRuntimeOrchestrator {
  private pluginRegistry: PluginRegistry | null = null;
  private scopedRegistry: ScopedPluginRegistry | null = null;
  private generation = 0;
  private appliedAt: number | null = null;
  private drainingScopedRegistries: DrainingScopedRegistryEntry[] = [];
  private pendingScopedRegistryDestroyers = new Set<Timer>();
  private readonly activatedPluginNames: ReadonlySet<string>;
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
    activatedPluginNames: readonly string[] = [],
  ) {
    this.activatedPluginNames = new Set(activatedPluginNames);
  }

  getPluginRegistry(): PluginRegistry | null {
    return this.pluginRegistry;
  }

  getScopedRegistry(): ScopedPluginRegistry | null {
    return this.scopedRegistry;
  }

  getDatabase(): Database | undefined {
    return this.db;
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
    const nextPluginRegistry = new PluginRegistry(this.configBasePath, this.activatedPluginNames);
    let nextScopedRegistry: ScopedPluginRegistry | null = null;

    try {
      logger.info('🔍 Orchestrator scanning plugin directories...');
      await nextPluginRegistry.scanAndLoadAllPlugins();

      const declaredPlugins = collectDeclaredPluginConfigs(config);
      if (declaredPlugins.length > 0) {
        logger.info({ declaredPlugins: declaredPlugins.length }, '🔄 Orchestrator reconciling declared plugin metadata');
        await nextPluginRegistry.loadPlugins(declaredPlugins);
      }

      const runtimeConfig = createRuntimeEligibleConfig(config, nextPluginRegistry, this.activatedPluginNames);

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
    return buildPluginRuntimeStatusReport(
      this.pluginRegistry,
      this.scopedRegistry,
      this.drainingScopedRegistries,
      this.generation,
      this.appliedAt,
      this.activatedPluginNames,
    );
  }
}
