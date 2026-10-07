import type { AppConfig } from '@jeffusion/bungee-types';
import type { Server } from 'bun';
import {
  ConfigWorkerLifecycleReadinessError,
  type ConfigWorkerLifecycle,
} from '../config-publication/worker-runtime-contract';
import { derivePluginReadiness, requiredPluginNames } from '../config-publication/worker-runtime-plugins';
import type { StartWorkerCommand } from '../config-publication/types';
import type { PluginRuntimeOrchestratorStatusReport } from '../plugin-runtime-orchestrator';
import type { RequestLoggerDependencies } from '../logger/request-logger';
import { parseWorkerTransportSecret, restoreWorkerTransportRequest } from './private-transport';
import type { PluginServiceHost } from '../plugin-services';

type LifecycleServer = Pick<Server<unknown>, 'port' | 'stop'>;

export type ConfigWorkerServingHandle = {
  readonly server: LifecycleServer;
  readonly cleanup: () => Promise<void>;
  drainPromise: Promise<void> | null;
  drainComplete: boolean;
  stopped: boolean;
  forceStopped: boolean;
  stopPromise: Promise<void> | null;
};

type LifecycleFetch = (request: Request) => Response | Promise<Response>;

export type ServingRequestContext = {
  readonly servingRevision: number;
  readonly logging?: RequestLoggerDependencies;
};

export type ProductionResources = {
  configureBodyStorage(config: AppConfig): void;
  initializeRuntimeState(config: AppConfig): void;
  cleanupRuntimeState(): void;
  readonly requestLogging?: RequestLoggerDependencies;
  initializePluginContext(): void;
  cleanupPluginContexts(): Promise<void>;
  initializePluginRuntime(config: AppConfig, activatedPluginNames: readonly string[], services?: PluginServiceHost, beforeBootstrap?: (signal: AbortSignal) => Promise<void>): Promise<{
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
  /**
   * Canonical worker-process service host (peer-communication enabled) shared
   * with the plugin runtime, so worker plugins reach control services through
   * the same owner/lifecycle/lease registry as every other consumer.
   */
  readonly services?: PluginServiceHost;
  /**
   * Observed before plugin initialization, so a peer/routing layer can pin the
   * exact applied start target (catalog hash) before any plugin runs.
   */
  readonly onStartTarget?: (command: StartWorkerCommand) => void;
  /**
   * Real, bounded startup gate awaited BEFORE plugin initialization: the peer
   * transport must be authenticated and attached, instead of relying on a scan
   * delay that happened to be enough.
   */
  readonly awaitPeerReady?: (signal: AbortSignal) => Promise<void>;
  /**
   * Host gate awaited by the plugin registry itself: after the dependency graph
   * is updated and before any plugin handler is created. The worker runtime
   * wires it to the real publication-directory load.
   */
  readonly beforeBootstrap?: (signal: AbortSignal) => Promise<void>;
  /**
   * Wired to the real drain admission point: no new peer/bootstrap/background
   * work is admitted from here on, while every already-accepted lease and
   * terminal keeps draining.
   */
  readonly onDrainStart?: () => void;
};

async function cleanupAll(resources: ProductionResources): Promise<void> {
  const errors: unknown[] = [];
  const operations = [
    () => resources.cleanupPluginRuntime(),
    () => resources.cleanupPluginContexts(),
    () => Promise.resolve().then(() => resources.cleanupRuntimeState()),
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
        resources.initializePluginContext();
        options.onStartTarget?.(command);
        // Real gate, bounded and cancelable: the authenticated peer transport
        // must be attached before any plugin can consume a remote service.
        if (options.awaitPeerReady !== undefined) {
          const startup = new AbortController();
          try { await options.awaitPeerReady(startup.signal); }
          finally { startup.abort('config worker plugin initialization finished'); }
        }
        const pluginRuntime = await resources.initializePluginRuntime(
          config, command.activated_plugin_names, options.services, options.beforeBootstrap,
        );
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
            logging: resources.requestLogging,
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
            forceStopped: false,
            stopPromise: null,
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
      // Real drain admission point: retire peer admission and every host owner
      // synchronously, BEFORE the HTTP drain window starts, so no new
      // background/bootstrap work can be admitted while old leases drain.
      try { options.onDrainStart?.(); } catch { /* retirement is best-effort; the drain still proceeds */ }
      handle.drainPromise = handle.server.stop(false).then(() => {
        handle.drainComplete = true;
      });
    },
    async drain(handle) {
      await handle.drainPromise;
    },
    async forceStop(handle) {
      if (!handle.stopped && !handle.drainComplete && !handle.forceStopped) {
        await handle.server.stop(true);
        handle.forceStopped = true;
      }
    },
    async stop(handle) {
      if (handle.stopped) return;
      if (handle.stopPromise !== null) return handle.stopPromise;
      handle.stopPromise = (async () => {
        let stopError: unknown;
        if (!handle.drainComplete && !handle.forceStopped) {
          try {
            await handle.server.stop(true);
            handle.forceStopped = true;
          } catch (error) { stopError = error; }
        }
        try {
          await handle.cleanup();
        } catch (cleanupError) {
          if (stopError !== undefined) throw new AggregateError([stopError, cleanupError], 'config worker stop failed');
          throw cleanupError;
        }
        if (stopError !== undefined) throw stopError;
        handle.stopped = true;
      })();
      return handle.stopPromise;
    },
  };
}

export async function loadProductionResources(): Promise<ProductionResources> {
  const { BodyStorageManager } = await import('../logger/body-storage');
  const { HeaderStorageManager } = await import('../logger/header-storage');
  const { AccessLogWriter } = await import('../logger/access-log-writer');
  const { FileLogWriter } = await import('../logger/file-log-writer');
  const runtimeState = await import('../worker/state/runtime-state');
  const pluginContexts = await import('../plugin-context-manager');
  const pluginRuntime = await import('../worker/state/plugin-manager');
  const requestHandler = await import('../worker/request/handler');
  const accessLogWriter = new AccessLogWriter(
    process.env.BUNGEE_ACCESS_DB_PATH ?? `${process.cwd()}/logs/access.db`,
  );
  const bodyStorage = new BodyStorageManager({}, process.env.BUNGEE_BODY_LOG_DIR);
  const headerStorage = new HeaderStorageManager({}, process.env.BUNGEE_HEADER_LOG_DIR);
  const fileLogWriter = new FileLogWriter(process.env.BUNGEE_FILE_LOG_DIR);
  return {
    requestLogging: { accessLogWriter, fileLogWriter, bodyStorage, headerStorage },
    configureBodyStorage(config) {
      const body = config.logging?.body;
      const current = bodyStorage.getConfig();
      bodyStorage.updateConfig({
        enabled: body?.enabled ?? false,
        maxSize: body?.max_size ?? current.maxSize,
        retentionDays: body?.retention_days ?? current.retentionDays,
      });
    },
    initializeRuntimeState: runtimeState.initializeRuntimeState,
    cleanupRuntimeState: runtimeState.cleanupRuntimeState,
    initializePluginContext() {
      pluginContexts.initializePluginContextManager(accessLogWriter.getDatabase());
    },
    async cleanupPluginContexts() {
      if (pluginContexts.isPluginContextManagerInitialized()) {
        await pluginContexts.getPluginContextManager().destroyAll();
      }
    },
    async initializePluginRuntime(config, activatedPluginNames, services, beforeBootstrap) {
      const result = await pluginRuntime.initializePluginRuntime(config, {
        basePath: process.cwd(),
        db: accessLogWriter.getDatabase(),
        activatedPluginNames,
        ...(services === undefined ? {} : { services }),
        ...(beforeBootstrap === undefined ? {} : { beforeBootstrap }),
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
        idleTimeout: 0,
        // Enforce the serving config in handleRequest so 413 responses and their
        // reasons pass through normal request logging, including chunked bodies.
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        fetch,
      });
    },
    closeAccessLog: async () => {
      const { flushBodyCaptures } = await import('../logger/body-capture');
      await flushBodyCaptures();
      await accessLogWriter.close();
    },
    closeFileLog: () => fileLogWriter.close(),
  };
}
