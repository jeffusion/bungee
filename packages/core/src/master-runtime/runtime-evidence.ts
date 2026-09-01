import type { ServingConfigWorker } from '../config-publication/coordinator-types';
import { samePublicationIdentity } from '../config-publication/message-fields';
import type { ProcessCleanupResult } from '../config-publication/process-cleanup';
import type { MasterRuntimeWorkerPool } from './runtime-contracts';

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

export function exactExitProof(
  expectedPids: readonly number[],
  results: readonly ProcessCleanupResult[],
): boolean {
  const remaining = new Set(expectedPids);
  if (remaining.size !== expectedPids.length || results.length !== expectedPids.length) return false;
  for (const result of results) {
    const pid = result.process.pid;
    if (!remaining.delete(pid) || result.exitEvidence?.pid !== pid || result.waitError !== undefined) return false;
  }
  return remaining.size === 0;
}
