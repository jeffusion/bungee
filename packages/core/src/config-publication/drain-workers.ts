import type {
  PublicationFailure,
  PublicationScheduler,
  ServingConfigWorker,
  WorkerExitEvidence,
} from './coordinator-types';
import { waitForDrainAck } from './worker-wait';
import { terminateWithEscalation } from './process-termination';

export type WorkerDrainEvidence = {
  readonly worker: ServingConfigWorker;
  readonly acknowledgementFailure: PublicationFailure | null;
  readonly terminationError?: unknown;
  readonly exitEvidence: WorkerExitEvidence | null;
};

function errorDetail(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message.slice(0, 512) : fallback;
}

export async function drainWorkers(
  workers: readonly ServingConfigWorker[],
  scheduler: PublicationScheduler,
  timeoutMs: number,
): Promise<readonly WorkerDrainEvidence[]> {
  return await Promise.all(workers.map(async (worker) => {
    const { process } = worker;
    const acknowledgement = waitForDrainAck({ worker, scheduler, timeoutMs });
    const sendResult: Promise<PublicationFailure | null> = process.send({ command: 'drain-worker', ...process.identity,
      revision: worker.revision, content_hash: worker.content_hash,
      plugin_catalog_hash: worker.plugin_catalog_hash, publication: worker.publication })
      .then(() => null, (error): PublicationFailure => ({ slot: process.slot, code: 'apply_failed',
        detail: errorDetail(error, 'worker drain command failed') }));
    const acknowledgementFailure = await Promise.race([
      acknowledgement.result,
      sendResult.then((failure) => {
        if (failure !== null) acknowledgement.fail(failure);
        return acknowledgement.result;
      }),
    ]);
    const termination = await terminateWithEscalation(
      process, scheduler, timeoutMs, timeoutMs,
    );
    return { worker, acknowledgementFailure, ...termination };
  }));
}

export function drainFailures(evidence: readonly WorkerDrainEvidence[]): readonly PublicationFailure[] {
  return evidence.flatMap(({ worker, acknowledgementFailure, terminationError, exitEvidence }) => {
    const failures: PublicationFailure[] = acknowledgementFailure === null ? [] : [acknowledgementFailure];
    if (terminationError !== undefined && exitEvidence === null) failures.push({ slot: worker.process.slot, code: 'apply_failed',
      detail: errorDetail(terminationError, 'worker termination failed') });
    if (exitEvidence === null) failures.push({ slot: worker.process.slot, code: 'timeout',
      detail: 'worker exit unconfirmed' });
    return failures;
  });
}

export function allDrainExitsConfirmed(evidence: readonly WorkerDrainEvidence[]): boolean {
  return evidence.every(({ exitEvidence }) => exitEvidence !== null);
}
