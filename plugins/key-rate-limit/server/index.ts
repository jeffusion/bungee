import { definePlugin } from '@jeffusion/bungee-core/plugin';
export { createIngress } from './policy';
export default definePlugin(class { static readonly name='key-rate-limit'; static readonly version='1.0.0'; bodyRequirements(): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements { return { request: 'none' }; }
  register(){} });
