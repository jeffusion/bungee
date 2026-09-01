import { describe, expect, test } from 'bun:test';
import type {
  ConfigPublicationWorkerProcess,
  PublicationScheduler,
  ScheduledTimeout,
  WorkerExitEvidence,
} from '../../src/config-publication';
import { terminateWithEscalation } from '../../src/config-publication/process-termination';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../../src/config-publication/messages';

const IDENTITY: ConfigProcessIdentity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 0,
};

class ManualScheduler implements PublicationScheduler {
  private readonly pending: (() => void)[] = [];

  schedule(_delayMs: number, callback: () => void): ScheduledTimeout {
    this.pending.push(callback);
    return { cancel: () => {
      const index = this.pending.indexOf(callback);
      if (index >= 0) this.pending.splice(index, 1);
    } };
  }

  fireNext(): void {
    this.pending.shift()?.();
  }

  get size(): number { return this.pending.length; }
}

class TerminationProcess implements ConfigPublicationWorkerProcess {
  readonly identity = IDENTITY;
  readonly pid = 4321;
  readonly slot = 0;
  readonly calls: ('graceful' | 'force')[] = [];
  private readonly exitListeners = new Set<(evidence: WorkerExitEvidence) => void>();
  graceful: () => Promise<void> = () => Promise.resolve();
  force: () => Promise<void> = () => Promise.resolve();

  send(_message: ConfigMasterMessage): Promise<void> { return Promise.resolve(); }
  subscribeMessage(_listener: (message: unknown) => void): () => void { return () => undefined; }
  subscribeExit(listener: (evidence: WorkerExitEvidence) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }
  terminate(mode: 'graceful' | 'force'): Promise<void> {
    this.calls.push(mode);
    return mode === 'graceful' ? this.graceful() : this.force();
  }
  exit(): void {
    for (const listener of this.exitListeners) listener({ exited: true, pid: this.pid });
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

describe('terminateWithEscalation', () => {
  test('escalates when graceful request never settles and accepts exact force exit', async () => {
    // Given
    const scheduler = new ManualScheduler();
    const process = new TerminationProcess();
    process.graceful = () => new Promise<void>(() => undefined);
    process.force = () => { process.exit(); return Promise.resolve(); };

    // When
    const pending = terminateWithEscalation(process, scheduler, 10, 20);
    await flushMicrotasks();

    // Then
    expect(scheduler.size).toBe(1);
    scheduler.fireNext();
    await flushMicrotasks();
    expect(process.calls).toEqual(['graceful', 'force']);
    expect(await pending).toEqual({ exitEvidence: { exited: true, pid: 4321 } });
  });

  test('returns conservatively when force request and both signal Promises never settle', async () => {
    // Given
    const scheduler = new ManualScheduler();
    const process = new TerminationProcess();
    process.graceful = () => new Promise<void>(() => undefined);
    process.force = () => new Promise<void>(() => undefined);

    // When
    const pending = terminateWithEscalation(process, scheduler, 10, 20);
    await flushMicrotasks();
    scheduler.fireNext();
    await flushMicrotasks();

    // Then
    expect(scheduler.size).toBe(1);
    expect(process.calls).toEqual(['graceful', 'force']);
    scheduler.fireNext();
    expect(await pending).toEqual({ exitEvidence: null });
  });

  test('handles a graceful rejection arriving after timeout and exact force exit', async () => {
    // Given
    const scheduler = new ManualScheduler();
    const process = new TerminationProcess();
    let rejectGraceful: ((error: Error) => void) | undefined;
    process.graceful = () => new Promise<void>((_resolve, reject) => { rejectGraceful = reject; });
    process.force = () => { process.exit(); return Promise.resolve(); };
    const pending = terminateWithEscalation(process, scheduler, 10, 20);
    await flushMicrotasks();

    // When
    scheduler.fireNext();
    await flushMicrotasks();
    rejectGraceful?.(new Error('late signal failure'));
    await flushMicrotasks();

    // Then
    expect(await pending).toEqual({ exitEvidence: { exited: true, pid: 4321 } });
  });
});
