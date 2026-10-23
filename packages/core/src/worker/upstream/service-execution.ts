import type { AppConfig, Service } from '@jeffusion/bungee-types';
import type { EffectiveRouteConfig, RuntimeServiceReference, RuntimeUpstream } from '../types';
import { createRuntimeUpstreams, runtimeState } from '../state/runtime-state';
import { canAttemptUpstream } from './filter';
import { resolveReachableEndpoints } from '../../utils/endpoint-resolver';
import { DataAdmissionError } from '../../data-admission/errors';

export function serviceById(config: AppConfig, id: string): Service & {id:string} {
  const service = config.services?.find(candidate => candidate.id === id);
  if (!service) throw new DataAdmissionError(422, 'service_reference_not_found');
  return service as Service & {id:string};
}

export function serviceLayer(route: EffectiveRouteConfig, service: Service): EffectiveRouteConfig {
  return {...route, endpoints:service.endpoints, service_references:service.service_references,
    failover:service.failover, load_balancing:service.load_balancing,
    service_health_check:service.health_check, state_key:service.id};
}

export function layerEndpoints(layer: EffectiveRouteConfig): RuntimeUpstream[] {
  // Dispatch can keep the entry Route identity while replacing its target with
  // references. Its cached Endpoint state still belongs to the entry pool.
  if (layer.endpoints.length === 0) return [];
  return runtimeState.get(layer.state_key ?? layer.id ?? layer.path)?.upstreams ?? createRuntimeUpstreams(layer.endpoints);
}

/** Global reachability excludes request conditions and does not acquire probe slots. */
export function serviceAvailable(config: AppConfig, service: Service, ancestors: ReadonlySet<string> = new Set()): boolean {
  if (ancestors.has(service.id!)) throw new DataAdmissionError(422, 'service_reference_cycle');
  const visited = new Set(ancestors).add(service.id!);
  const upstreams = runtimeState.get(service.id!)?.upstreams ?? createRuntimeUpstreams(service.endpoints);
  if (upstreams.some(endpoint => !endpoint.is_disabled && canAttemptUpstream(endpoint, service.failover?.recovery?.backoff_base_ms ?? 5000).canAttempt)) return true;
  return (service.service_references ?? []).some(reference => !reference.is_disabled
    && serviceAvailable(config,serviceById(config,reference.service_id),visited));
}

export function layerReferences(config: AppConfig, layer: EffectiveRouteConfig): RuntimeServiceReference[] {
  return (layer.service_references ?? []).map(reference => ({...reference,kind:'service',upstream_id:reference.id,
    status:serviceAvailable(config,serviceById(config,reference.service_id)) ? 'HEALTHY':'UNHEALTHY',
    consecutive_failures:0,consecutive_successes:0,recovery_attempt_count:0}));
}

/** Shared by every layer and by ordinary/repair retries; only physical dispatch spends it. */
export class PhysicalRequestBudget {
  private remaining: number;
  constructor(config:AppConfig, route:EffectiveRouteConfig, private readonly signal:AbortSignal) {
    const retries=route.retry?.enabled ? route.retry.max_retries ?? 1 : 0;
    this.remaining=resolveReachableEndpoints(route,config.services).length*(1+retries)+1;
  }
  take():void {
    this.signal.throwIfAborted();
    if (this.remaining<=0) throw new DataAdmissionError(503,'physical_request_budget_exhausted');
    this.remaining--;
  }
}
