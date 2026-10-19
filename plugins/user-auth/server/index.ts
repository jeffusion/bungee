import { definePlugin, type Plugin } from '@jeffusion/bungee-core/plugin';
import type { PluginHooks } from '@jeffusion/bungee-core/plugin';
/** Management identity exists exclusively in the control plane. */
export const UserAuthPlugin = definePlugin(class implements Plugin {
  static readonly name = 'user-auth';
  static readonly version = '1.0.0';
  bodyRequirements(): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements { return { request: 'none' }; }
  register(_hooks: PluginHooks): void {}
});
export default UserAuthPlugin;
