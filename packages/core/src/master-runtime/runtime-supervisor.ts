import type {
  ConfigPublicationWorkerProcess,
  ServingConfigWorker,
  StartupPublicationOutcome,
} from '../config-publication/coordinator-types';
import { isExactServingTarget } from './runtime-evidence';
import { classifyRecoveryError, classifyStartupOutcome } from '../config-publication/recovery-disposition';
import {
  MasterRuntimeError,
  type MasterRuntimeOptions,
  type MasterRuntimeWorkerExitListener,
} from './runtime-contracts';

const MAX_FAILED_REPAIR_ROUNDS = 3;
class StaleRepairGeneration extends Error {}

type SupervisorPhase = 'idle' | 'starting' | 'started' | 'stopped';

export class MasterRuntimeSupervisor {
  private phase: SupervisorPhase = 'idle';
  private dirty = false;
  private repairing = false;
  private failedRounds = 0;
  private unsubscribeExit: (() => void) | null = null;
  private unsubscribeUnavailable: (() => void) | null = null;
  private unsubscribeRecoveryGate: (() => void) | null = null;
  private repairTask: Promise<void> | null = null;
  private readonly unavailable = new Set<string>();

  constructor(
    private readonly options: MasterRuntimeOptions,
    private readonly failClosed: (error: MasterRuntimeError) => void,
  ) {}

  subscribe(): void {
    this.phase = 'starting';
    const listener: MasterRuntimeWorkerExitListener = (process) => { this.workerExited(process); };
    this.unsubscribeExit = this.options.workerPool.subscribeExit(listener);
    this.unsubscribeUnavailable = this.options.workerPool.subscribeUnavailable((process, evidence) => {
      this.options.onWorkerUnavailable(process, evidence);
      this.workerUnavailable(process);
    });
    const gate = this.options.ingressBootRecoveryGate;
    this.unsubscribeRecoveryGate = gate?.subscribeReleased(0, () => {
      try {
        if (this.phase === 'idle' || this.phase === 'stopped'
          || gate.isCurrent(gate.generation) || gate.signal.aborted) return;
        this.dirty = true;
        if (this.phase === 'started') this.scheduleRepair();
      } catch (error) {
        try {
          this.failClosed(new MasterRuntimeError('repair_failed', 'recovery gate release handling failed', error));
        } catch {
          // A release callback must not strand other gate listeners.
        }
      }
    }) ?? null;
  }

  started(): void {
    this.phase = 'started';
    if (this.dirty) this.scheduleRepair();
  }

  detach(): (() => void) | null {
    this.phase = 'stopped';
    const unsubscribe = this.unsubscribeExit;
    this.unsubscribeExit = null;
    const unavailable = this.unsubscribeUnavailable;
    this.unsubscribeUnavailable = null;
    const recoveryGate = this.unsubscribeRecoveryGate;
    this.unsubscribeRecoveryGate = null;
    for (const listener of [unsubscribe, unavailable, recoveryGate]) {
      try { listener?.(); } catch { /* detach must not prevent shutdown cleanup */ }
    }
    return null;
  }

  settled(): Promise<void> {
    return this.repairTask ?? Promise.resolve();
  }

  private workerExited(process: ConfigPublicationWorkerProcess): void {
    void this.handleWorkerExit(process);
  }

  private workerUnavailable(process: ConfigPublicationWorkerProcess): void {
    if (this.phase === 'idle' || this.phase === 'stopped') return;
    const key = this.identityKey(process);
    if (this.unavailable.has(key)) return;
    this.unavailable.add(key);
    this.dirty = true;
    if (this.phase === 'started' && !this.recoveryGateActive()) this.scheduleRepair();
  }

  private async handleWorkerExit(process: ConfigPublicationWorkerProcess): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'stopped') return;
    const admitted = this.options.admission.snapshot();
    if (!admitted.some((worker) => worker.process === process)) return;
    this.dirty = true;
    if (this.phase === 'started' && !this.recoveryGateActive()) this.scheduleRepair();
  }

  private async shrinkToOwned(
    admitted: readonly ServingConfigWorker[] = this.options.admission.snapshot(),
    context: { readonly generation: number; readonly signal: AbortSignal } | null = null,
  ): Promise<readonly ServingConfigWorker[]> {
    this.assertGeneration(context);
    const survivors = admitted.filter(({ process }) => this.options.workerPool.owns(process));
    if (survivors.length === admitted.length) return admitted;
    if (survivors.length === 0) { this.options.admission.clear(); return survivors; }
    let prepared;
    try {
      prepared = await this.options.admission.prepare(survivors, context?.signal);
    } catch (error) {
      if (this.isStale(error, context)) { this.dirty = true; return survivors; }
      throw error;
    }
    this.assertGeneration(context);
    const latestAdmitted = this.options.admission.snapshot();
    const latestSurvivors = latestAdmitted.filter(({ process: current }) => this.options.workerPool.owns(current));
    if (latestSurvivors.length !== survivors.length
      || latestSurvivors.some(({ process: current }, index) => current !== survivors[index]?.process)) {
      return this.shrinkToOwned(latestAdmitted, context);
    }
    try { await prepared.commit(); }
    catch (error) {
      if (this.isStale(error, context)) { this.dirty = true; return survivors; }
      throw error;
    }
    this.assertGeneration(context);
    return survivors;
  }

  private scheduleRepair(): void {
    if (this.repairing || this.phase !== 'started' || this.recoveryGateActive()) return;
    this.repairing = true;
    const queued = this.options.publicationTasks.enqueueRecovery(async () => {
      try {
        await this.repair();
        return { kind: 'complete' as const };
      } catch (error) {
        return { kind: 'fatal' as const, error: error instanceof Error ? error : new Error(String(error)) };
      }
    });
    this.repairTask = queued.then(
      (result) => {
        this.repairing = false;
        this.repairTask = null;
        if (result.kind === 'fatal') {
          this.failClosed(new MasterRuntimeError('repair_failed', 'worker repair failed', result.error));
          return;
        }
        if (this.dirty && this.phase === 'started') this.scheduleRepair();
      },
      (error: unknown) => {
        this.repairing = false;
        this.repairTask = null;
        const failure = error instanceof MasterRuntimeError
          ? error : new MasterRuntimeError('repair_failed', 'worker repair failed', error);
        this.failClosed(failure);
      },
    );
  }

  private async repair(): Promise<void> {
    while (this.phase === 'started' && this.dirty) {
      if (this.recoveryGateActive()) { this.dirty = true; return; }
      const context = this.repairContext();
      this.dirty = false;
      const admitted = this.options.admission.snapshot();
      const hadUnavailable = this.unavailable.size > 0;
      const unavailable = admitted.filter(({ process }) => this.unavailable.has(this.identityKey(process)));
      if (hadUnavailable && unavailable.length === 0) {
        this.assertGeneration(context);
        for (const key of [...this.unavailable]) {
          if (!admitted.some(({ process }) => this.identityKey(process) === key)) this.unavailable.delete(key);
        }
        if (this.dirty) continue;
        return;
      }
      let survivors: readonly ServingConfigWorker[];
      try {
        survivors = unavailable.length > 0
          ? admitted.filter(({ process }) => !this.unavailable.has(this.identityKey(process)))
          : await this.shrinkToOwned(admitted, context);
      } catch (error) {
        if (this.isStale(error, context)) { this.dirty = true; return; }
        throw error;
      }
      const retiring = unavailable.length > 0 ? unavailable : [];
      try { this.assertGeneration(context); }
      catch (error) {
        if (this.isStale(error, context)) { this.dirty = true; return; }
        throw error;
      }
      let outcome: StartupPublicationOutcome;
      try {
        outcome = await this.options.coordinator.startCurrent(
          this.options.repository.getSnapshot(),
          survivors,
          retiring,
          context.signal,
        );
      } catch (error) {
        if (this.isStale(error, context)) { this.dirty = true; return; }
        if (classifyRecoveryError(error) === 'fatal') {
          throw new MasterRuntimeError('repair_failed', 'fatal worker repair failure', error);
        }
        try { this.assertGeneration(context); }
        catch (stale) {
          if (this.isStale(stale, context)) { this.dirty = true; return; }
          throw stale;
        }
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
      try { this.assertGeneration(context); }
      catch (error) {
        if (this.isStale(error, context)) { this.dirty = true; return; }
        throw error;
      }
      const currentAdmission = this.options.admission.snapshot();
      const exactTarget = isExactServingTarget(currentAdmission, outcome.serving,
        this.options.repository.getSnapshot(), this.options.expectedPluginCatalogHash, this.options.workerCount,
        this.options.workerPool);
      const classification = classifyStartupOutcome(outcome, exactTarget);
      switch (classification.kind) {
        case 'fatal':
          throw new MasterRuntimeError('repair_failed', 'fatal worker repair outcome', classification.error);
        case 'deterministic':
          this.assertGeneration(context);
          this.unavailable.clear();
          this.failedRounds = 0;
          return;
        case 'success':
          this.assertGeneration(context);
          for (const worker of unavailable) this.unavailable.delete(this.identityKey(worker.process));
          if (!this.dirty) {
            this.failedRounds = 0;
            return;
          }
          continue;
        case 'retryable':
          break;
        default: {
          const unhandled: never = classification;
          throw new MasterRuntimeError('repair_failed', 'unhandled worker repair outcome', unhandled);
        }
      }
      this.assertGeneration(context);
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

  private identityKey(process: ConfigPublicationWorkerProcess): string {
    const identity = process.identity;
    return `${identity.master_generation}:${identity.worker_instance_id}:${identity.worker_slot}`;
  }

  private recoveryGateActive(): boolean {
    const gate = this.options.ingressBootRecoveryGate;
    return gate !== undefined && gate.isCurrent(gate.generation);
  }

  private repairContext(): { readonly generation: number; readonly signal: AbortSignal } {
    const gate = this.options.ingressBootRecoveryGate;
    return gate === undefined
      ? { generation: 0, signal: new AbortController().signal }
      : { generation: gate.generation, signal: gate.signal };
  }

  private assertGeneration(context: { readonly generation: number; readonly signal: AbortSignal } | null): void {
    if (this.phase !== 'started') throw new StaleRepairGeneration('worker repair is no longer started');
    if (context === null) return;
    const gate = this.options.ingressBootRecoveryGate;
    if (gate !== undefined && (gate.generation !== context.generation
      || gate.isCurrent(context.generation) || context.signal.aborted)) {
      throw new StaleRepairGeneration('worker repair generation is stale');
    }
  }

  private isStale(error: unknown, context?: { readonly generation: number; readonly signal: AbortSignal } | null): boolean {
    const gate = this.options.ingressBootRecoveryGate;
    return error instanceof StaleRepairGeneration || this.phase !== 'started' || this.recoveryGateActive()
      || (gate !== undefined && context != null
        && (gate.generation !== context.generation || context.signal.aborted));
  }
}
