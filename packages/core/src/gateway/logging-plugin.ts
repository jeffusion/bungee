import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
import { RequestLogger } from '../logger/request-logger';
/** Logging remains a required built-in provider and cannot be disabled by configuration. */
export class LoggingPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayLog.tapPromise('builtin.logging', async input => {
      if (input.phase === 'create') return {logger:new RequestLogger(input.request,input.options,input.dependencies)};
      if (input.phase === 'root') await input.logger.persistRoot(input.status,input.options);
      else await input.logger.complete(input.status,input.options);
      return {};
    });
  }
}
