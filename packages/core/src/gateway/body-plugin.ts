import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
import { BodySource } from './body-service';

/** The only production constructor. Ownership and decoding remain in BodySource. */
export class BodyServicePlugin implements Plugin {
  bodyRequirements() { return {request: 'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayBody.tap('builtin.body-service', (...args) => new BodySource(...args));
  }
}
