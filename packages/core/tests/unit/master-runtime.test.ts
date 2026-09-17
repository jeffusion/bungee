import { describe, expect, test } from 'bun:test';
import type { ConfigurationOperation, RepositorySnapshot } from '../../src/config-storage';
import type {
  ConfigPublicationWorkerProcess,
  MasterPublicationOutcome,
  ServingConfigWorker,
  StartupPublicationOutcome,
} from '../../src/config-publication';
import type { MasterIngressStartupFailureDisposition } from '../../src/ingress/master-controller';
import { MasterRuntime, MasterRuntimeError } from '../../src/master-runtime/runtime';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG_HASH = `sha256:${'b'.repeat(64)}` as const;
const SNAPSHOT: RepositorySnapshot = {
  revision: 4,
  content_hash: HASH,
  aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
};
const STARTUP_DISPOSITION: MasterIngressStartupFailureDisposition = Object.freeze({
  kind: 'preserved', origin: null,
  evidence: Object.freeze({ registry: null, statusRefreshed: false, pendingAdmission: false, uncertainAdmission: false, pendingRetiredRelease: false, reason: 'unowned' }),
});
function operation(
  errorCode: 'old_worker_drain_failed' | 'replacement_convergence_failed' | 'control_readiness_failed',
): ConfigurationOperation {
  return {
    mutation_id: 'runtime-test', request_hash: HASH, expected_revision: 3, committed_revision: 4,
    kind: 'config', target_worker_count: 2, drain_recovery_generation: 0,
    last_drain_recovery_previous_generation: null, created_at: 1, updated_at: 2,
    state: 'degraded', result_status: 202, error_code: errorCode, error_detail: 'recovery',
  };
}

function process(slot: number): ConfigPublicationWorkerProcess {
  return {
    slot, pid: 7000 + slot,
    identity: { master_generation: '50000000-0000-4000-8000-000000000001',
      worker_instance_id: `60000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`, worker_slot: slot },
    send: async () => undefined, subscribeMessage: () => () => undefined,
    subscribeExit: () => () => undefined, terminate: async () => undefined,
  };
}

function workers(): readonly ServingConfigWorker[] {
  return [0, 1].map((slot) => ({ process: process(slot), revision: 4, content_hash: HASH,
    plugin_catalog_hash: CATALOG_HASH, private_port: 4100 + slot, publication: null }));
}

function recovered(serving: readonly ServingConfigWorker[]): MasterPublicationOutcome {
  return { kind: 'degraded', http_status: 202, error_code: 'old_worker_drain_failed', recovery_disposition: 'retryable', failures: [],
    operation: operation('old_worker_drain_failed'), serving };
}

function replacementFailed(): MasterPublicationOutcome {
  return { kind: 'degraded', http_status: 202, error_code: 'replacement_convergence_failed', recovery_disposition: 'retryable',
    failures: [{ slot: 0, code: 'apply_failed', detail: 'failed', recovery_disposition: 'retryable' }],
    operation: operation('replacement_convergence_failed'), serving: [] };
}

function controlReadinessFailed(): MasterPublicationOutcome {
  return { kind: 'degraded', http_status: 202, error_code: 'control_readiness_failed', recovery_disposition: 'retryable', failures: [],
    operation: operation('control_readiness_failed'), serving: [] };
}

type Scenario = {
  readonly recovery?: (serving: readonly ServingConfigWorker[]) => MasterPublicationOutcome | null;
  readonly startup?: (serving: readonly ServingConfigWorker[]) => StartupPublicationOutcome;
  readonly admitted?: (serving: readonly ServingConfigWorker[]) => readonly ServingConfigWorker[];
  readonly fail?: ReadonlySet<string>;
  readonly unconfirmed?: boolean;
  readonly alwaysClose?: boolean;
  readonly beforeCleanup?: () => void | Promise<void>;
  readonly listenerPort?: number | null;
  readonly listenerReady?: boolean;
};

function fixture(input: Scenario = {}) {
  const calls: string[] = [];
  const serving = workers();
  const fail = (name: string): void => {
    calls.push(name);
    if (input.fail?.has(name)) throw new Error(`${name} failed`);
  };
  let port: number | null = input.listenerPort ?? null;
  const runtime = new MasterRuntime({
    workerCount: 2,
    expectedPluginCatalogHash: CATALOG_HASH,
    repository: {
      getSnapshot() { calls.push('repository.snapshot'); return SNAPSHOT; },
      close() { fail('repository.close'); },
    },
    coordinator: {
      async recoverAndPublish() { calls.push('coordinator.recover'); return input.recovery?.(serving) ?? null; },
      async startCurrent(snapshot) {
        calls.push(`coordinator.current:${snapshot.revision}`);
        return input.startup?.(serving) ?? { kind: 'startup_ready', serving };
      },
    },
    publicationTasks: {
      enqueue() {}, async enqueueRecovery(task) { return task(); }, setFatalHandler() {}, async stop() { fail('publication.stop'); },
    },
    admission: {
      prepare() { return Promise.resolve({ async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {} }); },
      adoptCommitted() {},
      snapshot() { calls.push('admission.snapshot'); return input.admitted?.(serving) ?? serving; },
      clear() { fail('admission.clear'); },
    },
    publicListener: {
      get port() { return port; },
      start() { fail('listener.start'); port = 8088; },
      ...(input.listenerReady ? { ready() { fail('listener.ready'); } } : {}),
      async stop() { fail('listener.stop'); port = null; },
    },
    workerPool: {
      pids: () => serving.map(({ process: worker }) => worker.pid),
      owns: (worker) => serving.some(({ process: current }) => current === worker),
      subscribeExit: () => () => { fail('pool.unsubscribeExit'); },
      subscribeUnavailable: () => () => { fail('pool.unsubscribeUnavailable'); }, disconnectAll() { fail('pool.disconnectAll'); },
      markCommitted() {},
      async shutdownAll() {
        fail('pool.shutdown');
        return serving.map(({ process: worker }, index) => ({ process: worker,
          exitEvidence: input.unconfirmed && index === 1 ? null : { exited: true as const, pid: worker.pid } }));
      },
    },
    instanceLock: { async release() { fail('lock.release'); } },
    onWorkerUnavailable() {},
    ...(input.alwaysClose ? { alwaysClose: async () => { fail('always.close'); } } : {}),
    ancillary: {
      ...(input.beforeCleanup === undefined ? {} : { beforeCleanup: input.beforeCleanup }),
      async cleanupAfterStartupFailure() { fail('ancillary.close'); return STARTUP_DISPOSITION; },
      async closeForNormalShutdown() { fail('ancillary.close'); },
    },
  });
  return { calls, runtime, serving };
}

const CLEANUP = ['pool.unsubscribeExit', 'pool.unsubscribeUnavailable', 'listener.stop', 'publication.stop', 'admission.clear', 'pool.shutdown', 'ancillary.close',
  'repository.close', 'lock.release'] as const;
const STARTUP_CLEANUP = ['pool.unsubscribeExit', 'pool.unsubscribeUnavailable', 'listener.stop', 'publication.stop', 'ancillary.close', 'pool.disconnectAll',
  'repository.close', 'lock.release'] as const;

describe('MasterRuntime startup', () => {
  test('always closes master-owned resources before repository and locks on startup cleanup', async () => {
    const { calls, runtime } = fixture({ fail: new Set(['listener.start']), alwaysClose: true });
    await expect(runtime.start()).rejects.toThrow('listener.start failed');
    expect(calls.indexOf('always.close')).toBeGreaterThan(calls.indexOf('listener.stop'));
    expect(calls.indexOf('always.close')).toBeLessThan(calls.indexOf('repository.close'));
    expect(calls.indexOf('always.close')).toBeLessThan(calls.indexOf('lock.release'));
  });

  test('retains the instance lock when an always-close resource fails during startup cleanup', async () => {
    const { calls, runtime } = fixture({ fail: new Set(['listener.start', 'always.close']), alwaysClose: true });
    await expect(runtime.start()).rejects.toThrow('master runtime startup failed');
    expect(calls).not.toContain('lock.release');
  });

  test('recovers first, then starts the current snapshot and binds last when no operation is active', async () => {
    const { calls, runtime } = fixture();
    await runtime.start();
    expect(calls).toEqual(['coordinator.recover', 'repository.snapshot', 'coordinator.current:4',
      'admission.snapshot', 'listener.start']);
  });

  test('uses ready for a prebound listener without starting it again', async () => {
    const { calls, runtime } = fixture({ listenerPort: 8088, listenerReady: true });
    await runtime.start();
    expect(calls).toContain('listener.ready');
    expect(calls).not.toContain('listener.start');
  });

  test('starts a legacy listener unconditionally even when it already exposes a port', async () => {
    const { calls, runtime } = fixture({ listenerPort: 8088 });
    await runtime.start();
    expect(calls).toContain('listener.start');
  });

  test('uses a complete recovered 202 admission without starting current', async () => {
    const { calls, runtime } = fixture({ recovery: recovered });
    await runtime.start();
    expect(calls).toEqual(['coordinator.recover', 'admission.snapshot', 'listener.start']);
  });

  test('falls back only from terminal replacement failure with zero serving workers', async () => {
    const { calls, runtime } = fixture({ recovery: replacementFailed });
    await runtime.start();
    expect(calls).toEqual(['coordinator.recover', 'repository.snapshot', 'coordinator.current:4',
      'admission.snapshot', 'listener.start']);
  });

  test('keeps the listener and management plane alive for the empty control-readiness recovery state', async () => {
    const { calls, runtime } = fixture({ recovery: () => controlReadinessFailed(), admitted: () => [] });
    await runtime.start();
    expect(calls).toEqual(['coordinator.recover', 'admission.snapshot', 'admission.snapshot', 'listener.start']);
    expect(calls).not.toContain('coordinator.current:4');
    await runtime.shutdown();
  });

  test('fails closed for nonterminal, fatal, and incomplete recovery outcomes', async () => {
    const recoveries: readonly Scenario['recovery'][] = [
      () => ({ kind: 'outcome_unknown', fatal: false, code: 'recovery_replacements_failed',
        error: new Error('retry'), serving: [], pending: [] }),
      () => ({ kind: 'outcome_unknown', fatal: true, code: 'repository_failure',
        error: new Error('fatal'), serving: [], pending: [] }),
      (serving) => recovered(serving.slice(0, 1)),
    ];
    for (const recovery of recoveries) {
      const { calls, runtime } = fixture({ recovery });
      const error = await runtime.start().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(calls).toEqual(['coordinator.recover', ...STARTUP_CLEANUP]);
      expect(calls).not.toContain('listener.start');
    }
  });

  test('rejects incomplete or mismatched admission evidence before binding', async () => {
    const admissions = [
      (serving: readonly ServingConfigWorker[]) => serving.slice(0, 1),
      (serving: readonly ServingConfigWorker[]) => serving.map((worker, index) =>
        index === 0 ? { ...worker, private_port: 9999 } : worker),
    ];
    for (const admitted of admissions) {
      const { calls, runtime } = fixture({ recovery: recovered, admitted });
      const error = await runtime.start().catch((failure: unknown) => failure);
      expect(String(error)).toContain('admission');
      expect(calls).toEqual(['coordinator.recover', 'admission.snapshot', ...STARTUP_CLEANUP]);
      expect(calls).not.toContain('listener.start');
    }
  });

  test('rolls back in reverse order when the listener bind fails', async () => {
    const { calls, runtime } = fixture({ recovery: recovered, fail: new Set(['listener.start']) });
    const error = await runtime.start().catch((failure: unknown) => failure);
    expect(String(error)).toContain('listener.start failed');
    expect(calls).toEqual(['coordinator.recover', 'admission.snapshot', 'listener.start', ...STARTUP_CLEANUP]);
  });

  test('keeps the management plane alive when current startup is retryable', async () => {
    const { calls, runtime } = fixture({ startup: () => ({ kind: 'startup_failed', failures: [], serving: [] }), admitted: () => [] });
    await runtime.start();
    expect(calls).toEqual(['coordinator.recover', 'repository.snapshot', 'coordinator.current:4', 'admission.snapshot', 'listener.start']);
    await runtime.shutdown();
  });
});

describe('MasterRuntime shutdown', () => {
  test('is concurrent-safe, idempotent, and hides runtime details outside started state', async () => {
    const { calls, runtime } = fixture();
    expect(runtime.publicPort).toBeNull(); expect(runtime.workerPids).toBeNull();
    await runtime.start();
    expect(runtime.publicPort).toBe(8088); expect(runtime.workerPids).toEqual([7000, 7001]);
    calls.length = 0;
    const first = runtime.shutdown(); const second = runtime.shutdown();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(runtime.shutdown()).toBe(first);
    expect(calls).toEqual([...CLEANUP]);
    expect(runtime.publicPort).toBeNull(); expect(runtime.workerPids).toBeNull();
  });

  test('aggregates cleanup failures and still attempts every later cleanup', async () => {
    const failures = new Set(['listener.stop', 'admission.clear', 'ancillary.close', 'repository.close', 'lock.release']);
    const { calls, runtime } = fixture({ fail: failures });
    await runtime.start(); calls.length = 0;
    const error = await runtime.shutdown().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('expected aggregate shutdown failure');
    expect(error.errors.map(String)).toEqual([
      'Error: listener.stop failed', 'Error: admission.clear failed', 'Error: ancillary.close failed',
      'Error: repository.close failed', 'MasterRuntimeError: management listener did not stop; instance lock retained',
    ]);
    expect(calls).toEqual(CLEANUP.slice(0, -1));
  });

  test('retains the instance lock when any worker exit is unconfirmed', async () => {
    const { calls, runtime } = fixture({ unconfirmed: true });
    await runtime.start(); calls.length = 0;
    const error = await runtime.shutdown().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('expected aggregate shutdown failure');
    expect(error.errors.map(String)).toContain(
      'MasterRuntimeError: worker exits were not confirmed; instance lock retained',
    );
    expect(calls).toEqual(CLEANUP.filter((call) => call !== 'ancillary.close').slice(0, -1));
  });

  test('continues cleanup after pool shutdown throws and retains the lock', async () => {
    const failures = new Set(['pool.shutdown', 'repository.close']);
    const { calls, runtime } = fixture({ fail: failures });
    await runtime.start(); calls.length = 0;
    const error = await runtime.shutdown().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('expected aggregate shutdown failure');
    expect(error.errors.map(String)).toEqual([
      'Error: pool.shutdown failed', 'Error: repository.close failed',
      'MasterRuntimeError: worker exits were not confirmed; instance lock retained',
    ]);
    expect(calls).toEqual(CLEANUP.filter((call) => call !== 'ancillary.close').slice(0, -1));
  });
});

test('runs beforeCleanup once for normal and fatal shutdown', async () => {
  for (const fatal of [false, true]) {
    let beforeCleanupCalls = 0;
    const { runtime } = fixture({ beforeCleanup: () => { beforeCleanupCalls += 1; } });
    await runtime.start();
    if (fatal) {
      runtime.reportAsynchronousFailure(new MasterRuntimeError('publication_failed', 'injected fatal failure'));
      await runtime.shutdown().catch(() => undefined);
    } else {
      await runtime.shutdown();
    }
    expect(beforeCleanupCalls).toBe(1);
  }
});

test('cancels startup recovery synchronously before the coordinator gate opens', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const recovery = new AbortController();
  const events: string[] = [];
  let sideEffects = 0;
  let recoveryStopped = false;
  const runtime = new MasterRuntime({
    workerCount: 1,
    expectedPluginCatalogHash: CATALOG_HASH,
    repository: { getSnapshot() { return SNAPSHOT; }, close() { events.push('repository.close'); } },
    coordinator: {
      async recoverAndPublish() { return null; },
      async startCurrent() {
        await gate;
        if (!recovery.signal.aborted) sideEffects += 1;
        return { kind: 'startup_failed', failures: [], serving: [] };
      },
    },
    publicationTasks: { enqueue() {}, async enqueueRecovery(task) { return task(); }, setFatalHandler() {}, async stop() { events.push('publication.stop'); } },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot: () => [], clear() { events.push('admission.clear'); } },
    publicListener: { port: null, start() {}, async stop() { events.push('listener.stop'); } },
    workerPool: {
      pids: () => [], owns: () => false, subscribeExit: () => () => undefined, subscribeUnavailable: () => () => undefined,
      markCommitted() {}, disconnectAll() { events.push('pool.disconnect'); }, async shutdownAll() { events.push('pool.shutdown'); return []; },
    },
    instanceLock: { async release() { events.push('lock.release'); } },
    onWorkerUnavailable() {},
    stopAcceptingRecovery() {
      if (recoveryStopped) return;
      recoveryStopped = true;
      recovery.abort('startup failure');
      events.push('recovery.stop');
    },
    alwaysClose: () => { events.push('always.close'); },
    ancillary: {
      beforeCleanup() { events.push('beforeCleanup'); },
      cleanupAfterStartupFailure() { events.push('ingress.close'); return STARTUP_DISPOSITION; },
      closeForNormalShutdown() { events.push('ingress.close'); },
    },
  });
  const starting = runtime.start();
  await Promise.resolve();
  runtime.reportAsynchronousFailure(new MasterRuntimeError('startup_incomplete', 'injected startup failure'));
  expect(recovery.signal.aborted).toBeTrue();
  expect(sideEffects).toBe(0);
  release();
  await expect(starting).rejects.toBeDefined();
  expect(events).toEqual(['recovery.stop', 'listener.stop', 'beforeCleanup', 'always.close', 'publication.stop', 'ingress.close', 'pool.disconnect', 'repository.close', 'lock.release']);
  expect(events).not.toContain('admission.clear');
  expect(events).not.toContain('pool.shutdown');
  expect(events).toContain('ingress.close');
  expect(events).toContain('lock.release');
});
