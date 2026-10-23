import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
import { isServiceReference, type RuntimeCandidate, type RuntimeServiceReference, type RuntimeUpstream } from '../worker/types';
import { selectUpstream } from '../worker/upstream/selector';
import { FailoverCoordinator } from '../worker/upstream/failover-coordinator';
function orderedCandidates(upstreams:RuntimeUpstream[], references:RuntimeServiceReference[]=[]):RuntimeCandidate[]{
  return [...upstreams,...references].map((candidate,index)=>({candidate,position:candidate.position ?? index}))
    .sort((left,right)=>left.position-right.position).map(entry=>entry.candidate);
}
export class SelectionPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewaySelect.tap('builtin.selection', input => {
      const selection = input.coordinator?.selectNext();
      const candidate = input.coordinator ? selection?.upstream
        : input.references?.length ? selectUpstream(orderedCandidates(input.upstreams,input.references),input.route,input.context)
        : (input.selector ?? selectUpstream)(input.upstreams,input.route,input.context);
      if (!candidate) return {};
      return {...(isServiceReference(candidate) ? {reference:candidate} : {upstream:candidate}),
        shouldTransitionToHalfOpen:selection?.shouldTransitionToHalfOpen};
    });
    hooks.onGatewayFailover.tap('builtin.selection', input =>
      new FailoverCoordinator(orderedCandidates(input.upstreams,input.references),input.route,input.recoveryIntervalMs,input.context));
  }
}
