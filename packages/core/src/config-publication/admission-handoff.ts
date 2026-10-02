import type { PreparedWorkerAdmission, PublicationScheduler, WorkerHandoffStatus } from './coordinator-types';

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

/**
 * Wait for the ingress-owned pre-drain handoff barrier. Its remaining time is authoritative:
 * after it expires, keep polling the same handle without restarting H or consuming worker D.
 */
export async function waitForAdmissionHandoff(
  prepared: PreparedWorkerAdmission,
  scheduler: PublicationScheduler,
  hasRetiredWorkers: boolean,
  signal?: AbortSignal,
): Promise<AdmissionHandoffResult> {
  if (!hasRetiredWorkers && prepared.handoffStatus === undefined) return { kind: 'complete' };
  let retiredId: string | null = null;
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
      const resumed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          timeout.cancel();
          signal?.removeEventListener('abort', abort);
          resolve(value);
        };
        const timeout = scheduler.schedule(Math.max(1, Math.min(100, status.remaining_ms)), () => finish(true));
        const abort = (): void => finish(false);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      if (!resumed) return { kind: 'unknown', reason: 'cancelled' };
    } catch {
      return { kind: 'unknown', reason: signal?.aborted ? 'cancelled' : 'unavailable' };
    }
  }
}
