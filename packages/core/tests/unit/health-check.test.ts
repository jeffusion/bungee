import { describe, test, expect, beforeEach } from 'bun:test';
import type { RuntimeUpstream } from '../../src/worker/types';
import type { RouteConfig } from '@jeffusion/bungee-types';
import {
  getHealthCheckConfig,
  processHealthCheckResult,
  type HealthCheckResult,
  type HealthCheckConfig,
} from '../../src/worker/health/checker';

const defaultConfig: HealthCheckConfig = {
  enabled: true,
  intervalMs: 10000,
  timeoutMs: 3000,
  path: '/health',
  method: 'GET',
  expectedStatus: [200],
  unhealthyThreshold: 3,
  healthyThreshold: 2,
  autoEnableOnHealthCheck: true,
};

function buildConfig(overrides: Partial<HealthCheckConfig> = {}): HealthCheckConfig {
  return {
    ...defaultConfig,
    ...overrides,
    expectedStatus: overrides.expectedStatus ?? [...defaultConfig.expectedStatus],
    autoEnableOnHealthCheck: overrides.autoEnableOnHealthCheck ?? defaultConfig.autoEnableOnHealthCheck,
  };
}

describe('Health Check - Configuration', () => {
  test('should return null when health check is not enabled', () => {
    const route: RouteConfig = {
      configVersion: 2,
      path: '/api',
      upstreams: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retryOn: [502, 503],
      },
    };

    const config = getHealthCheckConfig(route);
    expect(config).toBeNull();
  });

  test('should return config with defaults when health check is enabled', () => {
    const route: RouteConfig = {
      configVersion: 2,
      path: '/api',
      upstreams: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retryOn: [502, 503],
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
    expect(config?.autoEnableOnHealthCheck).toBe(true);
  });

  test('should use custom configuration values', () => {
    const route: RouteConfig = {
      configVersion: 2,
      path: '/api',
      upstreams: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retryOn: [502, 503],
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
        passiveHealth: {
          autoEnableOnActiveHealthCheck: false,
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
    expect(config?.autoEnableOnHealthCheck).toBe(false);
  });
});

describe('Health Check - Result Processing', () => {
  let upstream: RuntimeUpstream;

  beforeEach(() => {
    upstream = {
      upstreamId: 'server1',
      target: 'http://server1.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      healthCheckSuccesses: 0,
      healthCheckFailures: 0,
      recoveryAttemptCount: 0,
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

    processHealthCheckResult(upstream, result, buildConfig());

    expect(upstream.healthCheckSuccesses).toBe(1);
    expect(upstream.healthCheckFailures).toBe(0);
    expect(upstream.status).toBe('HEALTHY');
  });

  test('should mark as UNHEALTHY after reaching unhealthy threshold', () => {
    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: false,
      status: 503,
      latency: 50,
      timestamp: Date.now(),
    };

    const config = buildConfig();
    processHealthCheckResult(upstream, result, config);
    processHealthCheckResult(upstream, result, config);
    processHealthCheckResult(upstream, result, config);

    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.lastFailureTime).toBeDefined();
  });

  test('should mark as HEALTHY after reaching healthy threshold', () => {
    upstream.status = 'UNHEALTHY';
    upstream.lastFailureTime = Date.now() - 10000;

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    const config = buildConfig();
    processHealthCheckResult(upstream, result, config);
    processHealthCheckResult(upstream, result, config);

    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.lastFailureTime).toBeUndefined();
  });

  test('should respect autoEnableOnHealthCheck=false', () => {
    upstream.status = 'UNHEALTHY';
    upstream.disabled = true;
    upstream.healthCheckSuccesses = 1;

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    processHealthCheckResult(upstream, result, buildConfig({ autoEnableOnHealthCheck: false }));

    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.disabled).toBe(true);
  });
});
