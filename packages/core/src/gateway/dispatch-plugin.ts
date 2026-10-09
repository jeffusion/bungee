import type { Plugin, PluginHooks, GatewayDispatchInput, GatewayDispatchDecision, GatewayDispatchTarget } from './plugin';
import { DataAdmissionError } from '../data-admission/errors';
import { getScopedPluginRegistry } from '../scoped-plugin-registry';
import { resolveEffectiveRoute } from './routing-plugin';
import type { LLMProtocol, RouteConfig } from '@jeffusion/bungee-types';

export class DispatchPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayDispatch.tapPromise('builtin.dispatch', async ({config,entry,context,signal,principal,servingRevision}: GatewayDispatchInput): Promise<GatewayDispatchDecision> => {
      const registry = getScopedPluginRegistry();
      const references = registry?.getDeclaredDispatchTargets?.(entry.path) ?? [];
      const targets = references.map(target => {
        const entity = (target.type === 'route' ? config.routes : config.services ?? []).find(entity => entity.id === target.id);
        return {...target,protocol:entity?.llm_protocol as LLMProtocol | undefined};
      });
      const dispatch = await registry?.getRoutePrecompiledHooks?.(entry.path)?.hooks.onDispatchRequest.promise({context,signal,principal,servingRevision,targets});
      if (!dispatch) return {route:entry,effective:resolveEffectiveRoute(config,entry),context};
      if (!targets.some(target => target.type === dispatch.target.type && target.id === dispatch.target.id)) throw new DataAdmissionError(403,'dispatch_target_not_declared');
      signal.throwIfAborted();
      let route: RouteConfig;
      if (dispatch.target.type === 'route') {
        const target = config.routes.find(route => route.id === dispatch.target.id);
        if (!target || target.id === entry.id || target.direct_response?.enabled || target.redirect?.enabled || target.response_rules?.some(rule => rule.enabled)) throw new DataAdmissionError(422,'dispatch_target_unavailable');
        route = target;
        const suffix = context.url.pathname.startsWith(entry.path) ? context.url.pathname.slice(entry.path.length) : '';
        context.url.pathname = target.path.replace(/\/$/,'') + suffix;
      } else {
        const service = config.services?.find(service => service.id === dispatch.target.id);
        if (!service) throw new DataAdmissionError(422,'dispatch_target_unavailable');
        route = {...entry,service:service.name,service_id:service.id,endpoints:undefined} as RouteConfig;
      }
      return {route,effective:resolveEffectiveRoute(config,route),context,entryRouteId:entry.id ?? entry.path,target:dispatch.target,adapter:dispatch.adapter};
    });
  }
}
