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
  verifyImpl: () => Promise<WorkerExitEvidence | null> = () => Promise.resolve(null);
  verifyCalls = 0;

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
  verifyExactExit(): Promise<WorkerExitEvidence | null> {
    this.verifyCalls += 1;
    return this.verifyImpl();
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

  test('adopted worker without child exit proves exit via exact verification after the graceful wait', async () => {
    // Given — adopted workers never emit a child exit event; the OS probe says dead.
    const scheduler = new ManualScheduler();
    const process = new TerminationProcess();
    process.graceful = () => new Promise<void>(() => undefined);
    process.verifyImpl = () => Promise.resolve({ exited: true, pid: process.pid });

    // When
    const pending = terminateWithEscalation(process, scheduler, 10, 20);
    await flushMicrotasks();
    scheduler.fireNext();
    await flushMicrotasks();

    // Then — proof arrived before force: no escalation, no OS signal path.
    expect(process.calls).toEqual(['graceful']);
    expect(process.verifyCalls).toBe(1);
    expect(await pending).toEqual({ exitEvidence: { exited: true, pid: 4321 } });
  });

  test('alive after graceful escalates to force and accepts the final exact verification', async () => {
    // Given — the first probe says the exact process is still alive, the final one dead.
    const scheduler = new ManualScheduler();
    const process = new TerminationProcess();
    process.graceful = () => new Promise<void>(() => undefined);
    process.force = () => new Promise<void>(() => undefined);
    let alive = true;
    process.verifyImpl = () => Promise.resolve(alive ? null : { exited: true, pid: process.pid });

    // When
    const pending = terminateWithEscalation(process, scheduler, 10, 20);
    await flushMicrotasks();
    scheduler.fireNext();
    await flushMicrotasks();

    // Then — force was requested because the first verification said alive.
    expect(process.calls).toEqual(['graceful', 'force']);
    expect(scheduler.size).toBe(1);
    alive = false;
    scheduler.fireNext();
    await flushMicrotasks();

    // Then — the final verification after the force wait supplies the proof.
    expect(process.verifyCalls).toBe(2);
    expect(await pending).toEqual({ exitEvidence: { exited: true, pid: 4321 } });
  });

  test('unknown probe keeps exit unproven and records the wait error without fabricating proof', async () => {
    // Given — the OS cannot tell whether the exact process exited.
    const scheduler = new ManualScheduler();
    const process = new TerminationProcess();
    process.graceful = () => new Promise<void>(() => undefined);
    process.force = () => new Promise<void>(() => undefined);
    process.verifyImpl = () => Promise.reject(new Error('worker exit state could not be verified against the operating system'));

    // When
    const pending = terminateWithEscalation(process, scheduler, 10, 20);
    await flushMicrotasks();
    scheduler.fireNext();
    await flushMicrotasks();
    scheduler.fireNext();
    const result = await pending;

    // Then — both waits verified, both unknown: no proof is invented.
    expect(process.verifyCalls).toBe(2);
    expect(result.exitEvidence).toBeNull();
    expect(result.waitError).toBeInstanceOf(Error);
    expect((result.waitError as Error).message).toBe('worker exit state could not be verified against the operating system');
  });

  test('evidence carrying a foreign pid is never accepted as this process exit proof', async () => {
    // Given — the probe observed an exit, but for a pid this process object never owned.
    const scheduler = new ManualScheduler();
    const process = new TerminationProcess();
    process.graceful = () => new Promise<void>(() => undefined);
    process.force = () => new Promise<void>(() => undefined);
    process.verifyImpl = () => Promise.resolve({ exited: true, pid: 9999 });

    // When
    const pending = terminateWithEscalation(process, scheduler, 10, 20);
    await flushMicrotasks();
    scheduler.fireNext();
    await flushMicrotasks();
    scheduler.fireNext();
    const result = await pending;

    // Then — a replacement instance's proof does not release this ownership.
    expect(process.verifyCalls).toBe(2);
    expect(result.exitEvidence).toBeNull();
  });

  test('two processes sharing a pid never consume each other exact exit proof', async () => {
    // Given — same pid, two distinct process objects with independent probes.
    const scheduler = new ManualScheduler();
    const first = new TerminationProcess();
    const second = new TerminationProcess();
    for (const process of [first, second]) process.graceful = () => new Promise<void>(() => undefined);
    first.verifyImpl = () => Promise.resolve({ exited: true, pid: first.pid });
    second.force = () => new Promise<void>(() => undefined);
    second.verifyImpl = () => Promise.resolve(null);

    // When
    const firstPending = terminateWithEscalation(first, scheduler, 10, 20);
    await flushMicrotasks();
    scheduler.fireNext();
    await flushMicrotasks();
    const firstResult = await firstPending;
    const secondPending = terminateWithEscalation(second, scheduler, 10, 20);
    await flushMicrotasks();
    scheduler.fireNext();
    await flushMicrotasks();
    scheduler.fireNext();
    const secondResult = await secondPending;

    // Then — proof binds to the object that verified it, never to the shared pid.
    expect(firstResult.exitEvidence).toEqual({ exited: true, pid: 4321 });
    expect(secondResult.exitEvidence).toBeNull();
  });
});
