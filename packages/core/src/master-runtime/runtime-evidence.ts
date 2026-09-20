import type { ServingConfigWorker } from '../config-publication/coordinator-types';
import { samePublicationIdentity } from '../config-publication/message-fields';
import type { ProcessCleanupResult } from '../config-publication/process-cleanup';
import type { MasterRuntimeWorkerPool } from './runtime-contracts';
import type { RepositorySnapshot } from '../config-storage/repository-types';

function sameServingEvidence(left: ServingConfigWorker, right: ServingConfigWorker): boolean {
  return left.process === right.process
    && left.revision === right.revision
    && left.content_hash === right.content_hash
    && left.plugin_catalog_hash === right.plugin_catalog_hash
    && left.private_port === right.private_port
    && samePublicationIdentity(left.publication, right.publication);
}

export function exactAdmission(
  admitted: readonly ServingConfigWorker[],
  evidence: readonly ServingConfigWorker[],
  workerCount: number,
): boolean {
  if (admitted.length !== workerCount || evidence.length !== workerCount) return false;
  const unmatched = [...evidence];
  for (const worker of admitted) {
    const index = unmatched.findIndex((candidate) => sameServingEvidence(worker, candidate));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

export function admissionIsPoolOwned(
  admitted: readonly ServingConfigWorker[],
  pool: MasterRuntimeWorkerPool,
): boolean {
  return admitted.every(({ process }) => pool.owns(process));
}

export function isExactServingTarget(
  admitted: readonly ServingConfigWorker[], evidence: readonly ServingConfigWorker[],
  snapshot: RepositorySnapshot, expectedPluginCatalogHash: string, workerCount: number,
  pool?: MasterRuntimeWorkerPool,
): boolean {
  const slots = evidence.map(({ process }) => process.slot);
  const validSlots = slots.every((slot) => Number.isSafeInteger(slot) && slot >= 0 && slot < workerCount)
    && new Set(slots).size === workerCount
    && [...slots].sort((left, right) => left - right).every((slot, index) => slot === index)
    && evidence.every(({ process }) => process.slot === process.identity.worker_slot);
  return exactAdmission(admitted, evidence, workerCount)
    && validSlots
    && evidence.every((worker) => worker.revision === snapshot.revision
      && worker.content_hash === snapshot.content_hash
      && worker.plugin_catalog_hash === expectedPluginCatalogHash)
    && (pool === undefined || admissionIsPoolOwned(admitted, pool));
}

export function exactExitProof(
  expectedPids: readonly number[],
  results: readonly ProcessCleanupResult[],
): boolean {
  // PID multiset: two owned process objects may share one PID and each must consume its
  // own exact proof — a Set would silently drop the duplicate and mis-report convergence
  // (both-proved as false, or one-missing as true once lengths drift).
  const remaining = new Map<number, number>();
  for (const pid of expectedPids) remaining.set(pid, (remaining.get(pid) ?? 0) + 1);
  if (results.length !== expectedPids.length) return false;
  for (const result of results) {
    const pid = result.process.pid;
    const left = remaining.get(pid) ?? 0;
    if (left <= 0 || result.exitEvidence?.pid !== pid || result.waitError !== undefined) return false;
    if (left === 1) remaining.delete(pid);
    else remaining.set(pid, left - 1);
  }
  return remaining.size === 0;
}
