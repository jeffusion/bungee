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
  test('retries a transient status failure on the same barrier before allowing drain', async () => {
    const scheduler = new ManualScheduler();
    let reads = 0;
    const prepared: PreparedWorkerAdmission = {
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() {
        if (++reads === 1) throw Object.assign(new Error('status connection reset'), { code: 'network' });
        return { retired_id: `sha256:${'a'.repeat(64)}`, pending: 0, complete: true, remaining_ms: 0 };
      },
    };
    const waiting = waitForAdmissionHandoff(prepared, scheduler, true);
    await Promise.resolve();
    await Promise.resolve();
    scheduler.fireNext();
    expect(await waiting).toEqual({ kind: 'complete' });
    expect(reads).toBe(2);
  });

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

  test('bounds repeated unavailable reads and never treats an unknown barrier as complete', async () => {
    let reads = 0;
    const scheduler: PublicationScheduler = { schedule(_delay, callback) {
      queueMicrotask(callback);
      return { cancel() {} };
    } };
    const prepared: PreparedWorkerAdmission = {
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() { reads += 1; throw new Error('status unavailable'); },
    };
    expect(await waitForAdmissionHandoff(prepared, scheduler, true)).toEqual({ kind: 'unknown', reason: 'unavailable' });
    expect(reads).toBe(3);
  });

  test('stops on a protocol rejection without retrying or reopening H', async () => {
    const scheduler = new ManualScheduler();
    let reads = 0;
    expect(await waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() { reads += 1; throw Object.assign(new Error('invalid MAC'), { code: 'invalid_mac' }); },
    }, scheduler, true)).toEqual({ kind: 'unknown', reason: 'unavailable' });
    expect(reads).toBe(1);
    expect(scheduler.size).toBe(0);
  });

  test('a status retry cannot bypass an expired pending barrier', async () => {
    let reads = 0;
    const scheduler: PublicationScheduler = { schedule(_delay, callback) {
      queueMicrotask(callback);
      return { cancel() {} };
    } };
    expect(await waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() {
        if (++reads === 1) throw new Error('status unavailable');
        return { retired_id: `sha256:${'a'.repeat(64)}`, pending: 1, complete: false, remaining_ms: 0 };
      },
    }, scheduler, true)).toEqual({ kind: 'unknown', reason: 'expired' });
    expect(reads).toBe(2);
  });

  test('cancels an unavailable-status retry without sending a later read', async () => {
    const scheduler = new ManualScheduler();
    const controller = new AbortController();
    let reads = 0;
    const waiting = waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() { reads += 1; throw new Error('status unavailable'); },
    }, scheduler, true, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.size).toBe(1);
    controller.abort();
    expect(await waiting).toEqual({ kind: 'unknown', reason: 'cancelled' });
    expect(reads).toBe(1);
    expect(scheduler.size).toBe(0);
  });

  test('a throwing retry scheduler returns unknown and removes its abort listener', async () => {
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => { listeners += 1; add(...args); }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { listeners -= 1; remove(...args); }) as typeof remove;
    const result = await waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() { throw new Error('status unavailable'); },
    }, { schedule() { throw new Error('scheduler unavailable'); } }, true, controller.signal);
    expect(result).toEqual({ kind: 'unknown', reason: 'unavailable' });
    expect(listeners).toBe(0);
  });

  test('a throwing timer cancel cannot strand a completed handoff wait', async () => {
    let reads = 0;
    expect(await waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() {
        return { retired_id: `sha256:${'a'.repeat(64)}`, pending: reads++ === 0 ? 1 : 0,
          complete: reads > 1, remaining_ms: 100 };
      },
    }, { schedule(_delay, callback) {
      queueMicrotask(callback);
      return { cancel() { throw new Error('timer cancel failed'); } };
    } }, true)).toEqual({ kind: 'complete' });
    expect(reads).toBe(2);
  });

  test('rejects a changed barrier identity after a transient status failure', async () => {
    let reads = 0;
    expect(await waitForAdmissionHandoff({
      async commit() {}, async abort() {}, async releaseRetiredAfterExitProof() {},
      async handoffStatus() {
        if (++reads === 2) throw new Error('status unavailable');
        return { retired_id: `sha256:${(reads === 1 ? 'a' : 'b').repeat(64)}`, pending: reads === 1 ? 1 : 0,
          complete: reads > 1, remaining_ms: 100 };
      },
    }, { schedule(_delay, callback) { queueMicrotask(callback); return { cancel() {} }; } }, true))
      .toEqual({ kind: 'unknown', reason: 'invalid' });
    expect(reads).toBe(3);
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
