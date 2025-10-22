/**
 * Runtime state management for upstream servers
 * Tracks health status and failure times for failover functionality
 */

import { forEach, map } from 'lodash-es';
import { logger } from '../../logger';
import type { AppConfig } from '@jeffusion/bungee-shared';
import type { RuntimeUpstream } from '../types';

/**
 * Global runtime state tracking upstream health per route
 * Map key: route path
 * Map value: upstreams with runtime status
 */
export const runtimeState = new Map<string, { upstreams: RuntimeUpstream[] }>();

/**
 * Initializes runtime state for all routes with failover enabled
 *
 * This function should be called during server startup to set up
 * health tracking for upstream servers. Only routes with failover
 * enabled will have runtime state tracking.
 *
 * **Initialization rules:**
 * - All upstreams start in HEALTHY status
 * - lastFailureTime is undefined initially
 * - Only routes with `failover.enabled = true` are tracked
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
  runtimeState.clear();

  forEach(config.routes, (route) => {
    if (route.failover?.enabled && route.upstreams && route.upstreams.length > 0) {
      runtimeState.set(route.path, {
        upstreams: map(route.upstreams, (up) => ({
          ...up,
          status: 'HEALTHY' as const,
          lastFailureTime: undefined,
        })),
      });
    }
  });

  logger.info('Runtime state initialized.');
}
