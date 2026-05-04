/**
 * Active health check module
 * Periodically probes upstream servers to verify their health status
 */

import { logger } from '../../logger';
import type { RouteConfig } from '@jeffusion/bungee-types';
import type { RuntimeUpstream } from '../types';
import { evaluateExpression, type ExpressionContext } from '../../expression-engine';

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
  autoEnableOnHealthCheck: boolean;
  body?: string;
  contentType: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
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
    autoEnableOnHealthCheck: route.failover?.passiveHealth?.autoEnableOnActiveHealthCheck ?? true,
    body: hc.body,
    contentType: hc.contentType ?? 'application/json',
    headers: hc.headers,
    query: hc.query,
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
  const target = new URL(upstream.target);
  const expressionContext: ExpressionContext = {
    env: process.env as Record<string, string>,
    headers: {},
    body: {},
    url: {
      pathname: config.path,
      search: '',
      host: target.host,
      protocol: target.protocol,
    },
    method: config.method,
  };

  // Construct health check URL
  const healthCheckUrl = new URL(config.path, upstream.target);
  if (config.query) {
    for (const [key, value] of Object.entries(config.query)) {
      try {
        const evaluatedValue = evaluateExpression(value, expressionContext);
        healthCheckUrl.searchParams.set(key, evaluatedValue);
      } catch (error) {
        logger.warn(
          {
            upstream: upstream.target,
            queryParam: key,
            value,
            error: (error as Error).message,
          },
          'Failed to evaluate expression in health check query parameter, using raw value'
        );
        healthCheckUrl.searchParams.set(key, value);
      }
    }
  }

  const method = config.method.toUpperCase();
  const supportsRequestBody = ['POST', 'PUT', 'PATCH'].includes(method);

  logger.debug(
    {
      upstream: upstream.target,
      path: config.path,
      method,
      timeout: config.timeoutMs,
      bodyConfigured: Boolean(config.body),
      bodyApplied: Boolean(config.body && supportsRequestBody),
      customHeaders: config.headers ? Object.keys(config.headers) : [],
      customQuery: config.query ? Object.keys(config.query) : [],
    },
    'Performing health check'
  );

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const headers: Record<string, string> = {
      'User-Agent': 'Bungee-HealthCheck/1.0',
    };
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        try {
          headers[key] = evaluateExpression(value, expressionContext);
        } catch (error) {
          logger.warn(
            {
              upstream: upstream.target,
              header: key,
              value,
              error: (error as Error).message,
            },
            'Failed to evaluate expression in health check header, using raw value'
          );
          headers[key] = value;
        }
      }
    }
    const requestOptions: RequestInit = {
      method: config.method,
      signal: controller.signal,
      headers,
    };

    if (config.body && supportsRequestBody) {
      requestOptions.body = config.body;
      headers['Content-Type'] = config.contentType;
    } else if (config.body && !supportsRequestBody) {
      logger.warn(
        {
          upstream: upstream.target,
          method: config.method,
        },
        'Health check body configured but HTTP method does not support a request payload, skipping body'
      );
    }

    const response = await fetch(healthCheckUrl.href, requestOptions);

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

    let recoveredByHealthCheck = false;
    // Check if we should mark as HEALTHY
    if (upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN') {
      if (upstream.healthCheckSuccesses >= config.healthyThreshold) {
        recoveredByHealthCheck = true;
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

    if (config.autoEnableOnHealthCheck && upstream.disabled && recoveredByHealthCheck) {
      upstream.disabled = false;
      upstream.consecutiveFailures = 0;
      logger.info(
        {
          upstream: upstream.target,
          autoEnabled: true
        },
        'Previously disabled upstream automatically re-enabled after successful health checks'
      );
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
