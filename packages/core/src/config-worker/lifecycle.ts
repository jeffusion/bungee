import type { AppConfig } from '@jeffusion/bungee-types';
import type { Server } from 'bun';
import {
  ConfigWorkerLifecycleReadinessError,
  type ConfigWorkerLifecycle,
} from '../config-publication/worker-runtime-contract';
import { derivePluginReadiness, requiredPluginNames } from '../config-publication/worker-runtime-plugins';
import type { StartWorkerCommand } from '../config-publication/types';
import type { PluginRuntimeOrchestratorStatusReport } from '../plugin-runtime-orchestrator';
import { parseWorkerTransportSecret, restoreWorkerTransportRequest } from './private-transport';

type LifecycleServer = Pick<Server<unknown>, 'port' | 'stop'>;

export type ConfigWorkerServingHandle = {
  readonly server: LifecycleServer;
  readonly cleanup: () => Promise<void>;
  drainPromise: Promise<void> | null;
  drainComplete: boolean;
  stopped: boolean;
};

type LifecycleFetch = (request: Request) => Response | Promise<Response>;

export type ServingRequestContext = {
  readonly servingRevision: number;
};

export type ProductionResources = {
  configureBodyStorage(config: AppConfig): void;
  initializeRuntimeState(config: AppConfig): void;
  cleanupRuntimeState(): void;
  setServingConfig(config: AppConfig, activatedPluginNames: readonly string[]): void;
  clearServingConfig(): void;
  initializePluginContext(): void;
  cleanupPluginContexts(): Promise<void>;
  initializePluginRuntime(config: AppConfig, activatedPluginNames: readonly string[]): Promise<{
    generation: number;
    status: PluginRuntimeOrchestratorStatusReport;
  }>;
  cleanupPluginRuntime(): Promise<void>;
  handleRequest(request: Request, config: AppConfig, context: ServingRequestContext): Promise<Response>;
  serve(fetch: LifecycleFetch): LifecycleServer;
  closeAccessLog(): Promise<void>;
  closeFileLog(): Promise<void>;
};

export type ConfigWorkerLifecycleOptions = {
  readonly transportSecret: string;
  readonly loadResources?: () => Promise<ProductionResources>;
};

async function cleanupAll(resources: ProductionResources): Promise<void> {
  const errors: unknown[] = [];
  const operations = [
    () => resources.cleanupPluginRuntime(),
    () => resources.cleanupPluginContexts(),
    () => Promise.resolve().then(() => resources.cleanupRuntimeState()),
    () => Promise.resolve().then(() => resources.clearServingConfig()),
    () => resources.closeAccessLog(),
    () => resources.closeFileLog(),
  ];
  for (const operation of operations) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'config worker cleanup failed');
}

export function createConfigWorkerLifecycle(
  options: ConfigWorkerLifecycleOptions,
): ConfigWorkerLifecycle<ConfigWorkerServingHandle> {
  const transportSecret = parseWorkerTransportSecret(options.transportSecret);
  const loadResources = options.loadResources ?? loadProductionResources;
  return {
    async start(config: AppConfig, command: StartWorkerCommand) {
      const resources = await loadResources();
      let cleanupPromise: Promise<void> | null = null;
      const cleanup = () => cleanupPromise ??= cleanupAll(resources);
      let server: LifecycleServer | null = null;
      try {
        resources.configureBodyStorage(config);
        resources.initializeRuntimeState(config);
        resources.setServingConfig(config, command.activated_plugin_names);
        resources.initializePluginContext();
        const pluginRuntime = await resources.initializePluginRuntime(config, command.activated_plugin_names);
        const readiness = derivePluginReadiness(
          requiredPluginNames(config),
          pluginRuntime.generation,
          pluginRuntime.status,
        );
        if (readiness.failed.length > 0) {
          throw new ConfigWorkerLifecycleReadinessError(readiness.failed);
        }
        server = resources.serve(async (request) => {
          const restored = restoreWorkerTransportRequest(request, transportSecret);
          if (!restored.ok) return new Response(null, { status: restored.status });
          return resources.handleRequest(restored.request, config, {
            servingRevision: command.revision,
          });
        });
        const boundPort = server.port;
        if (!Number.isSafeInteger(boundPort) || boundPort === undefined || boundPort <= 0) {
          throw new Error('Bun server did not bind a positive port');
        }
        return {
          handle: {
            server,
            cleanup,
            drainPromise: null,
            drainComplete: false,
            stopped: false,
          },
          private_port: boundPort,
          plugin_runtime_generation: pluginRuntime.generation,
          plugin_status: pluginRuntime.status,
        };
      } catch (error) {
        const failures: unknown[] = [error];
        if (server !== null) {
          try { await server.stop(true); } catch (stopError) { failures.push(stopError); }
        }
        try {
          await cleanup();
        } catch (cleanupError) {
          if (cleanupError instanceof AggregateError) failures.push(...cleanupError.errors);
          else failures.push(cleanupError);
        }
        if (failures.length > 1) throw new AggregateError(failures, 'config worker start failed');
        throw error;
      }
    },
    async stopAccepting(handle) {
      if (handle.drainPromise !== null || handle.stopped) return;
      handle.drainPromise = handle.server.stop(false).then(() => {
        handle.drainComplete = true;
      });
    },
    async drain(handle) {
      await handle.drainPromise;
    },
    async stop(handle) {
      if (handle.stopped) return;
      handle.stopped = true;
      let stopError: unknown;
      if (!handle.drainComplete) {
        try { await handle.server.stop(true); } catch (error) { stopError = error; }
      }
      try {
        await handle.cleanup();
      } catch (cleanupError) {
        if (stopError !== undefined) {
          throw new AggregateError([stopError, cleanupError], 'config worker stop failed');
        }
        throw cleanupError;
      }
      if (stopError !== undefined) throw stopError;
    },
  };
}

export async function loadProductionResources(): Promise<ProductionResources> {
  const bodyStorage = await import('../logger/body-storage');
  const runtimeState = await import('../worker/state/runtime-state');
  const serving = await import('../api/serving-config');
  const accessLogs = await import('../logger/access-log-writer');
  const pluginContexts = await import('../plugin-context-manager');
  const pluginRuntime = await import('../worker/state/plugin-manager');
  const requestHandler = await import('../worker/request/handler');
  const fileLogs = await import('../logger/file-log-writer');
  return {
    configureBodyStorage(config) {
      const body = config.logging?.body;
      const current = bodyStorage.bodyStorageManager.getConfig();
      bodyStorage.bodyStorageManager.updateConfig({
        enabled: body?.enabled ?? false,
        maxSize: body?.max_size ?? current.maxSize,
        retentionDays: body?.retention_days ?? current.retentionDays,
      });
    },
    initializeRuntimeState: runtimeState.initializeRuntimeState,
    cleanupRuntimeState: runtimeState.cleanupRuntimeState,
    setServingConfig: serving.setServingConfig,
    clearServingConfig: serving.clearServingConfig,
    initializePluginContext() {
      pluginContexts.initializePluginContextManager(accessLogs.accessLogWriter.getDatabase());
    },
    async cleanupPluginContexts() {
      if (pluginContexts.isPluginContextManagerInitialized()) {
        await pluginContexts.getPluginContextManager().destroyAll();
      }
    },
    async initializePluginRuntime(config, activatedPluginNames) {
      const result = await pluginRuntime.initializePluginRuntime(config, {
        basePath: process.cwd(),
        db: accessLogs.accessLogWriter.getDatabase(),
        activatedPluginNames,
      });
      return { generation: result.generation, status: result.status };
    },
    cleanupPluginRuntime: pluginRuntime.cleanupPluginRegistry,
    handleRequest(request, config, context) {
      return (requestHandler.handleRequest as unknown as (
        request: Request, config: AppConfig, context: ServingRequestContext,
      ) => Promise<Response>)(request, config, context);
    },
    serve(fetch) {
      return Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        reusePort: false,
        fetch,
      });
    },
    closeAccessLog: () => accessLogs.accessLogWriter.close(),
    closeFileLog: () => fileLogs.fileLogWriter.close(),
  };
}
