import { definePlugin, type Plugin } from '@jeffusion/bungee-core/plugin';
import type { PluginHooks } from '@jeffusion/bungee-core/plugin';
/** Compatibility worker instance: management identity exists exclusively in master control. */
export const LocalAccountsPlugin = definePlugin(class implements Plugin {
  static readonly name = 'local-accounts';
  static readonly version = '1.0.0';
  bodyRequirements(): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements { return { request: 'none' }; }
  register(_hooks: PluginHooks): void {}
});
export default LocalAccountsPlugin;
