/**
 * Worker module
 * Main HTTP request handler with routing, failover, and plugin support
 */

import { logger } from './logger';
import { bodyStorageManager } from './logger/body-storage';
import { logCleanupService } from './logger/log-cleanup';
import { PluginRegistry } from './plugin-registry';
import type { AppConfig } from '@jeffusion/bungee-shared';
import type { Server } from 'bun';
import { loadConfig } from './config';
import { forEach, map } from 'lodash-es';

// ===== Import and re-export types from worker modules =====
export type { RuntimeUpstream, RequestSnapshot, UpstreamSelector } from './worker/types';

// ===== Import and re-export state management =====
export { runtimeState, initializeRuntimeState } from './worker/state/runtime-state';
export {
  getPluginRegistry,
  setPluginRegistry,
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
export async function startServer(config: AppConfig): Promise<Server> {
  const { initializeRuntimeState } = await import('./worker/state/runtime-state');
  const { setPluginRegistry } = await import('./worker/state/plugin-manager');
  const { handleRequest } = await import('./worker/request/handler');

  initializeRuntimeState(config);

  // 初始化 Plugin Registry
  const pluginRegistry = new PluginRegistry(process.cwd());
  setPluginRegistry(pluginRegistry);

  // 加载全局 plugins
  if (config.plugins && config.plugins.length > 0) {
    logger.info(`🔌 Loading ${config.plugins.length} global plugin(s)...`);
    await pluginRegistry.loadPlugins(config.plugins);
  }

  logger.info(`🚀 Reverse proxy server starting on port ${PORT}`);
  logger.info(`📋 Health check: http://localhost:${PORT}/health`);
  logger.info('\n📝 Configured routes:');
  forEach(config.routes, (route) => {
    const targets = map(route.upstreams, (up) => `${up.target} (w: ${up.weight}, p: ${up.priority || 1})`).join(', ');
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
  return server;
}

/**
 * Shutdown the worker server gracefully
 * Cleans up plugins and stops the HTTP server
 */
export async function shutdownServer(server: Server) {
  const { getPluginRegistry, setPluginRegistry } = await import('./worker/state/plugin-manager');

  logger.info('Shutting down server...');

  // 清理 plugins
  const pluginRegistry = getPluginRegistry();
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
    setPluginRegistry(null);
  }

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
        maxSize: config.logging.body.maxSize,
        retentionDays: config.logging.body.retentionDays,
      });
      logger.info({ bodyLogging: config.logging.body }, 'Body storage configured');
    }

    // 启动日志清理服务（仅在非 worker 模式，即主进程或单进程模式）
    if (process.env.BUNGEE_ROLE !== 'worker') {
      logCleanupService.start();
      logger.info('Log cleanup service started in worker process');
    }

    const server = await startServer(config);

    // Notify master that worker is ready
    if (process.send) {
      process.send({ status: 'ready', pid: process.pid });
    }

    // Listen for shutdown commands from master
    process.on('message', async (message: any) => {
      if (message && typeof message === 'object' && message.command === 'shutdown') {
        logger.info(`Worker #${workerId} received shutdown command. Initiating graceful shutdown...`);
        await shutdownServer(server);
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
