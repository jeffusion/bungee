import { definePlugin } from '../../../packages/core/src/plugin.types';
export { createIngress } from './policy';
export default definePlugin(class { static readonly name='key-rate-limit'; static readonly version='1.0.0'; bodyRequirements(): import('../../../packages/core/src/plugin.types').PluginBodyRequirements { return { request: 'none' }; }
  register(){} });
