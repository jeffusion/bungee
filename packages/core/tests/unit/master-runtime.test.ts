import { describe, expect, test } from 'bun:test';
import type { ConfigurationOperation, RepositorySnapshot } from '../../src/config-storage';
import type {
  ConfigPublicationWorkerProcess,
  MasterPublicationOutcome,
  ServingConfigWorker,
  StartupPublicationOutcome,
} from '../../src/config-publication';
import { MasterRuntime } from '../../src/master-runtime/runtime';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG_HASH = `sha256:${'b'.repeat(64)}` as const;
const SNAPSHOT: RepositorySnapshot = {
  revision: 4,
  content_hash: HASH,
  aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
};
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
  return { kind: 'degraded', http_status: 202, error_code: 'old_worker_drain_failed', failures: [],
    operation: operation('old_worker_drain_failed'), serving };
}

function replacementFailed(): MasterPublicationOutcome {
  return { kind: 'degraded', http_status: 202, error_code: 'replacement_convergence_failed',
    failures: [{ slot: 0, code: 'apply_failed', detail: 'failed' }],
    operation: operation('replacement_convergence_failed'), serving: [] };
}

function controlReadinessFailed(): MasterPublicationOutcome {
  return { kind: 'degraded', http_status: 202, error_code: 'control_readiness_failed', failures: [],
    operation: operation('control_readiness_failed'), serving: [] };
}

type Scenario = {
  readonly recovery?: (serving: readonly ServingConfigWorker[]) => MasterPublicationOutcome | null;
  readonly startup?: (serving: readonly ServingConfigWorker[]) => StartupPublicationOutcome;
  readonly admitted?: (serving: readonly ServingConfigWorker[]) => readonly ServingConfigWorker[];
  readonly fail?: ReadonlySet<string>;
  readonly unconfirmed?: boolean;
};

function fixture(input: Scenario = {}) {
  const calls: string[] = [];
  const serving = workers();
  const fail = (name: string): void => {
    calls.push(name);
    if (input.fail?.has(name)) throw new Error(`${name} failed`);
  };
  let port: number | null = null;
  const runtime = new MasterRuntime({
    workerCount: 2,
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
      enqueue() {}, setFatalHandler() {}, async stop() { fail('publication.stop'); },
    },
    admission: {
      prepare() { return { commit() {} }; },
      snapshot() { calls.push('admission.snapshot'); return input.admitted?.(serving) ?? serving; },
      clear() { fail('admission.clear'); },
    },
    publicListener: {
      get port() { return port; },
      start() { fail('listener.start'); port = 8088; },
      async stop() { fail('listener.stop'); port = null; },
    },
    workerPool: {
      pids: () => serving.map(({ process: worker }) => worker.pid),
      owns: (worker) => serving.some(({ process: current }) => current === worker),
      subscribeExit: () => () => { fail('pool.unsubscribeExit'); },
      async shutdownAll() {
        fail('pool.shutdown');
        return serving.map(({ process: worker }, index) => ({ process: worker,
          exitEvidence: input.unconfirmed && index === 1 ? null : { exited: true as const, pid: worker.pid } }));
      },
    },
    instanceLock: { async release() { fail('lock.release'); } },
    ancillary: { async close() { fail('ancillary.close'); } },
  });
  return { calls, runtime, serving };
}

const CLEANUP = ['pool.unsubscribeExit', 'listener.stop', 'publication.stop', 'admission.clear', 'pool.shutdown', 'ancillary.close',
  'repository.close', 'lock.release'] as const;

describe('MasterRuntime startup', () => {
  test('recovers first, then starts the current snapshot and binds last when no operation is active', async () => {
    const { calls, runtime } = fixture();
    await runtime.start();
    expect(calls).toEqual(['coordinator.recover', 'repository.snapshot', 'coordinator.current:4',
      'admission.snapshot', 'listener.start']);
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
      expect(calls).toEqual(['coordinator.recover', ...CLEANUP]);
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
      expect(calls).toEqual(['coordinator.recover', 'admission.snapshot', ...CLEANUP]);
      expect(calls).not.toContain('listener.start');
    }
  });

  test('rolls back in reverse order when the listener bind fails', async () => {
    const { calls, runtime } = fixture({ recovery: recovered, fail: new Set(['listener.start']) });
    const error = await runtime.start().catch((failure: unknown) => failure);
    expect(String(error)).toContain('listener.start failed');
    expect(calls).toEqual(['coordinator.recover', 'admission.snapshot', 'listener.start', ...CLEANUP]);
  });

  test('does not bind when current startup fails', async () => {
    const { calls, runtime } = fixture({ startup: () => ({ kind: 'startup_failed', failures: [], serving: [] }) });
    const error = await runtime.start().catch((failure: unknown) => failure);
    expect(String(error)).toContain('current snapshot');
    expect(calls).toEqual(['coordinator.recover', 'repository.snapshot', 'coordinator.current:4', ...CLEANUP]);
    expect(calls).not.toContain('listener.start');
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
    expect(error.errors.map(String)).toEqual([...failures].map((name) => `Error: ${name} failed`));
    expect(calls).toEqual([...CLEANUP]);
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
    expect(calls).toEqual(CLEANUP.slice(0, -1));
  });

  test('continues cleanup after pool shutdown throws and retains the lock', async () => {
    const failures = new Set(['pool.shutdown', 'ancillary.close', 'repository.close']);
    const { calls, runtime } = fixture({ fail: failures });
    await runtime.start(); calls.length = 0;
    const error = await runtime.shutdown().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('expected aggregate shutdown failure');
    expect(error.errors.map(String)).toEqual([
      'Error: pool.shutdown failed', 'Error: ancillary.close failed', 'Error: repository.close failed',
      'MasterRuntimeError: worker exits were not confirmed; instance lock retained',
    ]);
    expect(calls).toEqual(CLEANUP.slice(0, -1));
  });
});
