import type { RouteConfig, Endpoint, FailoverConfig, LoadBalancingConfig, ServiceHealthCheckConfig, ServiceReference } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../expression-engine';

export interface EffectiveRouteConfig extends RouteConfig {
  endpoints: Endpoint[];
  failover?: FailoverConfig;
  load_balancing?: LoadBalancingConfig;
  service_health_check?: ServiceHealthCheckConfig;
  state_key?: string;
}

export interface RuntimeTargetState {
  upstream_id: string;
  status: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  last_failure_time?: number;
  last_used_time?: number;
  consecutive_failures: number;
  consecutive_successes: number;
  recovery_attempt_count: number;
  health_check_successes?: number;
  health_check_failures?: number;
  slow_start_recovery_time?: number;
  slow_start_weight_factor?: number;
  active_request_count?: number;
}

export interface RuntimeUpstream extends Endpoint, RuntimeTargetState {}
export interface RuntimeServiceReference extends ServiceReference, RuntimeTargetState {
  readonly kind: 'service';
  readonly condition?: never;
  readonly target?: never;
}
export type RuntimeCandidate = RuntimeUpstream | RuntimeServiceReference;
export function isServiceReference(candidate: RuntimeCandidate): candidate is RuntimeServiceReference {
  return 'kind' in candidate && candidate.kind === 'service';
}

export interface RequestSnapshot {
  bodySource?: import("./request/body-source").BodySource;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
  content_type: string;
  is_json_body: boolean;
  is_body_cloned?: boolean;
  is_headers_cloned?: boolean;
}

export type UpstreamSelector = (
  upstreams: RuntimeUpstream[],
  route?: EffectiveRouteConfig,
  context?: ExpressionContext
) => RuntimeUpstream | undefined;
