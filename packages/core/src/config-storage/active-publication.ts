import type { Database } from 'bun:sqlite';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { operationFromRow, type OperationRow } from './operation-store';
import { OPERATION_SELECT, readOperationWorkers } from './operation-records';
import { readActiveRevision } from './current-revision';
import { hashConfigurationContent } from './content-hash';
import { getServingSnapshot, writeServingSnapshot } from './serving-snapshot';
import { readPublicationRecoveryBarrier } from './recovery-store';
import { validateDigest } from './repository-validation';
import type { RepositorySnapshot } from './repository-types';
import type {
  ActiveConfigurationPublication,
  ConfigurationOperation,
  ConfigurationOperationWorker,
  PublicationCandidateAllocation,
  PublicationCandidateExitEvidence,
  PublicationPrepareDecision,
} from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll, sqliteGet } from './sqlite-query';
import { validateOperationIdentity } from './operation-relations';
import { readUnsettledWorkerLaunches, readWorkerLaunchAllocationFacts } from './worker-launch-store';
import { CURRENT_RUNTIME_EPOCH } from './runtime-cutover';

type OwnerOperation = Extract<ConfigurationOperation, { readonly state: 'committed' | 'publishing' | 'draining' }>;
export type PublicationOwner = {
  readonly operation: OwnerOperation;
  readonly targets: readonly ConfigurationOperationWorker[];
};

const OWNER_STATES = `('committed','publishing','draining')`;
const SUPERSEDED_DETAIL = 'revision was superseded before publication was claimed';
const CANCELLED_DETAIL = 'publication candidate was cancelled before admission preparation';

/** At most one persistable publication owner exists; unclaimed targets stay pending. */
export function readPublicationOwner(db: Database): PublicationOwner | null {
  const rows = sqliteAll<OperationRow, []>(db, `${OPERATION_SELECT} WHERE state IN ${OWNER_STATES}
    AND runtime_epoch=${CURRENT_RUNTIME_EPOCH}`);
  if (rows.length > 1) throw new ConfigRepositoryError('schema_corrupt', 'multiple publication owners exist');
  const row = rows[0];
  if (row === undefined) return null;
  const operation = operationFromRow(row);
  if (operation.state === 'pending' || operation.state === 'converged' || operation.state === 'degraded' ||
      operation.state === 'superseded') {
    throw new ConfigRepositoryError('schema_corrupt', 'publication owner state is invalid');
  }
  return { operation, targets: readOperationWorkers(db, operation.mutation_id) };
}

function resolveSnapshot(
  db: Database, operation: OwnerOperation, pluginCatalogHash: Sha256Digest,
): RepositorySnapshot {
  const revision = sqliteGet<{ readonly content_hash: string }, [number]>(db,
    'SELECT content_hash FROM configuration_revisions WHERE revision=?', operation.committed_revision);
  if (revision === null) throw new ConfigRepositoryError('schema_corrupt', 'publication revision is missing');
  const snapshot = getServingSnapshot(db, {
    revision: operation.committed_revision, content_hash: revision.content_hash as Sha256Digest,
    plugin_catalog_hash: pluginCatalogHash,
  });
  if (snapshot === null) throw new ConfigRepositoryError('schema_corrupt', 'publication snapshot is missing');
  validateOperationIdentity(db, operation, readOperationWorkers(db, operation.mutation_id), snapshot);
  return snapshot;
}

function publicationFrom(
  db: Database, owner: PublicationOwner, pluginCatalogHash: Sha256Digest,
): ActiveConfigurationPublication {
  const { operation, targets } = owner;
  const snapshot = resolveSnapshot(db, operation, pluginCatalogHash);
  const uniqueSlots = new Set(targets.map(({ worker_slot }) => worker_slot));
  if (targets.length !== operation.target_worker_count || uniqueSlots.size !== targets.length) {
    throw new ConfigRepositoryError('schema_corrupt', 'publication target cardinality is incoherent');
  }
  if (targets.some(({ target_revision }) => target_revision !== operation.committed_revision)) {
    throw new ConfigRepositoryError('schema_corrupt', 'publication targets do not belong to the frozen revision');
  }
  return { operation, snapshot, targets, plugin_catalog_hash: pluginCatalogHash };
}

/** Reads the frozen owner projection without claiming or mutating anything. */
export function readActivePublication(db: Database): ActiveConfigurationPublication | null {
  const owner = readPublicationOwner(db);
  if (owner === null) return null;
  if (owner.operation.plugin_catalog_hash === null) {
    throw new ConfigRepositoryError('schema_corrupt', 'publication snapshot catalog identity is missing');
  }
  return publicationFrom(db, owner, owner.operation.plugin_catalog_hash);
}

/** The latest snapshot is the only source for a target that is about to be sealed by claim. */
function requireLatestAggregate(db: Database, snapshot: RepositorySnapshot, revision: number) {
  if (snapshot.revision !== revision || snapshot.revision !== readActiveRevision(db)) {
    throw new ConfigRepositoryError('schema_corrupt', 'publication target disagrees with the latest snapshot');
  }
  return snapshot.aggregate;
}

/**
 * Claim the newest persisted target when nobody owns publication. Older unclaimed targets
 * are superseded without evidence because no candidate process ever referenced them.
 */
export function claimPublicationTarget(
  db: Database, snapshot: RepositorySnapshot, pluginCatalogHash: Sha256Digest, updatedAt: number,
  preparedInstances?: ReadonlySet<string>,
): ActiveConfigurationPublication | null {
  if (!validateDigest(pluginCatalogHash)) {
    throw new ConfigRepositoryError('invalid_command', 'publication catalog identity is invalid');
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new ConfigRepositoryError('invalid_command', 'publication claim timestamp is invalid');
  }
  const owner = readPublicationOwner(db);
  if (owner !== null) {
    if (owner.operation.plugin_catalog_hash === null) {
      throw new ConfigRepositoryError('schema_corrupt', 'publication owner has no frozen catalog identity');
    }
    if (owner.operation.plugin_catalog_hash !== pluginCatalogHash) {
      throw new ConfigRepositoryError('invalid_operation', 'claimed publication catalog identity is immutable');
    }
    return publicationFrom(db, owner, pluginCatalogHash);
  }
  // An unresolved or safety-unknown reconciliation, or worker retirement, must finish
  // before another target reaches the data plane. This query is global, so advancing the
  // latest revision cannot hide an older unresolved barrier.
  const recovery = readPublicationRecoveryBarrier(db);
  if (recovery !== null) {
    throw new ConfigRepositoryError('recovery_in_progress',
      'configuration application is blocked by an unresolved recovery', undefined, recovery);
  }
  const retirement = sqliteGet<{ readonly mutation_id: string }, []>(db,
    `SELECT r.mutation_id FROM configuration_retirements r JOIN configuration_operations o USING(mutation_id)
    WHERE r.state<>'released' AND o.runtime_epoch=${CURRENT_RUNTIME_EPOCH} LIMIT 1`);
  if (retirement !== null) {
    throw new ConfigRepositoryError('invalid_operation',
      'configuration application is blocked by unresolved worker retirement');
  }
  if (readUnsettledWorkerLaunches(db).some(entry => entry.kind !== 'launch'
    || entry.launch.allocation !== null || !preparedInstances?.has(entry.launch.identity.worker_instance_id))) {
    throw new ConfigRepositoryError('invalid_operation',
      'configuration application is blocked by an unsettled worker launch');
  }
  const activeRevision = readActiveRevision(db);
  db.run(`UPDATE configuration_operations
    SET state='superseded',result_status=409,error_code='revision_superseded',error_detail=?,
      updated_at=max(?,updated_at)
    WHERE state='pending' AND committed_revision<?`, [SUPERSEDED_DETAIL, updatedAt, activeRevision]);
  const candidateRow = sqliteGet<OperationRow, [number]>(db,
    `${OPERATION_SELECT} WHERE state='pending' AND committed_revision=?`, activeRevision);
  if (candidateRow === null) return null;
  const candidate = operationFromRow(candidateRow);
  if (candidate.state !== 'pending') throw new ConfigRepositoryError('schema_corrupt', 'pending target state is invalid');
  const aggregate = requireLatestAggregate(db, snapshot, candidate.committed_revision);
  const revision = sqliteGet<{ readonly content_hash: string }, [number]>(db,
    'SELECT content_hash FROM configuration_revisions WHERE revision=?', candidate.committed_revision);
  if (revision === null || hashConfigurationContent(aggregate) !== revision.content_hash) {
    throw new ConfigRepositoryError('schema_corrupt', 'claimed target aggregate does not match its revision');
  }
  writeServingSnapshot(db, {
    revision: candidate.committed_revision, content_hash: revision.content_hash as Sha256Digest, aggregate,
  }, pluginCatalogHash);
  const claimed = db.run(`UPDATE configuration_operations
    SET state='committed',plugin_catalog_hash=?,updated_at=?,runtime_epoch=${CURRENT_RUNTIME_EPOCH}
    WHERE mutation_id=? AND state='pending'`, [pluginCatalogHash, Math.max(updatedAt, candidate.updated_at), candidate.mutation_id]);
  if (claimed.changes !== 1) throw new ConfigRepositoryError('repository_failure', 'publication claim lost its target');
  const ownerAfter = readPublicationOwner(db);
  if (ownerAfter === null) throw new ConfigRepositoryError('repository_failure', 'publication claim did not persist');
  return publicationFrom(db, ownerAfter, pluginCatalogHash);
}

function requireOwner(
  db: Database, mutationId: string, committedRevision: number,
): OwnerOperation {
  const owner = readPublicationOwner(db);
  if (owner === null || owner.operation.mutation_id !== mutationId ||
      owner.operation.committed_revision !== committedRevision) {
    throw new ConfigRepositoryError('invalid_operation', 'publication command does not match the current owner');
  }
  return owner.operation;
}

function requireTimestamp(updatedAt: number, operation: ConfigurationOperation): void {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < operation.updated_at) {
    throw new ConfigRepositoryError('invalid_operation', 'operation timestamp regressed or is unsafe');
  }
}

/** Cancellation is only legal while admission preparation has not been granted. */
export function requestPublicationCancellation(
  db: Database, mutationId: string, committedRevision: number, updatedAt: number,
): ConfigurationOperation {
  const operation = requireOwner(db, mutationId, committedRevision);
  if (operation.prepare_started || operation.state === 'draining') {
    throw new ConfigRepositoryError('cancellation_not_permitted',
      'publication candidate has entered admission preparation');
  }
  if (operation.cancel_requested) return operation;
  requireTimestamp(updatedAt, operation);
  db.run(`UPDATE configuration_operations SET cancel_requested=1,updated_at=?
    WHERE mutation_id=? AND state IN ('committed','publishing') AND prepare_started=0`,
  [updatedAt, mutationId]);
  const updated = sqliteGet<OperationRow, [string]>(db, `${OPERATION_SELECT} WHERE mutation_id=?`, mutationId);
  if (updated === null) throw new ConfigRepositoryError('repository_failure', 'cancellation request was not persisted');
  return operationFromRow(updated);
}

/** Grants or denies admission preparation exactly once, racing cancellation through the owner row. */
export function enterPublicationPrepare(
  db: Database, mutationId: string, committedRevision: number, updatedAt: number,
): PublicationPrepareDecision {
  const operation = requireOwner(db, mutationId, committedRevision);
  if (operation.state === 'draining') throw new ConfigRepositoryError('invalid_operation', 'operation is not a candidate');
  if (operation.prepare_started) return { kind: 'granted', operation };
  // Re-check the durable latest target inside the same transaction: an in-memory check
  // by the caller cannot order a concurrent save against this preparation grant.
  const latestRevision = readActiveRevision(db);
  if (latestRevision < operation.committed_revision) {
    throw new ConfigRepositoryError('schema_corrupt', 'publication target is newer than the latest revision');
  }
  if (latestRevision > operation.committed_revision) {
    if (!operation.cancel_requested) {
      db.run(`UPDATE configuration_operations SET cancel_requested=1,updated_at=?
        WHERE mutation_id=? AND state IN ('committed','publishing') AND prepare_started=0 AND cancel_requested=0`,
      [Math.max(updatedAt, operation.updated_at), mutationId]);
    }
    return { kind: 'cancelled' };
  }
  if (operation.cancel_requested) return { kind: 'cancelled' };
  requireTimestamp(updatedAt, operation);
  const granted = db.run(`UPDATE configuration_operations SET prepare_started=1,updated_at=?
    WHERE mutation_id=? AND state IN ('committed','publishing') AND prepare_started=0 AND cancel_requested=0`,
  [updatedAt, mutationId]).changes;
  const current = sqliteGet<OperationRow, [string]>(db, `${OPERATION_SELECT} WHERE mutation_id=?`, mutationId);
  if (current === null) throw new ConfigRepositoryError('repository_failure', 'preparation decision was not persisted');
  const result = operationFromRow(current);
  if (granted === 1) return { kind: 'granted', operation: result };
  if (result.state === 'committed' || result.state === 'publishing') {
    if (result.cancel_requested) return { kind: 'cancelled' };
  }
  throw new ConfigRepositoryError('invalid_operation', 'preparation decision lost the owner');
}

/**
 * Persists exit/cleanup proof for one started candidate attempt. Evidence is bound to the
 * frozen operation, worker slot and attempt; it can never be shared across attempts.
 */
export function recordPublicationCandidateExit(
  db: Database, mutationId: string, committedRevision: number,
  workerSlot: number, attemptNo: number,
  evidence: PublicationCandidateExitEvidence, updatedAt: number,
): void {
  if (evidence === null || typeof evidence !== 'object' ||
      (evidence.kind !== 'not_started' &&
       (evidence.kind !== 'exited' || evidence.cleanup !== 'released'))) {
    throw new ConfigRepositoryError('invalid_command', 'candidate exit evidence is invalid');
  }
  const operation = requireOwner(db, mutationId, committedRevision);
  if (operation.state === 'draining') {
    throw new ConfigRepositoryError('invalid_operation', 'operation is not a candidate');
  }
  requireTimestamp(updatedAt, operation);
  const worker = readOperationWorkers(db, mutationId).find(candidate => candidate.worker_slot === workerSlot);
  if (worker === undefined || !Number.isSafeInteger(attemptNo) || attemptNo <= 0 || worker.attempt_no !== attemptNo) {
    throw new ConfigRepositoryError('invalid_operation', 'candidate attempt identity is stale or not started');
  }
  const exitKind = evidence.kind;
  const cleanup = evidence.kind === 'not_started' ? 'not_started' : 'released';
  const launchFacts = readWorkerLaunchAllocationFacts(db, { mutation_id: mutationId, worker_slot: workerSlot, attempt_no: attemptNo });
  if (launchFacts !== null && ((exitKind === 'not_started' && launchFacts.exited_at !== null) ||
      (exitKind === 'exited' && launchFacts.not_started_at !== null))) {
    throw new ConfigRepositoryError('cas_conflict', 'candidate exit evidence conflicts with worker launch proof');
  }
  const existing = sqliteGet<{ readonly exit_kind: string; readonly cleanup: string }, [string, number, number]>(db,
    `SELECT exit_kind,cleanup FROM configuration_publication_candidate_evidence
     WHERE mutation_id=? AND worker_slot=? AND attempt_no=?`,
  mutationId, workerSlot, attemptNo);
  if (existing !== null) {
    if (existing.exit_kind !== exitKind || existing.cleanup !== cleanup) {
      throw new ConfigRepositoryError('cas_conflict', 'candidate exit evidence is already frozen');
    }
    return;
  }
  db.run(`INSERT INTO configuration_publication_candidate_evidence
    (mutation_id,worker_slot,attempt_no,exit_kind,cleanup,updated_at) VALUES (?,?,?,?,?,?)`,
  [mutationId, workerSlot, attemptNo, exitKind, cleanup, updatedAt]);
}

/** All started attempts of the current owner still occupy candidate budget. */
export function readOutstandingPublicationCandidates(db: Database): readonly PublicationCandidateAllocation[] {
  const owner = readPublicationOwner(db);
  if (owner === null) return [];
  return owner.targets
    .filter(({ attempt_no }) => attempt_no > 0)
    .map(({ worker_slot, attempt_no, state, updated_at }) => ({
      mutation_id: owner.operation.mutation_id,
      committed_revision: owner.operation.committed_revision,
      plugin_catalog_hash: owner.operation.plugin_catalog_hash,
      worker_slot, attempt_no, state, updated_at,
    }));
}

/**
 * Records the honest non-success terminal state only when every started attempt of this
 * candidate has persisted exit/cleanup proof. Missing or unknown evidence keeps the owner.
 */
export function confirmPublicationCandidateExited(
  db: Database, mutationId: string, committedRevision: number, updatedAt: number,
): ConfigurationOperation {
  const operation = requireOwner(db, mutationId, committedRevision);
  if (operation.state === 'draining' || operation.prepare_started) {
    throw new ConfigRepositoryError('cancellation_not_permitted',
      'publication candidate has entered admission preparation');
  }
  if (!operation.cancel_requested) {
    throw new ConfigRepositoryError('invalid_operation', 'candidate cancellation was not requested');
  }
  const started = readOperationWorkers(db, mutationId).filter(({ attempt_no }) => attempt_no > 0);
  for (const worker of started) {
    const evidence = sqliteGet<{ readonly attempt_no: number }, [string, number, number]>(db,
      `SELECT attempt_no FROM configuration_publication_candidate_evidence
       WHERE mutation_id=? AND worker_slot=? AND attempt_no=?`,
      mutationId, worker.worker_slot, worker.attempt_no);
    const launch = readWorkerLaunchAllocationFacts(db, {
      mutation_id: mutationId, worker_slot: worker.worker_slot, attempt_no: worker.attempt_no,
    });
    if (evidence === null && launch?.settled !== true) {
      throw new ConfigRepositoryError('invalid_operation', 'candidate exit evidence is incomplete');
    }
  }
  requireTimestamp(updatedAt, operation);
  const changed = db.run(`UPDATE configuration_operations
    SET state='superseded',result_status=409,error_code='revision_superseded',error_detail=?,updated_at=?
    WHERE mutation_id=? AND state IN ('committed','publishing') AND prepare_started=0 AND cancel_requested=1`,
  [CANCELLED_DETAIL, updatedAt, mutationId]).changes;
  if (changed !== 1) throw new ConfigRepositoryError('cas_conflict', 'candidate supersession lost its owner');
  const terminal = sqliteGet<OperationRow, [string]>(db, `${OPERATION_SELECT} WHERE mutation_id=?`, mutationId);
  if (terminal === null) throw new ConfigRepositoryError('repository_failure', 'candidate supersession was not persisted');
  return operationFromRow(terminal);
}
