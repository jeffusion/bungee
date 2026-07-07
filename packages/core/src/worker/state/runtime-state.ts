/**
 * Runtime state management for upstream servers
 * Tracks health status and failure times for failover functionality
 */

import { forEach, map } from 'lodash-es';
import { logger } from '../../logger';
import type { AppConfig, Endpoint, Service, LoadBalancingConfig } from '@jeffusion/bungee-types';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../types';
import { startHealthCheckScheduler, stopAllHealthCheckSchedulers } from '../health/scheduler';
import { resolveEffectiveRouteEndpoints } from '../../utils/endpoint-resolver';

/**
 * Global runtime state tracking upstream health per route
 * Map key: route path
 * Map value: upstreams with runtime status
 */
export const runtimeState = new Map<string, { upstreams: RuntimeUpstream[]; load_balancing?: LoadBalancingConfig }>();

/**
 * Initializes runtime state for all routes with failover enabled
 *
 * This function should be called during server startup to set up
 * health tracking for upstream servers. Only routes with failover
 * enabled will have runtime state tracking.
 *
 * **Initialization rules:**
 * - All upstreams start in HEALTHY status
 * - last_failure_time is undefined initially
 * - Only routes with `failover.enabled = true` are tracked
 * - Active health checks are started if configured
 *
 * @param config - Application configuration containing route definitions
 *
 * @example
 * ```typescript
 * const config: AppConfig = {
 *   routes: [
 *     {
 *       path: '/api',
 *       failover: { enabled: true },
 *       upstreams: [
 *         { target: 'http://server1:3000', weight: 100 },
 *         { target: 'http://server2:3000', weight: 100 }
 *       ]
 *     }
 *   ]
 * };
 * initializeRuntimeState(config);
 * // Now runtimeState.get('/api') contains upstreams with HEALTHY status
 * ```
 */
export function initializeRuntimeState(config: AppConfig): void {
  // Stop any existing health check schedulers
  stopAllHealthCheckSchedulers();

  runtimeState.clear();

  const services = new Map<string, Service>();
  forEach(config.services ?? [], (service) => {
    services.set(service.name, service);
  });

  forEach(config.routes, (route) => {
    const service = route.service ? services.get(route.service) : undefined;
    const endpoints = resolveEffectiveRouteEndpoints(route, config.services);
    const state_key = service?.name ?? route.path;
    const failover = service?.failover;
    const load_balancing = service?.load_balancing;

    if ((!failover?.enabled && !load_balancing) || endpoints.length === 0) {
      return;
    }

    const existing_state = runtimeState.get(state_key);
    const upstreams = existing_state?.upstreams ?? createRuntimeUpstreams(endpoints);

    if (!existing_state) {
      runtimeState.set(state_key, { upstreams, load_balancing });
    } else if (load_balancing) {
      existing_state.load_balancing = load_balancing;
    }

    const health_check = service?.health_check ?? failover?.health_check;
    if (failover && health_check?.enabled) {
      const health_check_route: EffectiveRouteConfig = {
        ...route,
        endpoints,
        failover: {
          ...failover,
          health_check,
        },
      };

      startHealthCheckScheduler(state_key, health_check_route, upstreams);
    }
  });

  logger.info('Runtime state initialized.');
}

function createRuntimeUpstreams(endpoints: Endpoint[]): RuntimeUpstream[] {
  return map(endpoints, (endpoint, index) => ({
    ...endpoint,
    upstream_id: ('id' in endpoint && typeof endpoint.id === 'string' ? endpoint.id : String(index)),
    status: 'HEALTHY' as const,
    last_failure_time: undefined,
    consecutive_failures: 0,
    consecutive_successes: 0,
    health_check_successes: 0,
    health_check_failures: 0,
    recovery_attempt_count: 0,
    active_request_count: 0,
  })) as RuntimeUpstream[];
}

const upstreamActiveCounters = new Map<string, number>();

export function incrementActiveRequests(stateKey: string, upstreamId: string): void {
  const key = `${stateKey}::${upstreamId}`;
  upstreamActiveCounters.set(key, (upstreamActiveCounters.get(key) ?? 0) + 1);
}

export function decrementActiveRequests(stateKey: string, upstreamId: string): void {
  const key = `${stateKey}::${upstreamId}`;
  const current = upstreamActiveCounters.get(key);
  if (current === undefined) return;
  if (current <= 1) {
    upstreamActiveCounters.delete(key);
  } else {
    upstreamActiveCounters.set(key, current - 1);
  }
}

export function getActiveRequestCount(stateKey: string, upstreamId: string): number {
  return upstreamActiveCounters.get(`${stateKey}::${upstreamId}`) ?? 0;
}

/**
 * Cleanup runtime state and stop all health check schedulers
 * Should be called on server shutdown
 */
export function cleanupRuntimeState(): void {
  stopAllHealthCheckSchedulers();
  runtimeState.clear();
  logger.info('Runtime state cleaned up.');
}
