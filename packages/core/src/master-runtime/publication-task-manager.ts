import type {
  MasterPublicationOutcome,
} from '../config-publication';

type PublicationTaskManagerOptions = {
  readonly publish: (signal: AbortSignal) => Promise<MasterPublicationOutcome | null>;
  readonly onWake?: () => void;
  readonly schedule?: (callback: () => void) => void;
};

export type RecoveryTaskResult =
  | { readonly kind: 'complete' }
  | { readonly kind: 'retryable'; readonly error?: unknown }
  | { readonly kind: 'fatal'; readonly error: Error };

export interface PublicationTaskLifecycle {
  /** Requests one publication run; repeated requests during a run coalesce into one follow-up. */
  wake(): void;
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
  private pending = false;
  private scheduled = false;
  private running: Promise<void> | null = null;
  private retainConfigurationWork: ((work: Promise<unknown>) => void) | null = null;
  private readonly stopController = new AbortController();
  private readonly schedule: (callback: () => void) => void;

  constructor(private readonly options: PublicationTaskManagerOptions) {
    this.schedule = options.schedule ?? queueMicrotask;
  }

  setFatalHandler(handler: (error: Error) => void): void {
    if (this.fatalHandler !== null) throw new PublicationTaskError('fatal handler is already configured');
    this.fatalHandler = handler;
  }

  wake(): void {
    if (!this.accepting) return;
    this.options.onWake?.();
    this.pending = true;
    if (this.scheduled || this.running !== null) return;
    this.scheduled = true;
    const scheduled = new Promise<void>((resolve, reject) => {
      try {
        this.schedule(() => { this.scheduled = false; resolve(); });
      } catch (error) {
        this.scheduled = false;
        reject(error);
      }
    });
    const running = this.tail.then(() => scheduled).then(() => this.drain());
    this.running = running;
    this.tail = running.catch((error: unknown) => {
      this.report(error instanceof Error ? error : new PublicationTaskError('publication task failed', { cause: error }));
    }).then(() => {
      if (this.running === running) this.running = null;
      if (this.pending && this.accepting) this.wake();
    });
  }

  stop(): Promise<void> {
    this.accepting = false;
    this.pending = false;
    this.stopController.abort('publication tasks stopping');
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

  serializeConfiguration<T>(task: () => Promise<T>): Promise<T> {
    let work: Promise<unknown> | undefined;
    const current = this.tail.then(async () => {
      this.retainConfigurationWork = (continuation) => { work = continuation; };
      try { return await task(); }
      finally { this.retainConfigurationWork = null; }
    });
    // A saved response can finish before cutover and retirement release the queue.
    this.tail = current.then(() => work, () => work).then(() => undefined, () => undefined);
    return current;
  }

  retainConfiguration(work: Promise<unknown>): void {
    if (this.retainConfigurationWork === null) throw new PublicationTaskError('configuration task does not own the publication queue');
    this.retainConfigurationWork(work);
  }

  private async drain(): Promise<void> {
    while (this.accepting && this.pending) {
      this.pending = false;
      let outcome: MasterPublicationOutcome | null = null;
      try {
        outcome = await this.options.publish(this.stopController.signal);
      } catch (error) {
        this.report(error instanceof Error ? error : new PublicationTaskError('publication task failed', { cause: error }));
        return;
      }
      if (outcome?.kind === 'outcome_unknown') {
        if (outcome.fatal) {
          this.report(new PublicationTaskError(`fatal publication outcome: ${outcome.code}`, { cause: outcome.error }));
        }
        // Do not start another publication before the unknown outcome is reconciled.
        return;
      }
    }
  }

  private report(error: Error): void {
    const handler = this.fatalHandler;
    if (handler === null) throw new PublicationTaskError('fatal handler is not configured', { cause: error });
    handler(error);
  }
}
