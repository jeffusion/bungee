import type { Sha256Digest } from '@jeffusion/bungee-types';
import type { RepositorySnapshot } from '../config-storage/repository-types';
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

type CurrentStartupOptions = {
  readonly workerFactory: ConfigPublicationWorkerFactory;
  readonly workerCount: number;
  readonly scheduler: PublicationScheduler;
  readonly applyTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly identities: ProcessIdentityAllocator;
  readonly pluginCatalogHash: Sha256Digest;
  readonly admission: WorkerAdmissionController;
};

function processError(error: unknown, slot: number): PublicationFailure {
  const detail = error instanceof Error && error.message.trim().length > 0
    ? error.message.slice(0, 512) : 'worker command failed';
  return { slot, code: 'apply_failed', detail };
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
  try {
    for (const identity of allocated) {
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
        publication: null } satisfies PendingConfigWorker;
      owned.add(process, worker);
      spawned.push(worker);
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
  const decisions = decisionsSettled.flatMap((settled, index) => {
    if (settled.status === 'fulfilled') {
      const worker = waiting[index]?.worker;
      if (settled.value.kind === 'ready' && worker !== undefined) {
        owned.promote(worker.process, settled.value.evidence.private_port);
      }
      return [settled.value];
    }
    startupError ??= settled.reason;
    return [];
  });
  const failures = decisions.flatMap((decision) => decision.kind === 'failed' ? [decision.failure] : []);
  if (startupError === undefined && failures.length === 0) {
    const serving = [...existingWorkers, ...owned.serving()]
      .sort((left, right) => left.process.slot - right.process.slot);
    try {
      options.admission.prepare(serving).commit();
      return { kind: 'startup_ready', serving };
    } catch (error) {
      startupError = error;
    }
  }
  const cleanup = await owned.cleanup(options.scheduler, options.drainTimeoutMs);
  if (cleanupConfirmed(cleanup)) {
    if (startupError !== undefined) {
      return { kind: 'startup_outcome_unknown', fatal: true, code: 'startup_failure',
        error: startupError, failures: [...failures, processError(startupError, spawned.length)],
        serving: existingWorkers, pending: [] };
    }
    return { kind: 'startup_failed', failures, serving: existingWorkers };
  }
  return { kind: 'startup_outcome_unknown', fatal: true, code: 'worker_exit_unconfirmed',
    error: { cause: startupError, cleanup }, failures,
    serving: [...existingWorkers, ...owned.serving()], pending: owned.pending() };
}
