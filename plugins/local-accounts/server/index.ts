import { definePlugin, type Plugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';
/** Compatibility worker instance: management identity exists exclusively in master control. */
export const LocalAccountsPlugin = definePlugin(class implements Plugin {
  static readonly name = 'local-accounts';
  static readonly version = '1.0.0';
  bodyRequirements(): import('../../../packages/core/src/plugin.types').PluginBodyRequirements { return { request: 'none' }; }
  register(_hooks: PluginHooks): void {}
});
export default LocalAccountsPlugin;
