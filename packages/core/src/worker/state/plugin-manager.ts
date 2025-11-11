/**
 * Global plugin registry management
 * Manages the lifecycle of the global plugin registry instance
 */

import { logger } from '../../logger';
import { PluginRegistry } from '../../plugin-registry';
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
 *   const plugins = registry.getEnabledPlugins();
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
 * Initialize Plugin Registry for testing
 *
 * This function is designed for test environments to set up the plugin system.
 * It performs the following:
 * 1. Cleans up any existing registry
 * 2. Creates a new registry with the specified base path
 * 3. Loads global plugins from config
 *
 * **Note:** In production, plugin registry is initialized in `startServer()`.
 *
 * @param config - Application configuration
 * @param basePath - Base path for plugin loading (defaults to process.cwd())
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
  // Clean up existing registry if any
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
  }

  // Create new registry
  pluginRegistry = new PluginRegistry(basePath);

  // Load global plugins if configured
  if (config.plugins && config.plugins.length > 0) {
    await pluginRegistry.loadPlugins(config.plugins);
  }

  logger.debug('Plugin registry initialized for tests');
}

/**
 * Clean up Plugin Registry
 *
 * Unloads all plugins and clears the registry.
 * Should be called during:
 * - Test cleanup (in afterEach/afterAll)
 * - Server shutdown
 *
 * @example
 * ```typescript
 * // In test teardown
 * afterEach(async () => {
 *   await cleanupPluginRegistry();
 * });
 *
 * // In server shutdown
 * async function shutdownServer() {
 *   await cleanupPluginRegistry();
 *   // ... other cleanup
 * }
 * ```
 */
export async function cleanupPluginRegistry(): Promise<void> {
  if (pluginRegistry) {
    await pluginRegistry.unloadAll();
    pluginRegistry = null;
  }
}
