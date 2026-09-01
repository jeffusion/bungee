/**
 * Global plugin registry management
 *
 * 管理两个独立的插件注册表：
 *
 * 1. PluginRegistry（元数据管理）
 *    - 用途：UI 元数据管理与插件发现
 *    - 不执行插件，只管理插件类信息
 *
 * 2. ScopedPluginRegistry（插件执行）
 *    - 用途：创建 Handler 实例、预编译 Hooks、实际执行插件
 *    - 支持三级作用域：global、route、upstream
 */

import { logger } from '../../logger';
import { PluginRegistry } from '../../plugin-registry';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import {
  PluginRuntimeOrchestrator,
  type PluginRuntimeOrchestratorApplyResult,
} from '../../plugin-runtime-orchestrator';
import { collectDeclaredPluginConfigs } from '../../plugin-runtime-config';
import type {
  PluginRuntimeConvergenceStatusReport,
  PluginRuntimeClusterReconcileResultMessage,
} from '../../plugin-runtime-multi-worker-convergence';

/**
 * Global plugin registry instance
 * Null when not initialized
 */
let pluginRegistry: PluginRegistry | null = null;
let pluginRuntimeOrchestrator: PluginRuntimeOrchestrator | null = null;
let lastPluginRuntimeReconcileResult: PluginRuntimeOrchestratorApplyResult | null = null;

/**
 * Gets the current plugin registry instance
 *
 * @returns Plugin registry instance or null if not initialized
 *
 * @example
 * ```typescript
 * const registry = getPluginRegistry();
 * if (registry) {
 *   const metadata = registry.getAllPluginsMetadata();
 * }
 * ```
 */
export function getPluginRegistry(): PluginRegistry | null {
  return pluginRegistry;
}

/**
 * Sets the plugin registry instance
 *
 * **Note:** This function is for internal use only.
 * External code should use `initializePluginRegistryForTests()` instead.
 *
 * @param registry - Plugin registry instance to set
 * @internal
 */
export function setPluginRegistry(registry: PluginRegistry | null): void {
  pluginRegistry = registry;
}

export function getPluginRuntimeOrchestrator(): PluginRuntimeOrchestrator | null {
  return pluginRuntimeOrchestrator;
}

export async function initializePluginRuntime(
  config: AppConfig,
  options: {
    basePath?: string;
    db?: Database;
    activatedPluginNames?: readonly string[];
  } = {},
): Promise<PluginRuntimeOrchestratorApplyResult> {
  await cleanupPluginRegistry();

  pluginRuntimeOrchestrator = new PluginRuntimeOrchestrator(
    options.basePath ?? process.cwd(),
    options.db,
    options.activatedPluginNames ?? [],
  );

  const result = await pluginRuntimeOrchestrator.applyConfig(config);
  pluginRegistry = pluginRuntimeOrchestrator.getPluginRegistry();
  lastPluginRuntimeReconcileResult = result;

  logger.debug({ generation: result.generation }, 'Plugin runtime initialized via orchestrator');
  return result;
}

export async function reconcilePluginRuntime(
  config: AppConfig,
): Promise<PluginRuntimeOrchestratorApplyResult> {
  if (!pluginRuntimeOrchestrator) {
    throw new Error('Plugin runtime orchestrator not initialized');
  }

  const result = await pluginRuntimeOrchestrator.applyConfig(config);
  pluginRegistry = pluginRuntimeOrchestrator.getPluginRegistry();
  lastPluginRuntimeReconcileResult = result;

  logger.debug({ generation: result.generation }, 'Plugin runtime reconciled via orchestrator');
  return result;
}

export async function reconcilePluginRuntimeAcrossWorkers(
  config: AppConfig,
): Promise<{
  result: PluginRuntimeOrchestratorApplyResult;
  convergence: PluginRuntimeConvergenceStatusReport | null;
}> {
  if (process.env.BUNGEE_ROLE !== 'worker' || !process.send) {
    return {
      result: await reconcilePluginRuntime(config),
      convergence: null,
    };
  }

  const convergence = await requestClusterPluginRuntimeReconcile();
  if (!lastPluginRuntimeReconcileResult) {
    throw new Error('Cluster plugin runtime reconcile completed without a local reconcile result');
  }

  return {
    result: lastPluginRuntimeReconcileResult,
    convergence,
  };
}

async function requestClusterPluginRuntimeReconcile(): Promise<PluginRuntimeConvergenceStatusReport> {
  const requestId = crypto.randomUUID();

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off('message', handleMessage);
      reject(new Error('Timed out waiting for cluster plugin runtime reconcile result'));
    }, 10000);

    const handleMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const clusterMessage = message as Partial<PluginRuntimeClusterReconcileResultMessage>;
      if (clusterMessage.status !== 'cluster-plugin-runtime-reconcile-result' || clusterMessage.requestId !== requestId) {
        return;
      }

      clearTimeout(timeout);
      process.off('message', handleMessage);

      if (clusterMessage.error) {
        reject(new Error(clusterMessage.error));
        return;
      }

      if (!clusterMessage.convergence) {
        reject(new Error('Cluster plugin runtime reconcile result did not include convergence status'));
        return;
      }

      resolve(clusterMessage.convergence);
    };

    process.on('message', handleMessage);
    process.send?.({
      command: 'cluster-reconcile-plugin-runtime',
      requestId,
    });
  });
}

/**
 * Initialize Plugin Registries for testing
 *
 * 初始化测试环境的插件系统，包括：
 * 1. PluginRegistry - 加载插件元数据（用于 UI）
 * 2. ScopedPluginRegistry - 创建插件实例并预编译 Hooks（用于执行）
 *
 * **注意**：生产环境的初始化由 config worker lifecycle 完成。
 *
 * @param config - 应用配置
 * @param basePath - 插件加载的基础路径（默认 process.cwd()）
 *
 * @example
 * ```typescript
 * // In test setup
 * beforeEach(async () => {
 *   await initializePluginRegistryForTests(testConfig, '/path/to/plugins');
 * });
 *
 * afterEach(async () => {
 *   await cleanupPluginRegistry();
 * });
 * ```
 */
export async function initializePluginRegistryForTests(
  config: AppConfig,
  basePath: string = process.cwd()
): Promise<void> {
  const activatedPluginNames = [...new Set(
    collectDeclaredPluginConfigs(config)
      .filter((plugin) => plugin.enabled !== false && plugin.name)
      .map((plugin) => plugin.name),
  )];
  await initializePluginRuntime(config, { basePath, activatedPluginNames });

  logger.debug('Plugin registries initialized for tests');
}

/**
 * Clean up Plugin Registries
 *
 * 清理所有插件注册表，释放资源。
 * 应在以下场景调用：
 * - 测试清理（afterEach/afterAll）
 * - 服务器关闭
 *
 * @example
 * ```typescript
 * // In test teardown
 * afterEach(async () => {
 *   await cleanupPluginRegistry();
 * });
 * ```
 */
export async function cleanupPluginRegistry(): Promise<void> {
  if (pluginRuntimeOrchestrator) {
    await pluginRuntimeOrchestrator.destroy();
    pluginRuntimeOrchestrator = null;
  }

  pluginRegistry = null;
  lastPluginRuntimeReconcileResult = null;
}
