import type { Plugin, PluginHooks, GatewayDispatchInput, GatewayDispatchDecision, GatewayDispatchTarget } from './plugin';
import { DataAdmissionError } from '../data-admission/errors';
import { getScopedPluginRegistry } from '../scoped-plugin-registry';
import { resolveEffectiveRoute } from './routing-plugin';
import type { RouteConfig } from '@jeffusion/bungee-types';

export class DispatchPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayDispatch.tapPromise('builtin.dispatch', async ({config,entry,context,signal,principal,servingRevision,webSocketConnection}: GatewayDispatchInput): Promise<GatewayDispatchDecision> => {
      const registry = getScopedPluginRegistry();
      const targets = registry?.getDeclaredDispatchTargets?.(entry.path) ?? [];
      const dispatch = await registry?.dispatchRequest(entry.path,{context,signal,principal,servingRevision,webSocketConnection,targets},{kind:'gateway-request',revision:servingRevision,target:{requestId:context.requestId,attemptId:context.requestId,principal,routeId:entry.id ?? entry.path,serviceId:null,upstreamId:'dispatch',url:context.originalUrl.href,model:typeof context.body?.model==='string'?context.body.model:null,now:Date.now()}});
      if (!dispatch) return {route:entry,effective:resolveEffectiveRoute(config,entry),context};
      if (!targets.some(target => target.type === dispatch.target.type && target.id === dispatch.target.id)) throw new DataAdmissionError(403,'dispatch_target_not_declared');
      signal.throwIfAborted();
      const route=resolveDispatchTarget(config,entry,dispatch.target,context);
      return {route,effective:resolveEffectiveRoute(config,route),context,entryRouteId:entry.id ?? entry.path,target:dispatch.target,requiredUpstreamId:dispatch.requiredUpstreamId,protocol:dispatch.protocol,adapter:dispatch.adapter,canonicalInput:dispatch.canonicalInput,diagnostics:dispatch.diagnostics,prepareRequest:dispatch.prepareRequest};
    });
  }
}

/** Resolve a schema-bound target without invoking another dispatch hook. */
export function resolveDispatchTarget(config:import('@jeffusion/bungee-types').AppConfig,entry:RouteConfig,target:GatewayDispatchTarget,context:GatewayDispatchInput['context']):RouteConfig {
  if(target.type==='route') {
    const route=config.routes.find(route=>route.id===target.id);
    if(!route || route.id===entry.id || route.direct_response?.enabled || route.redirect?.enabled || route.response_rules?.some(rule=>rule.enabled))throw new DataAdmissionError(422,'dispatch_target_unavailable');
    const suffix=context.url.pathname.startsWith(entry.path)?context.url.pathname.slice(entry.path.length):'';
    context.url.pathname=route.path.replace(/\/$/,'')+suffix;
    return route;
  }
  if(target.type!=='service')throw new DataAdmissionError(422,'dispatch_target_unavailable');
  const service=config.services?.find(service=>service.id===target.id);
  if(!service)throw new DataAdmissionError(422,'dispatch_target_unavailable');
  return {...entry,service:service.name,service_id:service.id,endpoints:undefined} as RouteConfig;
}
