/**
 * Health check scheduler
 * Manages periodic health checks for all routes with active health checking enabled
 */

import { logger } from '../../logger';
import { forEach } from 'lodash-es';
import type { RouteConfig } from '@jeffusion/bungee-shared';
import type { RuntimeUpstream } from '../types';
import { addJitter } from '../utils/jitter';
import {
  getHealthCheckConfig,
  performHealthCheck,
  processHealthCheckResult,
  type HealthCheckConfig,
} from './checker';

/**
 * Health check scheduler state
 */
interface HealthCheckScheduler {
  routePath: string;
  config: HealthCheckConfig;
  upstreams: RuntimeUpstream[];
  intervalId?: ReturnType<typeof setInterval>;
  running: boolean;
}

/**
 * Global registry of active health check schedulers
 */
const schedulers = new Map<string, HealthCheckScheduler>();

/**
 * Start health check scheduler for a route
 *
 * @param routePath - Route path
 * @param route - Route configuration
 * @param upstreams - Runtime upstreams for this route
 */
export function startHealthCheckScheduler(
  routePath: string,
  route: RouteConfig,
  upstreams: RuntimeUpstream[]
): void {
  // Get health check configuration
  const config = getHealthCheckConfig(route);
  if (!config) {
    logger.debug({ routePath }, 'Health check not enabled for route');
    return;
  }

  // Stop existing scheduler if any
  stopHealthCheckScheduler(routePath);

  logger.info(
    {
      routePath,
      intervalMs: config.intervalMs,
      upstreamCount: upstreams.length,
    },
    'Starting health check scheduler'
  );

  const scheduler: HealthCheckScheduler = {
    routePath,
    config,
    upstreams,
    running: true,
  };

  // Perform initial health check immediately (with small jitter to avoid thundering herd)
  const initialDelay = addJitter(100, 0.5); // 50-150ms
  setTimeout(() => {
    if (scheduler.running) {
      performHealthChecksForRoute(scheduler);
    }
  }, initialDelay);

  // Schedule periodic health checks with jitter
  // Use setInterval but add jitter to each execution
  scheduler.intervalId = setInterval(() => {
    if (scheduler.running) {
      // Add jitter to prevent synchronized health checks across routes
      const jitteredDelay = addJitter(0, 0.1); // 0-10% jitter on execution time
      setTimeout(() => {
        if (scheduler.running) {
          performHealthChecksForRoute(scheduler);
        }
      }, jitteredDelay);
    }
  }, config.intervalMs);

  schedulers.set(routePath, scheduler);
}

/**
 * Stop health check scheduler for a route
 *
 * @param routePath - Route path
 */
export function stopHealthCheckScheduler(routePath: string): void {
  const scheduler = schedulers.get(routePath);
  if (!scheduler) {
    return;
  }

  logger.info({ routePath }, 'Stopping health check scheduler');

  scheduler.running = false;
  if (scheduler.intervalId) {
    clearInterval(scheduler.intervalId);
  }

  schedulers.delete(routePath);
}

/**
 * Stop all health check schedulers
 */
export function stopAllHealthCheckSchedulers(): void {
  logger.info({ count: schedulers.size }, 'Stopping all health check schedulers');

  forEach(Array.from(schedulers.keys()), (routePath) => {
    stopHealthCheckScheduler(routePath);
  });
}

/**
 * Get active scheduler count
 */
export function getActiveSchedulerCount(): number {
  return schedulers.size;
}

/**
 * Perform health checks for all upstreams in a route
 *
 * @param scheduler - Health check scheduler
 */
async function performHealthChecksForRoute(scheduler: HealthCheckScheduler): Promise<void> {
  if (!scheduler.running) {
    return;
  }

  logger.debug(
    {
      routePath: scheduler.routePath,
      upstreamCount: scheduler.upstreams.length,
    },
    'Performing health checks for route'
  );

  // Perform health checks for all upstreams in parallel
  const checks = scheduler.upstreams.map(async (upstream) => {
    try {
      const result = await performHealthCheck(upstream, scheduler.config);
      processHealthCheckResult(upstream, result, scheduler.config);
    } catch (error) {
      logger.error(
        {
          routePath: scheduler.routePath,
          upstream: upstream.target,
          error: (error as Error).message,
        },
        'Health check failed with unexpected error'
      );
    }
  });

  await Promise.all(checks);

  logger.debug(
    {
      routePath: scheduler.routePath,
      healthyCount: scheduler.upstreams.filter((u) => u.status === 'HEALTHY').length,
      unhealthyCount: scheduler.upstreams.filter((u) => u.status === 'UNHEALTHY').length,
      halfOpenCount: scheduler.upstreams.filter((u) => u.status === 'HALF_OPEN').length,
    },
    'Health checks completed for route'
  );
}
