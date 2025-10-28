/**
 * Shared types for worker modules
 * Central location for all worker-related type definitions to avoid circular dependencies
 */

import type { Upstream } from '@jeffusion/bungee-shared';

/**
 * Runtime upstream server with health status tracking
 * Extends the base Upstream configuration with runtime state
 */
export interface RuntimeUpstream extends Upstream {
  /** Current health status of the upstream server */
  status: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  /** Timestamp of last failure (for recovery timing) */
  lastFailureTime?: number;
  /** Consecutive failure count (resets on success) - for passive health checks */
  consecutiveFailures: number;
  /** Consecutive success count (resets on failure) - for passive health checks */
  consecutiveSuccesses: number;
  /** Health check success count - for active health checks */
  healthCheckSuccesses?: number;
  /** Health check failure count - for active health checks */
  healthCheckFailures?: number;
  /** Slow start recovery time (when upstream was marked HEALTHY after being UNHEALTHY) */
  slowStartRecoveryTime?: number;
  /** Slow start weight factor (0-1), gradually increases to 1.0 */
  slowStartWeightFactor?: number;
}

/**
 * Request snapshot for failover isolation
 * Captures the original request state before any plugin modifications
 * This ensures each upstream retry receives an unmodified copy of the original request
 */
export interface RequestSnapshot {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Full request URL */
  url: string;
  /** Request headers as key-value pairs */
  headers: Record<string, string>;
  /** Request body (parsed JSON object or ArrayBuffer) */
  body: any;
  /** Original Content-Type header value */
  contentType: string;
  /** Whether the body is JSON (true) or binary/other (false) */
  isJsonBody: boolean;
}

/**
 * Function type for upstream selection algorithms
 * Takes available upstreams and returns the selected one
 */
export type UpstreamSelector = (upstreams: RuntimeUpstream[]) => RuntimeUpstream | undefined;
