import { describe, expect, test } from 'bun:test';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import {
  startMasterComposition,
  type MasterProcessDependencies,
} from '../../src/master-runtime/composition';

const HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;
const OPTIONS = Object.freeze({
  configDbPath: '/work/data/bungee.db',
  configDbLockPath: '/work/data/bungee.db.lock',
  workerCount: 2,
  host: '127.0.0.1',
  port: 8088,
  startupApplyTimeoutMs: 101,
  drainTimeoutMs: 102,
  heartbeatIntervalMs: 103,
  heartbeatTimeoutMs: 104,
  shutdownTimeoutMs: 105,
});

type Stage =
  | 'config-lock' | 'access-lock' | 'migration' | 'resolver' | 'catalog' | 'repository'
  | 'admission' | 'secret' | 'launch' | 'factory' | 'coordinator'
  | 'generation' | 'listener' | 'runtime' | 'runtime-start' | 'signals';

function fixture(
  failAt?: Stage,
  workerExitConfirmed = true,
) {
  const events: string[] = [];
  let factoryOptions: object | null = null;
  const fail = (stage: Stage): void => {
    events.push(stage);
    if (failAt === stage) throw new Error(`failed:${stage}`);
  };
  const unused = (): never => { throw new Error('unused fake method'); };
  const repository = {
    getSnapshot: unused,
    getActivePublication: unused,
    getOperationState: unused,
    getCurrentOperationState: unused,
    commit: unused,
    beginPublication: unused,
    beginWorkerAttempt: unused,
    beginDrainingRecovery: unused,
    recordWorkerResult: unused,
    markDraining: unused,
    finalizePublication: unused,
    close: () => { events.push('repository.close'); },
  };
  const admission = {
    prepare: unused,
    snapshot: () => [],
    select: () => null,
    clear: () => { events.push('admission.clear'); },
  };
  const workerFactory = {
    spawn: unused,
    pids: () => workerExitConfirmed ? [] : [99],
    owns: () => false,
    subscribeExit: () => () => undefined,
    shutdownAll: async () => { events.push('factory.shutdown'); return []; },
  };
  const listener = {
    port: 8088,
    start: () => undefined,
    stop: async () => { events.push('listener.stop'); },
  };
  const runtime = {
    start: async () => { fail('runtime-start'); },
    shutdown: async () => { events.push('runtime.shutdown'); },
  };
  const compileOptions = Object.freeze({
    pluginSchemas: new Map(),
    availablePlugins: new Set<string>(),
    pluginCatalogHash: HASH,
  });
  const dependencies = {
    context: {
      cwd: '/work',
      moduleDirectory: '/work/packages/core/src',
      executable: '/bun',
      entry: '/work/packages/core/src/main.ts',
      pid: 42,
      accessLogDbPath: '/work/logs/access.db',
    },
    clock: { now: () => 123 },
    readOptions: () => {
      events.push('options');
      return OPTIONS;
    },
    acquireInstanceLock: async (path) => {
      const stage = path === OPTIONS.configDbLockPath ? 'config-lock' : 'access-lock';
      fail(stage);
      return { release: async () => { events.push(`${stage}.release`); } };
    },
    migrateAccessDatabase: async () => { fail('migration'); },
    createPluginPathResolver: () => { fail('resolver'); return {}; },
    buildPluginCatalog: async () => {
      fail('catalog');
      return { hash: HASH, toCompileOptions: () => compileOptions };
    },
    resolveAuthToken: (token: string) => `resolved:${token}`,
    openRepository: (_path, options) => {
      fail('repository');
      expect(options).toEqual({
        compileOptions,
      });
      return repository;
    },
    createAdmission: () => { fail('admission'); return admission; },
    generateTransportSecret: () => { fail('secret'); return 'transport-secret'; },
    resolveWorkerLaunch: (input) => {
      fail('launch');
      expect(input).toEqual({ executable: '/bun', entry: '/work/packages/core/src/main.ts' });
      return { source: 'source' as const, executable: '/bun', args: [input.entry] };
    },
    createWorkerFactory: (options) => {
      fail('factory');
      factoryOptions = options;
      expect(options.transportSecret).toBe('transport-secret');
      expect(options.masterPid).toBe(42);
      expect(options.accessLogDbPath).toBe('/work/logs/access.db');
      return workerFactory;
    },
    createMasterGeneration: () => { fail('generation'); return 'master-generation'; },
    createCoordinator: (options) => {
      fail('coordinator');
      expect(options).toMatchObject({
        repository, workerFactory, admission,
        workerCount: 2, startupApplyTimeoutMs: 101, drainTimeoutMs: 102,
        pluginCatalogHash: HASH, masterGeneration: 'master-generation',
      });
      return { recoverAndPublish: unused, startCurrent: unused, publish: unused };
    },
    createPublicListener: (options) => {
      fail('listener');
      expect(options).toMatchObject({
        hostname: '127.0.0.1', port: 8088,
        transportSecret: 'transport-secret', admission,
      });
      expect(options.controlApi?.handle).toBeFunction();
      return listener;
    },
    createRuntime: () => { fail('runtime'); return runtime; },
    installSignalHandlers: () => {
      fail('signals');
      return { shutdown: runtime.shutdown, remove: () => { events.push('signals.remove'); } };
    },
  } satisfies MasterProcessDependencies;
  return { dependencies, events, factoryOptions: () => factoryOptions };
}

describe('master process composition', () => {
  test('constructs the approved production graph in strict order', async () => {
    const { dependencies, events } = fixture();
    const processHandle = await startMasterComposition(dependencies);

    expect(events).toEqual([
      'options', 'config-lock', 'access-lock', 'migration', 'resolver', 'catalog', 'repository',
      'admission', 'secret', 'launch', 'factory', 'generation', 'coordinator',
      'listener', 'runtime', 'runtime-start', 'signals',
    ]);
    processHandle.removeSignalHandlers();
  });

  test('passes the exact current worker factory options', async () => {
    const { dependencies, factoryOptions } = fixture();
    await startMasterComposition(dependencies);

    expect(factoryOptions()).toEqual({
      launch: { source: 'source', executable: '/bun', args: ['/work/packages/core/src/main.ts'] },
      masterPid: 42,
      heartbeatIntervalMs: 103,
      heartbeatTimeoutMs: 104,
      shutdownTimeoutMs: 105,
      transportSecret: 'transport-secret',
      accessLogDbPath: '/work/logs/access.db',
      cwd: '/work',
    });
  });

  test('returns the exact current master process handle shape', async () => {
    const { dependencies } = fixture();
    const processHandle = await startMasterComposition(dependencies);

    expect(Object.keys(processHandle)).toEqual(['runtime', 'shutdown', 'removeSignalHandlers']);
  });

  test('closes constructed resources in reverse at every failed boundary', async () => {
    const stages: Stage[] = [
      'config-lock', 'access-lock', 'migration', 'resolver', 'catalog', 'repository', 'admission',
      'secret', 'launch', 'factory', 'coordinator', 'listener', 'runtime',
      'generation', 'runtime-start', 'signals',
    ];
    for (const stage of stages) {
      const { dependencies, events } = fixture(stage);
      let failure: unknown;
      try {
        await startMasterComposition(dependencies);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) expect(failure.message).toContain(`failed:${stage}`);
      if (events.includes('runtime.shutdown')) {
        expect(events.at(-1)).toBe('runtime.shutdown');
      } else if (events.includes('factory.shutdown')) {
        expect(events.slice(-5)).toEqual([
          'admission.clear', 'factory.shutdown', 'repository.close',
          'access-lock.release', 'config-lock.release',
        ]);
      } else if (events.includes('repository')) {
        expect(events.slice(-2)).toEqual(['access-lock.release', 'config-lock.release']);
      }
    }
  });

  test('retains the instance lock when worker exit evidence is incomplete', async () => {
    const { dependencies, events } = fixture('coordinator', false);
    let failure: unknown;
    try {
      await startMasterComposition(dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (failure instanceof AggregateError) {
      expect(failure.errors.some((error) =>
        error instanceof Error && error.message.includes('worker exits were not confirmed'))).toBeTrue();
    }
    expect(events).not.toContain('config-lock.release');
    expect(events).not.toContain('access-lock.release');
  });

  test('releases the config lock when access database lock acquisition fails', async () => {
    const { dependencies, events } = fixture('access-lock');

    const failure = await startMasterComposition(dependencies).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain('failed:access-lock');
    expect(events).toEqual(['options', 'config-lock', 'access-lock', 'config-lock.release']);
  });
});
