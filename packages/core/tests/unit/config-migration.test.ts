import { describe, test, expect } from 'bun:test';
import { migrateConfigToLatest } from '../../src/config-migrations/migrate-config';

describe('config migration to v4', () => {
  test('migrates legacy failover fields to service-level v4 snake_case', () => {
    const legacyConfig = {
      routes: [
        {
          path: '/api',
          upstreams: [{ target: 'http://example.com' }],
          failover: {
            enabled: true,
            retryableStatusCodes: '>=500,!503',
            consecutiveFailuresThreshold: 3,
            healthyThreshold: 2,
            requestTimeoutMs: 30000,
            connectTimeoutMs: 5000,
            autoDisableThreshold: 10,
            autoEnableOnHealthCheck: true,
            recoveryIntervalMs: 5000,
            recoveryTimeoutMs: 3000,
          }
        }
      ]
    };

    const migrated = migrateConfigToLatest(legacyConfig);
    const route = migrated.config.routes[0];
    const service = migrated.config.services?.find(candidate => candidate.name === route.service);

    expect(migrated.originalVersion).toBe(1);
    expect(migrated.finalVersion).toBe(4);

    expect(route.timeouts).toEqual({ request_ms: 30000, connect_ms: 5000 });
    expect(service?.failover?.retry_on).toBe('>=500,!503');
    expect(service?.failover?.passive_health).toEqual({
      consecutive_failures: 3,
      healthy_successes: 2,
      auto_disable_threshold: 10,
      auto_enable_on_active_health_check: true,
    });
    expect(service?.failover?.recovery).toEqual({
      probe_interval_ms: 5000,
      probe_timeout_ms: 3000,
    });

    const services = migrated.config.services ?? [];
    expect(route.service).toBeDefined();
    expect(services.length).toBeGreaterThan(0);
  });

  test('migrates v2 config to v4 service-level snake_case', () => {
    const v2Config = {
      configVersion: 2,
      routes: [
        {
          path: '/api',
          upstreams: [{ target: 'http://example.com' }],
          timeouts: { requestMs: 30000, connectMs: 5000 },
          failover: {
            enabled: true,
            retryOn: [500],
            recovery: { probeIntervalMs: 5000, probeTimeoutMs: 3000 },
          }
        }
      ]
    };

    const migrated = migrateConfigToLatest(v2Config);
    const route = migrated.config.routes[0];
    const service = migrated.config.services?.find(candidate => candidate.name === route.service);

    expect(migrated.finalVersion).toBe(4);
    expect(route.timeouts).toEqual({ request_ms: 30000, connect_ms: 5000 });
    expect(service?.failover?.retry_on).toEqual([500]);
    expect(service?.failover?.recovery).toEqual({ probe_interval_ms: 5000, probe_timeout_ms: 3000 });
    expect(route.service).toBeDefined();
    expect(migrated.config.config_version).toBe(4);
  });

  test('moves v3 route failover and sticky_session onto existing service', () => {
    const v3Config = {
      config_version: 3,
      services: [
        {
          name: 'api-service',
          endpoints: [{ target: 'http://example.com' }],
        },
      ],
      routes: [
        {
          path: '/api',
          service: 'api-service',
          failover: { enabled: true, retry_on: [502] },
          sticky_session: { enabled: true, key_expression: '{{headers["x-session-id"]}}' },
        },
      ],
    };

    const migrated = migrateConfigToLatest(v3Config);
    const route = migrated.config.routes[0];
    const service = migrated.config.services?.[0];

    expect(migrated.finalVersion).toBe(4);
    expect(service?.failover?.retry_on).toEqual([502]);
    expect(service?.load_balancing?.policy).toBe('consistent_hash');
    expect(service?.load_balancing?.hash_policy?.expression).toBe('{{headers["x-session-id"]}}');
    expect('failover' in route).toBe(false);
    expect('sticky_session' in route).toBe(false);
  });

  test('rejects mixed legacy and v2 failover fields', () => {
    const mixedConfig = {
      routes: [
        {
          path: '/api',
          upstreams: [{ target: 'http://example.com' }],
          timeouts: { requestMs: 30000 },
          failover: {
            enabled: true,
            requestTimeoutMs: 30000,
          }
        }
      ]
    };

    expect(() => migrateConfigToLatest(mixedConfig)).toThrow();
  });
});
