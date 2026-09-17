import { describe, expect, test } from 'bun:test';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { startMasterComposition, type MasterProcessDependencies } from '../../src/master-runtime/composition';
import { handleManagementRequest, trackManagementResponse } from '../../src/management-listener';
import { MasterRuntime } from '../../src/master-runtime/runtime';
import { MasterStatsInitializationError } from '../../src/master-runtime/master-stats';
import type { ConfigPublicationWorkerProcess, PreparedWorkerAdmission, ServingConfigWorker } from '../../src/config-publication';
import type { DaemonBootstrap } from '../../src/daemon-control/bootstrap';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { DAEMON_AUTHORIZATION_HEADER, DAEMON_BOOT_HEADER, DAEMON_INSTANCE_HEADER, DAEMON_PID_HEADER, DAEMON_SHUTDOWN_PATH } from '../../src/daemon-control';
import { installMasterSignalHandlers } from '../../src/master-runtime/signal-handlers';

const HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;
const OPTIONS = Object.freeze({
  configDbPath: '/work/data/bungee.db',
  configDbLockPath: '/work/data/bungee.db.lock',
  workerCount: 2,
  host: '127.0.0.1',
  port: 8088,
  managementHost: '127.0.0.1',
  managementPort: 8089,
  ingressControlPort: 3010,
  ingressInstanceLockPath: '/work/data/ingress.instance.lock',
  startupApplyTimeoutMs: 101,
  drainTimeoutMs: 102,
  shutdownTimeoutMs: 105,
});

type Stage =
  | 'config-lock' | 'access-lock' | 'migration' | 'claim' | 'resolver' | 'catalog' | 'repository'
  | 'admission' | 'secret' | 'ingress' | 'launch' | 'factory' | 'coordinator'
  | 'generation' | 'listener' | 'runtime' | 'runtime-start' | 'signals';

function fixture(
  failAt?: Stage,
  workerExitConfirmed = true,
  withIngress = false,
  authenticatedIngressSession = true,
  runtimeShutdownError?: Error,
  realRuntime = false,
) {
  const events: string[] = [];
  let factoryOptions: object | null = null;
  let managementOptions: any = null;
  const cleanupProcess = {
    slot: 0,
    identity: {
      master_generation: '30000000-0000-4000-8000-000000000001',
      worker_instance_id: '40000000-0000-4000-8000-000000000001',
      worker_slot: 0,
    },
    pid: 10_000,
    terminate: async () => { events.push('workers.terminate'); },
  } as unknown as ConfigPublicationWorkerProcess;
  const fail = (stage: Stage): void => {
    events.push(stage);
    if (failAt === stage) throw new Error(`failed:${stage}`);
  };
  const unused = (): never => { throw new Error('unused fake method'); };
  const repository = {
    getSnapshot: realRuntime ? recoverySnapshot : unused,
    getServingSnapshot: unused,
    appendServingSnapshot: realRuntime ? () => undefined : unused,
    getActivePublication: realRuntime ? () => null : unused,
    getOperationState: unused,
    getCurrentOperationState: realRuntime ? () => null : unused,
    getCurrentRecovery: () => null,
    createManualRecovery: unused,
    claimRecoveryAttempt: unused,
    scheduleRecoveryRetry: unused,
    succeedRecovery: unused,
    stopRecovery: unused,
    requeueRecovery: unused,
    commit: unused,
    beginPublication: unused,
    beginWorkerAttempt: unused,
    beginDrainingRecovery: unused,
    recordWorkerResult: unused,
    markDraining: unused,
    finalizePublication: unused,
    close: () => { events.push('repository.close'); },
    claimControllerWithCapability: (_capability: unknown, controllerId: string) => {
      fail('claim');
      return { instance_id: '11111111-1111-4111-8111-111111111111', controller_epoch: 1,
        current_controller_id: controllerId, updated_at: 123 };
    },
  };
  const admission = {
    prepare: unused,
    adoptCommitted: unused,
    snapshot: () => [],
    select: () => null,
    clear: () => { events.push('admission.clear'); },
  };
  const workerFactory = {
    spawn: unused,
    pids: () => workerExitConfirmed ? [] : [99],
    owns: () => false,
    snapshot: () => realRuntime ? [cleanupProcess] : [],
    subscribeExit: () => () => undefined,
    subscribeUnavailable: () => () => undefined,
    disconnectAll: () => undefined,
    markCommitted: () => undefined,
    setRateLimitSession: () => undefined,
    retireForIngressBootChange: async () => ({
      kind: 'cleaned' as const, exited: [], spawnedExitUnconfirmed: [], adoptedExitUnknown: [], exitUnknown: [],
    }),
    disconnectProcesses: () => undefined,
    forgetProcessesWithoutExitProof: () => { events.push('workers.forget'); },
    discardConfirmedUncommitted: async () => undefined,
    shutdownAll: async () => { events.push('factory.shutdown'); return []; },
    discoverAndAdopt: unused,
  };
  const listener = {
    port: 8088,
    hostname: '127.0.0.1',
    start: () => { events.push('management.bind'); },
    ready: () => { events.push('management.ready'); },
    stop: async () => { events.push('management.close'); },
  };
  let runtime: {
    start(): Promise<void>;
    shutdown(): Promise<void>;
    shutdownAfterStartupFailure?(): Promise<void>;
    reportAsynchronousFailure(error: Error): void;
  } = {
    start: async () => {
      fail('runtime-start');
      events.push('worker/admission');
      listener.ready();
    },
    shutdown: async () => {
      events.push('runtime.shutdown');
      if (runtimeShutdownError !== undefined) throw runtimeShutdownError;
    },
    reportAsynchronousFailure: () => { events.push('runtime.async-failure'); },
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
      if (!withIngress) expect(options).toEqual({ compileOptions });
      return repository;
    },
    createAdmission: () => { fail('admission'); return admission; },
    deriveTransportSecret: () => { fail('secret'); return Buffer.alloc(32, 7).toString('base64url'); },
    createControllerClaim: () => ({ consume<Result>(claim: () => Result): Result { return claim(); } }),
    resolveWorkerLaunch: (input) => {
      fail('launch');
      expect(input).toEqual({ executable: '/bun', entry: '/work/packages/core/src/main.ts' });
      return { source: 'source' as const, executable: '/bun', args: [input.entry] };
    },
    createWorkerFactory: (options) => {
      fail('factory');
      factoryOptions = options;
      expect(options.transportSecret).toBe(withIngress ? Buffer.alloc(32, 7).toString('base64url') : Buffer.alloc(32).toString('base64url'));
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
      return realRuntime ? {
        recoverAndPublish: async () => ({
          kind: 'degraded' as const,
          http_status: 202 as const,
          error_code: 'control_readiness_failed' as const,
          failures: [],
          operation: { state: 'degraded', error_code: 'control_readiness_failed' },
          serving: [],
          recovery_disposition: 'retryable' as const,
        } as never),
        startCurrent: unused,
        publish: unused,
      } : { recoverAndPublish: unused, startCurrent: unused, publish: unused };
    },
    createManagementListener: (options) => {
      if (failAt === 'listener') throw new Error('failed:listener');
      managementOptions = options;
      expect(options).toMatchObject({
        hostname: '127.0.0.1', port: 8089,
      });
      expect(options.controlApi?.handle).toBeFunction();
      return listener;
    },
    ...(withIngress ? {
      createIngressController: () => {
        fail('ingress');
        return {
          controlPort: 3010,
          authenticatedRateLimitSession: () => authenticatedIngressSession ? ({ supervisionPort: 3010, expectedIngress: {
            process_instance_id: '70000000-0000-4000-8000-000000000001',
            boot_nonce: '70000000-0000-4000-8000-000000000002',
          } }) : null,
          connect: async () => { events.push('ingress-connect'); },
          stop: async () => { events.push('ingress.stop'); },
          cleanupAfterStartupFailure: async () => {
            events.push('ingress.cleanup:preserved');
            return {
              kind: 'preserved' as const,
              origin: 'spawned' as const,
              evidence: {
                registry: {
                  active: {
                    master_generation: '30000000-0000-4000-8000-000000000001',
                    admission_sequence: 1,
                    revision: 1,
                    content_hash: HASH,
                    plugin_catalog_hash: HASH,
                    workers: [{
                      master_generation: cleanupProcess.identity.master_generation,
                      worker_instance_id: cleanupProcess.identity.worker_instance_id,
                      boot_nonce: '50000000-0000-4000-8000-000000000001',
                      worker_slot: cleanupProcess.identity.worker_slot,
                      private_port: 31_000,
                    }],
                  },
                  prepared: null,
                  retired: [],
                },
                statusRefreshed: true,
                pendingAdmission: false,
                uncertainAdmission: false,
                pendingRetiredRelease: false,
                reason: 'active' as const,
              },
            };
          },
          prepare: unused,
          status: unused,
          trustedActiveAdmission: () => null,
        } as unknown as import('../../src/ingress/master-controller').MasterIngressController;
      },
    } : {}),
    createRuntime: (options) => {
      fail('runtime');
      if (!realRuntime) return runtime;
      const actual = new MasterRuntime(options);
      runtime = {
        start: () => actual.start(),
        shutdown: () => actual.shutdown(),
        shutdownAfterStartupFailure: () => actual.shutdownAfterStartupFailure(),
        reportAsynchronousFailure: (error) => { events.push('runtime.async-failure'); actual.reportAsynchronousFailure(error as never); },
      };
      return runtime;
    },
    installSignalHandlers: (signalRuntime) => {
      fail('signals');
      return { shutdown: signalRuntime.shutdown, remove: () => { events.push('signals.remove'); } };
    },
  } satisfies MasterProcessDependencies;
  return { dependencies, events, factoryOptions: () => factoryOptions, managementOptions: () => managementOptions };
}

describe('master process composition', () => {
  test('constructs the approved production graph in strict order', async () => {
    const { dependencies, events } = fixture();
    const processHandle = await startMasterComposition(dependencies);

    expect(events).toEqual([
      'options', 'config-lock', 'access-lock', 'migration', 'resolver', 'catalog', 'repository',
      'admission', 'management.bind', 'launch', 'factory', 'generation', 'coordinator',
      'runtime', 'runtime-start', 'worker/admission', 'management.ready', 'signals',
    ]);
    processHandle.removeSignalHandlers();
  });

  test('binds management before ingress connect or worker construction', async () => {
    const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, events } = fixture(undefined, true, true);
      const handle = await startMasterComposition(dependencies);
      expect(events.indexOf('management.bind')).toBeLessThan(events.indexOf('ingress-connect'));
      expect(events.indexOf('management.bind')).toBeLessThan(events.indexOf('factory'));
      expect(events.indexOf('ingress-connect')).toBeLessThan(events.indexOf('worker/admission'));
      expect(events.indexOf('worker/admission')).toBeLessThan(events.indexOf('management.ready'));
      handle.removeSignalHandlers();
    } finally {
      if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
    }
  });

  test('fails on an occupied management port before constructing ingress or workers', async () => {
    const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, events } = fixture('listener', true, true);
      await expect(startMasterComposition(dependencies)).rejects.toThrow('failed:listener');
      expect(events).not.toContain('ingress');
      expect(events).not.toContain('factory');
    } finally {
      if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
    }
  });

  test('no control catalog leaves the internal route absent and bypasses management handlers', async () => {
    const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, managementOptions } = fixture(undefined, true, true);
      await startMasterComposition(dependencies);
      const options = managementOptions();
      expect(options.internalPluginControl).toBeUndefined();
      let controlCalls = 0;
      const response = await handleManagementRequest(
        new Request('http://127.0.0.1/__bungee/internal/plugin-control/v1'),
        {
          controlApi: { handle: async () => { controlCalls += 1; return null; } },
          internalPluginControl: options.internalPluginControl,
        },
      );
      expect(response.status).toBe(404);
      expect(controlCalls).toBe(0);
    } finally {
      if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
    }
  });

  test('claims the durable controller epoch before any ingress discovery', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, events } = fixture(undefined, true, true);
      const handle = await startMasterComposition(dependencies);
      expect(events.indexOf('claim')).toBeGreaterThan(events.indexOf('access-lock'));
      expect(events.indexOf('claim')).toBeLessThan(events.indexOf('ingress'));
      expect(events.indexOf('ingress-connect')).toBeGreaterThan(events.indexOf('claim'));
      handle.removeSignalHandlers();
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('passes only the authenticated ingress rate-limit session to the factory', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, factoryOptions } = fixture(undefined, true, true);
      await startMasterComposition(dependencies);
      expect(factoryOptions()).toMatchObject({
        rateLimitSession: {
          supervisionPort: 3010,
          expectedIngress: {
            process_instance_id: '70000000-0000-4000-8000-000000000001',
            boot_nonce: '70000000-0000-4000-8000-000000000002',
          },
        },
      });
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('refuses to construct a worker factory without an authenticated ingress session', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies } = fixture(undefined, true, true, false);
      await expect(startMasterComposition(dependencies)).rejects.toThrow('ingress rate-limit session is not authenticated');
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('passes the exact current worker factory options', async () => {
    const { dependencies, factoryOptions } = fixture();
    await startMasterComposition(dependencies);

    expect(factoryOptions()).toMatchObject({
      launch: { source: 'source', executable: '/bun', args: ['/work/packages/core/src/main.ts'] },
      transportSecret: Buffer.alloc(32).toString('base64url'),
      accessLogDbPath: '/work/logs/access.db',
      configDbPath: '/work/data/bungee.db',
      shutdownTimeoutMs: 105,
      runtimeWorkersDirectory: '/work/data/runtime/workers',
      authority: { controller_epoch: 0, controller_id: '00000000-0000-4000-8000-000000000000' },
      cwd: '/work',
    });
  });

  test('arms only after startup and drains the daemon RPC through one shutdown path', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, events, managementOptions } = fixture(undefined, true, true);
      const transitions: string[] = [];
      let armedMetadata: DaemonMetadataV1 | undefined;
      const signalListeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
      const signalSource = {
        on(signal: 'SIGINT' | 'SIGTERM', listener: () => void) { signalListeners.set(signal, listener); },
        off(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
          if (signalListeners.get(signal) === listener) signalListeners.delete(signal);
        },
        emit(signal: 'SIGINT' | 'SIGTERM') { signalListeners.get(signal)?.(); },
      };
      const metadata = {
        schema: 'bungee-daemon-metadata-v1', state: 'starting', launcher_pid: process.pid,
        boot_nonce: 'abcdef12-3456-7890-abcd-ef1234567890', shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        executable: '/bun', entrypoint: '/work/packages/core/src/main.ts', pid: process.pid,
        instance_id: null, management_host: null, management_port: null,
      } as const;
      const daemonBootstrap = {
        metadataPath: '/work/run/daemon.json', bootNonce: metadata.boot_nonce, shutdownSecret: metadata.shutdown_secret,
        pid: process.pid, metadata,
        store: {
          file: { runtimeDirectory: '/work/run' },
          read: async () => metadata,
          transition: async (_path: string, input: { next: any }) => {
            transitions.push(input.next.state);
            if (input.next.state === 'armed') armedMetadata = input.next;
            return input.next;
          },
          deleteForMaster: async () => { transitions.push('absent'); return true; },
        },
      } as unknown as DaemonBootstrap;
      const handle = await startMasterComposition({
        ...dependencies,
        installSignalHandlers: (runtime) => installMasterSignalHandlers({
          runtime, source: signalSource, onError: () => undefined,
        }),
      }, daemonBootstrap);
      expect(transitions).toEqual(['armed']);
      expect(armedMetadata).toMatchObject({
        instance_id: '11111111-1111-4111-8111-111111111111',
        management_host: '127.0.0.1', management_port: 8088,
      });
      const options = managementOptions()!;
      expect(options.daemonControl).toBeDefined();
      let settle: (() => void | Promise<void>) | undefined;
      const response = await options.daemonControl.handle(new Request(`http://127.0.0.1${DAEMON_SHUTDOWN_PATH}`, {
        method: 'POST',
        headers: {
          [DAEMON_AUTHORIZATION_HEADER]: `Bearer ${metadata.shutdown_secret}`,
          [DAEMON_BOOT_HEADER]: metadata.boot_nonce,
          [DAEMON_INSTANCE_HEADER]: '11111111-1111-4111-8111-111111111111',
          [DAEMON_PID_HEADER]: String(process.pid),
          'content-length': '0',
        },
      }), { onResponseSettled: (callback: () => void | Promise<void>) => { settle = callback; } });
      expect(response.status).toBe(202);
      const tracked = trackManagementResponse(response, () => { void settle?.(); });
      expect(events).not.toContain('runtime.shutdown');
      expect(await tracked.text()).toBe(JSON.stringify({ status: 'accepted', boot_nonce: metadata.boot_nonce, instance_id: '11111111-1111-4111-8111-111111111111', pid: metadata.pid }));
      const shutdown = handle.shutdown();
      expect(shutdown).toBe(handle.runtime.shutdown());
      signalSource.emit('SIGTERM');
      expect(shutdown).toBe(handle.shutdown());
      await shutdown;
      expect(events.filter((event) => event === 'runtime.shutdown')).toHaveLength(1);
      expect(transitions).toEqual(['armed', 'stopping', 'absent']);
      handle.removeSignalHandlers();
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('does not return a handle when shutdown races the armed metadata transition', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, events, managementOptions } = fixture(undefined, true, true);
      const transitions: string[] = [];
      const arm = deferred<void>();
      let armStarted = false;
      const metadata = {
        schema: 'bungee-daemon-metadata-v1', state: 'starting', launcher_pid: process.pid,
        boot_nonce: 'abcdef12-3456-7890-abcd-ef1234567890', shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        executable: '/bun', entrypoint: '/work/packages/core/src/main.ts', pid: process.pid,
        instance_id: null, management_host: null, management_port: null,
      } as const;
      const daemonBootstrap = {
        metadataPath: '/work/run/daemon.json', bootNonce: metadata.boot_nonce, shutdownSecret: metadata.shutdown_secret,
        pid: process.pid, metadata,
        store: {
          file: { runtimeDirectory: '/work/run' },
          read: async () => metadata,
          transition: async (_path: string, input: { next: any }) => {
            transitions.push(input.next.state);
            if (input.next.state === 'armed') { armStarted = true; await arm.promise; }
            return input.next;
          },
          deleteForMaster: async () => { transitions.push('absent'); return true; },
        },
      } as unknown as DaemonBootstrap;
      const startup = startMasterComposition(dependencies, daemonBootstrap);
      while (!armStarted) await new Promise((resolve) => setTimeout(resolve, 0));
      const options = managementOptions()!;
      let settle: (() => void | Promise<void>) | undefined;
      const response = await options.daemonControl.handle(new Request(`http://127.0.0.1${DAEMON_SHUTDOWN_PATH}`, {
        method: 'POST',
        headers: {
          [DAEMON_AUTHORIZATION_HEADER]: `Bearer ${metadata.shutdown_secret}`,
          [DAEMON_BOOT_HEADER]: metadata.boot_nonce,
          [DAEMON_INSTANCE_HEADER]: '11111111-1111-4111-8111-111111111111',
          [DAEMON_PID_HEADER]: String(process.pid),
          'content-length': '0',
        },
      }), { onResponseSettled: (callback: () => void | Promise<void>) => { settle = callback; } });
      expect(response.status).toBe(202);
      const tracked = trackManagementResponse(response, () => { void settle?.(); });
      expect(events).not.toContain('runtime.shutdown');
      await tracked.text();
      expect(events).toContain('runtime.shutdown');
      arm.resolve();
      await expect(startup).rejects.toMatchObject({ code: 'startup_cancelled' });
      expect(transitions).toEqual(['armed', 'stopping', 'absent']);
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('starts runtime first and keeps armed metadata when stopping transition rejects', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, events } = fixture(undefined, true, true);
      const evidence = daemonBootstrapForTest({ stoppingError: new Error('stopping failed'), timeline: events });
      const handle = await startMasterComposition(dependencies, evidence.bootstrap);
      await expect(handle.shutdown()).rejects.toThrow('master shutdown failed');
      expect(events).toContain('runtime.shutdown');
      expect(events.indexOf('runtime.shutdown')).toBeLessThan(events.indexOf('transition:stopping'));
      expect(evidence.transitions).toEqual(['armed', 'stopping']);
      expect(evidence.diskMetadata()?.state).toBe('armed');
      expect(evidence.transitions).not.toContain('delete');
      handle.removeSignalHandlers();
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('retains stopping metadata when runtime cleanup rejects', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies } = fixture(undefined, true, true, true, new Error('runtime failed'));
      const evidence = daemonBootstrapForTest();
      const handle = await startMasterComposition(dependencies, evidence.bootstrap);
      await expect(handle.shutdown()).rejects.toThrow('master shutdown failed');
      expect(evidence.transitions).toEqual(['armed', 'stopping']);
      expect(evidence.diskMetadata()?.state).toBe('stopping');
      expect(evidence.transitions).not.toContain('delete');
      handle.removeSignalHandlers();
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('rejects shutdown and preserves stopping metadata when deletion is unconfirmed or fails', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      for (const options of [{ deleteResult: false }, { deleteError: new Error('delete failed') }]) {
        const { dependencies } = fixture(undefined, true, true);
        const evidence = daemonBootstrapForTest(options);
        const handle = await startMasterComposition(dependencies, evidence.bootstrap);
        await expect(handle.shutdown()).rejects.toThrow();
        expect(evidence.transitions).toEqual(['armed', 'stopping', 'delete']);
        expect(evidence.diskMetadata()?.state).toBe('stopping');
        handle.removeSignalHandlers();
      }
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('uses startup cleanup and removes signals when arming rejects', async () => {
    const original = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { dependencies, events } = fixture(undefined, false, true, true, undefined, true);
      let removeCalls = 0;
      const source = {
        on() {},
        off() { removeCalls += 1; },
      };
      const armError = new Error('armed transition failed');
      const evidence = daemonBootstrapForTest({ armError, timeline: events });
      const handleDependencies = {
        ...dependencies,
        installSignalHandlers: (runtime: { shutdown(): Promise<void> }) => installMasterSignalHandlers({
          runtime,
          source,
          onError: () => undefined,
        }),
      };
      const failure = await startMasterComposition(handleDependencies, evidence.bootstrap).catch((error: unknown) => error);
      expect(failure).toBe(armError);
      await Promise.resolve();
      expect(events).toContain('management.close');
      expect(events).toContain('ingress.cleanup:preserved');
      expect(events).toContain('workers.forget');
      expect(events).not.toContain('factory.shutdown');
      expect(events).not.toContain('workers.terminate');
      expect(events).toContain('repository.close');
      expect(events).toContain('access-lock.release');
      expect(events).toContain('config-lock.release');
      expect(events).not.toContain('lock.retained');
      expect(evidence.transitions).toEqual(['armed']);
      expect(removeCalls).toBe(2);
    } finally {
      if (original === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = original;
    }
  });

  test('returns the exact current master process handle shape', async () => {
    const { dependencies, managementOptions } = fixture();
    const processHandle = await startMasterComposition(dependencies);

    expect(Object.keys(processHandle)).toEqual(['runtime', 'shutdown', 'removeSignalHandlers']);
    expect(managementOptions()!.daemonControl).toBeUndefined();
  });

  test('closes constructed resources in reverse at every failed boundary', async () => {
    const stages: Stage[] = [
      'config-lock', 'access-lock', 'migration', 'resolver', 'catalog', 'repository', 'admission',
      'launch', 'factory', 'coordinator', 'listener', 'runtime',
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

  test('disconnects workers without shutting down adopted state when construction fails', async () => {
    const { dependencies, events } = fixture('coordinator', false);
    let failure: unknown;
    try {
      await startMasterComposition(dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(events).toContain('config-lock.release');
    expect(events).toContain('access-lock.release');
    expect(events).not.toContain('factory.shutdown');
  });

  test('releases the config lock when access database lock acquisition fails', async () => {
    const { dependencies, events } = fixture('access-lock');

    const failure = await startMasterComposition(dependencies).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain('failed:access-lock');
    expect(events).toEqual(['options', 'config-lock', 'access-lock', 'config-lock.release']);
  });

  test('retains instance locks when stats initialization cannot close its database', async () => {
    const { dependencies, events } = fixture();
    const failure = new MasterStatsInitializationError(new Error('pragma failed'), new Error('close failed'));

    await expect(startMasterComposition({ ...dependencies, createMasterStats: () => { throw failure; } })).rejects.toBeInstanceOf(AggregateError);
    expect(events).not.toContain('access-lock.release');
    expect(events).not.toContain('config-lock.release');
  });
});

function recoverySnapshot() {
  return {
    revision: 7,
    content_hash: HASH,
    aggregate: { logical_configuration: { services: [], routes: [] }, plugin_activations: [] },
  } as never;
}

function recoveryWorker(process: ConfigPublicationWorkerProcess): ServingConfigWorker {
  return {
    process,
    boot_nonce: '40000000-0000-4000-8000-000000000001',
    revision: 7,
    content_hash: HASH,
    plugin_catalog_hash: HASH,
    publication: null,
    private_port: 41_234,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function daemonBootstrapForTest(options: {
  readonly armError?: Error;
  readonly stoppingError?: Error;
  readonly deleteResult?: boolean;
  readonly deleteError?: Error;
  readonly timeline?: string[];
} = {}): {
  readonly bootstrap: DaemonBootstrap;
  readonly transitions: string[];
  readonly diskMetadata: () => DaemonMetadataV1 | null;
} {
  const metadata: DaemonMetadataV1 = {
    schema: 'bungee-daemon-metadata-v1', state: 'starting', launcher_pid: process.pid,
    boot_nonce: 'abcdef12-3456-7890-abcd-ef1234567890', shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    executable: '/bun', entrypoint: '/work/packages/core/src/main.ts', pid: process.pid,
    instance_id: null, management_host: null, management_port: null,
  };
  let persisted: DaemonMetadataV1 | null = metadata;
  const transitions: string[] = [];
  const bootstrap = {
    metadataPath: '/work/run/daemon.json', bootNonce: metadata.boot_nonce, shutdownSecret: metadata.shutdown_secret,
    pid: process.pid, metadata,
    store: {
      file: { runtimeDirectory: '/work/run' },
      read: async () => persisted ?? metadata,
      transition: async (_path: string, input: { next: DaemonMetadataV1 }) => {
        transitions.push(input.next.state);
        options.timeline?.push(`transition:${input.next.state}`);
        if (input.next.state === 'armed' && options.armError !== undefined) {
          options.timeline?.push('failure:daemon-arm');
          throw options.armError;
        }
        if (input.next.state === 'stopping' && options.stoppingError !== undefined) throw options.stoppingError;
        persisted = input.next;
        return input.next;
      },
      deleteForMaster: async () => {
        transitions.push('delete');
        options.timeline?.push('delete');
        if (options.deleteError !== undefined) throw options.deleteError;
        if (options.deleteResult === false) return false;
        persisted = null;
        return true;
      },
    },
  } as unknown as DaemonBootstrap;
  return { bootstrap, transitions, diskMetadata: () => persisted };
}

function recoveryDependencies(input: {
  readonly withIngress?: boolean;
  readonly realRuntime?: boolean;
  readonly primeRuntime?: boolean;
  readonly getActivePublication?: () => unknown;
  readonly recoverAndPublish?: (options: { readonly admission: { prepare(workers: readonly ServingConfigWorker[]): Promise<{ commit(): Promise<void> }> } }) => Promise<unknown>;
  readonly startCurrent?: (options: { readonly admission: { prepare(workers: readonly ServingConfigWorker[]): Promise<{ commit(): Promise<void> }> } }, serving: ServingConfigWorker) => Promise<unknown>;
  readonly retireForIngressBootChange?: (process: ConfigPublicationWorkerProcess, broadcastExit: () => void, record: (event: string) => void) => Promise<unknown>;
  readonly localPrepare?: (workers: readonly ServingConfigWorker[], signal?: AbortSignal) => Promise<PreparedWorkerAdmission>;
  readonly remotePrepare?: (workers: readonly ServingConfigWorker[], signal?: AbortSignal) => Promise<PreparedWorkerAdmission>;
  readonly rateLimitSession?: (token?: number) => unknown;
  readonly fenceAndStatus?: (token?: number) => Promise<unknown>;
}) {
  const events: string[] = [];
  const snapshot = recoverySnapshot();
  const process = {
    slot: 0,
    identity: {
      master_generation: '10000000-0000-4000-8000-000000000001',
      worker_instance_id: '20000000-0000-4000-8000-000000000001',
      worker_slot: 0,
    },
    pid: 50_000,
    send: async () => undefined,
    subscribeMessage: () => () => undefined,
    subscribeExit: () => () => undefined,
    terminate: async () => { events.push('terminate'); },
  } as ConfigPublicationWorkerProcess;
  const serving = recoveryWorker(process);
  let admitted: readonly ServingConfigWorker[] = [];
  let ingressOptions: { onRecovered?: (event: unknown) => Promise<unknown>; onNewBootAccepted?: (event: unknown) => void } | undefined;
  let runtimeReady = false;
  let runtime: { start(): Promise<void>; shutdown(): Promise<void>; reportAsynchronousFailure(error: Error): void };
  let composedCoordinator: { recoverAndPublish(): Promise<unknown> } | undefined;
  let composedAdmission: { prepare(workers: readonly ServingConfigWorker[], signal?: AbortSignal): Promise<PreparedWorkerAdmission> } | undefined;
  let recoveryGate: {
    readonly generation: number;
    readonly isActive: () => boolean;
    readonly signal: AbortSignal;
    readonly activate: () => number;
    readonly release: (generation: number) => void;
    readonly cancel: () => void;
  } | undefined;
  let exitListener: ((process: ConfigPublicationWorkerProcess) => void) | undefined;
  let fatalCount = 0;
  let reports = 0;
  let recoveryReads = 0;
  let latestRateLimitSession: unknown;
  const repository = {
    getSnapshot: () => snapshot,
    getActivePublication: () => input.getActivePublication?.() ?? null,
    getServingSnapshot: () => null,
    appendServingSnapshot: () => { events.push('append'); },
    getOperationState: () => null,
    getCurrentOperationState: () => null,
    getCurrentRecovery: () => { recoveryReads += 1; return null; },
    beginPublication: () => null,
    beginWorkerAttempt: () => null,
    beginDrainingRecovery: () => null,
    recordWorkerResult: () => null,
    markDraining: () => null,
    finalizePublication: () => null,
    commit: () => null,
    close: () => undefined,
    claimControllerWithCapability: () => ({
      instance_id: '11111111-1111-4111-8111-111111111111', controller_epoch: 1,
      current_controller_id: '00000000-0000-4000-8000-000000000001', updated_at: 1,
    }),
  };
  const admission = {
    prepare: async (workers: readonly ServingConfigWorker[], signal?: AbortSignal) => input.localPrepare?.(workers, signal) ?? ({
        commit: async () => { admitted = workers; },
        abort: async () => undefined,
        releaseRetiredAfterExitProof: async () => undefined,
      }),
    adoptCommitted: (workers: readonly ServingConfigWorker[]) => { admitted = workers; },
    snapshot: () => admitted,
    select: () => null,
    clear: () => { events.push('admission.clear'); admitted = []; },
  };
  const workerFactory = {
    spawn: (_identity: unknown) => { events.push('worker-spawn'); return process; },
    pids: () => [],
    owns: (candidate: ConfigPublicationWorkerProcess) => candidate === process,
    subscribeExit: (listener: (candidate: ConfigPublicationWorkerProcess) => void) => {
      exitListener = listener;
      return () => { exitListener = undefined; };
    },
    subscribeUnavailable: () => () => undefined,
    disconnectAll: () => undefined,
    markCommitted: () => undefined,
    setRateLimitSession: (session: unknown) => { latestRateLimitSession = session; events.push('rate-limit-session'); },
    retireForIngressBootChange: async () => input.retireForIngressBootChange === undefined
      ? { kind: 'cleaned', exited: [], spawnedExitUnconfirmed: [], adoptedExitUnknown: [], exitUnknown: [] }
      : await input.retireForIngressBootChange(process, () => exitListener?.(process), (event) => { events.push(event); }),
    disconnectProcesses: () => undefined,
    forgetProcessesWithoutExitProof: () => undefined,
    discardConfirmedUncommitted: async () => undefined,
    shutdownAll: async () => [],
  };
  const coordinatorOptions = { admission };
  const defaultStart = async (options: typeof coordinatorOptions) => {
    const prepared = await options.admission.prepare([serving]);
    await prepared.commit();
    return { kind: 'startup_ready', serving: [serving] };
  };
  const dependencies = {
    context: { cwd: '/work', moduleDirectory: '/work', executable: '/bun', entry: '/work/worker.ts', pid: 42, accessLogDbPath: '/work/access.db' },
    clock: { now: () => 1 },
    readOptions: () => ({ configDbPath: '/work/config.db', configDbLockPath: '/work/config.lock', workerCount: 1, host: '127.0.0.1', port: 8088, managementHost: '127.0.0.1', managementPort: 8089, ingressControlPort: 3010, ingressInstanceLockPath: '/work/ingress.lock', startupApplyTimeoutMs: 100, drainTimeoutMs: 100 }),
    acquireInstanceLock: async () => ({ release: async () => undefined }),
    migrateAccessDatabase: async () => undefined,
    createPluginPathResolver: () => ({}),
    buildPluginCatalog: async () => ({ hash: HASH, toCompileOptions: () => ({ pluginSchemas: new Map(), availablePlugins: new Set(), pluginCatalogHash: HASH }) }),
    resolveAuthToken: () => undefined,
    openRepository: () => repository,
    createAdmission: () => admission,
    resolveWorkerLaunch: () => ({ source: 'source', executable: '/bun', args: [] }),
    createWorkerFactory: () => workerFactory,
    createMasterGeneration: () => '10000000-0000-4000-8000-000000000001',
    createCoordinator: (options: typeof coordinatorOptions) => {
      composedAdmission = options.admission;
      return ({
      recoverAndPublish: async () => input.recoverAndPublish?.(options) ?? null,
      startCurrent: async () => {
        events.push('startCurrent');
        return input.startCurrent?.(options, serving) ?? defaultStart(options);
      },
      publish: async () => ({ kind: 'converged', http_status: 200, operation: {} as never, serving: [serving] }),
      });
    },
    createManagementListener: () => ({ port: 8089, start: () => undefined, stop: async () => undefined }),
    createControllerClaim: () => ({ consume<Result>(claim: () => Result): Result { return claim(); } }),
    deriveTransportSecret: () => Buffer.alloc(32, 9).toString('base64url'),
    ...(input.withIngress ? {
      createIngressController: (options: { onRecovered?: (event: unknown) => Promise<unknown>; onNewBootAccepted?: (event: unknown) => void }) => {
        ingressOptions = options;
        return {
          controlPort: 3010, publicPort: 8088,
          authenticatedRateLimitSession: (token?: number) => input.rateLimitSession?.(token) ?? ({ supervisionPort: 3010, expectedIngress: {
            process_instance_id: '70000000-0000-4000-8000-000000000001',
            boot_nonce: '70000000-0000-4000-8000-000000000002',
          } }),
          connect: async () => undefined, stop: async () => undefined,
          disconnect: async () => undefined, shutdownDataPlane: async () => undefined,
          trustedActiveAdmission: () => null, hasTrustedActiveAdmission: () => false,
          trustedActiveAdmissionIfFresh: () => null,
          isMutationReady: () => true,
          subscribeEligibilityChange: () => () => undefined,
          prepare: async (workers: readonly ServingConfigWorker[], signal?: AbortSignal) => {
            events.push('ingress-prepare');
            return input.remotePrepare?.(workers, signal) ?? { commit: async () => undefined, abort: async () => undefined };
          },
          status: async () => ({ state: 'attached', registry: { active: null, prepared: null, retired: [] } }),
          fenceAndStatus: async (_token?: number) => {
            events.push('fence-and-status');
            return input.fenceAndStatus === undefined
              ? { active: null, prepared: null, retired: [] }
              : await input.fenceAndStatus(_token);
          },
        };
      },
    } : {}),
    createRuntime: (options: any) => {
      composedCoordinator = options.coordinator;
      recoveryGate = options.ingressBootRecoveryGate;
      if (!input.realRuntime) {
        runtime = {
          start: async () => {
            if (input.primeRuntime) await options.coordinator.startCurrent(snapshot);
            runtimeReady = true;
          },
          shutdown: async () => undefined,
          reportAsynchronousFailure: () => { reports += 1; },
        };
        return runtime;
      }
      const actual = new MasterRuntime({ ...options, onFatal: () => { fatalCount += 1; } });
      runtime = {
        start: () => actual.start(),
        shutdown: () => actual.shutdown(),
        reportAsynchronousFailure: (error) => { reports += 1; actual.reportAsynchronousFailure(error as never); },
      };
      return runtime;
    },
    installSignalHandlers: (value: any) => ({ shutdown: () => value.shutdown(), remove: () => undefined }),
  } as unknown as MasterProcessDependencies;
  return {
    dependencies,
    events,
    serving,
    runtime: () => runtime,
    ingressOptions: () => ingressOptions,
    newBootEvent: (token = 1) => {
      const event = { kind: 'new_boot' as const, previous: {} as never, current: {} as never, token };
      ingressOptions?.onNewBootAccepted?.(event);
      return event;
    },
    recover: () => composedCoordinator!.recoverAndPublish(),
    admission: () => composedAdmission!,
    gate: () => recoveryGate!,
    latestRateLimitSession: () => latestRateLimitSession,
    counts: () => ({ fatalCount, reports, runtimeReady, admitted, recoveryReads }),
    triggerExit: () => { exitListener?.(process); },
    repository,
    workerFactory,
    admit: (workers: readonly ServingConfigWorker[]) => { admitted = workers; },
  };
}

test('does not recover before the active snapshot is durably remembered after a transient pre-read failure', async () => {
  const active = { snapshot: recoverySnapshot(), operation: { mutation_id: 'mutation-1' } };
  let reads = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    primeRuntime: true,
    getActivePublication: () => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('repository read failed'), { code: 'repository_failure' });
      return reads === 2 ? active : null;
    },
    recoverAndPublish: async (options) => {
      harness.events.push('base-recover');
      harness.workerFactory.spawn(harness.serving.process.identity);
      const prepared = await options.admission.prepare([harness.serving]);
      await prepared.commit();
      return { kind: 'converged', http_status: 200, operation: {} as never, serving: [harness.serving] };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    await harness.recover!().catch((error) => { throw error; });
    await harness.recover!().catch((error) => { throw error; });
    expect(harness.events.indexOf('append')).toBeGreaterThanOrEqual(0);
    expect(harness.events.filter((event) => event === 'append')).toHaveLength(1);
    expect(harness.events.indexOf('append')).toBeLessThan(harness.events.indexOf('base-recover'));
    expect(harness.events.indexOf('append')).toBeLessThan(harness.events.indexOf('worker-spawn'));
    expect(harness.events.indexOf('append')).toBeLessThan(harness.events.indexOf('ingress-prepare'));
    expect(reads).toBe(2);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('does not revive non-durable ingress recovery work', async () => {
  let reads = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  const harness = recoveryDependencies({
    withIngress: true,
    realRuntime: true,
    getActivePublication: () => {
      reads += 1;
      if (reads === 2) throw Object.assign(new Error('serving snapshot is corrupt'), { code: 'serving_snapshot_corrupt' });
      return null;
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    await harness.ingressOptions()!.onRecovered!({ kind: 'same_boot' }).catch((error) => { throw error; });
    await handle.shutdown().catch(() => undefined);
    expect(harness.counts().reports).toBe(0);
    expect(harness.counts().fatalCount).toBe(0);
    expect(reads).toBeLessThanOrEqual(1);
    expect(unhandled).toHaveLength(0);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    process.off('unhandledRejection', onUnhandled);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('retires old workers before the existing supervisor repairs a new ingress boot', async () => {
  const harness = recoveryDependencies({
    withIngress: true,
    realRuntime: true,
    startCurrent: async (options, serving) => {
      const prepared = await options.admission.prepare([serving]);
      await prepared.commit();
      return { kind: 'startup_ready', serving: [serving] };
    },
    retireForIngressBootChange: async (process, broadcastExit, record) => {
      record('retire-start');
      await process.terminate('graceful');
      record('exit-broadcast');
      broadcastExit();
      record('retire-end');
      return { kind: 'cleaned', exited: [], spawnedExitUnconfirmed: [], adoptedExitUnknown: [], exitUnknown: [] };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const baseline = harness.events.length;
    const event = harness.newBootEvent();
    await harness.ingressOptions()!.onRecovered!(event);
    const index = (event: string): number => harness.events.indexOf(event, baseline);
    for (let attempt = 0; attempt < 20 && index('startCurrent') < 0; attempt += 1) await Promise.resolve();
    expect(index('admission.clear')).toBe(-1);
    expect(index('rate-limit-session')).toBeGreaterThanOrEqual(0);
    expect(index('fence-and-status')).toBeGreaterThan(index('rate-limit-session'));
    expect(index('retire-start')).toBeGreaterThanOrEqual(0);
    expect(index('retire-start')).toBeGreaterThan(index('fence-and-status'));
    expect(index('terminate')).toBeGreaterThan(index('retire-start'));
    expect(index('exit-broadcast')).toBeGreaterThan(index('terminate'));
    expect(index('retire-end')).toBeGreaterThan(index('exit-broadcast'));
    expect(index('startCurrent')).toBeGreaterThan(index('retire-end'));
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('same-boot recovery only wakes the recovery runner', async () => {
  const harness = recoveryDependencies({ withIngress: true, realRuntime: true });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const baseline = harness.events.length;
    const recoveryReadsBefore = harness.counts().recoveryReads;
    const onRecovered = harness.ingressOptions()!.onRecovered as (event: { kind: 'same_boot' }) => Promise<unknown>;
    await onRecovered({ kind: 'same_boot' });
    const after = harness.events.slice(baseline);
    expect(harness.counts().recoveryReads).toBe(recoveryReadsBefore + 1);
    expect(after).not.toContain('rate-limit-session');
    expect(after).not.toContain('fence-and-status');
    expect(after).not.toContain('retire-start');
    expect(after).not.toContain('startCurrent');
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test.each(['cleanup_debt', 'retryable'] as const)(
  'new-boot %s never starts a replacement before cleanup succeeds',
  async (kind) => {
    let cleanupCalls = 0;
    const harness = recoveryDependencies({
      withIngress: true,
      realRuntime: true,
      retireForIngressBootChange: async (_process, _broadcastExit, record) => {
        cleanupCalls += 1;
        record('retire-finished');
        if (cleanupCalls > 1) {
          return { kind: 'cleaned', exited: [], spawnedExitUnconfirmed: [], adoptedExitUnknown: [], exitUnknown: [] };
        }
        return kind === 'cleanup_debt'
          ? { kind, exited: [], spawnedExitUnconfirmed: [], adoptedExitUnknown: [], exitUnknown: [] }
          : { kind, code: 'registry_unavailable', exited: [], spawnedExitUnconfirmed: [], adoptedExitUnknown: [], exitUnknown: [] };
      },
    });
    const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
    try {
      handle = await startMasterComposition(harness.dependencies);
      const baseline = harness.events.length;
      harness.triggerExit();
      const event = harness.newBootEvent();
      await expect(harness.ingressOptions()!.onRecovered!(event)).resolves.toBe('retryable');
      const after = harness.events.slice(baseline);
      expect(after).toContain('retire-finished');
      expect(after).not.toContain('startCurrent');
      expect(after).not.toContain('worker-spawn');
      expect(harness.gate().isActive()).toBe(true);
      await expect(harness.ingressOptions()!.onRecovered!(event)).resolves.toBe('complete');
      expect(cleanupCalls).toBe(2);
      expect(harness.gate().isActive()).toBe(false);
    } finally {
      await handle?.shutdown().catch(() => undefined);
      if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
    }
  },
);

test('new-boot gate aborts an in-flight admission before cleanup and retries repair afterwards', async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  let preparedReady = false;
  const harness = recoveryDependencies({
    withIngress: true,
    realRuntime: true,
    startCurrent: async (options, serving) => {
      starts += 1;
      try {
        const prepared = await options.admission.prepare([serving]);
        if (starts === 2) {
          preparedReady = true;
          await blocker;
        }
        await prepared.commit();
        harness.events.push(`admission-commit-${starts}`);
      } catch (error) {
        harness.events.push(`admission-abort-${starts}`);
        throw error;
      }
      return { kind: 'startup_ready', serving: [serving] };
    },
    retireForIngressBootChange: async (_process, _broadcastExit, record) => {
      record('retire-finished');
      return { kind: 'cleaned', exited: [], spawnedExitUnconfirmed: [], adoptedExitUnknown: [], exitUnknown: [] };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    harness.triggerExit();
    for (let attempt = 0; attempt < 20 && !preparedReady; attempt += 1) await Promise.resolve();
    expect(starts).toBe(2);
    const event = harness.newBootEvent();
    const bootRecovery = harness.ingressOptions()!.onRecovered!(event);
    release();
    await bootRecovery;
    const events = harness.events;
    expect(events).toContain('admission-commit-1');
    expect(events).toContain('admission-abort-2');
    expect(events.indexOf('admission-abort-2')).toBeLessThan(events.indexOf('retire-finished'));
    for (let attempt = 0; attempt < 20 && !events.includes('admission-commit-3'); attempt += 1) await Promise.resolve();
    expect(events.indexOf('admission-commit-3')).toBeGreaterThan(events.indexOf('retire-finished'));
  } finally {
    release();
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('a queued new-boot task does not discard a new admission after recovery stops', async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const harness = recoveryDependencies({
    withIngress: true,
    primeRuntime: true,
    getActivePublication: () => ({ snapshot: recoverySnapshot(), operation: { mutation_id: 'mutation-1' } }),
    recoverAndPublish: async () => {
      entered = true;
      await blocker;
      return null;
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const firstRecovery = harness.recover!();
    await Promise.resolve();
    expect(entered).toBeTrue();
    const event = harness.newBootEvent();
    const queuedBoot = harness.ingressOptions()!.onRecovered!(event);
    harness.admit([harness.serving]);
    const shutdown = handle.shutdown();
    release();
    await firstRecovery;
    await queuedBoot;
    await shutdown;
    expect(harness.events).not.toContain('admission.clear');
    expect(harness.counts().admitted).toEqual([harness.serving]);
  } finally {
    release();
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('stops reconciliation without ingress and never revives repository work after shutdown', async () => {
  let activeReads = 0;
  let appends = 0;
  let starts = 0;
  let spawns = 0;
  const timers = new Map<number, () => void>();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nextTimer = 1;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    const id = nextTimer++;
    timers.set(id, callback as () => void);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number | ReturnType<typeof setTimeout>) => { timers.delete(Number(id)); }) as typeof clearTimeout;
  const harness = recoveryDependencies({
    realRuntime: true,
    getActivePublication: () => { activeReads += 1; return null; },
    startCurrent: async () => {
      starts += 1;
      if (starts === 1) return { kind: 'startup_failed', failures: [], serving: [] };
      spawns += 1;
      return { kind: 'startup_failed', failures: [], serving: [] };
    },
  });
  harness.repository.appendServingSnapshot = () => { appends += 1; };
  harness.workerFactory.spawn = () => { spawns += 1; return harness.serving.process; };
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    expect(timers.size).toBe(0);
    const before = { activeReads, appends, starts, spawns };
    await handle.shutdown().catch((error) => { throw error; });
    await Promise.resolve();
    expect({ activeReads, appends, starts, spawns }).toEqual(before);
  } finally {
    for (const callback of timers.values()) callback();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await handle?.shutdown().catch(() => undefined);
  }
});

test('ADM aborts a local handle that arrives after abort', async () => {
  const localReady = deferred<void>();
  let localAbortCalls = 0;
  const localHandle: PreparedWorkerAdmission = {
    commit: async () => undefined,
    abort: async () => { localAbortCalls += 1; },
    releaseRetiredAfterExitProof: async () => undefined,
  };
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => { await localReady.promise; return localHandle; },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const controller = new AbortController();
    const prepared = harness.admission().prepare([harness.serving], controller.signal) as Promise<PreparedWorkerAdmission> & {
      abort(): Promise<void>;
    };
    controller.abort('cancelled');
    localReady.resolve(undefined);
    await prepared.abort();
    expect(localAbortCalls).toBe(1);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('ADM aborts a remote handle that arrives late exactly once', async () => {
  const remoteReady = deferred<void>();
  let remoteStarted = false;
  let localAbortCalls = 0;
  let remoteAbortCalls = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => ({
      commit: async () => undefined,
      abort: async () => { localAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
    remotePrepare: async () => {
      remoteStarted = true;
      await remoteReady.promise;
      return {
        commit: async () => undefined,
        abort: async () => { remoteAbortCalls += 1; },
        releaseRetiredAfterExitProof: async () => undefined,
      };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const controller = new AbortController();
    const prepared = harness.admission().prepare([harness.serving], controller.signal) as Promise<PreparedWorkerAdmission> & {
      abort(): Promise<void>;
    };
    for (let attempt = 0; attempt < 20 && !remoteStarted; attempt += 1) await Promise.resolve();
    expect(remoteStarted).toBeTrue();
    controller.abort('cancelled');
    for (let attempt = 0; attempt < 20 && localAbortCalls === 0; attempt += 1) await Promise.resolve();
    expect(localAbortCalls).toBe(1);
    remoteReady.resolve(undefined);
    await prepared.abort();
    expect(remoteAbortCalls).toBe(1);
    expect(localAbortCalls).toBe(1);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('ADM aborts local immediately when remote prepare never resolves', async () => {
  const remoteReady = deferred<void>();
  let remoteStarted = false;
  let localAbortCalls = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => ({
      commit: async () => undefined,
      abort: async () => { localAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
    remotePrepare: async () => {
      remoteStarted = true;
      await remoteReady.promise;
      return { commit: async () => undefined, abort: async () => undefined, releaseRetiredAfterExitProof: async () => undefined };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const prepared = harness.admission().prepare([harness.serving]);
    for (let attempt = 0; attempt < 20 && !remoteStarted; attempt += 1) await Promise.resolve();
    expect(remoteStarted).toBeTrue();
    harness.gate().activate();
    for (let attempt = 0; attempt < 20 && localAbortCalls === 0; attempt += 1) await Promise.resolve();
    expect(localAbortCalls).toBe(1);
    remoteReady.resolve(undefined);
    await expect(prepared).rejects.toThrow();
  } finally {
    remoteReady.resolve(undefined);
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('ADM rescans a late remote handle while local abort is still pending', async () => {
  const remoteReady = deferred<void>();
  const localAbortReady = deferred<void>();
  let localAbortCalls = 0;
  let remoteAbortCalls = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => ({
      commit: async () => undefined,
      abort: async () => { localAbortCalls += 1; await localAbortReady.promise; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
    remotePrepare: async () => {
      await remoteReady.promise;
      return {
        commit: async () => undefined,
        abort: async () => { remoteAbortCalls += 1; },
        releaseRetiredAfterExitProof: async () => undefined,
      };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const controller = new AbortController();
    const prepared = harness.admission().prepare([harness.serving], controller.signal) as Promise<PreparedWorkerAdmission> & { abort(): Promise<void> };
    for (let attempt = 0; attempt < 20 && !harness.events.includes('ingress-prepare'); attempt += 1) await Promise.resolve();
    controller.abort('cancelled');
    const abort = prepared.abort();
    for (let attempt = 0; attempt < 20 && localAbortCalls === 0; attempt += 1) await Promise.resolve();
    remoteReady.resolve(undefined);
    for (let attempt = 0; attempt < 20 && remoteAbortCalls === 0; attempt += 1) await Promise.resolve();
    expect(localAbortCalls).toBe(1);
    expect(remoteAbortCalls).toBe(0);
    localAbortReady.resolve(undefined);
    await abort;
    expect(remoteAbortCalls).toBe(1);
  } finally {
    localAbortReady.resolve(undefined);
    remoteReady.resolve(undefined);
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('ADM restores a rejected commit side to prepared so abort can clean it up', async () => {
  let localCommitCalls = 0;
  let localAbortCalls = 0;
  let remoteAbortCalls = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => ({
      commit: async () => { localCommitCalls += 1; throw new Error('local commit failed'); },
      abort: async () => { localAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
    remotePrepare: async () => ({
      commit: async () => undefined,
      abort: async () => { remoteAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const prepared = await harness.admission().prepare([harness.serving]);
    await expect(prepared.commit()).rejects.toThrow('local commit failed');
    expect(localCommitCalls).toBe(1);
    expect(localAbortCalls).toBe(1);
    expect(remoteAbortCalls).toBe(0);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('ADM removes the captured signal listener after automatic abort reaches terminal sides', async () => {
  let capturedSignal: AbortSignal | undefined;
  const localHandle: PreparedWorkerAdmission = {
    commit: async () => undefined,
    abort: async () => undefined,
    releaseRetiredAfterExitProof: async () => undefined,
  };
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async (_workers, signal) => { capturedSignal = signal; return localHandle; },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const controller = new AbortController();
    const prepared = harness.admission().prepare([harness.serving], controller.signal) as Promise<PreparedWorkerAdmission>;
    await prepared;
    let removeCalls = 0;
    const originalRemove = capturedSignal!.removeEventListener.bind(capturedSignal);
    capturedSignal!.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      removeCalls += 1;
      return originalRemove(...args);
    }) as AbortSignal['removeEventListener'];
    controller.abort('cancelled');
    await (prepared as Promise<PreparedWorkerAdmission> & { abort(): Promise<void> }).abort();
    expect(removeCalls).toBe(1);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('ADM aborts local immediately when a permanently blocked remote commit meets a new gate', async () => {
  const remoteCommitReady = deferred<void>();
  let remoteCommitStarted = false;
  let localCommitCalls = 0;
  let localAbortCalls = 0;
  let remoteAbortCalls = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => ({
      commit: async () => { localCommitCalls += 1; },
      abort: async () => { localAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
    remotePrepare: async () => ({
      commit: async () => {
        remoteCommitStarted = true;
        await remoteCommitReady.promise;
      },
      abort: async () => { remoteAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const prepared = await harness.admission().prepare([harness.serving]);
    const commit = prepared.commit();
    for (let attempt = 0; attempt < 20 && !remoteCommitStarted; attempt += 1) await Promise.resolve();
    expect(remoteCommitStarted).toBeTrue();
    harness.gate().activate();
    for (let attempt = 0; attempt < 20 && localAbortCalls === 0; attempt += 1) await Promise.resolve();
    expect(localAbortCalls).toBe(1);
    expect(localCommitCalls).toBe(0);
    remoteCommitReady.resolve(undefined);
    await expect(commit).rejects.toThrow();
    expect(localCommitCalls).toBe(0);
    expect(remoteAbortCalls).toBe(0);
  } finally {
    remoteCommitReady.resolve(undefined);
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('ADM retries a failed abort without retaining a rejected promise', async () => {
  let abortCalls = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => ({
      commit: async () => undefined,
      abort: async () => {
        abortCalls += 1;
        if (abortCalls === 1) throw new Error('abort failed');
      },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const prepared = await harness.admission().prepare([harness.serving]);
    await expect(prepared.abort()).rejects.toBeInstanceOf(AggregateError);
    await prepared.abort();
    expect(abortCalls).toBe(2);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test.each([
  ['admission_not_committed', 1],
  ['stale_boot', 0],
  ['outcome_unknown', 0],
  ['provider_failure', 0],
] as const)('ADM classifies hostile remote commit %s conservatively', async (code, remoteAbortExpected) => {
  const remoteError = Object.assign(new Error(`remote ${code}`), { code });
  let localAbortCalls = 0;
  let remoteAbortCalls = 0;
  const harness = recoveryDependencies({
    withIngress: true,
    localPrepare: async () => ({
      commit: async () => undefined,
      abort: async () => { localAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
    remotePrepare: async () => ({
      commit: async () => { throw remoteError; },
      abort: async () => { remoteAbortCalls += 1; },
      releaseRetiredAfterExitProof: async () => undefined,
    }),
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const prepared = await harness.admission().prepare([harness.serving]);
    let failure: unknown;
    await prepared.commit().catch((error: unknown) => { failure = error; });
    expect(failure).toBe(remoteError);
    expect(localAbortCalls).toBe(1);
    expect(remoteAbortCalls).toBe(remoteAbortExpected);
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('GATE ignores stale release and cannot be reactivated after cancel', async () => {
  const harness = recoveryDependencies({ withIngress: true });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const first = harness.gate().activate();
    const second = harness.gate().activate();
    harness.gate().release(first);
    expect(harness.gate().isActive()).toBeTrue();
    harness.gate().release(second);
    expect(harness.gate().isActive()).toBeFalse();
    harness.gate().cancel();
    harness.gate().activate();
    expect(harness.gate().isActive()).toBeFalse();
    harness.gate().release(second);
    expect(harness.gate().isActive()).toBeFalse();
  } finally {
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('GATE bounds superseded recovery tokens across continuous boots', async () => {
  const firstRecoveryReady = deferred<void>();
  let firstRecoveryStarted = false;
  const harness = recoveryDependencies({
    withIngress: true,
    fenceAndStatus: async (token) => {
      if (token === 1) {
        firstRecoveryStarted = true;
        await firstRecoveryReady.promise;
      }
      return { active: null, prepared: null, retired: [] };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const first = harness.newBootEvent(1);
    const firstRecovery = harness.ingressOptions()!.onRecovered!(first);
    for (let attempt = 0; attempt < 20 && !firstRecoveryStarted; attempt += 1) await Promise.resolve();
    expect(firstRecoveryStarted).toBeTrue();
    for (let token = 2; token <= 64; token += 1) harness.newBootEvent(token);
    const latest = harness.newBootEvent(65);
    firstRecoveryReady.resolve(undefined);
    await firstRecovery;
    await expect(harness.ingressOptions()!.onRecovered!(latest)).resolves.toBe('complete');
  } finally {
    firstRecoveryReady.resolve(undefined);
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});

test('GATE publishes the latest rate-limit session before its recovery callback completes', async () => {
  const callbackReady = deferred<void>();
  let callbackStarted = false;
  const harness = recoveryDependencies({
    withIngress: true,
    rateLimitSession: (token) => ({ supervisionPort: 3010, expectedIngress: {
      process_instance_id: `process-${token ?? 'initial'}`,
      boot_nonce: `boot-${token ?? 'initial'}`,
    } }),
    fenceAndStatus: async (token) => {
      if (token === 3) {
        callbackStarted = true;
        await callbackReady.promise;
      }
      return { active: null, prepared: null, retired: [] };
    },
  });
  const previousSecret = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  process.env.BUNGEE_PLUGIN_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
  let handle: Awaited<ReturnType<typeof startMasterComposition>> | undefined;
  try {
    handle = await startMasterComposition(harness.dependencies);
    const c = harness.newBootEvent(3);
    const cRecovery = harness.ingressOptions()!.onRecovered!(c);
    for (let attempt = 0; attempt < 20 && !callbackStarted; attempt += 1) await Promise.resolve();
    expect(callbackStarted).toBeTrue();
    harness.newBootEvent(4);
    expect((harness.latestRateLimitSession() as { expectedIngress: { process_instance_id: string } }).expectedIngress.process_instance_id)
      .toBe('process-4');
    callbackReady.resolve(undefined);
    await cRecovery;
  } finally {
    callbackReady.resolve(undefined);
    await handle?.shutdown().catch(() => undefined);
    if (previousSecret === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previousSecret;
  }
});
