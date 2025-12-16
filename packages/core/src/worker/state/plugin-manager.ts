/**
 * Global plugin registry management
 *
 * 管理两个独立的插件注册表：
 *
 * 1. PluginRegistry（元数据管理）
 *    - 用途：UI 元数据管理、插件发现、启用/禁用状态
 *    - 不执行插件，只管理插件类信息
 *
 * 2. ScopedPluginRegistry（插件执行）
 *    - 用途：创建 Handler 实例、预编译 Hooks、实际执行插件
 *    - 支持三级作用域：global、route、upstream
 */

import { logger } from '../../logger';
import { PluginRegistry } from '../../plugin-registry';
import {
  initScopedPluginRegistry,
  getScopedPluginRegistry,
  destroyScopedPluginRegistry
} from '../../scoped-plugin-registry';
import type { AppConfig } from '@jeffusion/bungee-types';

/**
 * Global plugin registry instance
 * Null when not initialized
 */
let pluginRegistry: PluginRegistry | null = null;

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

/**
 * Initialize Plugin Registries for testing
 *
 * 初始化测试环境的插件系统，包括：
 * 1. PluginRegistry - 加载插件元数据（用于 UI）
 * 2. ScopedPluginRegistry - 创建插件实例并预编译 Hooks（用于执行）
 *
 * **注意**：生产环境的初始化在 `startServer()` 中完成。
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
  // Clean up existing registries if any
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
  }
  await destroyScopedPluginRegistry();

  // Create new plugin registry (for UI and plugin metadata)
  pluginRegistry = new PluginRegistry(basePath);

  // Load global plugins if configured
  if (config.plugins && config.plugins.length > 0) {
    await pluginRegistry.loadPlugins(config.plugins);
  }

  // Initialize ScopedPluginRegistry (precompiled hooks)
  const scopedRegistry = initScopedPluginRegistry(basePath);
  await scopedRegistry.initializeFromConfig(config);

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
  // 清理 ScopedPluginRegistry（预编译 Hooks）
  await destroyScopedPluginRegistry();

  // 清理 PluginRegistry（UI 元数据）
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
    pluginRegistry = null;
  }
}
