import { describe, expect, test } from 'bun:test';
import type {
  ConfigMasterMessage,
  ConfigProcessIdentity,
  ConfigPublicationWorkerProcess,
  WorkerExitEvidence,
} from '../../src/config-publication';
import {
  MasterHeartbeatSender,
  type HeartbeatIntervalScheduler,
} from '../../src/master-runtime/heartbeat-sender';

const IDENTITY: ConfigProcessIdentity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 3,
};

class ManualIntervalScheduler implements HeartbeatIntervalScheduler {
  readonly callbacks = new Set<() => void>();
  readonly intervals: number[] = [];

  scheduleEvery(intervalMs: number, callback: () => void) {
    this.intervals.push(intervalMs);
    this.callbacks.add(callback);
    return { cancel: () => { this.callbacks.delete(callback); } };
  }

  fire(): void {
    for (const callback of [...this.callbacks]) callback();
  }
}

class HeartbeatProcess implements ConfigPublicationWorkerProcess {
  readonly pid = 4321;
  readonly slot = IDENTITY.worker_slot;
  readonly identity = IDENTITY;
  readonly sent: ConfigMasterMessage[] = [];
  sendFailure: Error | null = null;
  holdSend = false;
  private readonly exitListeners = new Set<(evidence: WorkerExitEvidence) => void>();
  private release: (() => void) | undefined;

  async send(message: ConfigMasterMessage): Promise<void> {
    this.sent.push(message);
    if (this.sendFailure !== null) throw this.sendFailure;
    if (this.holdSend) await new Promise<void>((resolve) => { this.release = resolve; });
  }

  releaseSend(): void { this.release?.(); }
  exit(pid = this.pid): void {
    for (const listener of this.exitListeners) listener({ exited: true, pid });
  }
  subscribeMessage(_listener: (message: unknown) => void): () => void { return () => undefined; }
  subscribeExit(listener: (evidence: WorkerExitEvidence) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }
  terminate(_mode: 'graceful' | 'force'): Promise<void> { return Promise.resolve(); }
}

async function settle(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

describe('MasterHeartbeatSender', () => {
  test('sends an immediate exact heartbeat then strictly increasing heartbeats', async () => {
    // Given
    const scheduler = new ManualIntervalScheduler();
    const process = new HeartbeatProcess();
    const sender = new MasterHeartbeatSender({ masterPid: 9876, intervalMs: 100, scheduler });

    // When
    sender.start(process);
    expect(process.sent).toEqual([
      { command: 'master-heartbeat', ...IDENTITY, master_pid: 9876, sequence: 1 },
    ]);
    await settle();
    scheduler.fire();
    await settle();
    scheduler.fire();
    await settle();

    // Then
    expect(process.sent).toEqual([
      { command: 'master-heartbeat', ...IDENTITY, master_pid: 9876, sequence: 1 },
      { command: 'master-heartbeat', ...IDENTITY, master_pid: 9876, sequence: 2 },
      { command: 'master-heartbeat', ...IDENTITY, master_pid: 9876, sequence: 3 },
    ]);
    expect(scheduler.intervals).toEqual([100]);
  });

  test('contains send rejection and continues the same process sequence', async () => {
    // Given
    const scheduler = new ManualIntervalScheduler();
    const process = new HeartbeatProcess();
    process.sendFailure = new Error('ipc failed');
    const sender = new MasterHeartbeatSender({ masterPid: 9876, intervalMs: 100, scheduler });

    // When
    sender.start(process);
    await settle();
    process.sendFailure = null;
    scheduler.fire();
    await settle();

    // Then
    expect(process.sent.map((message) =>
      'command' in message && message.command === 'master-heartbeat' ? message.sequence : 0)).toEqual([1, 2]);
  });

  test('bounds pending sends and removes only an exactly exited process', async () => {
    // Given
    const scheduler = new ManualIntervalScheduler();
    const first = new HeartbeatProcess();
    first.holdSend = true;
    const second = new HeartbeatProcess();
    Object.defineProperty(second, 'pid', { value: 4322 });
    const sender = new MasterHeartbeatSender({ masterPid: 9876, intervalMs: 100, scheduler });
    sender.start(first);
    sender.start(second);
    await settle();

    // When
    scheduler.fire();
    await settle();
    first.exit(9999);
    expect(scheduler.callbacks.size).toBe(2);
    first.exit();
    first.releaseSend();
    scheduler.fire();
    await settle();

    // Then
    expect(first.sent).toHaveLength(1);
    expect(second.sent.map((message) =>
      'command' in message && message.command === 'master-heartbeat' ? message.sequence : 0)).toEqual([1, 2, 3]);
    expect(scheduler.callbacks.size).toBe(1);
  });
});
