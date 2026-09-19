import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  MASTER_PROCESS_ENV_NAMES,
  MasterProcessOptionsError,
  readMasterProcessOptions,
  resolveWorkerLaunch,
} from '../../src/master-runtime/process-options';

const CWD = '/srv/bungee';
function accessors(env: Readonly<Record<string, string | undefined>> = {}) {
  const reads: string[] = [];
  return {
    reads,
    source: {
      env(name: string): string | undefined {
        reads.push(name);
        return env[name];
      },
      cwd(): string {
        return CWD;
      },
    },
  };
}

describe('master process options', () => {
  test('uses strict defaults, ignores CONFIG_PATH, and freezes the result', () => {
    const env = Object.freeze({ CONFIG_PATH: '/tmp/config.json' });
    const before = { ...env };
    const { reads, source } = accessors(env);

    const options = readMasterProcessOptions(source);

    expect(options).toEqual({
      configDbPath: resolve(CWD, 'data/bungee.db'),
      configDbLockPath: `${resolve(CWD, 'data/bungee.db')}.lock`,
      workerCount: 2,
      host: '0.0.0.0',
      port: 8088,
      managementHost: '127.0.0.1',
      managementPort: 8089,
      ingressControlPort: 3010,
      ingressInstanceLockPath: resolve(CWD, 'data/ingress.instance.lock'),
      startupApplyTimeoutMs: 30_000,
      drainTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
    });
    expect(Object.isFrozen(options)).toBeTrue();
    expect(reads).not.toContain('CONFIG_PATH');
    expect(env).toEqual(before);
  });

  test('resolves relative database paths against cwd and uses the exact database lock suffix', () => {
    const relative = readMasterProcessOptions(accessors({ BUNGEE_CONFIG_DB_PATH: 'state/config.db' }).source);
    const absolute = readMasterProcessOptions(accessors({ BUNGEE_CONFIG_DB_PATH: '/var/lib/bungee/config.db' }).source);

    expect(relative.configDbPath).toBe(resolve(CWD, 'state/config.db'));
    expect(relative.configDbLockPath).toBe(`${resolve(CWD, 'state/config.db')}.lock`);
    expect(absolute.configDbPath).toBe(resolve('/var/lib/bungee/config.db'));
    expect(absolute.configDbLockPath).toBe(`${resolve('/var/lib/bungee/config.db')}.lock`);
  });

  test('parses exact configured environment values', () => {
    const env = Object.freeze({
      BUNGEE_CONFIG_DB_PATH: 'db/config.sqlite',
      WORKER_COUNT: '4',
      HOST: '127.0.0.1',
      PORT: '9000',
      BUNGEE_STARTUP_APPLY_TIMEOUT_MS: '11000',
      BUNGEE_DRAIN_TIMEOUT_MS: '12000',
      BUNGEE_SHUTDOWN_TIMEOUT_MS: '15000',
    });

    const { reads, source } = accessors(env);

    expect(readMasterProcessOptions(source)).toEqual({
      configDbPath: resolve(CWD, 'db/config.sqlite'),
      configDbLockPath: `${resolve(CWD, 'db/config.sqlite')}.lock`,
      workerCount: 4,
      host: '127.0.0.1',
      port: 9000,
      managementHost: '127.0.0.1',
      managementPort: 8089,
      ingressControlPort: 3010,
      ingressInstanceLockPath: resolve(CWD, 'db/ingress.instance.lock'),
      startupApplyTimeoutMs: 11_000,
      drainTimeoutMs: 12_000,
      shutdownTimeoutMs: 15_000,
    });
    expect(reads).toEqual(Object.values(MASTER_PROCESS_ENV_NAMES));
  });

  test('reads only the current master environment contract', () => {
    const { reads, source } = accessors({ UNKNOWN_ENVIRONMENT_VALUE: 'ignored' });

    const options = readMasterProcessOptions(source);

    expect(options).toEqual({
      configDbPath: resolve(CWD, 'data/bungee.db'),
      configDbLockPath: `${resolve(CWD, 'data/bungee.db')}.lock`,
      workerCount: 2,
      host: '0.0.0.0',
      port: 8088,
      managementHost: '127.0.0.1',
      managementPort: 8089,
      ingressControlPort: 3010,
      ingressInstanceLockPath: resolve(CWD, 'data/ingress.instance.lock'),
      startupApplyTimeoutMs: 30_000,
      drainTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
    });
    expect(reads).toEqual(Object.values(MASTER_PROCESS_ENV_NAMES));
  });

  test.each([
    ['WORKER_COUNT', '0'],
    ['WORKER_COUNT', '65'],
    ['WORKER_COUNT', '01'],
    ['WORKER_COUNT', '1.5'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '1e3'],
    ['BUNGEE_STARTUP_APPLY_TIMEOUT_MS', '0'],
    ['BUNGEE_DRAIN_TIMEOUT_MS', '-1'],
    ['BUNGEE_SHUTDOWN_TIMEOUT_MS', `${Number.MAX_SAFE_INTEGER + 1}`],
  ] as const)('rejects out-of-contract %s', (name, value) => {
    expect(() => readMasterProcessOptions(accessors({ [name]: value }).source))
      .toThrow(MasterProcessOptionsError);
    try {
      readMasterProcessOptions(accessors({ [name]: value }).source);
    } catch (error) {
      expect(error).toBeInstanceOf(MasterProcessOptionsError);
      if (error instanceof MasterProcessOptionsError) {
        expect(error.code).toBe('invalid_environment');
        expect(error.variable).toBe(name);
      }
    }
  });

  test.each(['', ' ', ' localhost', 'localhost '] as const)('rejects invalid HOST %p', (host) => {
    expect(() => readMasterProcessOptions(accessors({ HOST: host }).source))
      .toThrow(MasterProcessOptionsError);
  });

  test.each(['localhost', '0.0.0.0', '::', '192.0.2.1', ' 127.0.0.1'] as const)(
    'rejects non-loopback management host %p',
    (managementHost) => {
      expect(() => readMasterProcessOptions(accessors({ BUNGEE_MANAGEMENT_HOST: managementHost }).source))
        .toThrow(MasterProcessOptionsError);
      try {
        readMasterProcessOptions(accessors({ BUNGEE_MANAGEMENT_HOST: managementHost }).source);
      } catch (error) {
        expect(error).toBeInstanceOf(MasterProcessOptionsError);
        if (error instanceof MasterProcessOptionsError) {
          expect(error.code).toBe('invalid_environment');
          expect(error.variable).toBe(MASTER_PROCESS_ENV_NAMES.managementHost);
        }
      }
    },
  );

  test('accepts only loopback management hosts while leaving the data host configurable', () => {
    expect(readMasterProcessOptions(accessors({
      BUNGEE_MANAGEMENT_HOST: '::1', HOST: '192.0.2.1',
    }).source).managementHost).toBe('::1');
    expect(readMasterProcessOptions(accessors({
      BUNGEE_MANAGEMENT_HOST: '127.0.0.1', HOST: '192.0.2.1',
    }).source).host).toBe('192.0.2.1');
  });

});

describe('worker launch resolution', () => {
  test('launches source and dist entries through the current Bun executable', () => {
    const executable = '/opt/bun/bin/bun';
    const sourceEntry = '/repo/packages/core/src/main.ts';
    const distEntry = '/repo/packages/core/dist/main.js';

    const source = resolveWorkerLaunch({ executable, entry: sourceEntry });
    const dist = resolveWorkerLaunch({ executable, entry: distEntry });

    expect(source).toEqual({ source: 'source', executable, args: [sourceEntry] });
    expect(dist).toEqual({ source: 'dist', executable, args: [distEntry] });
    expect(Object.isFrozen(source)).toBeTrue();
    expect(Object.isFrozen(source.args)).toBeTrue();
    expect(Object.isFrozen(dist)).toBeTrue();
    expect(Object.isFrozen(dist.args)).toBeTrue();
  });

  test('launches a compiled binary as the current executable with no script argument', () => {
    const executable = '/usr/local/bin/bungee';

    const launch = resolveWorkerLaunch({ executable, entry: '/$bunfs/root/bungee' });

    expect(launch).toEqual({ source: 'compiled', executable, args: [] });
    expect(Object.isFrozen(launch)).toBeTrue();
    expect(Object.isFrozen(launch.args)).toBeTrue();
  });

  test('accepts canonical relative source and dist entry names', () => {
    const executable = '/opt/bun/bin/bun';

    expect(resolveWorkerLaunch({ executable, entry: 'src/main.ts' }).source).toBe('source');
    expect(resolveWorkerLaunch({ executable, entry: 'dist/main.js' }).source).toBe('dist');
  });

  test('rejects unknown and mismatched worker entries with a typed error', () => {
    for (const entry of ['/repo/src/worker.ts', '/repo/dist/master.js']) {
      expect(() => resolveWorkerLaunch({ executable: '/opt/bun/bin/bun', entry }))
        .toThrow(MasterProcessOptionsError);
      try {
        resolveWorkerLaunch({ executable: '/opt/bun/bin/bun', entry });
      } catch (error) {
        expect(error).toBeInstanceOf(MasterProcessOptionsError);
        if (error instanceof MasterProcessOptionsError) {
          expect(error.code).toBe('invalid_worker_entry');
          expect(error.variable).toBe('entry');
        }
      }
    }
  });
});
