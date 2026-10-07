import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
import { selectUpstream } from '../worker/upstream/selector';
import { FailoverCoordinator } from '../worker/upstream/failover-coordinator';
export class SelectionPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewaySelect.tap('builtin.selection', input => {
      if (input.coordinator) return input.coordinator.selectNext() ?? {};
      return {upstream:(input.selector ?? selectUpstream)(input.upstreams,input.route,input.context)};
    });
    hooks.onGatewayFailover.tap('builtin.selection', input =>
      new FailoverCoordinator(input.upstreams,input.route,input.recoveryIntervalMs,input.context));
  }
}
