import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { parseSupervisedWorkerEnvironment } from '../../src/config-worker/process-environment';
import { deriveWorkerSupervisionSeed, serializeWorkerSupervisionSeed } from '../../src/supervision';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';

const ACCESS_LOG_DB_PATH = resolve('/work/logs/access.db');
const WORKER_DESCRIPTOR_PATH = resolve('/work/runtime/worker.json');

const SUPERVISED_ENV = {
  BUNGEE_MASTER_GENERATION: '50000000-0000-4000-8000-000000000001',
  BUNGEE_WORKER_INSTANCE_ID: '60000000-0000-4000-8000-000000000001',
  BUNGEE_WORKER_SLOT: '0',
  BUNGEE_INTERNAL_TRANSPORT_SECRET: TEST_WORKER_TRANSPORT_SECRET,
  BUNGEE_ACCESS_DB_PATH: ACCESS_LOG_DB_PATH,
  BUNGEE_WORKER_SUPERVISION_SEED: serializeWorkerSupervisionSeed(deriveWorkerSupervisionSeed(
    new Uint8Array(32).fill(1), '50000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001', 0,
  )),
  BUNGEE_WORKER_CONTROL_PORT: '0',
  BUNGEE_MANAGEMENT_HOST: '::1',
  BUNGEE_MANAGEMENT_PORT: '65535',
  BUNGEE_WORKER_DESCRIPTOR_PATH: WORKER_DESCRIPTOR_PATH,
  BUNGEE_WORKER_STARTUP_WATCHDOG_MS: '30000',
  BUNGEE_WORKER_ATTACH_GRACE_MS: '5000',
};

describe('supervised worker process environment', () => {
  test('parses the supervised worker contract without a mode flag', () => {
    expect(parseSupervisedWorkerEnvironment(SUPERVISED_ENV)).toMatchObject({
      identity: {
        master_generation: SUPERVISED_ENV.BUNGEE_MASTER_GENERATION,
        worker_instance_id: SUPERVISED_ENV.BUNGEE_WORKER_INSTANCE_ID,
        worker_slot: 0,
      },
      managementHost: '::1',
      managementPort: 65535,
      controlPort: 0,
      accessLogDbPath: ACCESS_LOG_DB_PATH,
    });
  });

  test.each([
    ['BUNGEE_MANAGEMENT_HOST', '0.0.0.0'],
    ['BUNGEE_MANAGEMENT_PORT', '65536'],
    ['BUNGEE_MANAGEMENT_PORT', ''],
  ] as const)('rejects malformed %s', (name, value) => {
    expect(() => parseSupervisedWorkerEnvironment({ ...SUPERVISED_ENV, [name]: value })).toThrow(name);
  });

  test.each([
    'BUNGEE_MASTER_GENERATION', 'BUNGEE_WORKER_INSTANCE_ID', 'BUNGEE_WORKER_SLOT',
    'BUNGEE_INTERNAL_TRANSPORT_SECRET', 'BUNGEE_ACCESS_DB_PATH', 'BUNGEE_WORKER_SUPERVISION_SEED',
    'BUNGEE_WORKER_CONTROL_PORT', 'BUNGEE_MANAGEMENT_HOST', 'BUNGEE_MANAGEMENT_PORT',
    'BUNGEE_WORKER_DESCRIPTOR_PATH', 'BUNGEE_WORKER_STARTUP_WATCHDOG_MS', 'BUNGEE_WORKER_ATTACH_GRACE_MS',
  ])('rejects missing supervised %s', (name) => {
    const env = { ...SUPERVISED_ENV };
    delete env[name as keyof typeof env];
    expect(() => parseSupervisedWorkerEnvironment(env)).toThrow(name);
  });

  test('accepts a complete, pinned ingress rate-limit session and rejects partial trust input', () => {
    const session = {
      BUNGEE_INGRESS_SUPERVISION_PORT: '3010',
      BUNGEE_INGRESS_PROCESS_INSTANCE_ID: '70000000-0000-4000-8000-000000000001',
      BUNGEE_INGRESS_BOOT_NONCE: '70000000-0000-4000-8000-000000000002',
    };
    expect(parseSupervisedWorkerEnvironment({ ...SUPERVISED_ENV, ...session }).rateLimitSession).toEqual({
      supervisionPort: 3010,
      expectedIngress: {
        process_instance_id: session.BUNGEE_INGRESS_PROCESS_INSTANCE_ID,
        boot_nonce: session.BUNGEE_INGRESS_BOOT_NONCE,
      },
    });
    expect(() => parseSupervisedWorkerEnvironment({ ...SUPERVISED_ENV, BUNGEE_INGRESS_SUPERVISION_PORT: '3010' }))
      .toThrow('rate-limit ingress session');
  });
});
