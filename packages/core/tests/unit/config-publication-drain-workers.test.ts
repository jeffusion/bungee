import { describe, expect, test } from 'bun:test';
import type {
  ConfigPublicationWorkerProcess,
  PublicationScheduler,
  ScheduledTimeout,
  ServingConfigWorker,
  WorkerExitEvidence,
} from '../../src/config-publication';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../../src/config-publication/messages';
import { drainWorkers } from '../../src/config-publication/drain-workers';

const IDENTITY: ConfigProcessIdentity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 0,
};
const WORKER: ServingConfigWorker = {
  process: undefined as never,
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
    const entry = this.pending.shift();
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
  readonly calls: ('graceful' | 'force')[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<(evidence: WorkerExitEvidence) => void>();
  constructor(private readonly acknowledge: boolean) {}

  send(_message: ConfigMasterMessage): Promise<void> {
    if (this.acknowledge) {
      for (const listener of this.messageListeners) listener({
        status: 'worker-drained', ...IDENTITY, boot_nonce: 'boot', pid: this.pid,
        revision: 1, content_hash: WORKER.content_hash, plugin_catalog_hash: WORKER.plugin_catalog_hash,
        publication: null,
      });
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

  terminate(mode: 'graceful' | 'force'): Promise<void> {
    this.calls.push(mode);
    return Promise.resolve();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

async function runWithFakeClock(
  process: FakeProcess,
  scheduler: FakeScheduler,
  timeoutMs: number,
): Promise<readonly [number[], ('graceful' | 'force')[], number]> {
  const realNow = Date.now;
  const now = { value: 1_000_000 };
  Date.now = () => now.value;
  try {
    const pending = drainWorkers([{ ...WORKER, process }], scheduler, timeoutMs);
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

describe('drainWorkers', () => {
  test('keeps ACK and termination within one worker deadline', async () => {
    const scheduler = new FakeScheduler();
    const process = new FakeProcess(true);
    const [delays, calls, elapsed] = await runWithFakeClock(process, scheduler, 90);

    expect(elapsed).toBeLessThanOrEqual(90);
    expect(delays[0]).toBe(30);
    expect(delays).toEqual([30, 45, 45]);
    expect(calls).toEqual(['graceful', 'force']);
  });

  test('does not wait through three full timeout windows when ACK is exhausted', async () => {
    const scheduler = new FakeScheduler();
    const process = new FakeProcess(false);
    const [delays, calls, elapsed] = await runWithFakeClock(process, scheduler, 90);

    expect(elapsed).toBeLessThanOrEqual(90);
    expect(delays).toEqual([30, 30, 30]);
    expect(calls).toEqual(['graceful', 'force']);
  });
});
