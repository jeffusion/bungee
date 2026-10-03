import type { PreparedWorkerAdmission, PublicationScheduler, ScheduledTimeout, WorkerHandoffStatus } from './coordinator-types';
import { bestEffort } from './waiter-safety';

export type AdmissionHandoffResult =
  | { readonly kind: 'complete' }
  | { readonly kind: 'unknown'; readonly reason: 'cancelled' | 'missing' | 'expired' | 'invalid' | 'unavailable' };

const RETIRED_ID = /^sha256:[0-9a-f]{64}$/;

function validStatus(value: WorkerHandoffStatus): boolean {
  return typeof value.retired_id === 'string' && RETIRED_ID.test(value.retired_id)
    && Number.isSafeInteger(value.pending) && value.pending >= 0
    && typeof value.complete === 'boolean'
    && Number.isSafeInteger(value.remaining_ms) && value.remaining_ms >= 0
    && (!value.complete || value.pending === 0);
}

function waitBeforePoll(scheduler: PublicationScheduler, delay: number, signal?: AbortSignal): Promise<'poll' | 'cancelled' | 'unavailable'> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ScheduledTimeout | undefined;
    const finish = (value: 'poll' | 'cancelled' | 'unavailable'): void => {
      if (settled) return;
      settled = true;
      bestEffort(() => timeout?.cancel());
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = (): void => finish('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { timeout = scheduler.schedule(delay, () => finish('poll')); }
    catch { finish('unavailable'); }
    if (settled) bestEffort(() => timeout?.cancel());
  });
}

/**
 * Wait for the ingress-owned pre-drain handoff barrier. Its remaining time is authoritative:
 * Retry at most two unavailable status reads on the same handle. Never prepare/commit
 * again, restart H, or begin worker D without an exact signed completion status.
 */
export async function waitForAdmissionHandoff(
  prepared: PreparedWorkerAdmission,
  scheduler: PublicationScheduler,
  hasRetiredWorkers: boolean,
  signal?: AbortSignal,
): Promise<AdmissionHandoffResult> {
  if (!hasRetiredWorkers && prepared.handoffStatus === undefined) return { kind: 'complete' };
  let retiredId: string | null = null;
  let statusFailures = 0;
  while (true) {
    if (signal?.aborted) return { kind: 'unknown', reason: 'cancelled' };
    try {
      if (prepared.handoffStatus === undefined) return { kind: 'unknown', reason: 'missing' };
      const status = await prepared.handoffStatus();
      if (status === null) return hasRetiredWorkers
        ? { kind: 'unknown', reason: 'missing' }
        : { kind: 'complete' };
      if (!validStatus(status) || (retiredId !== null && status.retired_id !== retiredId)) return { kind: 'unknown', reason: 'invalid' };
      retiredId = status.retired_id;
      if (status.complete) return { kind: 'complete' };
      if (status.remaining_ms === 0) return { kind: 'unknown', reason: 'expired' };
      const resumed = await waitBeforePoll(scheduler, Math.max(1, Math.min(100, status.remaining_ms)), signal);
      if (resumed !== 'poll') return { kind: 'unknown', reason: resumed };
    } catch (error) {
      if (signal?.aborted) return { kind: 'unknown', reason: 'cancelled' };
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
      // Definite identity/protocol rejections remain unknown immediately. Generic
      // transport errors and recovery timeouts may clear on a fresh signed read.
      const retryable = code === undefined || ['network', 'timeout', 'unavailable', 'control_recovering', 'outcome_unknown'].includes(String(code));
      if (!retryable || ++statusFailures > 2) return { kind: 'unknown', reason: 'unavailable' };
      const resumed = await waitBeforePoll(scheduler, 100, signal);
      if (resumed !== 'poll') return { kind: 'unknown', reason: resumed };
    }
  }
}
