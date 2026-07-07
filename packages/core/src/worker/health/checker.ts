/**
 * Active health check module
 * Periodically probes upstream servers to verify their health status
 */

import { logger } from '../../logger';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../types';
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
  interval_ms: number;
  timeout_ms: number;
  path: string;
  method: string;
  expected_status: number[];
  unhealthy_threshold: number;
  healthy_threshold: number;
  auto_enable_on_health_check: boolean;
  body?: string;
  content_type: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/**
 * Get health check configuration with defaults
 */
export function getHealthCheckConfig(route: EffectiveRouteConfig): HealthCheckConfig | null {
  if (!route.service_health_check?.enabled) {
    return null;
  }

  const hc = route.service_health_check;
  return {
    enabled: true,
    interval_ms: hc.interval_ms ?? 10000,
    timeout_ms: hc.timeout_ms ?? 3000,
    path: hc.path ?? '/health',
    method: hc.method ?? 'GET',
    expected_status: hc.expected_status ?? [200],
    unhealthy_threshold: hc.unhealthy_threshold ?? 3,
    healthy_threshold: hc.healthy_threshold ?? 2,
    auto_enable_on_health_check: hc.auto_enable_on_active_health_check ?? true,
    body: hc.body,
    content_type: hc.content_type ?? 'application/json',
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
  const health_checkUrl = new URL(config.path, upstream.target);
  if (config.query) {
    for (const [key, value] of Object.entries(config.query)) {
      try {
        const evaluatedValue = evaluateExpression(value, expressionContext);
        health_checkUrl.searchParams.set(key, evaluatedValue);
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
        health_checkUrl.searchParams.set(key, value);
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
      timeout: config.timeout_ms,
      body_configured: Boolean(config.body),
      body_applied: Boolean(config.body && supportsRequestBody),
      custom_headers: config.headers ? Object.keys(config.headers) : [],
      custom_query: config.query ? Object.keys(config.query) : [],
    },
    'Performing health check'
  );

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout_ms);

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
      headers['Content-Type'] = config.content_type;
    } else if (config.body && !supportsRequestBody) {
      logger.warn(
        {
          upstream: upstream.target,
          method: config.method,
        },
        'Health check body configured but HTTP method does not support a request payload, skipping body'
      );
    }

    const response = await fetch(health_checkUrl.href, requestOptions);

    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;

    // Check if status is expected
    const success = config.expected_status.includes(response.status);

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
  if (upstream.health_check_successes === undefined) {
    upstream.health_check_successes = 0;
  }
  if (upstream.health_check_failures === undefined) {
    upstream.health_check_failures = 0;
  }

  if (result.success) {
    // Success: increment success counter, reset failure counter
    upstream.health_check_successes++;
    upstream.health_check_failures = 0;

    let recoveredByHealthCheck = false;
    // Check if we should mark as HEALTHY
    if (upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN') {
      if (upstream.health_check_successes >= config.healthy_threshold) {
        recoveredByHealthCheck = true;
        upstream.status = 'HEALTHY';
        upstream.last_failure_time = undefined;
        upstream.health_check_successes = 0; // Reset counter
        logger.info(
          {
            upstream: upstream.target,
            consecutive_successes: upstream.health_check_successes,
            healthy_threshold: config.healthy_threshold,
          },
          'Upstream marked HEALTHY by active health check'
        );
      } else {
        logger.debug(
          {
            upstream: upstream.target,
            consecutive_successes: upstream.health_check_successes,
            healthy_threshold: config.healthy_threshold,
          },
          'Health check success recorded, not yet marked HEALTHY'
        );
      }
    }

    if (config.auto_enable_on_health_check && upstream.is_disabled && recoveredByHealthCheck) {
      upstream.is_disabled = false;
      upstream.consecutive_failures = 0;
      logger.info(
        {
          upstream: upstream.target,
          auto_enabled: true
        },
        'Previously disabled upstream automatically re-enabled after successful health checks'
      );
    }
  } else {
    // Failure: increment failure counter, reset success counter
    upstream.health_check_failures++;
    upstream.health_check_successes = 0;

    // Check if we should mark as UNHEALTHY
    if (upstream.status === 'HEALTHY') {
      if (upstream.health_check_failures >= config.unhealthy_threshold) {
        upstream.status = 'UNHEALTHY';
        upstream.last_failure_time = Date.now();
        upstream.health_check_failures = 0; // Reset counter
        logger.warn(
          {
            upstream: upstream.target,
            consecutive_failures: upstream.health_check_failures,
            unhealthy_threshold: config.unhealthy_threshold,
            error: result.error,
            status: result.status,
          },
          'Upstream marked UNHEALTHY by active health check'
        );
      } else {
        logger.debug(
          {
            upstream: upstream.target,
            consecutive_failures: upstream.health_check_failures,
            unhealthy_threshold: config.unhealthy_threshold,
          },
          'Health check failure recorded, not yet marked UNHEALTHY'
        );
      }
    } else if (upstream.status === 'UNHEALTHY' || upstream.status === 'HALF_OPEN') {
      // Already unhealthy, just update failure time
      upstream.last_failure_time = Date.now();
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
