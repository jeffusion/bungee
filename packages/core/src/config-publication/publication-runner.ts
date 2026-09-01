import type {
  ActiveConfigurationPublication,
  ConfigurationOperationWorker,
  FinalizePublicationOutcome,
  WorkerPublicationResult,
} from '../config-storage/repository-types';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import type { ConfigProcessIdentity, ConfigPublicationIdentity, StartConfigWorkerCommand } from './types';
import {
  MasterConfigPublicationError,
  type ConfigPublicationRepository,
  ConfigPublicationWorkerFactory,
  MasterPublicationOutcome,
  PublicationClock,
  PublicationFailure,
  PublicationScheduler,
  ServingConfigWorker,
  WorkerAdmissionController,
} from './coordinator-types';
import { allDrainExitsConfirmed, drainFailures, drainWorkers } from './drain-workers';
import { cleanupConfirmed, OwnedProcessCollection } from './process-cleanup';
import { waitForApply } from './worker-wait';
import { ProcessIdentityAllocator, validateReplacementProcess } from './process-identity';

export type PublicationRunOptions = {
  readonly repository: ConfigPublicationRepository;
  readonly workerFactory: ConfigPublicationWorkerFactory;
  readonly clock: PublicationClock;
  readonly scheduler: PublicationScheduler;
  readonly applyTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly owned: OwnedProcessCollection;
  readonly identities: ProcessIdentityAllocator;
  readonly oldWorkers: readonly ServingConfigWorker[];
  readonly pluginCatalogHash: Sha256Digest;
  readonly admission: WorkerAdmissionController;
  readonly recoveringMaster: boolean;
};

type ReplacementAttempt = {
  readonly target: ConfigurationOperationWorker;
  readonly process: ServingConfigWorker['process'];
  readonly publication: ConfigPublicationIdentity;
};

function pending(active: ActiveConfigurationPublication, attempt: ReplacementAttempt,
  pluginCatalogHash: Sha256Digest) {
  return { process: attempt.process, revision: active.snapshot.revision,
    content_hash: active.snapshot.content_hash, plugin_catalog_hash: pluginCatalogHash,
    publication: attempt.publication };
}

function command(active: ActiveConfigurationPublication, attempt: ReplacementAttempt,
  pluginCatalogHash: Sha256Digest): StartConfigWorkerCommand {
  return { command: 'start-config-worker', ...attempt.process.identity,
    revision: active.snapshot.revision, content_hash: active.snapshot.content_hash,
    plugin_catalog_hash: pluginCatalogHash, aggregate: active.snapshot.aggregate,
    activated_plugin_names: Object.freeze(active.snapshot.aggregate.plugin_activations.map(({ plugin_name }) => plugin_name)),
    publication: attempt.publication };
}

function failureDetail(failures: readonly PublicationFailure[]): string {
  return failures.map(({ slot, code }) => `${slot}:${code}`).join(', ').slice(0, 512) || 'publication failed';
}

function processError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message.slice(0, 512) : fallback;
}

function addAttempt(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  target: ConfigurationOperationWorker,
  identity: ConfigProcessIdentity,
  attempts: readonly ReplacementAttempt[],
): ReplacementAttempt {
  const process = options.workerFactory.spawn(identity);
  if (options.oldWorkers.some(({ process: current }) => current === process)
    || attempts.some(({ process: current }) => current === process)) {
    throw new MasterConfigPublicationError('invalid_options', 'spawned worker reuses an existing process object');
  }
  const publication = { mutation_id: active.operation.mutation_id, attempt_no: target.attempt_no,
    drain_recovery_generation: target.drain_recovery_generation } satisfies ConfigPublicationIdentity;
  const attempt = { target, process, publication };
  validateReplacementProcess(process, identity, options.oldWorkers,
    attempts.map(({ process: current }) => current), active.targets.length);
  options.identities.bind(identity, process);
  options.owned.add(process, pending(active, attempt, options.pluginCatalogHash));
  return attempt;
}

function beginAttempts(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  recovery: boolean,
  attemptsAlreadyBegun = false,
): readonly ReplacementAttempt[] {
  const attempts: ReplacementAttempt[] = [];
  const identities = options.identities.allocate(active.targets.map(({ worker_slot }) => worker_slot));
  for (const [index, target] of active.targets.entries()) {
    const identity = identities[index];
    if (identity === undefined) {
      throw new MasterConfigPublicationError('invalid_options', 'worker identity allocation missing');
    }
    const begun = attemptsAlreadyBegun ? target : options.repository.beginWorkerAttempt(
      active.operation.mutation_id, target.worker_slot, target.attempt_no,
      recovery ? 'master_recovery' : target.attempt_no === 0 ? 'initial' : 'retry', options.clock.now(),
    );
    attempts.push(addAttempt(options, active, begun, identity, attempts));
  }
  return attempts;
}

async function awaitReplacements(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  attempts: readonly ReplacementAttempt[],
): Promise<readonly PublicationFailure[]> {
  const settled = await Promise.allSettled(attempts.map(async (attempt) => {
    const waiting = waitForApply({ process: attempt.process,
      expected: { revision: active.snapshot.revision, contentHash: active.snapshot.content_hash,
        pluginCatalogHash: options.pluginCatalogHash, publication: attempt.publication },
      scheduler: options.scheduler, timeoutMs: options.applyTimeoutMs });
    const send: Promise<PublicationFailure | null> = attempt.process.send(
      command(active, attempt, options.pluginCatalogHash)).then(
      () => null,
      (error): PublicationFailure => ({ slot: attempt.target.worker_slot, code: 'apply_failed',
        detail: processError(error, 'worker start command failed') }),
    );
    const decision = await Promise.race([
      waiting.result,
      send.then((sendFailure) => {
        if (sendFailure !== null) waiting.fail(sendFailure);
        return waiting.result;
      }),
    ]);
    if (decision.kind === 'ready') options.owned.promote(attempt.process, decision.evidence.private_port);
    const result: WorkerPublicationResult = decision.kind === 'ready'
      ? { kind: 'converged', attempt_no: attempt.publication.attempt_no,
        applied_revision: active.snapshot.revision }
      : { kind: 'failed', attempt_no: attempt.publication.attempt_no,
        error: decision.failure.detail.slice(0, 512) };
    options.repository.recordWorkerResult(
      active.operation.mutation_id, attempt.target.worker_slot, result, options.clock.now(),
    );
    return decision.kind === 'failed' ? decision.failure : null;
  }));
  const failures: PublicationFailure[] = [];
  let repositoryError: unknown;
  for (const result of settled) {
    if (result.status === 'rejected') repositoryError ??= result.reason;
    else if (result.value !== null) failures.push(result.value);
  }
  if (repositoryError !== undefined) throw repositoryError;
  return failures;
}

async function cleanupFailure(
  options: PublicationRunOptions,
  oldWorkers: readonly ServingConfigWorker[],
  error: unknown,
  code: 'repository_failure' | 'recovery_replacements_failed',
): Promise<MasterPublicationOutcome> {
  const cleanup = await options.owned.cleanup(options.scheduler, options.drainTimeoutMs);
  if (!cleanupConfirmed(cleanup)) {
      return { kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
      error: { cause: error, cleanup }, serving: [...oldWorkers, ...options.owned.serving()],
      pending: options.owned.pending() };
  }
  return code === 'recovery_replacements_failed'
    ? { kind: 'outcome_unknown', fatal: false, code, error, serving: [], pending: [] }
    : { kind: 'outcome_unknown', fatal: true, code, error, serving: oldWorkers, pending: [] };
}

export async function runPublication(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  oldWorkers: readonly ServingConfigWorker[],
): Promise<MasterPublicationOutcome> {
  const initialState = active.operation.state;
  let admissionCommitted = false;
  let oldWorkersExited = false;
  try {
    if (initialState === 'draining' && !options.recoveringMaster) {
      return { kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
        error: new TypeError('old generation exit proof is unavailable after master recovery'),
        serving: oldWorkers, pending: [] };
    }
    if (initialState === 'committed') {
      options.repository.beginPublication(active.operation.mutation_id, options.clock.now());
    }
    let refreshed = options.repository.getActivePublication();
    if (refreshed === null) throw new TypeError('active publication disappeared');
    let attemptsAlreadyBegun = false;
    if (initialState === 'draining') {
      options.repository.beginDrainingRecovery(
        refreshed.operation.mutation_id, refreshed.operation.drain_recovery_generation, options.clock.now(),
      );
      refreshed = options.repository.getActivePublication();
      if (refreshed === null) throw new TypeError('active publication disappeared after recovery fencing');
      attemptsAlreadyBegun = true;
    }
    const attempts = beginAttempts(options, refreshed, options.recoveringMaster, attemptsAlreadyBegun);
    const failures = await awaitReplacements(options, refreshed, attempts);
    if (failures.length > 0) {
      const cleaned = await cleanupFailure(options, oldWorkers, failures,
        options.recoveringMaster && initialState === 'draining'
          ? 'recovery_replacements_failed' : 'repository_failure');
      if (cleaned.kind === 'outcome_unknown' && cleaned.code === 'worker_exit_unconfirmed') return cleaned;
      if (options.recoveringMaster && initialState === 'draining') return cleaned;
      const operation = options.repository.finalizePublication(refreshed.operation.mutation_id, {
        outcome: 'degraded', error_code: 'replacement_convergence_failed',
        error_detail: failureDetail(failures),
      }, options.clock.now());
      return { kind: 'degraded', http_status: 202, error_code: 'replacement_convergence_failed',
        failures, operation, serving: oldWorkers };
    }
    const preparedAdmission = options.admission.prepare(options.owned.serving());
    if (refreshed.operation.state !== 'draining') {
      options.repository.markDraining(refreshed.operation.mutation_id, options.clock.now());
    }
    preparedAdmission.commit();
    admissionCommitted = true;
    if (options.recoveringMaster) {
      const operation = options.repository.finalizePublication(refreshed.operation.mutation_id, {
        outcome: 'degraded', error_code: 'old_worker_drain_failed',
        error_detail: 'old generation exit proof unavailable after master recovery',
        master_recovery_without_exit_proof: true,
      }, options.clock.now());
      return { kind: 'degraded', http_status: 202, error_code: 'old_worker_drain_failed',
        failures: [], operation, serving: options.owned.serving() };
    }
    const drainEvidence = await drainWorkers(oldWorkers, options.scheduler, options.drainTimeoutMs);
    const failuresDuringDrain = drainFailures(drainEvidence);
    if (!allDrainExitsConfirmed(drainEvidence)) {
      return { kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
        error: drainEvidence, serving: [...oldWorkers, ...options.owned.serving()],
        pending: options.owned.pending() };
    }
    oldWorkersExited = true;
    const outcome: FinalizePublicationOutcome = failuresDuringDrain.length === 0
      ? { outcome: 'converged', old_workers_exited: true }
      : { outcome: 'degraded', error_code: 'old_worker_drain_failed',
        error_detail: failureDetail(failuresDuringDrain), old_workers_exited: true };
    const operation = options.repository.finalizePublication(
      refreshed.operation.mutation_id, outcome, options.clock.now(),
    );
    return failuresDuringDrain.length === 0
      ? { kind: 'converged', http_status: 200, operation, serving: options.owned.serving() }
      : { kind: 'degraded', http_status: 202, error_code: 'old_worker_drain_failed',
        failures: failuresDuringDrain, operation, serving: options.owned.serving() };
  } catch (error) {
    if (admissionCommitted) {
      return { kind: 'outcome_unknown', fatal: true, code: 'repository_failure',
        error, serving: oldWorkersExited ? options.owned.serving() : [...oldWorkers, ...options.owned.serving()],
        pending: options.owned.pending() };
    }
    return await cleanupFailure(options, oldWorkers, error, 'repository_failure');
  }
}
