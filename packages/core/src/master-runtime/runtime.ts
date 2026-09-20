import type { ServingConfigWorker } from '../config-publication/coordinator-types';
import { cleanupAfterStartupFailure, closeForNormalShutdown } from './runtime-cleanup';
import {
  MasterRuntimeError,
  type MasterRuntimeOptions,
} from './runtime-contracts';
import { admissionIsPoolOwned, exactAdmission } from './runtime-evidence';
import { MasterRuntimeSupervisor } from './runtime-supervisor';

export { MasterRuntimeError } from './runtime-contracts';
export type {
  MasterRuntimeAdmission,
  MasterRuntimeAncillary,
  MasterRuntimeCoordinator,
  MasterRuntimeErrorCode,
  MasterRuntimeIngressBootRecoveryGate,
  MasterRuntimeInstanceLock,
  MasterRuntimeOptions,
  MasterRuntimePublicListener,
  MasterRuntimeRepository,
  MasterRuntimeWorkerExitListener,
  MasterRuntimeWorkerPool,
} from './runtime-contracts';

type RuntimePhase = 'created' | 'starting' | 'started' | 'stopping' | 'stopped';
type ServingResolution = {
  readonly serving: readonly ServingConfigWorker[];
  readonly recoveryOnly: boolean;
};

export class MasterRuntime {
  private phase: RuntimePhase = 'created';
  private shutdownPromise: Promise<void> | null = null;
  private startupSupervisionFailure: MasterRuntimeError | null = null;
  private readonly supervisor: MasterRuntimeSupervisor;

  constructor(private readonly options: MasterRuntimeOptions) {
    if (!Number.isSafeInteger(options.workerCount) || options.workerCount <= 0) {
      throw new MasterRuntimeError('invalid_options', 'workerCount must be a positive safe integer');
    }
    this.supervisor = new MasterRuntimeSupervisor(options, (error) => {
      this.asynchronousFailed(error);
    });
    options.publicationTasks.setFatalHandler((error) => this.asynchronousFailed(
      new MasterRuntimeError('publication_failed', 'configuration publication failed', error),
    ));
  }

  get publicPort(): number | null {
    return this.phase === 'started' ? this.options.publicListener.port : null;
  }

  get workerPids(): readonly number[] | null {
    return this.phase === 'started' ? this.options.workerPool.pids() : null;
  }

  async start(): Promise<void> {
    if (this.phase !== 'created') {
      throw new MasterRuntimeError('invalid_state', 'master runtime can only start once');
    }
    this.phase = 'starting';
    try {
      this.supervisor.subscribe();
      let resolution: ServingResolution;
      if (this.options.allowReadOnlyRecovery?.() && !this.options.canReconcileStartup?.()) {
        const retained = this.options.admission.snapshot();
        resolution = retained.length === this.options.workerCount
          && admissionIsPoolOwned(retained, this.options.workerPool)
          ? { serving: retained, recoveryOnly: false }
          : { serving: [], recoveryOnly: true };
      } else {
        try {
          resolution = await this.resolveServingWorkers();
        } catch (error) {
          if (!this.options.allowReadOnlyRecovery?.()) throw error;
          const retained = this.options.admission.snapshot();
          resolution = retained.length === this.options.workerCount
            && admissionIsPoolOwned(retained, this.options.workerPool)
            ? { serving: retained, recoveryOnly: false }
            : { serving: [], recoveryOnly: true };
        }
      }
      const serving = resolution.serving;
      const admitted = this.options.admission.snapshot();
      const readOnlyRetained = this.options.allowReadOnlyRecovery?.() === true
        && this.options.canReconcileStartup?.() !== true;
      const admissionValid = resolution.recoveryOnly
        ? admitted.length === 0
        : readOnlyRetained
          ? admitted.length === this.options.workerCount && admissionIsPoolOwned(admitted, this.options.workerPool)
        : exactAdmission(admitted, serving, this.options.workerCount);
      if (!admissionValid
        || !admissionIsPoolOwned(admitted, this.options.workerPool)) {
        throw new MasterRuntimeError(
          'admission_mismatch',
          'admission snapshot does not match complete pool-owned serving evidence',
          { admitted, serving },
        );
      }
      if (this.startupSupervisionFailure !== null) throw this.startupSupervisionFailure;
      if (this.options.publicListener.ready !== undefined) this.options.publicListener.ready();
      else this.options.publicListener.start();
      if (this.options.controlListener?.ready !== undefined) this.options.controlListener.ready();
      else this.options.controlListener?.start();
      if (this.options.publicListener.port === null) {
        throw new MasterRuntimeError('listener_port_unavailable', 'public listener did not expose a bound port');
      }
      if (this.options.controlListener !== undefined && this.options.controlListener.port === null) {
        throw new MasterRuntimeError('listener_port_unavailable', 'master control listener did not expose a bound port');
      }
      this.options.workerPool.markCommitted(serving.map(({ process }) => process));
      if (this.startupSupervisionFailure !== null) throw this.startupSupervisionFailure;
      this.phase = 'started';
      this.supervisor.started();
    } catch (error) {
      this.phase = 'stopping';
      this.options.publicListener.stopAccepting?.();
      const cleanupErrors = await cleanupAfterStartupFailure(
        this.options,
        this.supervisor.detach(),
        this.supervisor.settled(),
      );
      this.phase = 'stopped';
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'master runtime startup failed');
      }
      throw error;
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    if (this.phase === 'stopped') {
      this.shutdownPromise = Promise.resolve();
      return this.shutdownPromise;
    }
    this.phase = 'stopping';
    this.options.publicListener.stopAccepting?.();
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  shutdownAfterStartupFailure(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    if (this.phase === 'stopped') {
      this.shutdownPromise = Promise.resolve();
      return this.shutdownPromise;
    }
    this.phase = 'stopping';
    this.options.publicListener.stopAccepting?.();
    this.shutdownPromise = this.finishStartupFailureShutdown();
    return this.shutdownPromise;
  }

  reportAsynchronousFailure(error: MasterRuntimeError): void {
    this.asynchronousFailed(error);
  }

  private asynchronousFailed(error: MasterRuntimeError): void {
    if (this.phase === 'starting') {
      this.options.stopAcceptingRecovery?.();
      this.startupSupervisionFailure = error;
      return;
    }
    if (this.phase !== 'started' || this.shutdownPromise !== null) return;
    this.phase = 'stopping';
    this.options.publicListener.stopAccepting?.();
    const pending = this.finishShutdown(error);
    this.shutdownPromise = pending;
    void pending.catch(() => undefined);
  }

  private async resolveServingWorkers(): Promise<ServingResolution> {
    const recovered = await this.options.coordinator.recoverAndPublish();
    if (recovered === null) {
      const adopted = this.options.startupServing?.();
      if (adopted !== null && adopted !== undefined) {
        const snapshot = this.options.repository.getSnapshot();
        const current = adopted.every((worker) => worker.revision === snapshot.revision
          && worker.content_hash === snapshot.content_hash);
        return current
          ? { serving: adopted, recoveryOnly: false }
          : await this.startCurrent(snapshot, [], adopted);
      }
      return await this.startCurrent();
    }
    switch (recovered.kind) {
      case 'converged':
      case 'degraded':
        if (recovered.kind === 'degraded' && recovered.error_code === 'control_readiness_failed'
          && recovered.operation.state === 'degraded'
          && recovered.operation.error_code === 'control_readiness_failed'
          && recovered.serving.length === 0 && this.options.admission.snapshot().length === 0) {
          return { serving: [], recoveryOnly: true };
        }
        if (recovered.serving.length === this.options.workerCount) return { serving: recovered.serving, recoveryOnly: false };
        if (recovered.kind === 'degraded'
          && recovered.error_code === 'replacement_convergence_failed'
          && recovered.serving.length === 0) return await this.startCurrent();
        throw new MasterRuntimeError('startup_incomplete', 'recovery did not produce a complete serving set', recovered);
      case 'outcome_unknown':
        throw new MasterRuntimeError('startup_incomplete', 'recovery outcome does not permit startup', recovered);
      default: {
        const unhandled: never = recovered;
        throw new MasterRuntimeError('startup_incomplete', 'unhandled recovery outcome', unhandled);
      }
    }
  }

  private async startCurrent(
    snapshot = this.options.repository.getSnapshot(),
    existingWorkers: readonly ServingConfigWorker[] = [],
    retireWorkers: readonly ServingConfigWorker[] = [],
  ): Promise<ServingResolution> {
    const outcome = await this.options.coordinator.startCurrent(snapshot, existingWorkers, retireWorkers);
    if ((outcome.kind === 'startup_ready' || outcome.kind === 'startup_degraded')
      && outcome.serving.length === this.options.workerCount) {
      if (outcome.kind === 'startup_degraded' && outcome.error_code !== 'old_worker_drain_failed') {
        return { serving: [], recoveryOnly: true };
      }
      return { serving: outcome.serving, recoveryOnly: false };
    }
    if (outcome.kind === 'startup_failed'
      || (outcome.kind === 'startup_degraded' && (outcome.error_code === 'control_readiness_failed'
        || outcome.error_code === 'admission_outcome_unknown'))) return { serving: [], recoveryOnly: true };
    throw new MasterRuntimeError('startup_incomplete', 'current snapshot did not produce a complete serving set', outcome);
  }

  private async finishShutdown(reason?: MasterRuntimeError): Promise<void> {
    const errors = await closeForNormalShutdown(
      this.options,
      this.supervisor.detach(),
      this.supervisor.settled(),
    );
    this.phase = 'stopped';
    if (reason !== undefined || errors.length > 0) {
      const failure = reason !== undefined && errors.length === 0
        ? reason
        : new AggregateError(
          reason === undefined ? errors : [reason, ...errors],
          'master runtime shutdown failed',
        );
      if (reason !== undefined) await this.options.onFatal?.(failure);
      throw failure;
    }
  }

  private async finishStartupFailureShutdown(): Promise<void> {
    const errors = await cleanupAfterStartupFailure(
      this.options,
      this.supervisor.detach(),
      this.supervisor.settled(),
    );
    this.phase = 'stopped';
    if (errors.length > 0) throw new AggregateError(errors, 'master runtime startup cleanup failed');
  }
}
