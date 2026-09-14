import type {
  ActiveConfigurationPublication,
} from '../config-storage';
import type {
  MasterPublicationOutcome,
  ServingConfigWorker,
} from '../config-publication';

type PublicationTaskManagerOptions = {
  readonly publish: (
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
  ) => Promise<MasterPublicationOutcome>;
  readonly schedule?: (callback: () => void) => void;
};

export type RecoveryTaskResult =
  | { readonly kind: 'complete' }
  | { readonly kind: 'retryable'; readonly error?: unknown }
  | { readonly kind: 'fatal'; readonly error: Error };

export interface PublicationTaskLifecycle {
  enqueue(
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
  ): void;
  setFatalHandler(handler: (error: Error) => void): void;
  stop(): Promise<void>;
  enqueueRecovery(task: () => Promise<RecoveryTaskResult>): Promise<RecoveryTaskResult>;
}

export class PublicationTaskError extends Error {
  readonly name = 'PublicationTaskError';
}

export class PublicationTaskManager implements PublicationTaskLifecycle {
  private accepting = true;
  private fatalHandler: ((error: Error) => void) | null = null;
  private tail = Promise.resolve();
  private readonly schedule: (callback: () => void) => void;

  constructor(private readonly options: PublicationTaskManagerOptions) {
    this.schedule = options.schedule ?? queueMicrotask;
  }

  setFatalHandler(handler: (error: Error) => void): void {
    if (this.fatalHandler !== null) throw new PublicationTaskError('fatal handler is already configured');
    this.fatalHandler = handler;
  }

  enqueue(
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
  ): void {
    if (!this.accepting) throw new PublicationTaskError('publication task manager is stopped');
    if (this.fatalHandler === null) throw new PublicationTaskError('fatal handler is not configured');
    const scheduled = new Promise<void>((resolve, reject) => {
      try { this.schedule(resolve); } catch (error) { reject(error); }
    });
    const publication = this.tail.then(() => scheduled)
      .then(() => this.options.publish(active, oldWorkers));
    this.tail = publication.then(
      (outcome) => {
        if (outcome.kind === 'outcome_unknown' && outcome.fatal) {
          this.report(new PublicationTaskError(`fatal publication outcome: ${outcome.code}`, { cause: outcome.error }));
        }
      },
      (error: unknown) => {
        this.report(error instanceof Error ? error : new PublicationTaskError('publication task failed', { cause: error }));
      },
    );
  }

  stop(): Promise<void> {
    this.accepting = false;
    return this.tail;
  }

  enqueueRecovery(task: () => Promise<RecoveryTaskResult>): Promise<RecoveryTaskResult> {
    if (!this.accepting) return Promise.resolve({ kind: 'retryable', error: new PublicationTaskError('publication task manager is stopped') });
    const recovery = this.tail.then(task).catch((error): RecoveryTaskResult => ({
      kind: 'retryable', error,
    }));
    this.tail = recovery.then(() => undefined, () => undefined);
    return recovery;
  }

  private report(error: Error): void {
    const handler = this.fatalHandler;
    if (handler === null) throw new PublicationTaskError('fatal handler is not configured', { cause: error });
    handler(error);
  }
}
