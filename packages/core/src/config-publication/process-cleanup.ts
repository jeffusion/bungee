import type {
  ConfigPublicationWorkerProcess,
  PendingConfigWorker,
  PublicationScheduler,
  ServingConfigWorker,
  WorkerExitEvidence,
} from './coordinator-types';
import { terminateWithEscalation } from './process-termination';

export type OwnedProcess = {
  readonly process: ConfigPublicationWorkerProcess;
  readonly evidence: PendingConfigWorker | ServingConfigWorker;
};

export type ProcessCleanupResult = {
  readonly process: ConfigPublicationWorkerProcess;
  readonly exitEvidence: WorkerExitEvidence | null;
  readonly terminationError?: unknown;
  readonly waitError?: unknown;
};

export class OwnedProcessCollection {
  private readonly owned = new Map<ConfigPublicationWorkerProcess, OwnedProcess>();

  add(process: ConfigPublicationWorkerProcess, pending: PendingConfigWorker): void {
    this.owned.set(process, { process, evidence: pending });
  }

  promote(process: ConfigPublicationWorkerProcess, privatePort: number): ServingConfigWorker {
    const owned = this.owned.get(process);
    if (owned === undefined) throw new TypeError('cannot promote an unowned process');
    const serving = { ...owned.evidence, private_port: privatePort } satisfies ServingConfigWorker;
    this.owned.set(process, { process, evidence: serving });
    return serving;
  }

  remove(process: ConfigPublicationWorkerProcess): void {
    this.owned.delete(process);
  }

  processes(): readonly ConfigPublicationWorkerProcess[] {
    return [...this.owned.values()].map(({ process }) => process);
  }

  serving(): readonly ServingConfigWorker[] {
    return [...this.owned.values()].flatMap(({ evidence }) =>
      'private_port' in evidence ? [evidence] : []);
  }

  pending(): readonly PendingConfigWorker[] {
    return [...this.owned.values()].flatMap(({ evidence }) =>
      'private_port' in evidence ? [] : [evidence]);
  }

  async cleanup(scheduler: PublicationScheduler, timeoutMs: number): Promise<readonly ProcessCleanupResult[]> {
    const owned = [...this.owned.values()];
    const settled = await Promise.allSettled(owned.map(async ({ process }): Promise<ProcessCleanupResult> => {
      const result = await terminateWithEscalation(process, scheduler, timeoutMs, timeoutMs);
      const { exitEvidence } = result;
      if (exitEvidence !== null) this.owned.delete(process);
      return { process, ...result };
    }));
    return owned.map(({ process }, index) => {
      const result = settled[index];
      if (result?.status === 'fulfilled') return result.value;
      return { process, exitEvidence: null,
        waitError: result?.status === 'rejected' ? result.reason : new Error('cleanup result missing') };
    });
  }
}

export function cleanupConfirmed(results: readonly ProcessCleanupResult[]): boolean {
  return results.every(({ exitEvidence, waitError }) => exitEvidence !== null && waitError === undefined);
}
