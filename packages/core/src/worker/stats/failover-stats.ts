/**
 * Failover statistics API
 * Provides detailed statistics about upstream health and failover behavior
 */

import { runtimeState } from '../state/runtime-state';
import { getSlowStartProgress, isInSlowStart } from '../utils/slow-start';
import type { EffectiveRouteConfig } from '../types';

/**
 * Upstream statistics
 */
export interface UpstreamStats {
  upstream_id: string;
  target: string;
  status: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  weight: number;
  priority: number;

  // Passive health check stats
  consecutive_failures: number;
  consecutive_successes: number;
  last_failure_time?: number;
  last_used_time?: number;
  recovery_attempt_count: number;

  // Active health check stats
  health_check_successes?: number;
  health_check_failures?: number;

  // Slow start stats
  in_slow_start: boolean;
  slow_start_progress?: number; // 0-100
  slow_start_weight_factor?: number;
  effective_weight?: number;
}

/**
 * Route failover statistics
 */
export interface RouteStats {
  path: string;
  upstreams: UpstreamStats[];
  healthy_count: number;
  unhealthy_count: number;
  half_open_count: number;
}

/**
 * Global failover statistics
 */
export interface GlobalStats {
  routes: RouteStats[];
  total_upstreams: number;
  total_healthy: number;
  total_unhealthy: number;
  total_half_open: number;
}

/**
 * Get statistics for all routes
 *
 * @param config - Application configuration
 * @returns Global statistics
 */
export function getGlobalStats(config: { routes: EffectiveRouteConfig[] }): GlobalStats {
  const routes: RouteStats[] = [];
  let total_upstreams = 0;
  let total_healthy = 0;
  let total_unhealthy = 0;
  let total_half_open = 0;

  for (const route of config.routes) {
    const routeState = runtimeState.get(route.path);
    if (!routeState) continue;

    const upstreamStats: UpstreamStats[] = routeState.upstreams.map((up) => {
      const stats: UpstreamStats = {
        upstream_id: up.upstream_id,
        target: up.target,
        status: up.status,
        weight: up.weight ?? 100,
        priority: up.priority ?? 1,
        consecutive_failures: up.consecutive_failures,
        consecutive_successes: up.consecutive_successes,
        last_failure_time: up.last_failure_time,
        last_used_time: up.last_used_time,
        recovery_attempt_count: up.recovery_attempt_count,
        health_check_successes: up.health_check_successes,
        health_check_failures: up.health_check_failures,
        in_slow_start: isInSlowStart(up),
        slow_start_progress: isInSlowStart(up) ? getSlowStartProgress(up, route) : undefined,
        slow_start_weight_factor: up.slow_start_weight_factor,
      };

      total_upstreams++;
      if (up.status === 'HEALTHY') total_healthy++;
      else if (up.status === 'UNHEALTHY') total_unhealthy++;
      else if (up.status === 'HALF_OPEN') total_half_open++;

      return stats;
    });

    routes.push({
      path: route.path,
      upstreams: upstreamStats,
      healthy_count: upstreamStats.filter((u) => u.status === 'HEALTHY').length,
      unhealthy_count: upstreamStats.filter((u) => u.status === 'UNHEALTHY').length,
      half_open_count: upstreamStats.filter((u) => u.status === 'HALF_OPEN').length,
    });
  }

  return {
    routes,
    total_upstreams,
    total_healthy,
    total_unhealthy,
    total_half_open,
  };
}

/**
 * Get statistics for a specific route
 *
 * @param routePath - Route path
 * @param route - Route configuration
 * @returns Route statistics or null if not found
 */
export function getRouteStats(routePath: string, route: EffectiveRouteConfig): RouteStats | null {
  const routeState = runtimeState.get(routePath);
  if (!routeState) return null;

  const upstreamStats: UpstreamStats[] = routeState.upstreams.map((up) => ({
    upstream_id: up.upstream_id,
    target: up.target,
    status: up.status,
    weight: up.weight ?? 100,
    priority: up.priority ?? 1,
    consecutive_failures: up.consecutive_failures,
    consecutive_successes: up.consecutive_successes,
    last_failure_time: up.last_failure_time,
    last_used_time: up.last_used_time,
    recovery_attempt_count: up.recovery_attempt_count,
    health_check_successes: up.health_check_successes,
    health_check_failures: up.health_check_failures,
    in_slow_start: isInSlowStart(up),
    slow_start_progress: isInSlowStart(up) ? getSlowStartProgress(up, route) : undefined,
    slow_start_weight_factor: up.slow_start_weight_factor,
  }));

  return {
    path: routePath,
    upstreams: upstreamStats,
    healthy_count: upstreamStats.filter((u) => u.status === 'HEALTHY').length,
    unhealthy_count: upstreamStats.filter((u) => u.status === 'UNHEALTHY').length,
    half_open_count: upstreamStats.filter((u) => u.status === 'HALF_OPEN').length,
  };
}

/**
 * Get statistics for a specific upstream
 *
 * @param routePath - Route path
 * @param upstreamTarget - Upstream target URL
 * @param route - Route configuration
 * @returns Upstream statistics or null if not found
 */
export function getUpstreamStats(
  routePath: string,
  upstreamTarget: string,
  route: EffectiveRouteConfig
): UpstreamStats | null {
  const routeState = runtimeState.get(routePath);
  if (!routeState) return null;

  const upstream = routeState.upstreams.find((u) => u.target === upstreamTarget);
  if (!upstream) return null;

  return {
    upstream_id: upstream.upstream_id,
    target: upstream.target,
    status: upstream.status,
    weight: upstream.weight ?? 100,
    priority: upstream.priority ?? 1,
    consecutive_failures: upstream.consecutive_failures,
    consecutive_successes: upstream.consecutive_successes,
    last_failure_time: upstream.last_failure_time,
    last_used_time: upstream.last_used_time,
    recovery_attempt_count: upstream.recovery_attempt_count,
    health_check_successes: upstream.health_check_successes,
    health_check_failures: upstream.health_check_failures,
    in_slow_start: isInSlowStart(upstream),
    slow_start_progress: isInSlowStart(upstream) ? getSlowStartProgress(upstream, route) : undefined,
    slow_start_weight_factor: upstream.slow_start_weight_factor,
  };
}
