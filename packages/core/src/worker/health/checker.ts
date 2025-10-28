/**
 * Active health check module
 * Periodically probes upstream servers to verify their health status
 */

import { logger } from '../../logger';
import type { RouteConfig } from '@jeffusion/bungee-shared';
import type { RuntimeUpstream } from '../types';

/**
 * Health check result
 */
export interface HealthCheckResult {
  upstream: string;
  success: boolean;
  status?: number;
  latency: number;
  error?: string;
  timestamp: number;
}

/**
 * Health check configuration with defaults
 */
export interface HealthCheckConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  path: string;
  method: string;
  expectedStatus: number[];
  unhealthyThreshold: number;
  healthyThreshold: number;
}

/**
 * Get health check configuration with defaults
 */
export function getHealthCheckConfig(route: RouteConfig): HealthCheckConfig | null {
  if (!route.failover?.healthCheck?.enabled) {
    return null;
  }

  const hc = route.failover.healthCheck;
  return {
    enabled: true,
    intervalMs: hc.intervalMs ?? 10000,
    timeoutMs: hc.timeoutMs ?? 3000,
    path: hc.path ?? '/health',
    method: hc.method ?? 'GET',
    expectedStatus: hc.expectedStatus ?? [200],
    unhealthyThreshold: hc.unhealthyThreshold ?? 3,
    healthyThreshold: hc.healthyThreshold ?? 2,
  };
}

/**
 * Perform a single health check against an upstream
 *
 * @param upstream - Target upstream to check
 * @param config - Health check configuration
 * @returns Health check result
 */
export async function performHealthCheck(
  upstream: RuntimeUpstream,
  config: HealthCheckConfig
): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const targetUrl = new URL(upstream.target);

  // Construct health check URL
  const healthCheckUrl = new URL(config.path, upstream.target);

  logger.debug(
    {
      upstream: upstream.target,
      path: config.path,
      method: config.method,
      timeout: config.timeoutMs
    },
    'Performing health check'
  );

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const response = await fetch(healthCheckUrl.href, {
      method: config.method,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Bungee-HealthCheck/1.0',
      },
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;

    // Check if status is expected
    const success = config.expectedStatus.includes(response.status);

    logger.debug(
      {
        upstream: upstream.target,
        status: response.status,
        latency,
        success,
      },
      `Health check completed`
    );

    return {
      upstream: upstream.target,
      success,
      status: response.status,
      latency,
      timestamp: Date.now(),
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = (error as Error).message;

    logger.debug(
      {
        upstream: upstream.target,
        error: errorMessage,
        latency,
      },
      'Health check failed'
    );

    return {
      upstream: upstream.target,
      success: false,
      latency,
      error: errorMessage,
      timestamp: Date.now(),
    };
  }
}

/**
 * Process health check result and update upstream status
 *
 * @param upstream - Upstream to update
 * @param result - Health check result
 * @param config - Health check configuration
 */
export function processHealthCheckResult(
  upstream: RuntimeUpstream,
  result: HealthCheckResult,
  config: HealthCheckConfig
): void {
  // Initialize health check counters if not present
  if (upstream.healthCheckSuccesses === undefined) {
    upstream.healthCheckSuccesses = 0;
  }
  if (upstream.healthCheckFailures === undefined) {
    upstream.healthCheckFailures = 0;
  }

  if (result.success) {
    // Success: increment success counter, reset failure counter
    upstream.healthCheckSuccesses++;
    upstream.healthCheckFailures = 0;

    // Check if we should mark as HEALTHY
    if (upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN') {
      if (upstream.healthCheckSuccesses >= config.healthyThreshold) {
        upstream.status = 'HEALTHY';
        upstream.lastFailureTime = undefined;
        upstream.healthCheckSuccesses = 0; // Reset counter
        logger.info(
          {
            upstream: upstream.target,
            consecutiveSuccesses: upstream.healthCheckSuccesses,
            healthyThreshold: config.healthyThreshold,
          },
          'Upstream marked HEALTHY by active health check'
        );
      } else {
        logger.debug(
          {
            upstream: upstream.target,
            consecutiveSuccesses: upstream.healthCheckSuccesses,
            healthyThreshold: config.healthyThreshold,
          },
          'Health check success recorded, not yet marked HEALTHY'
        );
      }
    }
  } else {
    // Failure: increment failure counter, reset success counter
    upstream.healthCheckFailures++;
    upstream.healthCheckSuccesses = 0;

    // Check if we should mark as UNHEALTHY
    if (upstream.status === 'HEALTHY') {
      if (upstream.healthCheckFailures >= config.unhealthyThreshold) {
        upstream.status = 'UNHEALTHY';
        upstream.lastFailureTime = Date.now();
        upstream.healthCheckFailures = 0; // Reset counter
        logger.warn(
          {
            upstream: upstream.target,
            consecutiveFailures: upstream.healthCheckFailures,
            unhealthyThreshold: config.unhealthyThreshold,
            error: result.error,
            status: result.status,
          },
          'Upstream marked UNHEALTHY by active health check'
        );
      } else {
        logger.debug(
          {
            upstream: upstream.target,
            consecutiveFailures: upstream.healthCheckFailures,
            unhealthyThreshold: config.unhealthyThreshold,
          },
          'Health check failure recorded, not yet marked UNHEALTHY'
        );
      }
    } else if (upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN') {
      // Already unhealthy, just update failure time
      upstream.lastFailureTime = Date.now();
      logger.debug(
        {
          upstream: upstream.target,
          status: upstream.status,
        },
        'Health check failed for already unhealthy upstream'
      );
    }
  }
}
