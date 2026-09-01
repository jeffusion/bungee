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
): Promise<ProcessTerminationResult> {
  let exitEvidence: WorkerExitEvidence | null = null;
  let phaseFinish: ((evidence: WorkerExitEvidence) => void) | null = null;
  let unsubscribe = (): void => undefined;
  let waitError: unknown;
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
    if (exitEvidence !== null || waitError !== undefined) return;
    await new Promise<void>((resolve) => {
      let timeout: ScheduledTimeout = { cancel: () => undefined };
      let settled = false;
      const finish = (evidence: WorkerExitEvidence | null): void => {
        if (settled) return;
        settled = true;
        if (evidence !== null) exitEvidence = evidence;
        phaseFinish = null;
        bestEffort(() => { timeout.cancel(); });
        resolve();
      };
      phaseFinish = finish;
      try {
        timeout = scheduler.schedule(timeoutMs, () => { finish(null); });
        if (settled) bestEffort(() => { timeout.cancel(); });
      } catch (error) {
        waitError = error;
        finish(null);
      }
    });
  };

  const requestTermination = (mode: 'graceful' | 'force'): void => {
    try {
      void process.terminate(mode).then(
        () => undefined,
        (error) => { terminationError ??= error; },
      );
    } catch (error) {
      terminationError ??= error;
    }
  };

  try {
    if (exitEvidence === null) requestTermination('graceful');
    await waitPhase(gracefulTimeoutMs);
    if (exitEvidence === null) requestTermination('force');
    await waitPhase(forceTimeoutMs);
  } finally {
    bestEffort(unsubscribe);
  }

  if (exitEvidence !== null) return { exitEvidence };
  return {
    exitEvidence: null,
    ...(terminationError === undefined ? {} : { terminationError }),
    ...(waitError === undefined ? {} : { waitError }),
  };
}
