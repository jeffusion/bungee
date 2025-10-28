/**
 * Active health check unit tests
 * Tests for health check configuration, execution, and state management
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { RuntimeUpstream } from '../../src/worker/types';
import type { RouteConfig } from '@jeffusion/bungee-shared';
import {
  getHealthCheckConfig,
  processHealthCheckResult,
  type HealthCheckResult,
} from '../../src/worker/health/checker';

describe('Health Check - Configuration', () => {
  test('should return null when health check is not enabled', () => {
    const route: RouteConfig = {
      path: '/api',
      upstreams: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retryableStatusCodes: [502, 503],
      },
    };

    const config = getHealthCheckConfig(route);
    expect(config).toBeNull();
  });

  test('should return config with defaults when health check is enabled', () => {
    const route: RouteConfig = {
      path: '/api',
      upstreams: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retryableStatusCodes: [502, 503],
        healthCheck: {
          enabled: true,
        },
      },
    };

    const config = getHealthCheckConfig(route);
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(true);
    expect(config?.intervalMs).toBe(10000);
    expect(config?.timeoutMs).toBe(3000);
    expect(config?.path).toBe('/health');
    expect(config?.method).toBe('GET');
    expect(config?.expectedStatus).toEqual([200]);
    expect(config?.unhealthyThreshold).toBe(3);
    expect(config?.healthyThreshold).toBe(2);
  });

  test('should use custom configuration values', () => {
    const route: RouteConfig = {
      path: '/api',
      upstreams: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retryableStatusCodes: [502, 503],
        healthCheck: {
          enabled: true,
          intervalMs: 5000,
          timeoutMs: 2000,
          path: '/custom-health',
          method: 'POST',
          expectedStatus: [200, 204],
          unhealthyThreshold: 5,
          healthyThreshold: 3,
        },
      },
    };

    const config = getHealthCheckConfig(route);
    expect(config).not.toBeNull();
    expect(config?.intervalMs).toBe(5000);
    expect(config?.timeoutMs).toBe(2000);
    expect(config?.path).toBe('/custom-health');
    expect(config?.method).toBe('POST');
    expect(config?.expectedStatus).toEqual([200, 204]);
    expect(config?.unhealthyThreshold).toBe(5);
    expect(config?.healthyThreshold).toBe(3);
  });
});

describe('Health Check - Result Processing', () => {
  let upstream: RuntimeUpstream;

  beforeEach(() => {
    upstream = {
      target: 'http://server1.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      healthCheckSuccesses: 0,
      healthCheckFailures: 0,
    };
  });

  test('should increment success counter on successful health check', () => {
    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    processHealthCheckResult(upstream, result, config);

    expect(upstream.healthCheckSuccesses).toBe(1);
    expect(upstream.healthCheckFailures).toBe(0);
    expect(upstream.status).toBe('HEALTHY');
  });

  test('should increment failure counter on failed health check', () => {
    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: false,
      status: 503,
      latency: 50,
      timestamp: Date.now(),
    };

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    processHealthCheckResult(upstream, result, config);

    expect(upstream.healthCheckSuccesses).toBe(0);
    expect(upstream.healthCheckFailures).toBe(1);
    expect(upstream.status).toBe('HEALTHY'); // Still healthy (only 1 failure)
  });

  test('should mark as UNHEALTHY after reaching unhealthy threshold', () => {
    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: false,
      status: 503,
      latency: 50,
      timestamp: Date.now(),
    };

    // Failure 1
    processHealthCheckResult(upstream, result, config);
    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.healthCheckFailures).toBe(1);

    // Failure 2
    processHealthCheckResult(upstream, result, config);
    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.healthCheckFailures).toBe(2);

    // Failure 3 - should mark as UNHEALTHY
    processHealthCheckResult(upstream, result, config);
    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.lastFailureTime).toBeDefined();
    expect(upstream.healthCheckFailures).toBe(0); // Reset after marking unhealthy
  });

  test('should mark as HEALTHY after reaching healthy threshold', () => {
    upstream.status = 'UNHEALTHY';
    upstream.lastFailureTime = Date.now() - 10000;

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    // Success 1
    processHealthCheckResult(upstream, result, config);
    expect(upstream.status).toBe('UNHEALTHY'); // Still unhealthy
    expect(upstream.healthCheckSuccesses).toBe(1);

    // Success 2 - should mark as HEALTHY
    processHealthCheckResult(upstream, result, config);
    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.lastFailureTime).toBeUndefined();
    expect(upstream.healthCheckSuccesses).toBe(0); // Reset after marking healthy
  });

  test('should reset success counter on failure', () => {
    upstream.status = 'UNHEALTHY';
    upstream.healthCheckSuccesses = 1;

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: false,
      status: 503,
      latency: 50,
      timestamp: Date.now(),
    };

    processHealthCheckResult(upstream, result, config);

    expect(upstream.healthCheckSuccesses).toBe(0);
    expect(upstream.healthCheckFailures).toBe(1);
  });

  test('should reset failure counter on success', () => {
    upstream.healthCheckFailures = 2;

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    processHealthCheckResult(upstream, result, config);

    expect(upstream.healthCheckSuccesses).toBe(1);
    expect(upstream.healthCheckFailures).toBe(0);
  });

  test('should handle HALF_OPEN state correctly', () => {
    upstream.status = 'HALF_OPEN';
    upstream.lastFailureTime = Date.now() - 6000;

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    // Success should promote to HEALTHY
    const successResult: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    upstream.healthCheckSuccesses = 1;
    processHealthCheckResult(upstream, successResult, config);

    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.lastFailureTime).toBeUndefined();
  });

  test('should handle multiple expected status codes', () => {
    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200, 204, 206],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    // Test 200
    let result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };
    expect(result.success).toBe(true);

    // Test 204
    result = {
      upstream: 'http://server1.com',
      success: true,
      status: 204,
      latency: 50,
      timestamp: Date.now(),
    };
    expect(result.success).toBe(true);

    // Test 500 (not in expected list)
    result = {
      upstream: 'http://server1.com',
      success: false,
      status: 500,
      latency: 50,
      timestamp: Date.now(),
    };
    expect(result.success).toBe(false);
  });
});

describe('Health Check - Edge Cases', () => {
  test('should initialize counters if undefined', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server1.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      // healthCheckSuccesses and healthCheckFailures are undefined
    };

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    };

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    processHealthCheckResult(upstream, result, config);

    expect(upstream.healthCheckSuccesses).toBeDefined();
    expect(upstream.healthCheckFailures).toBeDefined();
  });

  test('should handle threshold of 1', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server1.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      healthCheckSuccesses: 0,
      healthCheckFailures: 0,
    };

    const config = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 3000,
      path: '/health',
      method: 'GET',
      expectedStatus: [200],
      unhealthyThreshold: 1,
      healthyThreshold: 1,
    };

    const failureResult: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: false,
      status: 503,
      latency: 50,
      timestamp: Date.now(),
    };

    // Single failure should mark as UNHEALTHY
    processHealthCheckResult(upstream, failureResult, config);
    expect(upstream.status).toBe('UNHEALTHY');

    // Single success should mark as HEALTHY
    const successResult: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    processHealthCheckResult(upstream, successResult, config);
    expect(upstream.status).toBe('HEALTHY');
  });
});
