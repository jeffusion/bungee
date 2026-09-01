import type { AppConfig } from '@jeffusion/bungee-types';

let servingConfig: AppConfig | null = null;
let activatedPluginNames: ReadonlySet<string> = new Set();

export function setServingConfig(config: AppConfig, activatedPlugins: readonly string[]): void {
  servingConfig = config;
  activatedPluginNames = new Set(activatedPlugins);
}

export function clearServingConfig(): void {
  servingConfig = null;
  activatedPluginNames = new Set();
}

export function isServingPluginActivated(pluginName: string): boolean {
  return activatedPluginNames.has(pluginName);
}

export function getServingConfig(): AppConfig {
  if (servingConfig === null) {
    throw new Error('serving configuration is unavailable: worker has not received a snapshot');
  }
  return servingConfig;
}
