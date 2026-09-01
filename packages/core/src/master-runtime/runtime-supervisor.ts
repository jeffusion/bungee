import type {
  ConfigPublicationWorkerProcess,
  ServingConfigWorker,
  StartupPublicationOutcome,
} from '../config-publication/coordinator-types';
import { admissionIsPoolOwned, exactAdmission } from './runtime-evidence';
import {
  MasterRuntimeError,
  type MasterRuntimeOptions,
  type MasterRuntimeWorkerExitListener,
} from './runtime-contracts';

const MAX_FAILED_REPAIR_ROUNDS = 3;

type SupervisorPhase = 'idle' | 'starting' | 'started' | 'stopped';

export class MasterRuntimeSupervisor {
  private phase: SupervisorPhase = 'idle';
  private dirty = false;
  private repairing = false;
  private failedRounds = 0;
  private unsubscribeExit: (() => void) | null = null;
  private repairTask: Promise<void> | null = null;

  constructor(
    private readonly options: MasterRuntimeOptions,
    private readonly failClosed: (error: MasterRuntimeError) => void,
  ) {}

  subscribe(): void {
    this.phase = 'starting';
    const listener: MasterRuntimeWorkerExitListener = (process) => { this.workerExited(process); };
    this.unsubscribeExit = this.options.workerPool.subscribeExit(listener);
  }

  started(): void {
    this.phase = 'started';
    if (this.dirty) this.scheduleRepair();
  }

  detach(): (() => void) | null {
    this.phase = 'stopped';
    const unsubscribe = this.unsubscribeExit;
    this.unsubscribeExit = null;
    return unsubscribe;
  }

  settled(): Promise<void> {
    return this.repairTask ?? Promise.resolve();
  }

  private workerExited(process: ConfigPublicationWorkerProcess): void {
    if (this.phase === 'idle' || this.phase === 'stopped') return;
    const admitted = this.options.admission.snapshot();
    if (!admitted.some((worker) => worker.process === process)) return;
    this.dirty = true;
    try { this.shrinkToOwned(admitted); }
    catch (error) {
      const failure = error instanceof Error
        ? error : new MasterRuntimeError('repair_failed', 'worker admission shrink failed', error);
      this.failClosed(new MasterRuntimeError('repair_failed', 'worker admission shrink failed', failure));
      return;
    }
    if (this.phase === 'started') this.scheduleRepair();
  }

  private shrinkToOwned(
    admitted: readonly ServingConfigWorker[] = this.options.admission.snapshot(),
  ): readonly ServingConfigWorker[] {
    const survivors = admitted.filter(({ process }) => this.options.workerPool.owns(process));
    if (survivors.length === admitted.length) return admitted;
    if (survivors.length === 0) this.options.admission.clear();
    else this.options.admission.prepare(survivors).commit();
    return survivors;
  }

  private scheduleRepair(): void {
    if (this.repairing || this.phase !== 'started') return;
    this.repairing = true;
    this.repairTask = this.repair().then(
      () => {
        this.repairing = false;
        if (this.dirty && this.phase === 'started') this.scheduleRepair();
      },
      (error: unknown) => {
        this.repairing = false;
        const failure = error instanceof MasterRuntimeError
          ? error : new MasterRuntimeError('repair_failed', 'worker repair failed', error);
        this.failClosed(failure);
      },
    );
  }

  private async repair(): Promise<void> {
    while (this.phase === 'started' && this.dirty) {
      this.dirty = false;
      const survivors = this.shrinkToOwned();
      let outcome: StartupPublicationOutcome;
      try {
        outcome = await this.options.coordinator.startCurrent(
          this.options.repository.getSnapshot(),
          survivors,
        );
      } catch (error) {
        this.failedRounds += 1;
        if (this.failedRounds >= MAX_FAILED_REPAIR_ROUNDS) {
          const failure = error instanceof Error
            ? error : new MasterRuntimeError('repair_failed', 'worker repair failed', error);
          throw new MasterRuntimeError(
            'repair_failed',
            'worker repair failed in three consecutive rounds',
            failure,
          );
        }
        this.dirty = true;
        continue;
      }
      const admitted = this.options.admission.snapshot();
      const complete = outcome.kind === 'startup_ready'
        && exactAdmission(admitted, outcome.serving, this.options.workerCount)
        && admissionIsPoolOwned(admitted, this.options.workerPool);
      if (complete && !this.dirty) {
        this.failedRounds = 0;
        return;
      }
      this.failedRounds += 1;
      if (this.failedRounds >= MAX_FAILED_REPAIR_ROUNDS) {
        throw new MasterRuntimeError(
          'repair_failed',
          'worker repair failed or became dirty in three consecutive rounds',
          outcome,
        );
      }
      this.dirty = true;
    }
  }
}
