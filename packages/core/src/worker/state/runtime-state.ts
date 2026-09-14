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

export const MAX_RUNTIME_STATE_SNAPSHOT_RECORDS = 1024;

export class RuntimeStateSnapshotError extends Error {
  readonly name = 'RuntimeStateSnapshotError';

  constructor(readonly code: 'duplicate_upstream_id' | 'unsafe_count', message: string) {
    super(message);
  }
}

export interface RuntimeStateSnapshotRecord {
  readonly state_key: string;
  readonly upstream_id: string;
  /** Circuit-breaker state only; this is not proof of an active health probe. */
  readonly circuit_state: RuntimeUpstream['status'];
  readonly active_request_count: number;
  readonly last_used_time: number | null;
  readonly last_failure_time: number | null;
  readonly consecutive_failures: number;
  readonly consecutive_successes: number;
  readonly health_check_successes: number;
  readonly health_check_failures: number;
  readonly recovery_attempt_count: number;
}

export interface RuntimeStateSnapshot {
  readonly records: readonly RuntimeStateSnapshotRecord[];
  readonly overflow: number;
}

/**
 * Initializes runtime state for routes that need upstream runtime tracking
 *
 * This function should be called during server startup to set up
 * health tracking for upstream servers. Routes with failover enabled or
 * load balancing configured have runtime state tracking.
 *
 * **Initialization rules:**
 * - All upstreams start in HEALTHY status
 * - last_failure_time is undefined initially
 * - Routes with failover enabled or load balancing configured are tracked
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

    const health_check = service?.health_check;
    if (failover && health_check?.enabled) {
      const health_check_route: EffectiveRouteConfig = {
        ...route,
        endpoints,
        failover,
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
    last_used_time: undefined,
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
 * Synchronously copies the observable upstream state. `active_request_count`
 * deliberately comes from the live counter map, not RuntimeUpstream's field.
 */
export function getRuntimeStateSnapshot(): RuntimeStateSnapshot {
  let upstream_count = 0;
  for (const state of runtimeState.values()) {
    const count = state.upstreams.length;
    if (!Number.isSafeInteger(count) || count < 0 || upstream_count > Number.MAX_SAFE_INTEGER - count) {
      throw new RuntimeStateSnapshotError('unsafe_count', 'runtime upstream count is unsafe');
    }
    upstream_count += count;
  }

  if (upstream_count > MAX_RUNTIME_STATE_SNAPSHOT_RECORDS) {
    return { records: [], overflow: upstream_count - MAX_RUNTIME_STATE_SNAPSHOT_RECORDS };
  }

  const records: RuntimeStateSnapshotRecord[] = [];
  const seen = new Set<string>();
  for (const [state_key, state] of runtimeState) {
    for (const upstream of state.upstreams) {
      const unique_key = JSON.stringify([state_key, upstream.upstream_id]);
      if (seen.has(unique_key)) {
        throw new RuntimeStateSnapshotError(
          'duplicate_upstream_id',
          `duplicate runtime upstream identity: ${state_key}/${upstream.upstream_id}`,
        );
      }
      seen.add(unique_key);
      records.push({
        state_key,
        upstream_id: upstream.upstream_id,
        circuit_state: upstream.status,
        active_request_count: getActiveRequestCount(state_key, upstream.upstream_id),
        last_used_time: upstream.last_used_time ?? null,
        last_failure_time: upstream.last_failure_time ?? null,
        consecutive_failures: upstream.consecutive_failures,
        consecutive_successes: upstream.consecutive_successes,
        health_check_successes: upstream.health_check_successes ?? 0,
        health_check_failures: upstream.health_check_failures ?? 0,
        recovery_attempt_count: upstream.recovery_attempt_count,
      });
    }
  }

  records.sort((left, right) => left.state_key < right.state_key ? -1
    : left.state_key > right.state_key ? 1
      : left.upstream_id < right.upstream_id ? -1
        : left.upstream_id > right.upstream_id ? 1 : 0);

  return { records, overflow: 0 };
}

const halfOpenInFlight = new Set<string>();

export function tryAcquireHalfOpenSlot(stateKey: string, upstreamId: string): boolean {
  const key = `${stateKey}::${upstreamId}`;
  if (halfOpenInFlight.has(key)) return false;
  halfOpenInFlight.add(key);
  return true;
}

export function releaseHalfOpenSlot(stateKey: string, upstreamId: string): void {
  halfOpenInFlight.delete(`${stateKey}::${upstreamId}`);
}

/**
 * Cleanup runtime state and stop all health check schedulers
 * Should be called on server shutdown
 */
export function cleanupRuntimeState(): void {
  stopAllHealthCheckSchedulers();
  runtimeState.clear();
  upstreamActiveCounters.clear();
  halfOpenInFlight.clear();
  logger.info('Runtime state cleaned up.');
}
