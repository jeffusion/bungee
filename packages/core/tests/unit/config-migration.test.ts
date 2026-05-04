import { describe, test, expect } from 'bun:test';
import { migrateConfigToLatest } from '../../src/config-migrations/migrate-config';

describe('config migration v1 -> v2', () => {
  test('migrates legacy failover fields into v2 structure', () => {
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

    expect(migrated.originalVersion).toBe(1);
    expect(migrated.finalVersion).toBe(2);
    expect(route.timeouts).toEqual({ requestMs: 30000, connectMs: 5000 });
    expect(route.failover.retryOn).toBe('>=500,!503');
    expect(route.failover.passiveHealth).toEqual({
      consecutiveFailures: 3,
      healthySuccesses: 2,
      autoDisableThreshold: 10,
      autoEnableOnActiveHealthCheck: true,
    });
    expect(route.failover.recovery).toEqual({
      probeIntervalMs: 5000,
      probeTimeoutMs: 3000,
    });
  });

  test('is idempotent for v2 config', () => {
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
    expect(migrated.config).toEqual(v2Config);
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
