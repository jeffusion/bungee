import type {
  ActiveConfigurationPublication,
  ConfigurationOperationWorker,
  FinalizePublicationOutcome,
  WorkerPublicationResult,
} from '../config-storage/repository-types';
import { resolvePublicationPolicy, type Sha256Digest } from '@jeffusion/bungee-types';
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
import { classifyRecoveryError } from './recovery-disposition';
import { allDrainExitsConfirmed, drainFailures, drainWorkersUntilKnown } from './drain-workers';
import { waitForAdmissionHandoff, type AdmissionHandoffResult } from './admission-handoff';
import { cleanupConfirmed, OwnedProcessCollection } from './process-cleanup';
import { waitForApply } from './worker-wait';
import { ProcessIdentityAllocator, validateReplacementProcess } from './process-identity';

export type PublicationCancellationSignal = AbortSignal;

type PublicationPhase = 'awaitReplacements' | 'admission.prepare' | 'markDraining' | 'admission.commit' | 'admission.handoff' | 'drainWorkers';
type PublicationPhaseBoundary = 'enter' | 'exit';

type PublicationStderr = {
  readonly write: (chunk: string) => unknown;
};

const PUBLICATION_CANCELLED = Symbol('bungee.publication.cancelled');

type PublicationCancellation = Error & {
  readonly [PUBLICATION_CANCELLED]: true;
  readonly commitMayHaveBeenSent: boolean;
};

export function throwIfPublicationCancelled(
  signal: PublicationCancellationSignal | undefined,
  commitMayHaveBeenSent = false,
): void {
  if (!signal?.aborted) return;
  const error = new Error('configuration publication cancelled') as PublicationCancellation;
  Object.defineProperties(error, {
    [PUBLICATION_CANCELLED]: { value: true },
    commitMayHaveBeenSent: { value: commitMayHaveBeenSent },
  });
  throw error;
}

export function isPublicationCancelled(error: unknown): error is PublicationCancellation {
  return typeof error === 'object' && error !== null
    && (error as Partial<PublicationCancellation>)[PUBLICATION_CANCELLED] === true;
}

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
  readonly confirmPreviousWorkersExited?: (replacements: readonly ServingConfigWorker[]) => Promise<boolean>;
  readonly signal?: PublicationCancellationSignal;
  readonly stderr?: PublicationStderr;
};

type ReplacementAttempt = {
  readonly target: ConfigurationOperationWorker;
  readonly process: ServingConfigWorker['process'];
  readonly publication: ConfigPublicationIdentity;
};

function pending(active: ActiveConfigurationPublication, attempt: ReplacementAttempt,
  pluginCatalogHash: Sha256Digest) {
  return { process: attempt.process, boot_nonce: null, revision: active.snapshot.revision,
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

function publicationPhase(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  phase: PublicationPhase,
  boundary: PublicationPhaseBoundary,
  handoffReason?: Extract<AdmissionHandoffResult, { kind: 'unknown' }>['reason'],
): void {
  try {
    (options.stderr ?? process.stderr).write(`${JSON.stringify({
      event: 'publication_phase', phase, boundary,
      mutation_id: active.operation.mutation_id, revision: active.snapshot.revision,
      ...(handoffReason === undefined ? {} : { handoff_reason: handoffReason }),
    })}\n`);
  } catch {
    // Diagnostics must not change publication behavior.
  }
}

function processError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message.slice(0, 512) : fallback;
}

function controlOutcomeUnknown(error: unknown): boolean {
  return error instanceof Error && ['outcome_unknown', 'control_recovering'].includes(
    (error as Error & { readonly code?: unknown }).code as string,
  );
}

function recoveringOutcome(
  options: PublicationRunOptions,
  oldWorkers: readonly ServingConfigWorker[],
  error: unknown,
): MasterPublicationOutcome {
  return { kind: 'outcome_unknown', fatal: true, code: 'admission_outcome_unknown', error,
    serving: [...oldWorkers, ...options.owned.serving()], pending: options.owned.pending() };
}

function retiredOutcomeUnknown(
  options: PublicationRunOptions,
  oldWorkers: readonly ServingConfigWorker[],
  error: unknown,
): MasterPublicationOutcome {
  return { kind: 'outcome_unknown', fatal: false, code: 'control_recovering', error,
    serving: options.owned.serving(),
    pending: [...options.owned.pending(), ...oldWorkers.map(({ private_port: _privatePort, ...worker }) => worker)] };
}

function addAttempt(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  target: ConfigurationOperationWorker,
  identity: ConfigProcessIdentity,
  attempts: readonly ReplacementAttempt[],
): ReplacementAttempt {
  throwIfPublicationCancelled(options.signal);
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
  throwIfPublicationCancelled(options.signal);
  return attempt;
}

async function beginAttempts(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  recovery: boolean,
  attemptsAlreadyBegun = false,
): Promise<readonly ReplacementAttempt[]> {
  const attempts: ReplacementAttempt[] = [];
  const identities = options.identities.allocate(active.targets.map(({ worker_slot }) => worker_slot));
  for (const [index, target] of active.targets.entries()) {
    const identity = identities[index];
    if (identity === undefined) {
      throw new MasterConfigPublicationError('invalid_options', 'worker identity allocation missing');
    }
    throwIfPublicationCancelled(options.signal);
    const begun = attemptsAlreadyBegun ? target : await options.repository.beginWorkerAttempt(
      active.operation.mutation_id, target.worker_slot, target.attempt_no,
      recovery ? 'master_recovery' : target.attempt_no === 0 ? 'initial' : 'retry', options.clock.now(),
    );
    throwIfPublicationCancelled(options.signal);
    attempts.push(addAttempt(options, active, begun, identity, attempts));
  }
  return attempts;
}

async function awaitReplacements(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  attempts: readonly ReplacementAttempt[],
): Promise<readonly PublicationFailure[]> {
  publicationPhase(options, active, 'awaitReplacements', 'enter');
  let settled: PromiseSettledResult<PublicationFailure | null>[];
  try {
    settled = await Promise.allSettled(attempts.map(async (attempt) => {
      const waiting = waitForApply({ process: attempt.process,
        expected: { revision: active.snapshot.revision, contentHash: active.snapshot.content_hash,
          pluginCatalogHash: options.pluginCatalogHash, publication: attempt.publication },
        scheduler: options.scheduler, timeoutMs: options.applyTimeoutMs });
      throwIfPublicationCancelled(options.signal);
      const send: Promise<PublicationFailure | null> = attempt.process.send(
        command(active, attempt, options.pluginCatalogHash)).then(
        () => null,
        (error): PublicationFailure => ({ slot: attempt.target.worker_slot, code: 'apply_failed',
          detail: processError(error, 'worker start command failed'), recovery_disposition: 'retryable' }),
      );
      const decision = await Promise.race([
        waiting.result,
        send.then((sendFailure) => {
          if (sendFailure !== null) waiting.fail(sendFailure);
          return waiting.result;
        }),
      ]);
      throwIfPublicationCancelled(options.signal);
      if (decision.kind === 'ready') options.owned.promote(
        attempt.process, decision.evidence.private_port, decision.evidence.boot_nonce,
      );
      const result: WorkerPublicationResult = decision.kind === 'ready'
        ? { kind: 'converged', attempt_no: attempt.publication.attempt_no,
          applied_revision: active.snapshot.revision }
        : { kind: 'failed', attempt_no: attempt.publication.attempt_no,
          error: decision.failure.detail.slice(0, 512) };
      throwIfPublicationCancelled(options.signal);
      await options.repository.recordWorkerResult(
        active.operation.mutation_id, attempt.target.worker_slot, result, options.clock.now(),
      );
      return decision.kind === 'failed' ? decision.failure : null;
    }));
  } finally {
    publicationPhase(options, active, 'awaitReplacements', 'exit');
  }
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

async function cleanupPreCommitFailure(
  options: PublicationRunOptions, oldWorkers: readonly ServingConfigWorker[], error: unknown,
): Promise<MasterPublicationOutcome> {
  const cleanup = await options.owned.cleanup(options.scheduler, options.drainTimeoutMs);
  if (!cleanupConfirmed(cleanup)) {
    return { kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
      error: { cause: error, cleanup }, serving: [...oldWorkers, ...options.owned.serving()], pending: options.owned.pending() };
  }
  if (classifyRecoveryError(error) === 'fatal') {
    return { kind: 'outcome_unknown', fatal: true, code: 'repository_failure',
      error, serving: oldWorkers, pending: [] };
  }
  const active = await options.repository.getActivePublication();
  if (active === null) {
    return { kind: 'outcome_unknown', fatal: true, code: 'repository_failure',
      error: new Error('active publication disappeared before admission commit'), serving: oldWorkers, pending: [] };
  }
  const operation = await options.repository.finalizePublication(active.operation.mutation_id, {
    outcome: 'degraded', error_code: 'control_readiness_failed',
    error_detail: processError(error, 'admission preparation failed'), recovery_disposition: 'retryable',
  }, options.clock.now());
  return { kind: 'degraded', http_status: 202, error_code: 'control_readiness_failed',
    recovery_disposition: 'retryable', failures: [], operation, serving: oldWorkers };
}

export async function runPublication(
  options: PublicationRunOptions,
  active: ActiveConfigurationPublication,
  oldWorkers: readonly ServingConfigWorker[],
): Promise<MasterPublicationOutcome> {
  const initialState = active.operation.state;
  const publicationPolicy = Object.freeze({
    ...resolvePublicationPolicy(active.snapshot.aggregate?.logical_configuration?.publication),
  });
  let admissionCommitted = false;
  let admissionCommitMayHaveBeenSent = false;
  let preparedAdmission: Awaited<ReturnType<WorkerAdmissionController['prepare']>> | null = null;
  let oldWorkersExited = false;
  try {
    throwIfPublicationCancelled(options.signal);
    if (initialState === 'draining' && !options.recoveringMaster) {
      return { kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
        error: new TypeError('old generation exit proof is unavailable after master recovery'),
        serving: oldWorkers, pending: [] };
    }
    if (initialState === 'committed') {
      throwIfPublicationCancelled(options.signal);
      await options.repository.beginPublication(active.operation.mutation_id, options.clock.now());
    }
    let refreshed = await options.repository.getActivePublication();
    if (refreshed === null) throw new TypeError('active publication disappeared');
    let attemptsAlreadyBegun = false;
    if (initialState === 'draining') {
      throwIfPublicationCancelled(options.signal);
      await options.repository.beginDrainingRecovery(
        refreshed.operation.mutation_id, refreshed.operation.drain_recovery_generation, options.clock.now(),
      );
      refreshed = await options.repository.getActivePublication();
      if (refreshed === null) throw new TypeError('active publication disappeared after recovery fencing');
      attemptsAlreadyBegun = true;
    }
    const attempts = await beginAttempts(options, refreshed, options.recoveringMaster, attemptsAlreadyBegun);
    const failures = await awaitReplacements(options, refreshed, attempts);
    throwIfPublicationCancelled(options.signal);
    if (failures.length > 0) {
      const cleaned = await cleanupFailure(options, oldWorkers, failures,
        options.recoveringMaster && initialState === 'draining'
          ? 'recovery_replacements_failed' : 'repository_failure');
      if (cleaned.kind === 'outcome_unknown' && cleaned.code === 'worker_exit_unconfirmed') return cleaned;
      if (options.recoveringMaster && initialState === 'draining') return cleaned;
      throwIfPublicationCancelled(options.signal);
      const operation = await options.repository.finalizePublication(refreshed.operation.mutation_id, {
        outcome: 'degraded', error_code: 'replacement_convergence_failed',
        error_detail: failureDetail(failures), recovery_disposition: failures.some(({ recovery_disposition }) => recovery_disposition === 'deterministic_worker_rejection')
          ? 'deterministic_worker_rejection' : failures.some(({ recovery_disposition }) => recovery_disposition === 'deterministic_protocol_failure')
            ? 'deterministic_protocol_failure' : 'retryable',
      }, options.clock.now());
      return { kind: 'degraded', http_status: 202, error_code: 'replacement_convergence_failed',
        recovery_disposition: failures.some(({ recovery_disposition }) => recovery_disposition === 'deterministic_worker_rejection')
          ? 'deterministic_worker_rejection' : failures.some(({ recovery_disposition }) => recovery_disposition === 'deterministic_protocol_failure')
            ? 'deterministic_protocol_failure' : 'retryable', failures, operation, serving: oldWorkers };
    }
    throwIfPublicationCancelled(options.signal);
    publicationPhase(options, refreshed, 'admission.prepare', 'enter');
    try {
      preparedAdmission = options.signal === undefined
        ? await options.admission.prepare(options.owned.serving(), undefined, publicationPolicy.drain_timeout_ms)
        : await options.admission.prepare(options.owned.serving(), options.signal, publicationPolicy.drain_timeout_ms);
    } finally {
      publicationPhase(options, refreshed, 'admission.prepare', 'exit');
    }
    throwIfPublicationCancelled(options.signal);
    try {
      if (refreshed.operation.state !== 'draining') {
        throwIfPublicationCancelled(options.signal);
        publicationPhase(options, refreshed, 'markDraining', 'enter');
        try {
          await options.repository.markDraining(refreshed.operation.mutation_id, options.clock.now());
        } finally {
          publicationPhase(options, refreshed, 'markDraining', 'exit');
        }
      }
      throwIfPublicationCancelled(options.signal);
      admissionCommitMayHaveBeenSent = true;
      publicationPhase(options, refreshed, 'admission.commit', 'enter');
      try {
        await preparedAdmission.commit();
        admissionCommitted = true;
        options.workerFactory.markCommitted(options.owned.serving().map(({ process }) => process));
      } finally {
        publicationPhase(options, refreshed, 'admission.commit', 'exit');
      }
      throwIfPublicationCancelled(options.signal, true);
    } catch (error) {
      if (controlOutcomeUnknown(error)) throw error;
      try { await preparedAdmission.abort(); } catch (abortError) { throw new AggregateError([error, abortError], 'worker admission abort failed'); }
      throw error;
    }
    publicationPhase(options, refreshed, 'admission.handoff', 'enter');
    let handoff: AdmissionHandoffResult | undefined;
    try { handoff = await waitForAdmissionHandoff(preparedAdmission!, options.scheduler, oldWorkers.length > 0, options.signal); }
    finally { publicationPhase(options, refreshed, 'admission.handoff', 'exit', handoff?.kind === 'unknown' ? handoff.reason : undefined); }
    if (handoff.kind === 'unknown') return retiredOutcomeUnknown(options, oldWorkers,
      new Error(`retired ingress handoff is unknown: ${handoff.reason}`));
    publicationPhase(options, refreshed, 'drainWorkers', 'enter');
    let drainEvidence: Awaited<ReturnType<typeof drainWorkersUntilKnown>>;
    try { drainEvidence = await drainWorkersUntilKnown(oldWorkers, options.scheduler, publicationPolicy,
      () => throwIfPublicationCancelled(options.signal, admissionCommitMayHaveBeenSent)); }
    finally { publicationPhase(options, refreshed, 'drainWorkers', 'exit'); }
    throwIfPublicationCancelled(options.signal, admissionCommitMayHaveBeenSent);
    const failuresDuringDrain = drainFailures(drainEvidence);
    // With no adopted old workers, the host must prove prior instances have exited.
    // This also covers migrations committed before any startup workers existed.
    const recoveringWithoutOldOwnership = options.recoveringMaster && oldWorkers.length === 0
      && await options.confirmPreviousWorkersExited?.(options.owned.serving()) !== true;
    throwIfPublicationCancelled(options.signal, admissionCommitMayHaveBeenSent);
    if (recoveringWithoutOldOwnership) {
      return { kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
        error: new TypeError('old generation exit proof is unavailable after master recovery'),
        serving: [...oldWorkers, ...options.owned.serving()],
        pending: options.owned.pending() };
    }
    if (!allDrainExitsConfirmed(drainEvidence)) return retiredOutcomeUnknown(options, oldWorkers, drainEvidence);
    oldWorkersExited = true;
    let releaseError: unknown;
    if (typeof preparedAdmission.releaseRetiredAfterExitProof !== 'function') {
      releaseError = new TypeError('retired admission release is unavailable');
    } else {
      try {
        throwIfPublicationCancelled(options.signal, admissionCommitMayHaveBeenSent);
        await preparedAdmission.releaseRetiredAfterExitProof();
      } catch (error) {
        if (!controlOutcomeUnknown(error)) throw error;
        releaseError = error;
      }
    }
    if (releaseError !== undefined) return retiredOutcomeUnknown(options, oldWorkers, releaseError);
    // A fenced draining recovery (drain_recovery_generation > 0) may only terminalize as
    // degraded old_worker_drain_failed, now backed by real old_workers_exited evidence.
    const drainedAfterRecoveryFence = refreshed.operation.drain_recovery_generation > 0;
    const outcome: FinalizePublicationOutcome = failuresDuringDrain.length === 0 && !drainedAfterRecoveryFence
      ? { outcome: 'converged', old_workers_exited: true }
      : { outcome: 'degraded', error_code: 'old_worker_drain_failed',
        error_detail: failuresDuringDrain.length > 0
          ? failureDetail(failuresDuringDrain)
          : 'old generation drained with exact exit proof after master recovery',
        old_workers_exited: true, recovery_disposition: 'retryable' };
    throwIfPublicationCancelled(options.signal, admissionCommitMayHaveBeenSent);
    const operation = await options.repository.finalizePublication(
      refreshed.operation.mutation_id, outcome, options.clock.now(),
    );
    return failuresDuringDrain.length === 0 && !drainedAfterRecoveryFence
      ? { kind: 'converged', http_status: 200, operation, serving: options.owned.serving() }
      : { kind: 'degraded', http_status: 202, error_code: 'old_worker_drain_failed',
        recovery_disposition: 'retryable', failures: failuresDuringDrain, operation, serving: options.owned.serving() };
  } catch (error) {
    if (isPublicationCancelled(error)) {
      if (error.commitMayHaveBeenSent || admissionCommitMayHaveBeenSent) throw error;
      let abortError: unknown;
      if (preparedAdmission !== null) {
        try { await preparedAdmission.abort(); } catch (cause) { abortError = cause; }
      }
      const cleanup = await options.owned.cleanup(options.scheduler, options.drainTimeoutMs);
      if (!cleanupConfirmed(cleanup)) {
        return { kind: 'outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
          error: { cause: error, cleanup }, serving: [...oldWorkers, ...options.owned.serving()],
          pending: options.owned.pending() };
      }
      if (abortError !== undefined) Object.defineProperty(error, 'cause', { value: abortError });
      throw error;
    }
    if (controlOutcomeUnknown(error)) {
      if (admissionCommitMayHaveBeenSent) {
        if (!admissionCommitted) return recoveringOutcome(options, oldWorkers, error);
        return retiredOutcomeUnknown(options, oldWorkers, error);
      }
      return await cleanupPreCommitFailure(options, oldWorkers, error);
    }
    if (admissionCommitted) {
      return { kind: 'outcome_unknown', fatal: true, code: 'repository_failure',
        error, serving: oldWorkersExited ? options.owned.serving() : [...oldWorkers, ...options.owned.serving()],
        pending: options.owned.pending() };
    }
    return await cleanupPreCommitFailure(options, oldWorkers, error);
  }
}
