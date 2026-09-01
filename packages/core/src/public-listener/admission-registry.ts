import { validateDigest } from '../config-storage/repository-validation';
import {
  MasterConfigPublicationError,
  type PreparedWorkerAdmission,
  type ServingConfigWorker,
  type WorkerAdmissionController,
} from '../config-publication/coordinator-types';
import {
  exactRoot,
  PROCESS_IDENTITY_FIELDS,
  processIdentity,
  publicationIdentity,
  snapshotMessage,
} from '../config-publication/message-fields';
import { validateProcessSet } from '../config-publication/process-identity';

const SERVING_FIELDS = new Set([
  'process', 'revision', 'content_hash', 'plugin_catalog_hash', 'private_port', 'publication',
]);
const EMPTY_ADMISSION: readonly ServingConfigWorker[] = Object.freeze([]);

function invalid(): never {
  throw new MasterConfigPublicationError('invalid_options', 'serving worker admission evidence is invalid');
}

function validateExactWorker(worker: ServingConfigWorker): void {
  const descriptors = Object.getOwnPropertyDescriptors(worker);
  const keys = Object.keys(descriptors);
  if (keys.length !== SERVING_FIELDS.size || keys.some((key) => !SERVING_FIELDS.has(key))) invalid();
  for (const field of SERVING_FIELDS) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !('value' in descriptor)) invalid();
  }
  if (!Number.isSafeInteger(worker.revision) || worker.revision <= 0
    || !validateDigest(worker.content_hash) || !validateDigest(worker.plugin_catalog_hash)
    || !Number.isSafeInteger(worker.private_port) || worker.private_port <= 0 || worker.private_port > 65_535) {
    invalid();
  }
  const identity = snapshotMessage(worker.process.identity);
  exactRoot(identity, new Set(PROCESS_IDENTITY_FIELDS));
  processIdentity(identity);
  if (worker.publication !== null) {
    publicationIdentity(snapshotMessage(worker.publication), 'publication');
  }
}

function frozenWorker(worker: ServingConfigWorker): ServingConfigWorker {
  const publication = worker.publication === null ? null : Object.freeze({ ...worker.publication });
  return Object.freeze({
    process: worker.process,
    revision: worker.revision,
    content_hash: worker.content_hash,
    plugin_catalog_hash: worker.plugin_catalog_hash,
    private_port: worker.private_port,
    publication,
  });
}

export class WorkerAdmissionRegistry implements WorkerAdmissionController {
  private admitted = EMPTY_ADMISSION;
  private nextIndex = 0;

  prepare(workers: readonly ServingConfigWorker[]): PreparedWorkerAdmission {
    try {
      if (!Array.isArray(workers) || workers.length === 0) invalid();
      for (const worker of workers) validateExactWorker(worker);
      const first = workers[0];
      if (first === undefined) invalid();
      validateProcessSet(workers, first.process.identity.master_generation, Number.POSITIVE_INFINITY);
      if (workers.some((worker) => worker.revision !== first.revision
        || worker.content_hash !== first.content_hash
        || worker.plugin_catalog_hash !== first.plugin_catalog_hash
        || worker.process.identity.master_generation !== first.process.identity.master_generation)) {
        invalid();
      }
    } catch (error) {
      if (error instanceof MasterConfigPublicationError) throw error;
      invalid();
    }
    const prepared = Object.freeze(workers.map(frozenWorker)
      .sort((left, right) => left.process.slot - right.process.slot));
    let committed = false;
    return Object.freeze({
      commit: (): void => {
        if (committed) return;
        committed = true;
        this.admitted = prepared;
        this.nextIndex = 0;
      },
    });
  }

  select(): ServingConfigWorker | null {
    const snapshot = this.admitted;
    if (snapshot.length === 0) return null;
    const index = this.nextIndex % snapshot.length;
    this.nextIndex = (index + 1) % snapshot.length;
    return snapshot[index] ?? null;
  }

  snapshot(): readonly ServingConfigWorker[] {
    return this.admitted;
  }

  clear(): void {
    this.admitted = EMPTY_ADMISSION;
    this.nextIndex = 0;
  }
}
