import { describe, test, expect, beforeEach } from 'bun:test';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../../src/worker/types';
import {
  getHealthCheckConfig,
  processHealthCheckResult,
  type HealthCheckResult,
  type HealthCheckConfig,
} from '../../src/worker/health/checker';

const defaultConfig: HealthCheckConfig = {
  enabled: true,
  interval_ms: 10000,
  timeout_ms: 3000,
  path: '/health',
  method: 'GET',
  expected_status: [200],
  unhealthy_threshold: 3,
  healthy_threshold: 2,
  auto_enable_on_health_check: true,
  content_type: 'application/json',
};

function buildConfig(overrides: Partial<HealthCheckConfig> = {}): HealthCheckConfig {
  return {
    ...defaultConfig,
    ...overrides,
    expected_status: overrides.expected_status ?? [...defaultConfig.expected_status],
    auto_enable_on_health_check: overrides.auto_enable_on_health_check ?? defaultConfig.auto_enable_on_health_check,
  };
}

describe('Health Check - Configuration', () => {
  test('should return null when health check is not enabled', () => {
    const route: EffectiveRouteConfig = {
      path: '/api',
      endpoints: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retry_on: [502, 503],
      },
    };

    const config = getHealthCheckConfig(route);
    expect(config).toBeNull();
  });

  test('should return config with defaults when health check is enabled', () => {
    const route: EffectiveRouteConfig = {
      path: '/api',
      endpoints: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retry_on: [502, 503],
      },
      service_health_check: {
        enabled: true,
      },
    };

    const config = getHealthCheckConfig(route);
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(true);
    expect(config?.interval_ms).toBe(10000);
    expect(config?.timeout_ms).toBe(3000);
    expect(config?.path).toBe('/health');
    expect(config?.method).toBe('GET');
    expect(config?.expected_status).toEqual([200]);
    expect(config?.unhealthy_threshold).toBe(3);
    expect(config?.healthy_threshold).toBe(2);
    expect(config?.auto_enable_on_health_check).toBe(true);
  });

  test('should use custom configuration values', () => {
    const route: EffectiveRouteConfig = {
      path: '/api',
      endpoints: [{ target: 'http://server1.com' }],
      failover: {
        enabled: true,
        retry_on: [502, 503],
        passive_health: {},
      },
      service_health_check: {
        enabled: true,
        interval_ms: 5000,
        timeout_ms: 2000,
        path: '/custom-health',
        method: 'POST',
        expected_status: [200, 204],
        unhealthy_threshold: 5,
        healthy_threshold: 3,
        auto_enable_on_active_health_check: false,
      },
    };

    const config = getHealthCheckConfig(route);
    expect(config).not.toBeNull();
    expect(config?.interval_ms).toBe(5000);
    expect(config?.timeout_ms).toBe(2000);
    expect(config?.path).toBe('/custom-health');
    expect(config?.method).toBe('POST');
    expect(config?.expected_status).toEqual([200, 204]);
    expect(config?.unhealthy_threshold).toBe(5);
    expect(config?.healthy_threshold).toBe(3);
    expect(config?.auto_enable_on_health_check).toBe(false);
  });
});

describe('Health Check - Result Processing', () => {
  let upstream: RuntimeUpstream;

  beforeEach(() => {
    upstream = {
      upstream_id: 'server1',
      target: 'http://server1.com',
      weight: 100,
      status: 'HEALTHY',
      last_failure_time: undefined,
      consecutive_failures: 0,
      consecutive_successes: 0,
      health_check_successes: 0,
      health_check_failures: 0,
      recovery_attempt_count: 0,
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

    expect(upstream.health_check_successes).toBe(1);
    expect(upstream.health_check_failures).toBe(0);
    expect(upstream.status as RuntimeUpstream['status']).toBe('HEALTHY');
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
    expect(upstream.last_failure_time).toBeDefined();
  });

  test('should mark as HEALTHY after reaching healthy threshold', () => {
    upstream.status = 'UNHEALTHY';
    upstream.last_failure_time = Date.now() - 10000;

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

    expect(upstream.status as RuntimeUpstream['status']).toBe('HEALTHY');
    expect(upstream.last_failure_time).toBeUndefined();
  });

  test('should respect auto_enable_on_health_check=false', () => {
    upstream.status = 'UNHEALTHY';
    upstream.is_disabled = true;
    upstream.health_check_successes = 1;

    const result: HealthCheckResult = {
      upstream: 'http://server1.com',
      success: true,
      status: 200,
      latency: 50,
      timestamp: Date.now(),
    };

    processHealthCheckResult(upstream, result, buildConfig({ auto_enable_on_health_check: false }));

    expect(upstream.status as RuntimeUpstream['status']).toBe('HEALTHY');
    expect(upstream.is_disabled).toBe(true);
  });
});
