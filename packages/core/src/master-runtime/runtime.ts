import type { ServingConfigWorker } from '../config-publication/coordinator-types';
import { cleanupMasterRuntime } from './runtime-cleanup';
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
  MasterRuntimeInstanceLock,
  MasterRuntimeOptions,
  MasterRuntimePublicListener,
  MasterRuntimeRepository,
  MasterRuntimeWorkerExitListener,
  MasterRuntimeWorkerPool,
} from './runtime-contracts';

type RuntimePhase = 'created' | 'starting' | 'started' | 'stopping' | 'stopped';

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
      const serving = await this.resolveServingWorkers();
      const admitted = this.options.admission.snapshot();
      if (!exactAdmission(admitted, serving, this.options.workerCount)
        || !admissionIsPoolOwned(admitted, this.options.workerPool)) {
        throw new MasterRuntimeError(
          'admission_mismatch',
          'admission snapshot does not match complete pool-owned serving evidence',
          { admitted, serving },
        );
      }
      if (this.startupSupervisionFailure !== null) throw this.startupSupervisionFailure;
      this.options.publicListener.start();
      if (this.options.publicListener.port === null) {
        throw new MasterRuntimeError('listener_port_unavailable', 'public listener did not expose a bound port');
      }
      if (this.startupSupervisionFailure !== null) throw this.startupSupervisionFailure;
      this.phase = 'started';
      this.supervisor.started();
    } catch (error) {
      this.phase = 'stopping';
      const cleanupErrors = await cleanupMasterRuntime(
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
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private asynchronousFailed(error: MasterRuntimeError): void {
    if (this.phase === 'starting') {
      this.startupSupervisionFailure = error;
      return;
    }
    if (this.phase !== 'started' || this.shutdownPromise !== null) return;
    this.phase = 'stopping';
    const pending = this.finishShutdown(error);
    this.shutdownPromise = pending;
    void pending.catch(() => undefined);
  }

  private async resolveServingWorkers(): Promise<readonly ServingConfigWorker[]> {
    const recovered = await this.options.coordinator.recoverAndPublish();
    if (recovered === null) return this.startCurrent();
    switch (recovered.kind) {
      case 'converged':
      case 'degraded':
        if (recovered.serving.length === this.options.workerCount) return recovered.serving;
        if (recovered.kind === 'degraded'
          && recovered.error_code === 'replacement_convergence_failed'
          && recovered.serving.length === 0) return this.startCurrent();
        throw new MasterRuntimeError('startup_incomplete', 'recovery did not produce a complete serving set', recovered);
      case 'outcome_unknown':
        throw new MasterRuntimeError('startup_incomplete', 'recovery outcome does not permit startup', recovered);
      default: {
        const unhandled: never = recovered;
        throw new MasterRuntimeError('startup_incomplete', 'unhandled recovery outcome', unhandled);
      }
    }
  }

  private async startCurrent(): Promise<readonly ServingConfigWorker[]> {
    const outcome = await this.options.coordinator.startCurrent(this.options.repository.getSnapshot());
    if (outcome.kind === 'startup_ready' && outcome.serving.length === this.options.workerCount) {
      return outcome.serving;
    }
    throw new MasterRuntimeError('startup_incomplete', 'current snapshot did not produce a complete serving set', outcome);
  }

  private async finishShutdown(reason?: MasterRuntimeError): Promise<void> {
    const errors = await cleanupMasterRuntime(
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
}
