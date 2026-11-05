import { describe, expect, test } from 'bun:test';
import { ConfigurationRecoveryRunner } from '../../src/master-runtime/configuration-recovery';
import { PublicationTaskManager } from '../../src/master-runtime/publication-task-manager';
import { throwIfPublicationCancelled } from '../../src/config-publication/publication-runner';

const HASH = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
const process = { slot: 0 } as never;
const snapshot = { revision: 7, content_hash: HASH, aggregate: {} } as never;
const worker = { process, revision: 7, content_hash: HASH, plugin_catalog_hash: HASH } as never;

function harness(initial: any = {
  recovery_id: '11111111-1111-4111-8111-111111111111', source_mutation_id: 'mutation', target_revision: 7,
  trigger: 'automatic', state: 'scheduled', attempt_count: 0, max_attempts: 6, next_retry_at: null,
  final_reason_code: null, final_reason_detail: null, created_at: 0, updated_at: 0,
}) {
  let now = 0;
  let recovery = initial;
  const events: string[] = [];
  const repository: any = {
    getSnapshot: () => snapshot,
    getCurrentRecovery: async () => recovery,
    getActivePublication: async () => null,
    claimRecoveryAttempt: async (_id: string, attempt: number) => {
      events.push(`claim:${attempt}`);
      recovery = { ...recovery, state: 'running', attempt_count: attempt + 1, updated_at: now };
      return recovery;
    },
    scheduleRecoveryRetry: async (_id: string, attempt: number, next: number) => {
      events.push(`schedule:${next - now}`);
      recovery = { ...recovery, state: 'scheduled', attempt_count: attempt, next_retry_at: next, updated_at: now };
      return recovery;
    },
    succeedRecovery: async (_id: string, attempt: number, reason: string) => {
      events.push(`succeed:${attempt}:${reason}`);
      recovery = { ...recovery, state: 'succeeded', attempt_count: attempt, final_reason_code: reason, next_retry_at: null };
      return recovery;
    },
    stopRecovery: async (_id: string, attempt: number, reason: string) => {
      events.push(`stop:${attempt}:${reason}`);
      recovery = { ...recovery, state: 'stopped', attempt_count: attempt, final_reason_code: reason, next_retry_at: null };
      return recovery;
    },
    requeueRecovery: async (_id: string, attempt: number) => {
      events.push(`requeue:${attempt}`);
      recovery = { ...recovery, state: 'scheduled', next_retry_at: null, updated_at: now };
      return recovery;
    },
    getUnsettledWorkerLaunches: async () => [],
  };
  const delays: number[] = [];
  const scheduler = { callbacks: [] as Array<() => void>, schedule(delay: number, callback: () => void) {
    delays.push(delay);
    this.callbacks.push(callback);
    return { cancel: () => undefined };
  } };
  let publishes = 0;
  const tasks = new PublicationTaskManager({ publish: async () => { publishes += 1; return { kind: 'converged' } as never; } });
  tasks.setFatalHandler((error) => { throw error; });
  return { repository, recovery: () => recovery, setRecovery: (next: any) => { recovery = next; }, scheduler, tasks, events, delays, now: () => now, setNow: (value: number) => { now = value; }, worker, publishes: () => publishes };
}

describe('ConfigurationRecoveryRunner', () => {
  test('verifies an older target revision before stopping a drifted recovery', async () => {
    const h = harness();
    h.repository.getSnapshot = () => ({ ...(snapshot as object), revision: 8 });
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [h.worker] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { throw new Error('must not publish an older target'); }, recoverAndPublish: async () => null },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(h.events).toEqual(['succeed:0:target_serving']);
  });

  test('supersedes an older target only after proving it is not serving', async () => {
    const h = harness();
    h.repository.getSnapshot = () => ({ ...(snapshot as object), revision: 8 });
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks,
      admission: { snapshot: () => [{ ...(h.worker as object), revision: 8 } as never] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { throw new Error('must not publish an older target'); }, recoverAndPublish: async () => null },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(h.events).toEqual(['stop:0:revision_superseded']);
  });

  test('keeps a superseded running recovery blocked by an unsettled launch', async () => {
    const h = harness({ ...harness().recovery(), state: 'running', attempt_count: 1 });
    h.repository.getSnapshot = () => ({ ...(snapshot as object), revision: 8 });
    h.repository.getUnsettledWorkerLaunches = async () => [{ kind: 'launch' }];
    let fatal: Error | null = null;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { throw new Error('must not publish while a launch is unsettled'); }, recoverAndPublish: async () => null },
      onFatal: (error) => { fatal = error; },
    });
    await runner.start();
    // The barrier stays real: no fabricated release, and a late signed cleanup gets a
    // retry instead of an immediate terminal safety_outcome_unknown.
    expect(h.events).toEqual(['schedule:500']);
    expect(h.recovery().state).toBe('scheduled');
    expect(fatal).toBeNull();
  });

  test('supersedes a running recovery after its launches are settled on a retry', async () => {
    const h = harness({ ...harness().recovery(), state: 'running', attempt_count: 1 });
    h.repository.getSnapshot = () => ({ ...(snapshot as object), revision: 8 });
    h.repository.getUnsettledWorkerLaunches = async () => [{ kind: 'launch' }];
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { throw new Error('must not publish an older target'); }, recoverAndPublish: async () => null },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(h.recovery().state).toBe('scheduled');
    h.repository.getUnsettledWorkerLaunches = async () => [];
    h.scheduler.callbacks.shift()?.();
    await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));
    expect(h.events).toContain('stop:1:revision_superseded');
  });

  test('supersedes a running recovery only when its launches are settled', async () => {
    const h = harness({ ...harness().recovery(), state: 'running', attempt_count: 1 });
    h.repository.getSnapshot = () => ({ ...(snapshot as object), revision: 8 });
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { throw new Error('must not publish an older target'); }, recoverAndPublish: async () => null },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(h.events).toEqual(['stop:1:revision_superseded']);
  });

  test('claims before startCurrent and coalesces duplicate wakeups', async () => {
    const h = harness();
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => {
        starts += 1;
        expect(h.events[0]).toBe('claim:0');
        return { kind: 'startup_failed', failures: [{ slot: 0, code: 'timeout', detail: 'timeout', recovery_disposition: 'retryable' }], serving: [] };
      }, recoverAndPublish: async () => null }, onFatal: (error) => { throw error; },
    });
    const first = runner.wake();
    expect(runner.wake()).toBe(first);
    await first;
    expect(starts).toBe(1);
    expect(h.events).toContain('schedule:500');
  });

  test('requeues a running crash and succeeds an already-serving recovered attempt', async () => {
    const h = harness({ ...harness().recovery(), state: 'running', attempt_count: 1 });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [h.worker] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { starts += 1; return { kind: 'startup_ready', serving: [h.worker] }; }, recoverAndPublish: async () => null },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(starts).toBe(0);
    expect(h.events).toEqual(['requeue:1', 'succeed:1:target_serving']);
  });

  test('uses the initial 250ms gate and exact retry delays before attempt six stops', async () => {
    const h = harness({ ...harness().recovery(), next_retry_at: 250 });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => {
        starts += 1;
        return { kind: 'startup_failed', failures: [{ slot: 0, code: 'timeout', detail: 'timeout', recovery_disposition: 'retryable' }], serving: [] };
      }, recoverAndPublish: async () => null }, onFatal: (error) => { throw error; },
    });
    await runner.start();
    for (const due of [250, 750, 1_750, 3_750, 7_750, 15_750]) {
      h.setNow(due);
      h.scheduler.callbacks.shift()?.();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    }
    expect(starts).toBe(6);
    expect(h.delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000]);
    expect(h.events.at(-1)).toBe('stop:6:retry_exhausted');
  });

  test('stops deterministic worker, protocol, and control outcomes without a retry timer', async () => {
    for (const [disposition, reason] of [
      ['deterministic_worker_rejection', 'deterministic_worker_rejection'],
      ['deterministic_protocol_failure', 'deterministic_protocol_failure'],
    ] as const) {
      const h = harness();
      const runner = new ConfigurationRecoveryRunner({
        repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
        workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
        coordinator: { startCurrent: async () => ({ kind: 'startup_failed', failures: [{ slot: 0, code: 'apply_failed',
          detail: 'deterministic', recovery_disposition: disposition }], serving: [] }) , recoverAndPublish: async () => null},
        onFatal: (error) => { throw error; },
      });
      await runner.start();
      expect(h.events).toContain(`stop:1:${reason}`);
      expect(h.delays).toEqual([]);
    }
    const control = harness();
    const controlRunner = new ConfigurationRecoveryRunner({
      repository: control.repository, publicationTasks: control.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: control.now, scheduler: control.scheduler,
      coordinator: { startCurrent: async () => ({ kind: 'startup_degraded', http_status: 202,
        error_code: 'control_readiness_failed', recovery_disposition: 'deterministic_control_failure', failures: [], serving: [] }) , recoverAndPublish: async () => null},
      onFatal: (error) => { throw error; },
    });
    await controlRunner.start();
    expect(control.events).toContain('stop:1:deterministic_control_failure');
    expect(control.delays).toEqual([]);
  });

  test('stops ACK-unknown as safety outcome and reports fatal once', async () => {
    const h = harness();
    const fatals: Error[] = [];
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => ({ kind: 'startup_degraded', http_status: 202,
        error_code: 'admission_outcome_unknown', recovery_disposition: 'fatal', failures: [], serving: [] }) , recoverAndPublish: async () => null},
      onFatal: (error) => { fatals.push(error); },
    });
    await runner.start();
    expect(h.events).toContain('stop:1:safety_outcome_unknown');
    expect(fatals).toHaveLength(1);
    await runner.wake();
    expect(fatals).toHaveLength(1);
  });

  test('keeps a complete target fatal when the ACK outcome is unknown', async () => {
    const h = harness();
    const fatals: Error[] = [];
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => ({ kind: 'startup_degraded', http_status: 202,
        error_code: 'admission_outcome_unknown', recovery_disposition: 'fatal', failures: [], serving: [h.worker] }) , recoverAndPublish: async () => null},
      onFatal: (error) => { fatals.push(error); },
    });
    await runner.start();
    expect(h.events).toContain('stop:1:safety_outcome_unknown');
    expect(fatals).toHaveLength(1);
  });

  test('fences duplicate timer generations and does not wake after shutdown', async () => {
    const h = harness({ ...harness().recovery(), next_retry_at: 250 });
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => ({ kind: 'startup_failed', failures: [], serving: [] }) , recoverAndPublish: async () => null},
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    const stale = h.scheduler.callbacks[0];
    await runner.wake();
    stale?.();
    expect(h.events).toEqual([]);
    await runner.stop();
    h.scheduler.callbacks.forEach((callback) => callback());
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    expect(h.events).toEqual([]);
  });

  test('does not claim or start a stopped recovery during runtime startup', async () => {
    const h = harness({ ...harness().recovery(), state: 'stopped', attempt_count: 1,
      final_reason_code: 'deterministic_control_failure' });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { starts += 1; return { kind: 'startup_ready', serving: [] }; }, recoverAndPublish: async () => null },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(starts).toBe(0);
    expect(h.events).toEqual([]);
  });

  test('does not claim a stopped fatal source marker and permits a later manual cycle', async () => {
    const h = harness({ ...harness().recovery(), state: 'stopped', attempt_count: 0,
      final_reason_code: 'fatal_source_failure' });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { starts += 1; return { kind: 'startup_ready', serving: [] }; }, recoverAndPublish: async () => null },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(starts).toBe(0);
    expect(h.events).toEqual([]);
  });

  test('claims before a target admission race and records target_serving', async () => {
    const h = harness();
    let admitted: readonly unknown[] = [];
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => admitted as never },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => {
        admitted = [h.worker];
        return { kind: 'startup_ready', serving: [h.worker] };
      }, recoverAndPublish: async () => null }, onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(h.events[0]).toBe('claim:0');
    expect(h.events).toContain('succeed:1:target_serving');
  });

  test('reversible shutdown at attempt six stops retry_exhausted without a safety fatal', async () => {
    const h = harness({ ...harness().recovery(), attempt_count: 5 });
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async (_snapshot, _workers, _old, signal) => {
        if (signal === undefined) throw new Error('recovery signal missing');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        throwIfPublicationCancelled(signal);
        return { kind: 'startup_failed', failures: [], serving: [] };
      }, recoverAndPublish: async () => null }, onFatal: (error) => { throw error; },
    });
    const started = runner.start();
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    await runner.stop();
    await started;
    expect(h.events).toContain('claim:5');
    expect(h.events).toContain('stop:6:retry_exhausted');
  });

  test('fails closed when startup reports ready or old-drain without the exact target', async () => {
    for (const outcome of [
      { kind: 'startup_ready' as const, serving: [] },
      { kind: 'startup_degraded' as const, http_status: 202 as const,
        error_code: 'old_worker_drain_failed' as const, recovery_disposition: 'retryable' as const,
        failures: [], serving: [] },
    ]) {
      const h = harness();
      let fatal = 0;
      const runner = new ConfigurationRecoveryRunner({
        repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
        workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
        coordinator: { startCurrent: async () => outcome , recoverAndPublish: async () => null}, onFatal: () => { fatal += 1; },
      });
      await runner.start();
      expect(fatal).toBe(1);
      expect(h.events).toContain('stop:1:safety_outcome_unknown');
    }
  });

  for (const owner of [
    { label: 'a cancelled pre-prepare owner', operation: { mutation_id: 'held-owner', state: 'publishing',
      cancel_requested: true, prepare_started: false },
      finalOutcome: { kind: 'superseded', operation: { mutation_id: 'held-owner', state: 'superseded' }, serving: [] } },
    { label: 'a draining owner', operation: { mutation_id: 'held-owner', state: 'draining',
      cancel_requested: false, prepare_started: true },
      finalOutcome: { kind: 'degraded', http_status: 202, error_code: 'old_worker_drain_failed',
        recovery_disposition: 'retryable', failures: [], serving: [],
        operation: { mutation_id: 'held-owner', state: 'degraded' } } },
  ]) {
    test(`observes ${owner.label} after late evidence without a recovery row`, async () => {
      const h = harness();
      const active = { operation: owner.operation, snapshot } as never;
      let recovered = 0;
      const outcomes = [
        ...Array.from({ length: 8 }, () => ({ kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
          error: new Error('cleanup is still in flight'), serving: [], pending: [] })),
        owner.finalOutcome,
      ] as never[];
      const repository = {
        ...h.repository,
        current: active,
        async getCurrentRecovery() { return null; },
        async getActivePublication() { return this.current; },
      };
      const coordinator = {
        outcomes,
        calls: 0,
        async startCurrent() { throw new Error('observation must not take the current-startup path'); },
        async recoverAndPublish() {
          return this.outcomes[this.calls++] ?? this.outcomes[this.outcomes.length - 1]!;
        },
      };
      const runner = new ConfigurationRecoveryRunner({
        repository,
        publicationTasks: h.tasks, admission: { snapshot: () => [] },
        workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
        coordinator,
        onRecovered: () => { recovered += 1; },
        onFatal: (error) => { throw error; },
      });

      await runner.wake(true);
      expect(coordinator.calls).toBe(1);
      expect(h.delays).toEqual([250]);
      for (let step = 0; step < 8; step += 1) {
        h.scheduler.callbacks.shift()?.();
        await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));
      }
      await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));

      expect(coordinator.calls).toBe(9);
      expect(h.delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
      expect(h.events).toEqual([]);
      expect(recovered).toBe(1);
      expect(h.publishes()).toBe(1);
    });
  }

  test('observes the owner even when the recovery row is terminal succeeded', async () => {
    const h = harness({ ...harness().recovery(), state: 'succeeded', final_reason_code: 'target_serving' });
    let calls = 0;
    let recovered = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: {
        ...h.repository,
        async getActivePublication() { return { operation: { mutation_id: 'held-owner', cancel_requested: true, prepare_started: false }, snapshot } as never; },
      },
      publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: {
        startCurrent: async () => { throw new Error('terminal observation must not initialize'); },
        recoverAndPublish: async () => {
          calls += 1;
          return { kind: 'superseded', operation: { mutation_id: 'held-owner' }, serving: [] } as never;
        },
      },
      onRecovered: () => { recovered += 1; },
      onFatal: (error) => { throw error; },
    });

    await runner.wake(true);
    expect(calls).toBe(1);
    expect(recovered).toBe(1);
    expect(h.events).toEqual([]);
  });

  test('keeps the stopped safety-unknown barrier closed to owner observation', async () => {
    const h = harness({ ...harness().recovery(), state: 'stopped', final_reason_code: 'safety_outcome_unknown' });
    let calls = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: {
        ...h.repository,
        async getActivePublication() { return { operation: { mutation_id: 'held-owner', cancel_requested: true, prepare_started: false }, snapshot } as never; },
      },
      publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: {
        startCurrent: async () => { throw new Error('barrier must not initialize'); },
        recoverAndPublish: async () => { calls += 1; return null; },
      },
      onFatal: (error) => { throw error; },
    });

    await runner.wake(true);
    expect(calls).toBe(0);
    expect(h.delays).toEqual([]);
  });

  test('consumes an observation requested while a recovery task is in flight', async () => {
    const h = harness();
    const active = { operation: { mutation_id: 'held-owner', cancel_requested: true, prepare_started: false }, snapshot } as never;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let observations = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: {
        ...h.repository,
        async getActivePublication() { return active; },
      },
      publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: {
        startCurrent: async () => {
          began();
          await gate;
          return { kind: 'startup_ready', serving: [h.worker] } as never;
        },
        recoverAndPublish: async () => {
          observations += 1;
          return { kind: 'superseded', operation: { mutation_id: 'held-owner' }, serving: [] } as never;
        },
      },
      onFatal: (error) => { throw error; },
    });

    const running = runner.start();
    await started;
    runner.wake(true);
    release();
    await running;
    await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));

    expect(observations).toBe(1);
    expect(h.delays).toEqual([]);
  });

  test('does not let a pending observation bypass the stopped safety-unknown barrier', async () => {
    const h = harness();
    h.repository.getActivePublication = async () => ({
      operation: { mutation_id: 'held-owner', cancel_requested: true, prepare_started: false }, snapshot,
    }) as never;
    let observations = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: {
        startCurrent: async () => { throw new Error('barrier must not initialize'); },
        recoverAndPublish: async () => { observations += 1; return null; },
      },
      onFatal: (error) => { throw error; },
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = h.tasks.enqueueRecovery(async () => {
      await gate;
      return { kind: 'complete' };
    });
    const running = runner.start();
    runner.wake(true);
    h.setRecovery({ ...h.recovery(), state: 'stopped', final_reason_code: 'safety_outcome_unknown', next_retry_at: null });
    release();
    await blocker;
    await running;
    await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));

    expect(observations).toBe(0);
    expect(h.delays).toEqual([]);
  });

  test('coordinates an owner-evidence timer with a future normal recovery deadline', async () => {
    const h = harness({ ...harness().recovery(), state: 'scheduled', next_retry_at: 5_000 });
    const outcomes = [
      { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
        error: new Error('cleanup is still in flight'), serving: [], pending: [] },
      { kind: 'superseded', operation: { mutation_id: 'held-owner' }, serving: [] },
    ] as never[];
    let calls = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: {
        ...h.repository,
        getActivePublication: async () => ({
          operation: { mutation_id: 'held-owner', cancel_requested: true, prepare_started: false }, snapshot,
        }) as never,
      },
      publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: {
        startCurrent: async () => { throw new Error('owner evidence must not initialize'); },
        recoverAndPublish: async () => outcomes[calls++] ?? outcomes[outcomes.length - 1]!,
      },
      onFatal: (error) => { throw error; },
    });

    await runner.wake(true);
    expect(h.delays).toEqual([250]);
    h.scheduler.callbacks.shift()?.();
    await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));

    expect(calls).toBe(2);
    expect(h.events).toEqual([]);
    expect(h.delays).toEqual([250, 5_000]);
  });

  test('runs a follow-up pass for a plain wake during an in-flight task', async () => {
    const h = harness();
    let reads = 0;
    const repository = {
      ...h.repository,
      async getCurrentRecovery() { reads += 1; return h.recovery(); },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: {
        startCurrent: async () => {
          starts += 1;
          began();
          await gate;
          return { kind: 'startup_failed',
            failures: [{ slot: 0, code: 'apply_failed', detail: 'retry', recovery_disposition: 'retryable' }],
            serving: [] } as never;
        },
        recoverAndPublish: async () => null,
      },
      onFatal: (error) => { throw error; },
    });

    const running = runner.start();
    await started;
    runner.wake();
    release();
    await running;
    await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));

    expect(reads).toBe(2);
    expect(starts).toBe(1);
  });

  test('drops a late observation callback after stopAccepting', async () => {
    const h = harness();
    let recovered = 0;
    let calls = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: {
        ...h.repository,
        getCurrentRecovery: async () => null,
        getActivePublication: async () => ({ operation: { mutation_id: 'held-owner', cancel_requested: true, prepare_started: false }, snapshot }) as never,
      },
      publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: {
        startCurrent: async () => { throw new Error('observation must not fork'); },
        recoverAndPublish: async () => {
          calls += 1;
          return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering',
            error: new Error('cleanup is still in flight'), serving: [], pending: [] } as never;
        },
      },
      onRecovered: () => { recovered += 1; },
      onFatal: (error) => { throw error; },
    });

    await runner.wake(true);
    expect(h.delays).toEqual([250]);
    runner.stopAccepting();
    h.scheduler.callbacks.shift()?.();
    await h.tasks.enqueueRecovery(async () => ({ kind: 'complete' }));

    expect(calls).toBe(1);
    expect(recovered).toBe(0);
  });
});
