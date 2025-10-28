/**
 * Failover statistics API
 * Provides detailed statistics about upstream health and failover behavior
 */

import type { RuntimeUpstream } from '../types';
import { runtimeState } from '../state/runtime-state';
import { getSlowStartProgress, isInSlowStart } from '../utils/slow-start';
import type { RouteConfig } from '@jeffusion/bungee-shared';

/**
 * Upstream statistics
 */
export interface UpstreamStats {
  target: string;
  status: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  weight: number;
  priority: number;

  // Passive health check stats
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime?: number;

  // Active health check stats
  healthCheckSuccesses?: number;
  healthCheckFailures?: number;

  // Slow start stats
  inSlowStart: boolean;
  slowStartProgress?: number; // 0-100
  slowStartWeightFactor?: number;
  effectiveWeight?: number;
}

/**
 * Route failover statistics
 */
export interface RouteStats {
  path: string;
  upstreams: UpstreamStats[];
  healthyCount: number;
  unhealthyCount: number;
  halfOpenCount: number;
}

/**
 * Global failover statistics
 */
export interface GlobalStats {
  routes: RouteStats[];
  totalUpstreams: number;
  totalHealthy: number;
  totalUnhealthy: number;
  totalHalfOpen: number;
}

/**
 * Get statistics for all routes
 *
 * @param config - Application configuration
 * @returns Global statistics
 */
export function getGlobalStats(config: { routes: RouteConfig[] }): GlobalStats {
  const routes: RouteStats[] = [];
  let totalUpstreams = 0;
  let totalHealthy = 0;
  let totalUnhealthy = 0;
  let totalHalfOpen = 0;

  for (const route of config.routes) {
    const routeState = runtimeState.get(route.path);
    if (!routeState) continue;

    const upstreamStats: UpstreamStats[] = routeState.upstreams.map((up) => {
      const stats: UpstreamStats = {
        target: up.target,
        status: up.status,
        weight: up.weight ?? 100,
        priority: up.priority ?? 1,
        consecutiveFailures: up.consecutiveFailures,
        consecutiveSuccesses: up.consecutiveSuccesses,
        lastFailureTime: up.lastFailureTime,
        healthCheckSuccesses: up.healthCheckSuccesses,
        healthCheckFailures: up.healthCheckFailures,
        inSlowStart: isInSlowStart(up),
        slowStartProgress: isInSlowStart(up) ? getSlowStartProgress(up, route) : undefined,
        slowStartWeightFactor: up.slowStartWeightFactor,
      };

      totalUpstreams++;
      if (up.status === 'HEALTHY') totalHealthy++;
      else if (up.status === 'UNHEALTHY') totalUnhealthy++;
      else if (up.status === 'HALF_OPEN') totalHalfOpen++;

      return stats;
    });

    routes.push({
      path: route.path,
      upstreams: upstreamStats,
      healthyCount: upstreamStats.filter((u) => u.status === 'HEALTHY').length,
      unhealthyCount: upstreamStats.filter((u) => u.status === 'UNHEALTHY').length,
      halfOpenCount: upstreamStats.filter((u) => u.status === 'HALF_OPEN').length,
    });
  }

  return {
    routes,
    totalUpstreams,
    totalHealthy,
    totalUnhealthy,
    totalHalfOpen,
  };
}

/**
 * Get statistics for a specific route
 *
 * @param routePath - Route path
 * @param route - Route configuration
 * @returns Route statistics or null if not found
 */
export function getRouteStats(routePath: string, route: RouteConfig): RouteStats | null {
  const routeState = runtimeState.get(routePath);
  if (!routeState) return null;

  const upstreamStats: UpstreamStats[] = routeState.upstreams.map((up) => ({
    target: up.target,
    status: up.status,
    weight: up.weight ?? 100,
    priority: up.priority ?? 1,
    consecutiveFailures: up.consecutiveFailures,
    consecutiveSuccesses: up.consecutiveSuccesses,
    lastFailureTime: up.lastFailureTime,
    healthCheckSuccesses: up.healthCheckSuccesses,
    healthCheckFailures: up.healthCheckFailures,
    inSlowStart: isInSlowStart(up),
    slowStartProgress: isInSlowStart(up) ? getSlowStartProgress(up, route) : undefined,
    slowStartWeightFactor: up.slowStartWeightFactor,
  }));

  return {
    path: routePath,
    upstreams: upstreamStats,
    healthyCount: upstreamStats.filter((u) => u.status === 'HEALTHY').length,
    unhealthyCount: upstreamStats.filter((u) => u.status === 'UNHEALTHY').length,
    halfOpenCount: upstreamStats.filter((u) => u.status === 'HALF_OPEN').length,
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
  route: RouteConfig
): UpstreamStats | null {
  const routeState = runtimeState.get(routePath);
  if (!routeState) return null;

  const upstream = routeState.upstreams.find((u) => u.target === upstreamTarget);
  if (!upstream) return null;

  return {
    target: upstream.target,
    status: upstream.status,
    weight: upstream.weight ?? 100,
    priority: upstream.priority ?? 1,
    consecutiveFailures: upstream.consecutiveFailures,
    consecutiveSuccesses: upstream.consecutiveSuccesses,
    lastFailureTime: upstream.lastFailureTime,
    healthCheckSuccesses: upstream.healthCheckSuccesses,
    healthCheckFailures: upstream.healthCheckFailures,
    inSlowStart: isInSlowStart(upstream),
    slowStartProgress: isInSlowStart(upstream) ? getSlowStartProgress(upstream, route) : undefined,
    slowStartWeightFactor: upstream.slowStartWeightFactor,
  };
}
