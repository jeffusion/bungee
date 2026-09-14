import type { Sha256Digest } from '@jeffusion/bungee-types';
import type { RepositorySnapshot } from '../config-storage/repository-types';
import { ConfigRepositoryError } from '../config-storage/repository-types';
import type { StartCurrentConfigWorkerCommand } from './types';
import {
  MasterConfigPublicationError,
  type ConfigPublicationWorkerFactory,
  type PublicationFailure,
  type PublicationScheduler,
  type PendingConfigWorker,
  type ServingConfigWorker,
  type StartupPublicationOutcome,
  type WorkerAdmissionController,
} from './coordinator-types';
import { cleanupConfirmed, OwnedProcessCollection } from './process-cleanup';
import { ProcessIdentityAllocator, validateReplacementProcess } from './process-identity';
import { waitForApply } from './worker-wait';
import { allDrainExitsConfirmed, drainFailures, drainWorkers } from './drain-workers';
import {
  isPublicationCancelled,
  throwIfPublicationCancelled,
  type PublicationCancellationSignal,
} from './publication-runner';

type CurrentStartupOptions = {
  readonly workerFactory: ConfigPublicationWorkerFactory;
  readonly workerCount: number;
  readonly scheduler: PublicationScheduler;
  readonly applyTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly identities: ProcessIdentityAllocator;
  readonly pluginCatalogHash: Sha256Digest;
  readonly admission: WorkerAdmissionController;
  readonly retireWorkers: readonly ServingConfigWorker[];
  readonly signal?: PublicationCancellationSignal;
};

function processError(error: unknown, slot: number): PublicationFailure {
  const detail = error instanceof Error && error.message.trim().length > 0
    ? error.message.slice(0, 512) : 'worker command failed';
  return { slot, code: 'apply_failed', detail, recovery_disposition: 'retryable' };
}

function isOutcomeUnknown(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ['outcome_unknown', 'control_recovering'].includes(
    (error as { readonly code?: unknown }).code as string,
  );
}

function isDefinitelyNotCommitted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ['invalid_options', 'not_committed', 'rejected'].includes(
    (error as { readonly code?: unknown }).code as string,
  );
}

export async function runCurrentStartup(
  options: CurrentStartupOptions,
  snapshot: RepositorySnapshot,
  existingWorkers: readonly ServingConfigWorker[],
): Promise<StartupPublicationOutcome> {
  const existingBySlot = new Map<number, ServingConfigWorker>();
  for (const worker of existingWorkers) {
    if (worker.revision !== snapshot.revision || worker.content_hash !== snapshot.content_hash
      || worker.plugin_catalog_hash !== options.pluginCatalogHash
      || !Number.isSafeInteger(worker.private_port) || worker.private_port <= 0 || worker.private_port > 65_535) {
      throw new MasterConfigPublicationError('invalid_options', 'existing current worker evidence is invalid');
    }
    existingBySlot.set(worker.process.slot, worker);
  }
  const missingSlots = Array.from({ length: options.workerCount }, (_, slot) => slot)
    .filter((slot) => !existingBySlot.has(slot));
  const allocated = options.identities.allocate(missingSlots);
  const owned = new OwnedProcessCollection();
  const spawned: PendingConfigWorker[] = [];
  let startupError: unknown;
  let admissionState: 'not_committed' | 'committed' | 'outcome_unknown' = 'not_committed';
  let admissionCommitMayHaveBeenSent = false;
  let failures: PublicationFailure[] = [];
  let preparedForCleanup: Awaited<ReturnType<WorkerAdmissionController['prepare']>> | null = null;
  try {
    try {
      throwIfPublicationCancelled(options.signal);
      for (const identity of allocated) {
        throwIfPublicationCancelled(options.signal);
        const process = options.workerFactory.spawn(identity);
        if (existingWorkers.some(({ process: current }) => current === process)
          || spawned.some(({ process: current }) => current === process)) {
          throw new MasterConfigPublicationError('invalid_options', 'spawned worker reuses an existing process object');
        }
        validateReplacementProcess(process, identity, existingWorkers,
          spawned.map(({ process: current }) => current), options.workerCount);
        options.identities.bind(identity, process);
        const worker = { process, revision: snapshot.revision,
          content_hash: snapshot.content_hash, plugin_catalog_hash: options.pluginCatalogHash,
          boot_nonce: null, publication: null } satisfies PendingConfigWorker;
        owned.add(process, worker);
        spawned.push(worker);
        throwIfPublicationCancelled(options.signal);
      }
    } catch (error) {
      startupError = error;
    }

  const candidates = startupError === undefined ? spawned : [];
  const waiting = candidates.map((worker) => ({ worker, handle: waitForApply({ process: worker.process,
    expected: { revision: snapshot.revision, contentHash: snapshot.content_hash,
      pluginCatalogHash: options.pluginCatalogHash, publication: null },
    scheduler: options.scheduler, timeoutMs: options.applyTimeoutMs }) }));
  const sends = waiting.map(({ worker }) => {
    throwIfPublicationCancelled(options.signal);
    const message: StartCurrentConfigWorkerCommand = { command: 'start-current-config-worker',
      ...worker.process.identity, revision: snapshot.revision, content_hash: snapshot.content_hash,
      plugin_catalog_hash: options.pluginCatalogHash, aggregate: snapshot.aggregate,
      activated_plugin_names: Object.freeze(snapshot.aggregate.plugin_activations.map(({ plugin_name }) => plugin_name)),
      publication: null };
    return worker.process.send(message).then(
      () => undefined,
      (error) => {
        startupError ??= error;
        const sendFailure = processError(error, worker.process.slot);
        for (const pending of waiting) {
          pending.handle.fail({ ...sendFailure, slot: pending.worker.process.slot });
        }
      },
    );
  });
  const decisionsPromise = Promise.allSettled(waiting.map(({ handle }) => handle.result));
  const decisionsSettled = await Promise.race([
    decisionsPromise,
    Promise.all(sends).then(() => decisionsPromise),
  ]);
  throwIfPublicationCancelled(options.signal);
  const decisions = decisionsSettled.flatMap((settled, index) => {
    if (settled.status === 'fulfilled') {
      const worker = waiting[index]?.worker;
      if (settled.value.kind === 'ready' && worker !== undefined) {
        throwIfPublicationCancelled(options.signal);
        owned.promote(worker.process, settled.value.evidence.private_port, settled.value.evidence.boot_nonce);
      }
      return [settled.value];
    }
    startupError ??= settled.reason;
    return [];
  });
  failures = decisions.flatMap((decision) => decision.kind === 'failed' ? [decision.failure] : []);
  if (startupError === undefined && failures.length === 0) {
    throwIfPublicationCancelled(options.signal);
    const serving = [...existingWorkers, ...owned.serving()]
      .sort((left, right) => left.process.slot - right.process.slot);
    let prepared: Awaited<ReturnType<WorkerAdmissionController['prepare']>>;
    try {
      prepared = options.signal === undefined
        ? await options.admission.prepare(serving)
        : await options.admission.prepare(serving, options.signal);
      preparedForCleanup = prepared;
      throwIfPublicationCancelled(options.signal);
    } catch (error) {
      startupError = error;
    }
    if (startupError === undefined) {
      try {
        throwIfPublicationCancelled(options.signal);
        admissionCommitMayHaveBeenSent = true;
        await prepared!.commit();
        throwIfPublicationCancelled(options.signal, true);
        admissionState = 'committed';
        throwIfPublicationCancelled(options.signal);
        options.workerFactory.markCommitted(serving.map(({ process }) => process));
      } catch (error) {
        if (isPublicationCancelled(error)) throw error;
        admissionState = isOutcomeUnknown(error) || !isDefinitelyNotCommitted(error) ? 'outcome_unknown' : 'not_committed';
        if (admissionState === 'outcome_unknown') {
          options.workerFactory.markCommitted(serving.map(({ process }) => process));
          return { kind: 'startup_degraded', http_status: 202, error_code: 'admission_outcome_unknown',
            recovery_disposition: 'fatal', failures: [processError(error, -1)], serving };
        }
        startupError = error;
      }
    }
    if (admissionState === 'committed') {
      try {
        if (options.retireWorkers.length > 0) {
          const drainEvidence = await drainWorkers(options.retireWorkers, options.scheduler, options.drainTimeoutMs);
          throwIfPublicationCancelled(options.signal, admissionCommitMayHaveBeenSent);
          const drainErrors = drainFailures(drainEvidence);
          if (!allDrainExitsConfirmed(drainEvidence)) {
            const unknown = options.retireWorkers.filter((worker) =>
              !drainEvidence.some((evidence) => evidence.worker.process === worker.process && evidence.exitEvidence !== null));
            options.workerFactory.forgetProcessesWithoutExitProof(unknown.map(({ process }) => process));
            return { kind: 'startup_degraded', http_status: 202, error_code: 'old_worker_drain_failed',
              recovery_disposition: 'retryable', failures: drainErrors, serving };
          }
          await prepared!.releaseRetiredAfterExitProof();
          throwIfPublicationCancelled(options.signal, admissionCommitMayHaveBeenSent);
          if (drainErrors.length > 0) return { kind: 'startup_degraded', http_status: 202, error_code: 'old_worker_drain_failed',
            recovery_disposition: 'retryable', failures: drainErrors, serving };
        }
        return { kind: 'startup_ready', serving };
      } catch (error) {
        options.workerFactory.forgetProcessesWithoutExitProof(options.retireWorkers.map(({ process }) => process));
        return { kind: 'startup_degraded', http_status: 202, error_code: 'old_worker_drain_failed',
          recovery_disposition: 'retryable', failures: [processError(error, -1)], serving };
      }
    }
  }
  if (admissionState !== 'not_committed') {
    return { kind: 'startup_degraded', http_status: 202, error_code: 'admission_outcome_unknown',
      recovery_disposition: 'fatal', failures: [...failures, processError(startupError, spawned.length)], serving: [...existingWorkers, ...owned.serving()] };
  }
  } catch (error) {
    if (isPublicationCancelled(error) && admissionCommitMayHaveBeenSent) throw error;
    startupError ??= error;
  }
  let cancellationAbortError: unknown;
  if (isPublicationCancelled(startupError) && preparedForCleanup !== null) {
    try { await preparedForCleanup.abort(); } catch (error) { cancellationAbortError = error; }
    if (cancellationAbortError !== undefined) {
      Object.defineProperty(startupError, 'cause', { value: cancellationAbortError });
    }
  }
  const cleanup = await owned.cleanup(options.scheduler, options.drainTimeoutMs);
  if (cleanupConfirmed(cleanup)) {
    if (isPublicationCancelled(startupError)) throw startupError;
    if (startupError !== undefined) {
      if (startupError instanceof MasterConfigPublicationError || startupError instanceof ConfigRepositoryError) {
        return { kind: 'startup_outcome_unknown', fatal: true, code: 'startup_failure',
          error: startupError, failures, serving: existingWorkers, pending: [] };
      }
      return { kind: 'startup_failed', failures: [...failures, processError(startupError, spawned.length)], serving: existingWorkers };
    }
    return { kind: 'startup_failed', failures, serving: existingWorkers };
  }
  return { kind: 'startup_outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
    error: { cause: startupError, cleanup }, failures,
    serving: [...existingWorkers, ...owned.serving()], pending: owned.pending() };
}
