import { runtimeState } from '../../worker';
import type { RouteConfig } from '@jeffusion/bungee-types';
import { loadConfig } from '../../config';

interface UpstreamWithStatus {
  target: string;
  weight?: number;
  priority?: number;
  plugins?: Array<any>;
  headers?: any;
  body?: any;
  query?: any;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  lastFailureTime?: number;
}

interface RouteWithStatus extends Omit<RouteConfig, 'upstreams'> {
  upstreams: UpstreamWithStatus[];
}

export class RoutesHandler {
  static async list(): Promise<Response> {
    try {
      const config = await loadConfig();

      const routesWithStatus: RouteWithStatus[] = config.routes.map((route: RouteConfig) => {
        const routeState = runtimeState.get(route.path);

        const upstreamsWithStatus: UpstreamWithStatus[] = route.upstreams.map((upstream, index) => {
          if (!routeState) {
            return {
              ...upstream,
              status: 'HEALTHY' as const,
              lastFailureTime: undefined
            };
          }

          const runtimeUpstream = routeState.upstreams[index];

          if (!runtimeUpstream) {
            return {
              ...upstream,
              status: 'HEALTHY' as const,
              lastFailureTime: undefined,
              disabled: upstream.disabled ?? false
            };
          }

          return {
            ...upstream,
            status: runtimeUpstream.status,
            lastFailureTime: runtimeUpstream.lastFailureTime,
            disabled: runtimeUpstream.disabled ?? upstream.disabled ?? false
          };
        });

        return {
          ...route,
          upstreams: upstreamsWithStatus
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
