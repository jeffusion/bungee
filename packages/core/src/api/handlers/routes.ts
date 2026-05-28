import { runtimeState } from '../../worker';
import type { Endpoint, RouteConfig } from '@jeffusion/bungee-types';
import { loadConfig } from '../../config';
import { resolveEffectiveRouteEndpoints, resolveRouteService } from '../../utils/endpoint-resolver';

interface EndpointWithStatus extends Endpoint {
  target: string;
  weight?: number;
  priority?: number;
  plugins?: Array<any>;
  headers?: any;
  body?: any;
  query?: any;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  last_failure_time?: number;
}

interface RouteWithStatus extends Omit<RouteConfig, 'endpoints'> {
  endpoints: EndpointWithStatus[];
  service_ref?: {
    name: string;
    found: boolean;
    endpoint_count: number;
  };
}

export class RoutesHandler {
  static async list(): Promise<Response> {
    try {
      const config = await loadConfig();

      const routesWithStatus: RouteWithStatus[] = config.routes.map((route: RouteConfig) => {
        const service = resolveRouteService(config, route);
        const endpoints = resolveEffectiveRouteEndpoints(route, config.services);
        const runtime_state_key = route.service ?? route.path;
        const routeState = runtimeState.get(runtime_state_key);

        const endpointsWithStatus: EndpointWithStatus[] = endpoints.map((endpoint, index) => {
          if (!routeState) {
            return {
              ...endpoint,
              status: 'HEALTHY' as const,
              last_failure_time: undefined
            };
          }

          const runtimeUpstream = routeState.upstreams[index];

          if (!runtimeUpstream) {
            return {
              ...endpoint,
              status: 'HEALTHY' as const,
              last_failure_time: undefined,
              is_disabled: endpoint.is_disabled ?? false
            };
          }

          return {
            ...endpoint,
            status: runtimeUpstream.status,
            last_failure_time: runtimeUpstream.last_failure_time,
            is_disabled: runtimeUpstream.is_disabled ?? endpoint.is_disabled ?? false
          };
        });

        return {
          ...route,
          endpoints: endpointsWithStatus,
          ...(route.service && {
            service_ref: {
              name: route.service,
              found: !!service,
              endpoint_count: endpoints.length,
            },
          }),
        };
      });

      return new Response(JSON.stringify(routesWithStatus), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: 'Failed to read routes: ' + error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
