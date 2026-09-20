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

  /**
   * Exact OS exit proof after a wait phase: adopted workers never deliver a child exit
   * event, so the bound process object is asked directly. Evidence is accepted only from
   * this process and only with a matching pid; null (probe says alive) keeps waiting and
   * a thrown unknown probe is recorded without fabricating proof. No OS signal is ever
   * sent here — force termination stays fail-closed.
   */
  const verifyAfterWait = async (): Promise<void> => {
    if (exitEvidence !== null || process.verifyExactExit === undefined) return;
    try {
      const evidence = await process.verifyExactExit();
      if (evidence !== null && evidence.pid === process.pid) exitEvidence = evidence;
    } catch (error) {
      waitError ??= error;
    }
  };

  try {
    if (exitEvidence === null) requestTermination('graceful');
    await waitPhase(gracefulTimeoutMs);
    await verifyAfterWait();
    if (exitEvidence === null) requestTermination('force');
    await waitPhase(forceTimeoutMs);
    await verifyAfterWait();
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
