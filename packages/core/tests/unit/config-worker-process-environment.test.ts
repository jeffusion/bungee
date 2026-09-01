import { describe, expect, test } from 'bun:test';
import { parseConfigWorkerEnvironment } from '../../src/config-worker/process-environment';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';

const VALID_ENV = {
  BUNGEE_MASTER_GENERATION: '50000000-0000-4000-8000-000000000001',
  BUNGEE_WORKER_INSTANCE_ID: '60000000-0000-4000-8000-000000000001',
  BUNGEE_WORKER_SLOT: '0',
  BUNGEE_MASTER_PID: '1234',
  BUNGEE_HEARTBEAT_TIMEOUT_MS: '5000',
  BUNGEE_SHUTDOWN_TIMEOUT_MS: '2000',
  BUNGEE_INTERNAL_TRANSPORT_SECRET: TEST_WORKER_TRANSPORT_SECRET,
  BUNGEE_ACCESS_DB_PATH: '/work/logs/access.db',
};

describe('config worker process environment', () => {
  test('parses the exact required BUNGEE variables', () => {
    const parsed = parseConfigWorkerEnvironment(VALID_ENV);

    expect(parsed).toEqual({
      identity: {
        master_generation: VALID_ENV.BUNGEE_MASTER_GENERATION,
        worker_instance_id: VALID_ENV.BUNGEE_WORKER_INSTANCE_ID,
        worker_slot: 0,
      },
      masterPid: 1234,
      heartbeatTimeoutMs: 5000,
      shutdownTimeoutMs: 2000,
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      accessLogDbPath: '/work/logs/access.db',
    });
  });

  test('selects the exact required values from a larger environment', () => {
    const parsed = parseConfigWorkerEnvironment({
      ...VALID_ENV,
      UNKNOWN_ENVIRONMENT_VALUE: 'ignored',
    });

    expect(parsed).toEqual({
      identity: {
        master_generation: VALID_ENV.BUNGEE_MASTER_GENERATION,
        worker_instance_id: VALID_ENV.BUNGEE_WORKER_INSTANCE_ID,
        worker_slot: 0,
      },
      masterPid: 1234,
      heartbeatTimeoutMs: 5000,
      shutdownTimeoutMs: 2000,
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      accessLogDbPath: '/work/logs/access.db',
    });
  });

  for (const name of Object.keys(VALID_ENV)) {
    test(`rejects missing ${name}`, () => {
      const env = { ...VALID_ENV };
      delete env[name as keyof typeof env];
      expect(() => parseConfigWorkerEnvironment(env)).toThrow(name);
    });
  }

  test.each([
    ['BUNGEE_MASTER_GENERATION', 'not-a-uuid'],
    ['BUNGEE_WORKER_INSTANCE_ID', 'NOT-A-UUID'],
    ['BUNGEE_WORKER_SLOT', '-1'],
    ['BUNGEE_WORKER_SLOT', '1.5'],
    ['BUNGEE_WORKER_SLOT', '01'],
    ['BUNGEE_MASTER_PID', '0'],
    ['BUNGEE_HEARTBEAT_TIMEOUT_MS', '0'],
    ['BUNGEE_HEARTBEAT_TIMEOUT_MS', '1e3'],
    ['BUNGEE_SHUTDOWN_TIMEOUT_MS', `${Number.MAX_SAFE_INTEGER + 1}`],
    ['BUNGEE_INTERNAL_TRANSPORT_SECRET', 'not-canonical'],
    ['BUNGEE_ACCESS_DB_PATH', 'relative/access.db'],
  ] as const)('rejects malformed %s', (name, value) => {
    expect(() => parseConfigWorkerEnvironment({ ...VALID_ENV, [name]: value })).toThrow(name);
  });
});
