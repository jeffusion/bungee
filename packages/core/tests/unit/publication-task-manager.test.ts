import { describe, expect, test } from 'bun:test';
import type { ActiveConfigurationPublication } from '../../src/config-storage';
import type { MasterPublicationOutcome, ServingConfigWorker } from '../../src/config-publication';
import { PublicationTaskManager } from '../../src/master-runtime/publication-task-manager';

const active = { operation: { mutation_id: 'queued-operation' } } as ActiveConfigurationPublication;
const workers: readonly ServingConfigWorker[] = [];
const converged = { kind: 'converged' } as MasterPublicationOutcome;

class ManualScheduler {
  readonly callbacks: Array<() => void> = [];
  schedule = (callback: () => void): void => { this.callbacks.push(callback); };
  flush(): void { for (const callback of this.callbacks.splice(0)) callback(); }
}

async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

describe('PublicationTaskManager', () => {
  test('starts after scheduling, serializes publications, and stop waits for the queue', async () => {
    const scheduler = new ManualScheduler();
    const calls: string[] = [];
    let releaseFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const manager = new PublicationTaskManager({
      schedule: scheduler.schedule,
      async publish(publication) {
        calls.push(publication.operation.mutation_id);
        if (calls.length === 1) await first;
        return converged;
      },
    });
    manager.setFatalHandler(() => { throw new Error('unexpected fatal'); });

    manager.enqueue(active, workers);
    manager.enqueue({ ...active, operation: { ...active.operation, mutation_id: 'second' } }, workers);
    expect(calls).toEqual([]);
    scheduler.flush();
    await settle();
    expect(calls).toEqual(['queued-operation']);
    let stopped = false;
    const stopping = manager.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBeFalse();
    releaseFirst();
    await stopping;
    expect(calls).toEqual(['queued-operation', 'second']);
    expect(() => manager.enqueue(active, workers)).toThrow();
  });

  test('contains rejection and reports rejection or fatal unknown outcome exactly once', async () => {
    for (const result of [new Error('publish rejected'), {
      kind: 'outcome_unknown', fatal: true, code: 'repository_failure', error: new Error('unknown'),
      serving: [], pending: [],
    } as MasterPublicationOutcome]) {
      const failures: Error[] = [];
      const manager = new PublicationTaskManager({
        schedule: queueMicrotask,
        publish: async () => { if (result instanceof Error) throw result; return result; },
      });
      manager.setFatalHandler((error) => { failures.push(error); });
      manager.enqueue(active, workers);
      await manager.stop();
      expect(failures).toHaveLength(1);
    }
  });

  test('queues recovery behind publications and stop waits for it', async () => {
    const manager = new PublicationTaskManager({
      publish: async () => converged,
    });
    manager.setFatalHandler(() => { throw new Error('unexpected fatal'); });
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    manager.enqueue(active, workers);
    const recovery = manager.enqueueRecovery(async () => {
      events.push('recovery-start');
      await slow;
      events.push('recovery-end');
      return { kind: 'complete' as const };
    });
    const stopping = manager.stop();
    await settle();
    expect(events).toEqual(['recovery-start']);
    release();
    await Promise.all([recovery, stopping]);
    expect(events).toEqual(['recovery-start', 'recovery-end']);
  });

  test('classifies recovery rejection as retryable without owning fatal reporting', async () => {
    const failures: Error[] = [];
    const manager = new PublicationTaskManager({ publish: async () => converged });
    manager.setFatalHandler((error) => { failures.push(error); });

    const retryable = await manager.enqueueRecovery(async () => { throw new Error('temporary'); });
    expect(retryable.kind).toBe('retryable');
    expect(failures).toHaveLength(0);

    const fatal = await manager.enqueueRecovery(async () => ({ kind: 'fatal' as const, error: new Error('fatal') }));
    await manager.stop();
    expect(fatal.kind).toBe('fatal');
    expect(failures).toHaveLength(0);
  });
});
