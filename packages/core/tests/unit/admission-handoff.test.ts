import { describe, expect, test } from 'bun:test';
import { waitForAdmissionHandoff } from '../../src/config-publication/admission-handoff';
import type { PreparedWorkerAdmission, PublicationScheduler, ScheduledTimeout } from '../../src/config-publication/coordinator-types';

class ManualScheduler implements PublicationScheduler {
  readonly delays: number[] = [];
  private callbacks: Array<() => void> = [];
  schedule(delay: number, callback: () => void): ScheduledTimeout {
    this.delays.push(delay);
    this.callbacks.push(callback);
    return { cancel: () => { this.callbacks = this.callbacks.filter((pending) => pending !== callback); } };
  }
  fireNext(): void { this.callbacks.shift()?.(); }
  get size(): number { return this.callbacks.length; }
}

describe('admission handoff wait', () => {
  test('polls the same hash barrier until ingress confirms completion', async () => {
    const scheduler = new ManualScheduler();
    let reads = 0;
    const retiredId = `sha256:${'a'.repeat(64)}`;
    const prepared: PreparedWorkerAdmission = {
      async commit() {},
      async abort() {},
      async releaseRetiredAfterExitProof() {},
      async handoffStatus() {
        reads += 1;
        return reads === 1
          ? { retired_id: retiredId, pending: 1, complete: false, remaining_ms: 100 }
          : { retired_id: retiredId, pending: 0, complete: true, remaining_ms: 0 };
      },
    };
    const waiting = waitForAdmissionHandoff(prepared, scheduler, true);
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(scheduler.delays).toEqual([100]);
    scheduler.fireNext();
    expect(await waiting).toEqual({ kind: 'complete' });
    expect(reads).toBe(2);
  });

  test('does not require a barrier when there is no retired worker set', async () => {
    let reads = 0;
    expect(await waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() { reads += 1; return null; },
    }, new ManualScheduler(), false)).toEqual({ kind: 'complete' });
    expect(reads).toBe(1);
  });

  test('uses the retired admission digest rather than a UUID or canonical JSON identity', async () => {
    let reads = 0;
    const prepared: PreparedWorkerAdmission = {
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() {
        reads += 1;
        return { retired_id: '{"master_generation":"...","workers":[]}', pending: 0, complete: true, remaining_ms: 0 };
      },
    };
    expect(await waitForAdmissionHandoff(prepared, new ManualScheduler(), true)).toEqual({ kind: 'unknown', reason: 'invalid' });
    expect(reads).toBe(1);
  });

  test('returns bounded unknown at H expiry and clears its poll when stopped', async () => {
    const scheduler = new ManualScheduler();
    const controller = new AbortController();
    const prepared: PreparedWorkerAdmission = {
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() { return { retired_id: `sha256:${'c'.repeat(64)}`, pending: 1, complete: false, remaining_ms: 500 }; },
    };
    const waiting = waitForAdmissionHandoff(prepared, scheduler, true, controller.signal);
    await Promise.resolve();
    expect(scheduler.size).toBe(1);
    controller.abort();
    expect(await waiting).toEqual({ kind: 'unknown', reason: 'cancelled' });
    expect(scheduler.size).toBe(0);
  });

  test('treats an absent remote status method as unknown, never complete', async () => {
    expect(await waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
    }, new ManualScheduler(), true)).toEqual({ kind: 'unknown', reason: 'missing' });
  });
});
