import { describe, expect, test } from 'bun:test';
import { DEFAULT_PUBLICATION_POLICY, type PublicationPolicy } from '@jeffusion/bungee-types';
import type {
  ConfigPublicationWorkerProcess,
  PublicationScheduler,
  ScheduledTimeout,
  ServingConfigWorker,
  WorkerExitEvidence,
} from '../../src/config-publication';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../../src/config-publication/messages';
import type { WorkerDrainedMessage, WorkerDrainFailedMessage, WorkerDrainStartedMessage } from '../../src/config-publication/types';
import { allDrainExitsConfirmed, drainFailures, drainWorkers, drainWorkersUntilKnown } from '../../src/config-publication/drain-workers';

const IDENTITY: ConfigProcessIdentity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 0,
};
const KERNEL_BOOT_ID = 'linux:11111111-1111-4111-8111-111111111111';
const WORKER: ServingConfigWorker = {
  process: undefined as never,
  boot_nonce: 'c0000000-0000-4000-8000-000000000001',
  revision: 1,
  content_hash: `sha256:${'a'.repeat(64)}`,
  plugin_catalog_hash: `sha256:${'b'.repeat(64)}`,
  private_port: 41_000,
  publication: null,
};

class FakeScheduler implements PublicationScheduler {
  readonly delays: number[] = [];
  elapsed = 0;
  private pending: { readonly delayMs: number; readonly callback: () => void }[] = [];

  schedule(delayMs: number, callback: () => void): ScheduledTimeout {
    this.delays.push(delayMs);
    const entry = { delayMs, callback };
    this.pending.push(entry);
    return { cancel: () => {
      const index = this.pending.indexOf(entry);
      if (index >= 0) this.pending.splice(index, 1);
    } };
  }

  fireNext(now: { value: number }): void {
    const index = this.pending.reduce((best, entry, candidate) => entry.delayMs < this.pending[best]?.delayMs! ? candidate : best, 0);
    const entry = this.pending.splice(index, 1)[0];
    if (entry === undefined) return;
    now.value += entry.delayMs;
    this.elapsed += entry.delayMs;
    entry.callback();
  }

  get size(): number { return this.pending.length; }
}

class FakeProcess implements ConfigPublicationWorkerProcess {
  readonly identity = IDENTITY;
  readonly pid = 4321;
  readonly slot = 0;
  readonly kernelBootId = KERNEL_BOOT_ID;
  readonly calls: ('graceful' | 'force')[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<(evidence: WorkerExitEvidence) => void>();
  private terminalMessage: any = null;
  private currentDrainStatus: WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null = null;
  constructor(private readonly acknowledge: boolean) {}

  send(message: ConfigMasterMessage): Promise<void> {
    if (this.acknowledge && message.command === 'drain-worker') {
      this.currentDrainStatus = {
        status: 'worker-draining', ...IDENTITY, boot_nonce: message.boot_nonce, pid: message.pid,
        revision: 1, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
        drain_id: message.drain_id, policy: message.policy, remaining_ms: message.policy.drain_timeout_ms,
        publication: null,
      };
      for (const listener of this.messageListeners) listener(this.currentDrainStatus);
      this.markTerminal({
        status: 'worker-drained', ...IDENTITY, boot_nonce: message.boot_nonce, pid: message.pid,
        revision: 1, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
        drain_id: message.drain_id, policy: message.policy, boot_id: KERNEL_BOOT_ID,
        exit_deadline_ns: '123456789000', exit_remaining_ms: message.policy.worker_exit_timeout_ms,
        cleanup_state: 'pending', publication: null,
      });
      for (const listener of this.messageListeners) listener(this.terminalMessage);
    }
    return Promise.resolve();
  }

  subscribeMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  subscribeExit(listener: (evidence: WorkerExitEvidence) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  async drainStatus(): Promise<WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null> { return this.currentDrainStatus; }

  async verifyExactExit(): Promise<WorkerExitEvidence | null> {
    if (this.terminalMessage === null) return null;
    return { exited: true, pid: this.pid, terminalDrain: { ...this.terminalMessage,
      exit_remaining_ms: Math.max(1, this.terminalMessage.policy.worker_exit_timeout_ms - 1), cleanup_state: 'success' } };
  }

  protected markTerminal(message: WorkerDrainedMessage | WorkerDrainFailedMessage): WorkerDrainedMessage | WorkerDrainFailedMessage {
    this.terminalMessage = message;
    this.currentDrainStatus = message;
    return message;
  }

  terminate(mode: 'graceful' | 'force'): Promise<void> {
    this.calls.push(mode);
    return Promise.resolve();
  }
}

class RecoveredProcess extends FakeProcess {
  readonly sent: ConfigMasterMessage[] = [];
  readonly originalPolicy: PublicationPolicy = {
    drain_start_timeout_ms: 2_000, drain_timeout_ms: 8_000, worker_exit_timeout_ms: 4_000,
  };

  private statusReads = 0;

  override async drainStatus() {
    this.statusReads += 1;
    if (this.statusReads > 1) return this.markTerminal({
      status: 'worker-drained', ...IDENTITY, boot_nonce: WORKER.boot_nonce!, pid: this.pid,
      revision: WORKER.revision, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
      drain_id: '94000000-0000-4000-8000-000000000001', policy: this.originalPolicy,
      boot_id: KERNEL_BOOT_ID, exit_deadline_ns: '123456789000', exit_remaining_ms: 4_000, cleanup_state: 'pending',
      publication: WORKER.publication,
    });
    return {
      status: 'worker-draining' as const, ...IDENTITY, boot_nonce: WORKER.boot_nonce!, pid: this.pid,
      revision: WORKER.revision, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
      drain_id: '94000000-0000-4000-8000-000000000001', policy: this.originalPolicy,
      remaining_ms: 1_500, publication: WORKER.publication,
    };
  }

  override send(message: ConfigMasterMessage): Promise<void> {
    this.sent.push(message);
    return super.send(message);
  }
}

class CRecoveryProcess extends FakeProcess {
  readonly sent: ConfigMasterMessage[] = [];
  private statusReads = 0;
  private task: WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null = null;
  constructor() { super(false); }
  override async send(message: ConfigMasterMessage): Promise<void> {
    this.sent.push(message);
    if (message.command !== 'drain-worker') return;
    this.task = {
      status: 'worker-drained', ...IDENTITY, boot_nonce: message.boot_nonce, pid: this.pid,
      revision: WORKER.revision, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
      drain_id: message.drain_id, policy: message.policy,
      boot_id: KERNEL_BOOT_ID, exit_deadline_ns: '123456789000', exit_remaining_ms: message.policy.worker_exit_timeout_ms,
      cleanup_state: 'pending', publication: WORKER.publication,
    };
    throw Object.assign(new Error('start ACK timed out'), { code: 'timeout' });
  }
  override async drainStatus(): Promise<WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null> {
    this.statusReads += 1;
    if (this.statusReads < 3) return null;
    return this.task;
  }
  override async verifyExactExit(): Promise<WorkerExitEvidence | null> {
    if (this.task === null || this.task.status === 'worker-draining') return null;
    return { exited: true, pid: this.pid, terminalDrain: { ...this.task,
      exit_remaining_ms: Math.max(1, this.task.policy.worker_exit_timeout_ms - 1), cleanup_state: 'success' } };
  }
}

class RejectingProcess extends FakeProcess {
  constructor() { super(false); }
  override async send(): Promise<void> { throw Object.assign(new Error('explicit HTTP command rejection'), { code: 'http' }); }
}

class TerminalStatusProcess extends FakeProcess {
  readonly terminal: WorkerDrainFailedMessage;
  constructor(cleanupState: 'failed' | 'pending') {
    super(false);
    this.terminal = {
      status: 'worker-drain-failed', ...IDENTITY, boot_nonce: WORKER.boot_nonce!, pid: this.pid,
      revision: WORKER.revision, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
      drain_id: '95000000-0000-4000-8000-000000000001', policy: DEFAULT_PUBLICATION_POLICY,
      error_code: 'timeout', http_stopped: true,
      boot_id: KERNEL_BOOT_ID, exit_deadline_ns: '123456789000', exit_remaining_ms: 500,
      cleanup_state: cleanupState, publication: WORKER.publication,
    };
  }
  override async drainStatus() { return this.terminal; }
  override async verifyExactExit(): Promise<WorkerExitEvidence | null> {
    return { exited: true, pid: this.pid, terminalDrain: this.terminal };
  }
}

class ExitWithoutTerminalProcess extends TerminalStatusProcess {
  override async verifyExactExit(): Promise<WorkerExitEvidence | null> { return { exited: true, pid: this.pid }; }
}

class ShutdownResponseLostProcess extends FakeProcess {
  override async terminate(): Promise<void> { throw new Error('shutdown response lost after worker cleanup'); }
}

class FailedFinalProofProcess extends ShutdownResponseLostProcess {
  override async verifyExactExit(): Promise<WorkerExitEvidence | null> {
    const evidence = await super.verifyExactExit();
    if (evidence?.terminalDrain === undefined) return evidence;
    return { ...evidence, terminalDrain: { ...evidence.terminalDrain,
      status: 'worker-drain-failed', error_code: 'timeout', http_stopped: true } };
  }
}

class StalledExitProbeProcess extends RecoveredProcess {
  override async drainStatus(): Promise<WorkerDrainStartedMessage> {
    return { status: 'worker-draining', ...IDENTITY, boot_nonce: WORKER.boot_nonce!, pid: this.pid,
      revision: WORKER.revision, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
      drain_id: '94000000-0000-4000-8000-000000000001', policy: this.originalPolicy,
      remaining_ms: 0, publication: WORKER.publication };
  }
  override verifyExactExit(): Promise<WorkerExitEvidence | null> { return new Promise(() => undefined); }
}

async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 32; step += 1) await Promise.resolve();
}

async function runWithFakeClock(
  process: FakeProcess,
  scheduler: FakeScheduler,
  policy: PublicationPolicy,
): Promise<readonly [number[], ('graceful' | 'force')[], number]> {
  const realNow = Date.now;
  const now = { value: 1_000_000 };
  Date.now = () => now.value;
  try {
    const pending = drainWorkers([{ ...WORKER, process }], scheduler, policy);
    await flushMicrotasks();
    while (scheduler.size > 0) {
      scheduler.fireNext(now);
      await flushMicrotasks();
    }
    await pending;
    return [scheduler.delays, process.calls, scheduler.elapsed];
  } finally {
    Date.now = realNow;
  }
}

async function drainEvidenceWithFakeClock(process: FakeProcess, scheduler: FakeScheduler, policy: PublicationPolicy) {
  const realNow = Date.now;
  const now = { value: 1_000_000 };
  Date.now = () => now.value;
  try {
    const pending = drainWorkers([{ ...WORKER, process }], scheduler, policy);
    await flushMicrotasks();
    while (scheduler.size > 0) { scheduler.fireNext(now); await flushMicrotasks(); }
    return await pending;
  } finally { Date.now = realNow; }
}

describe('drainWorkers', () => {
  const policy: PublicationPolicy = { drain_start_timeout_ms: 1_000, drain_timeout_ms: 2_000, worker_exit_timeout_ms: 3_000 };

  test('uses separate start, drain and exit deadlines after natural drain proof', async () => {
    const scheduler = new FakeScheduler();
    const process = new FakeProcess(true);
    const [delays, calls, elapsed] = await runWithFakeClock(process, scheduler, policy);

    expect(elapsed).toBeLessThanOrEqual(100);
    expect(delays).toEqual([policy.drain_start_timeout_ms, policy.worker_exit_timeout_ms]);
    expect(calls).toEqual(['graceful']);
  });

  test('retains ownership without force when start is unconfirmed and drain has no proof', async () => {
    const scheduler = new FakeScheduler();
    const process = new FakeProcess(false);
    const [delays, calls, elapsed] = await runWithFakeClock(process, scheduler, policy);

    expect(elapsed).toBeLessThanOrEqual(policy.drain_start_timeout_ms);
    expect(delays).toEqual([policy.drain_start_timeout_ms, 100]);
    expect(calls).toEqual([]);
  });

  test('reports an explicit C command rejection immediately and clears start waiters without D or force', async () => {
    const scheduler = new FakeScheduler();
    const process = new RejectingProcess();
    const result = await drainWorkers([{ ...WORKER, process }], scheduler, policy);
    expect(result[0]?.acknowledgementFailure).toMatchObject({ code: 'apply_failed', detail: 'explicit HTTP command rejection' });
    expect(result[0]?.unknownStage).toBe('rejected');
    expect(process.calls).toEqual([]);
    expect(scheduler.size).toBe(0);
    expect(scheduler.delays).toEqual([policy.drain_start_timeout_ms, 100]);
  });

  test('reconnects to the existing drain id and frozen policy without resetting D', async () => {
    const scheduler = new FakeScheduler();
    const process = new RecoveredProcess(true);
    const requestedPolicy: PublicationPolicy = {
      drain_start_timeout_ms: 1_000, drain_timeout_ms: 3_000, worker_exit_timeout_ms: 1_000,
    };
    const result = await runWithFakeClock(process, scheduler, requestedPolicy);
    expect(process.sent).toEqual([]);
    expect(result[0]).toEqual([1_500, 100, process.originalPolicy.worker_exit_timeout_ms]);
    expect(result[2]).toBeLessThanOrEqual(1_600);
    expect(result[1]).toEqual(['graceful']);
  });

  test('keeps one task across a C timeout until signed terminal status resolves', async () => {
    const scheduler = new FakeScheduler();
    const process = new CRecoveryProcess();
    const realNow = Date.now;
    const now = { value: 1_000_000 };
    Date.now = () => now.value;
    try {
      const pending = drainWorkersUntilKnown([{ ...WORKER, process }], scheduler, policy);
      await flushMicrotasks();
      while (scheduler.size > 0) { scheduler.fireNext(now); await flushMicrotasks(); }
      const evidence = await pending;
      expect(process.sent).toHaveLength(1);
      expect(evidence[0]?.acknowledgementFailure).toBeNull();
      const sent = process.sent[0];
      const sentDrainId = sent?.command === 'drain-worker' ? sent.drain_id : undefined;
      expect(evidence[0]?.exitEvidence?.terminalDrain?.drain_id).toBe(sentDrainId);
      expect(process.calls).toEqual([]);
    } finally { Date.now = realNow; }
  });

  test('signed cleanup failure plus exact exit is degraded and cannot converge', async () => {
    const scheduler = new FakeScheduler();
    const process = new TerminalStatusProcess('failed');
    const result = await drainEvidenceWithFakeClock(process, scheduler, DEFAULT_PUBLICATION_POLICY);
    expect(allDrainExitsConfirmed(result)).toBe(true);
    expect(drainFailures(result)).toContainEqual(expect.objectContaining({ code: 'apply_failed' }));
    expect(process.calls).toEqual(['graceful']);
  });

  test('matching signed cleanup and exact exit supersede a lost shutdown response', async () => {
    const process = new ShutdownResponseLostProcess(true);
    const result = await drainEvidenceWithFakeClock(process, new FakeScheduler(), policy);
    expect(allDrainExitsConfirmed(result)).toBe(true);
    expect(drainFailures(result)).toEqual([]);
    expect(result[0]?.terminationError).toBeUndefined();
  });

  test('the final signed drain failure remains degraded even when shutdown response is lost', async () => {
    const result = await drainEvidenceWithFakeClock(new FailedFinalProofProcess(true), new FakeScheduler(), policy);
    expect(allDrainExitsConfirmed(result)).toBe(true);
    expect(drainFailures(result)).toContainEqual(expect.objectContaining({ code: 'timeout' }));
  });

  test('exact process exit without signed terminal evidence remains unconfirmed', async () => {
    const scheduler = new FakeScheduler();
    const process = new ExitWithoutTerminalProcess('pending');
    const result = await drainEvidenceWithFakeClock(process, scheduler, DEFAULT_PUBLICATION_POLICY);
    expect(result[0]?.exitEvidence).toEqual({ exited: true, pid: process.pid });
    expect(allDrainExitsConfirmed(result)).toBe(false);
    expect(drainFailures(result)).toContainEqual(expect.objectContaining({ code: 'mismatched_message' }));
  });

  test('a stalled OS probe cannot extend the terminal polling window', async () => {
    const process = new StalledExitProbeProcess(false);
    const scheduler = new FakeScheduler();
    const result = await drainEvidenceWithFakeClock(process, scheduler, policy);
    expect(result[0]?.unknownStage).toBe('exit');
    expect(result[0]?.exitEvidence).toBeNull();
    expect(scheduler.elapsed).toBeLessThanOrEqual(process.originalPolicy.worker_exit_timeout_ms + 1);
    expect(process.calls).toEqual([]);
  });

  test('terminal polling checks cancellation again after a stalled OS probe', async () => {
    const process = new StalledExitProbeProcess(false);
    const scheduler: PublicationScheduler = { schedule(delay, callback) {
      const timer = setTimeout(callback, delay);
      return { cancel: () => clearTimeout(timer) };
    } };
    let checks = 0;
    const started = performance.now();
    await expect(drainWorkersUntilKnown([{ ...WORKER, process }], scheduler, policy, () => {
      if (++checks === 3) throw new Error('publication cancelled');
    })).rejects.toThrow('publication cancelled');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(process.calls).toEqual([]);
  });});
