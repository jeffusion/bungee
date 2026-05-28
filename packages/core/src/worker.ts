/**
 * Worker module
 * Main HTTP request handler with routing, failover, and plugin support
 */

import { logger } from './logger';
import { bodyStorageManager } from './logger/body-storage';
import { logCleanupService } from './logger/log-cleanup';
import { initializePluginContextManager } from './plugin-context-manager';
import { accessLogWriter } from './logger/access-log-writer';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { Server } from 'bun';
import { loadConfig } from './config';
import { forEach, map } from 'lodash-es';
import type {
  PluginRuntimeWorkerMessage,
  PluginRuntimeWorkerReconcileCommand,
} from './plugin-runtime-multi-worker-convergence';
import { getPluginRuntimeOrchestrator } from './worker/state/plugin-manager';
import { resolveEffectiveRouteEndpoints } from './utils/endpoint-resolver';

// ===== Import and re-export types from worker modules =====
export type { RuntimeUpstream, RequestSnapshot, UpstreamSelector } from './worker/types';

// ===== Import and re-export state management =====
export { runtimeState, initializeRuntimeState } from './worker/state/runtime-state';
export {
  getPluginRegistry,
  setPluginRegistry,
  getPluginRuntimeOrchestrator,
  initializePluginRuntime,
  initializePluginRegistryForTests,
  cleanupPluginRegistry
} from './worker/state/plugin-manager';

// ===== Import and re-export core functions =====
export { handleRequest } from './worker/request/handler';
export { applyBodyRules, deepMergeRules } from './worker/rules/modifier';

// ===== Constants =====
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8088;

// ===== Server lifecycle functions =====

/**
 * Start the worker server
 * Initializes runtime state, plugin registry, and starts HTTP server
 */
export async function startServer(config: AppConfig): Promise<{
  server: Server<unknown>;
  pluginRuntimeGeneration: number;
}> {
  const { initializeRuntimeState } = await import('./worker/state/runtime-state');
  const { initializePluginRuntime } = await import('./worker/state/plugin-manager');
  const { handleRequest } = await import('./worker/request/handler');

  initializeRuntimeState(config);

  // 初始化 Plugin Context Manager（必须在加载插件之前）
  const db = accessLogWriter.getDatabase();
  initializePluginContextManager(db);
  logger.info('Plugin context manager initialized');

  logger.info('🔧 Initializing plugin runtime orchestrator...');
  const orchestratorResult = await initializePluginRuntime(config, {
    basePath: process.cwd(),
    db,
  });
  logger.info(
    {
      generation: orchestratorResult.generation,
      diff: orchestratorResult.diff,
      runtime: orchestratorResult.runtime,
    },
    '✅ Plugin runtime orchestrator initialized',
  );

  logger.info(`🚀 Reverse proxy server starting on port ${PORT}`);
  logger.info(`📋 Health check: http://localhost:${PORT}/health`);
  logger.info('\n📝 Configured routes:');
  forEach(config.routes, (route) => {
    const endpoints = resolveEffectiveRouteEndpoints(route, config.services);
    const targets = map(endpoints, (endpoint) => `${endpoint.target} (w: ${endpoint.weight}, p: ${endpoint.priority || 1})`).join(', ');
    logger.info(`  ${route.path} -> [${targets}]`);
  });
  logger.info('\n');

  const server = Bun.serve({
    port: PORT,
    reusePort: true,
    fetch: (req) => handleRequest(req, config),
    error(error: Error) {
      logger.fatal({ error }, 'A top-level server error occurred');
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
    },
  });
  return {
    server,
    pluginRuntimeGeneration: orchestratorResult.generation,
  };
}

/**
 * Shutdown the worker server gracefully
 * Cleans up plugins and stops the HTTP server
 */
export async function shutdownServer(server: Server<unknown>) {
  const { cleanupPluginRegistry } = await import('./worker/state/plugin-manager');

  logger.info('Shutting down server...');

  await cleanupPluginRegistry();

  server.stop(true);
  logger.info('Server has been shut down.');
  process.exit(0);
}

// --- Worker (Slave) Logic ---
async function startWorker() {
  try {
    // Get worker configuration from environment variables
    const workerId = process.env.WORKER_ID ? parseInt(process.env.WORKER_ID) : 0;
    const configPath = process.env.CONFIG_PATH;

    logger.info(`Worker #${workerId} starting with PID ${process.pid}`);

    const config = configPath ? await loadConfig(configPath) : await loadConfig();

    // 初始化 body 存储管理器配置
    if (config.logging?.body) {
      bodyStorageManager.updateConfig({
        enabled: config.logging.body.enabled,
        maxSize: config.logging.body.max_size,
        retentionDays: config.logging.body.retention_days,
      });
      logger.info({ bodyLogging: config.logging.body }, 'Body storage configured');
    }

    // 启动日志清理服务（仅在非 worker 模式，即主进程或单进程模式）
    if (process.env.BUNGEE_ROLE !== 'worker') {
      logCleanupService.start();
      logger.info('Log cleanup service started in worker process');
    }

    const { server, pluginRuntimeGeneration } = await startServer(config);

    // Notify master that worker is ready
    if (process.send) {
      const message: PluginRuntimeWorkerMessage = {
        status: 'ready',
        pid: process.pid,
        pluginRuntime: {
          generation: pluginRuntimeGeneration,
        },
      };
      process.send(message);
    }

    // Listen for shutdown commands from master
    process.on('message', async (message: any) => {
      if (message && typeof message === 'object' && message.command === 'shutdown') {
        logger.info(`Worker #${workerId} received shutdown command. Initiating graceful shutdown...`);
        await shutdownServer(server);
        return;
      }

      if (message && typeof message === 'object' && message.command === 'reconcile-plugin-runtime') {
        const reconcileCommand = message as PluginRuntimeWorkerReconcileCommand;
        logger.info(
          { workerId, generation: reconcileCommand.generation },
          'Worker received plugin runtime reconcile command',
        );

        try {
          const nextConfig = configPath ? await loadConfig(configPath) : await loadConfig();
          const { reconcilePluginRuntime } = await import('./worker/state/plugin-manager');
          const result = await reconcilePluginRuntime(nextConfig);

          if (process.send) {
            const reconcileMessage: PluginRuntimeWorkerMessage = {
              status: 'plugin-runtime-reconcile-complete',
              pid: process.pid,
              generation: reconcileCommand.generation,
              servingGeneration: result.generation,
            };
            process.send(reconcileMessage);
          }
        } catch (error) {
          logger.error(
            { error, workerId, generation: reconcileCommand.generation },
            'Worker failed to reconcile plugin runtime generation',
          );

          const servingGeneration = getPluginRuntimeOrchestrator()?.getStatusReport().generation ?? null;
          if (process.send) {
            const reconcileMessage: PluginRuntimeWorkerMessage = {
              status: 'plugin-runtime-reconcile-failed',
              pid: process.pid,
              generation: reconcileCommand.generation,
              servingGeneration,
              error: error instanceof Error ? error.message : String(error),
            };
            process.send(reconcileMessage);
          }
        }
      }
    });

    const handleSignal = async (signal: NodeJS.Signals) => {
      logger.info(`Worker #${workerId} received ${signal}. Initiating graceful shutdown...`);
      await shutdownServer(server);
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

  } catch (error) {
    logger.error({ error }, 'Worker failed to start');
    if (process.send) {
      process.send({ status: 'error', error: (error instanceof Error ? error.message : String(error)) });
    }
    process.exit(1);
  }
}

// Start worker if running as worker process
if (process.env.BUNGEE_ROLE === 'worker' || import.meta.main) {
  startWorker();
}
