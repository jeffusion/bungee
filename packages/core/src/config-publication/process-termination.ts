import type {
  ConfigPublicationWorkerProcess,
  PublicationScheduler,
  ScheduledTimeout,
  WorkerExitEvidence,
} from './coordinator-types';
import { bestEffort } from './waiter-safety';

export type ProcessTerminationResult = {
  readonly exitEvidence: WorkerExitEvidence | null;
  readonly terminationError?: unknown;
  readonly waitError?: unknown;
};

export async function terminateWithEscalation(
  process: ConfigPublicationWorkerProcess,
  scheduler: PublicationScheduler,
  gracefulTimeoutMs: number,
  forceTimeoutMs: number,
  allowForce = true,
  exitDeadline?: import('./types').WorkerExitDeadlineEvidence,
): Promise<ProcessTerminationResult> {
  let exitEvidence: WorkerExitEvidence | null = null;
  let phaseFinish: ((evidence: WorkerExitEvidence) => void) | null = null;
  let unsubscribe = (): void => undefined;
  let waitError: unknown;
  let probeError: unknown;
  let terminationError: unknown;

  try {
    unsubscribe = process.subscribeExit((evidence) => {
      if (evidence.pid !== process.pid) return;
      exitEvidence = evidence;
      phaseFinish?.(evidence);
    });
  } catch (error) {
    waitError = error;
  }

  const waitPhase = async (timeoutMs: number): Promise<void> => {
    if (exitEvidence !== null) return;
    await new Promise<void>((resolve) => {
      let timeout: ScheduledTimeout = { cancel: () => undefined };
      let probeTimeout: ScheduledTimeout = { cancel: () => undefined };
      let settled = false;
      const finish = (evidence: WorkerExitEvidence | null): void => {
        if (settled) return;
        settled = true;
        if (evidence !== null) exitEvidence = evidence;
        phaseFinish = null;
        bestEffort(() => { timeout.cancel(); });
        bestEffort(() => { probeTimeout.cancel(); });
        resolve();
      };
      // Adopted workers have no child exit event. Check their exact OS identity
      // during the grace period rather than waiting for its entire deadline.
      const probe = async (): Promise<void> => {
        if (settled || process.verifyExactExit === undefined) return;
        try {
          const evidence = await process.verifyExactExit();
          if (!settled && evidence !== null && evidence.pid === process.pid) finish(evidence);
        } catch (error) {
          probeError = error;
        }
        if (!settled) bestEffort(() => {
          probeTimeout = scheduler.schedule(100, () => { void probe(); });
        });
      };
      phaseFinish = finish;
      try {
        timeout = scheduler.schedule(timeoutMs, () => { finish(null); });
        if (settled) bestEffort(() => { timeout.cancel(); });
        else if (timeoutMs > 0) void probe();
      } catch (error) {
        waitError = error;
        finish(null);
      }
    });
  };

  const requestTermination = (mode: 'graceful' | 'force', timeoutMs: number): void => {
    try {
      void process.terminate(mode, timeoutMs, exitDeadline).then(
        () => undefined,
        (error) => { terminationError ??= error; },
      );
    } catch (error) {
      terminationError ??= error;
    }
  };

  try {
    if (exitEvidence === null) requestTermination('graceful', gracefulTimeoutMs);
    await waitPhase(gracefulTimeoutMs);
    if (exitEvidence === null && allowForce) {
      requestTermination('force', forceTimeoutMs);
      await waitPhase(forceTimeoutMs);
    }
  } finally {
    bestEffort(unsubscribe);
  }

  if (exitEvidence !== null) return {
    exitEvidence,
    ...(terminationError === undefined ? {} : { terminationError }),
    ...(waitError === undefined ? {} : { waitError }),
  };
  return {
    exitEvidence: null,
    ...(terminationError === undefined ? {} : { terminationError }),
    ...(waitError === undefined && probeError === undefined ? {} : { waitError: waitError ?? probeError }),
  };
}
