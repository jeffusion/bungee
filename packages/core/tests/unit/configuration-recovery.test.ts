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
    getCurrentRecovery: () => recovery,
    claimRecoveryAttempt: (_id: string, attempt: number) => {
      events.push(`claim:${attempt}`);
      recovery = { ...recovery, state: 'running', attempt_count: attempt + 1, updated_at: now };
      return recovery;
    },
    scheduleRecoveryRetry: (_id: string, attempt: number, next: number) => {
      events.push(`schedule:${next - now}`);
      recovery = { ...recovery, state: 'scheduled', attempt_count: attempt, next_retry_at: next, updated_at: now };
      return recovery;
    },
    succeedRecovery: (_id: string, attempt: number, reason: string) => {
      events.push(`succeed:${attempt}:${reason}`);
      recovery = { ...recovery, state: 'succeeded', attempt_count: attempt, final_reason_code: reason, next_retry_at: null };
      return recovery;
    },
    stopRecovery: (_id: string, attempt: number, reason: string) => {
      events.push(`stop:${attempt}:${reason}`);
      recovery = { ...recovery, state: 'stopped', attempt_count: attempt, final_reason_code: reason, next_retry_at: null };
      return recovery;
    },
    requeueRecovery: (_id: string, attempt: number) => {
      events.push(`requeue:${attempt}`);
      recovery = { ...recovery, state: 'scheduled', next_retry_at: null, updated_at: now };
      return recovery;
    },
  };
  const delays: number[] = [];
  const scheduler = { callbacks: [] as Array<() => void>, schedule(delay: number, callback: () => void) {
    delays.push(delay);
    this.callbacks.push(callback);
    return { cancel: () => undefined };
  } };
  const tasks = new PublicationTaskManager({ publish: async () => ({ kind: 'converged' } as never) });
  tasks.setFatalHandler((error) => { throw error; });
  return { repository, scheduler, tasks, events, delays, now: () => now, setNow: (value: number) => { now = value; }, worker };
}

describe('ConfigurationRecoveryRunner', () => {
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
      } }, onFatal: (error) => { throw error; },
    });
    const first = runner.wake();
    expect(runner.wake()).toBe(first);
    await first;
    expect(starts).toBe(1);
    expect(h.events).toContain('schedule:500');
  });

  test('requeues a running crash and succeeds an already-serving recovered attempt', async () => {
    const h = harness({ ...harness().repository.getCurrentRecovery(), state: 'running', attempt_count: 1 });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [h.worker] },
      workerCount: 1, pluginCatalogHash: HASH, now: () => 0, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { starts += 1; return { kind: 'startup_ready', serving: [h.worker] }; } },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(starts).toBe(0);
    expect(h.events).toEqual(['requeue:1', 'succeed:1:target_serving']);
  });

  test('uses the initial 250ms gate and exact retry delays before attempt six stops', async () => {
    const h = harness({ ...harness().repository.getCurrentRecovery(), next_retry_at: 250 });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => {
        starts += 1;
        return { kind: 'startup_failed', failures: [{ slot: 0, code: 'timeout', detail: 'timeout', recovery_disposition: 'retryable' }], serving: [] };
      } }, onFatal: (error) => { throw error; },
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
          detail: 'deterministic', recovery_disposition: disposition }], serving: [] }) },
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
        error_code: 'control_readiness_failed', recovery_disposition: 'deterministic_control_failure', failures: [], serving: [] }) },
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
        error_code: 'admission_outcome_unknown', recovery_disposition: 'fatal', failures: [], serving: [] }) },
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
        error_code: 'admission_outcome_unknown', recovery_disposition: 'fatal', failures: [], serving: [h.worker] }) },
      onFatal: (error) => { fatals.push(error); },
    });
    await runner.start();
    expect(h.events).toContain('stop:1:safety_outcome_unknown');
    expect(fatals).toHaveLength(1);
  });

  test('fences duplicate timer generations and does not wake after shutdown', async () => {
    const h = harness({ ...harness().repository.getCurrentRecovery(), next_retry_at: 250 });
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => ({ kind: 'startup_failed', failures: [], serving: [] }) },
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
    const h = harness({ ...harness().repository.getCurrentRecovery(), state: 'stopped', attempt_count: 1,
      final_reason_code: 'deterministic_control_failure' });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { starts += 1; return { kind: 'startup_ready', serving: [] }; } },
      onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(starts).toBe(0);
    expect(h.events).toEqual([]);
  });

  test('does not claim a stopped fatal source marker and permits a later manual cycle', async () => {
    const h = harness({ ...harness().repository.getCurrentRecovery(), state: 'stopped', attempt_count: 0,
      final_reason_code: 'fatal_source_failure' });
    let starts = 0;
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async () => { starts += 1; return { kind: 'startup_ready', serving: [] }; } },
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
      } }, onFatal: (error) => { throw error; },
    });
    await runner.start();
    expect(h.events[0]).toBe('claim:0');
    expect(h.events).toContain('succeed:1:target_serving');
  });

  test('reversible shutdown at attempt six stops retry_exhausted without a safety fatal', async () => {
    const h = harness({ ...harness().repository.getCurrentRecovery(), attempt_count: 5 });
    const runner = new ConfigurationRecoveryRunner({
      repository: h.repository, publicationTasks: h.tasks, admission: { snapshot: () => [] },
      workerCount: 1, pluginCatalogHash: HASH, now: h.now, scheduler: h.scheduler,
      coordinator: { startCurrent: async (_snapshot, _workers, _old, signal) => {
        if (signal === undefined) throw new Error('recovery signal missing');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        throwIfPublicationCancelled(signal);
        return { kind: 'startup_failed', failures: [], serving: [] };
      } }, onFatal: (error) => { throw error; },
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
        coordinator: { startCurrent: async () => outcome }, onFatal: () => { fatal += 1; },
      });
      await runner.start();
      expect(fatal).toBe(1);
      expect(h.events).toContain('stop:1:safety_outcome_unknown');
    }
  });
});
