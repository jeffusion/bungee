import fs from 'fs';
import path from 'path';
import { runtimeState } from '../../worker';
import type { RouteConfig } from '@jeffusion/bungee-types';

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');

interface UpstreamWithStatus {
  target: string;
  weight?: number;
  priority?: number;
  plugins?: Array<any>;
  headers?: any;
  body?: any;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  lastFailureTime?: number;
}

interface RouteWithStatus extends Omit<RouteConfig, 'upstreams'> {
  upstreams: UpstreamWithStatus[];
}

export class RoutesHandler {
  /**
   * Get all routes with runtime status information
   */
  static list(): Response {
    try {
      // Read config file
      const configContent = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(configContent);

      if (!config.routes || !Array.isArray(config.routes)) {
        return new Response(
          JSON.stringify({ error: 'Invalid config: routes must be an array' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Merge config with runtime state
      const routesWithStatus: RouteWithStatus[] = config.routes.map((route: RouteConfig) => {
        const routeState = runtimeState.get(route.path);

        // Map upstreams with runtime status
        const upstreamsWithStatus: UpstreamWithStatus[] = route.upstreams.map((upstream) => {
          // If failover is not enabled or no runtime state, default to HEALTHY
          if (!routeState) {
            return {
              ...upstream,
              status: 'HEALTHY' as const,
              lastFailureTime: undefined
            };
          }

          // Find matching runtime upstream by target
          const runtimeUpstream = routeState.upstreams.find(
            (ru) => ru.target === upstream.target
          );

          if (!runtimeUpstream) {
            return {
              ...upstream,
              status: 'HEALTHY' as const,
              lastFailureTime: undefined
            };
          }

          return {
            ...upstream,
            status: runtimeUpstream.status,
            lastFailureTime: runtimeUpstream.lastFailureTime
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
