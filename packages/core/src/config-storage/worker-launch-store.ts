import type { Database } from 'bun:sqlite';
import type { ConfigProcessIdentity } from '../config-publication/types';
import type { ProcessLifetimeGuardFacts } from '../supervision/process-lifetime-guard';
import { parseProcessLifetimeGuardFacts } from '../supervision/process-lifetime-guard';
import { canonicalJson } from './content-hash';
import { ConfigRepositoryError } from './repository-types';
import { validateMutationId } from './repository-validation';
import { sqliteAll, sqliteGet } from './sqlite-query';
import { isLowercaseUuid } from './validation';

export type WorkerLaunchIdentity = ConfigProcessIdentity;

export type WorkerLaunchAllocation = {
  readonly mutation_id: string;
  readonly worker_slot: number;
  readonly attempt_no: number;
};

export type WorkerLaunch = {
  readonly identity: WorkerLaunchIdentity;
  readonly guard: ProcessLifetimeGuardFacts;
  readonly allocation: WorkerLaunchAllocation | null;
  readonly registered_at: number;
  readonly admitted: boolean;
  readonly not_started: boolean;
  readonly exited: boolean;
  readonly cleanup_released: boolean;
};

export type WorkerLaunchExitEvidence =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'exited'; readonly cleanup: 'released' | 'unknown' };

export type UnsettledWorkerLaunch =
  | { readonly kind: 'launch'; readonly launch: WorkerLaunch }
  | { readonly kind: 'reservation'; readonly allocation: WorkerLaunchAllocation };

/** Exact durable facts for one allocation, including a fence that has no launch intent. */
export type WorkerLaunchAllocationFacts = Readonly<{
  allocation: WorkerLaunchAllocation;
  launch: WorkerLaunch | null;
  reserved_at: number | null;
  not_started_at: number | null;
  admitted_at: number | null;
  exited_at: number | null;
  cleanup_released_at: number | null;
  settled: boolean;
}>;

type IntentRow = {
  readonly worker_instance_id: string;
  readonly master_generation: string;
  readonly worker_slot: number;
  readonly allocation_mutation_id: string | null;
  readonly allocation_worker_slot: number | null;
  readonly allocation_attempt_no: number | null;
  readonly guard_json: string;
  readonly registered_at: number;
};

type ReservationRow = {
  readonly mutation_id: string;
  readonly worker_slot: number;
  readonly attempt_no: number;
  readonly recorded_at: number;
};

type LaunchFacts = {
  readonly admitted: boolean;
  readonly not_started: boolean;
  readonly exited: boolean;
  readonly cleanup_released: boolean;
  readonly last_recorded_at: number;
};

const INTENT_SELECT = `SELECT worker_instance_id,master_generation,worker_slot,
  allocation_mutation_id,allocation_worker_slot,allocation_attempt_no,guard_json,registered_at
  FROM configuration_worker_launch_intents`;

function invalid(message: string): never {
  throw new ConfigRepositoryError('invalid_command', message);
}

function invalidOperation(message: string): never {
  throw new ConfigRepositoryError('invalid_operation', message);
}

function natural(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function validateIdentity(identity: WorkerLaunchIdentity): void {
  if (typeof identity !== 'object' || identity === null ||
      !isLowercaseUuid(identity.master_generation) ||
      !isLowercaseUuid(identity.worker_instance_id) ||
      !natural(identity.worker_slot)) {
    invalid('worker launch identity is invalid');
  }
}

function validateAllocation(allocation: WorkerLaunchAllocation, identity: WorkerLaunchIdentity): void {
  if (typeof allocation !== 'object' || allocation === null ||
      typeof allocation.mutation_id !== 'string' || !validateMutationId(allocation.mutation_id) ||
      !natural(allocation.worker_slot) || allocation.worker_slot !== identity.worker_slot ||
      !natural(allocation.attempt_no, 1)) {
    invalid('worker launch allocation is invalid');
  }
}

function validateAllocationInput(allocation: WorkerLaunchAllocation): void {
  if (typeof allocation !== 'object' || allocation === null ||
      typeof allocation.mutation_id !== 'string' || !validateMutationId(allocation.mutation_id) ||
      !natural(allocation.worker_slot) || !natural(allocation.attempt_no, 1)) {
    invalid('worker launch allocation is invalid');
  }
}

function parseGuard(value: unknown): ProcessLifetimeGuardFacts {
  try {
    return parseProcessLifetimeGuardFacts(value);
  } catch {
    throw new ConfigRepositoryError('schema_corrupt', 'worker launch guard facts are invalid');
  }
}

function parseInputGuard(value: ProcessLifetimeGuardFacts, identity: WorkerLaunchIdentity): ProcessLifetimeGuardFacts {
  let guard: ProcessLifetimeGuardFacts;
  try {
    guard = parseProcessLifetimeGuardFacts(value);
  } catch {
    invalid('worker launch guard facts are invalid');
  }
  if (guard.process_instance_id !== identity.worker_instance_id) {
    invalid('worker launch guard belongs to another process');
  }
  return guard;
}

function sameAllocation(left: WorkerLaunchAllocation | null, right: WorkerLaunchAllocation | null): boolean {
  return left === null ? right === null : right !== null &&
    left.mutation_id === right.mutation_id && left.worker_slot === right.worker_slot &&
    left.attempt_no === right.attempt_no;
}

function allocationKey(allocation: WorkerLaunchAllocation): string {
  return `${allocation.mutation_id}\u0000${allocation.worker_slot}\u0000${allocation.attempt_no}`;
}

function rowAllocation(row: IntentRow): WorkerLaunchAllocation | null {
  if (row.allocation_mutation_id === null || row.allocation_worker_slot === null ||
      row.allocation_attempt_no === null) return null;
  return {
    mutation_id: row.allocation_mutation_id,
    worker_slot: row.allocation_worker_slot,
    attempt_no: row.allocation_attempt_no,
  };
}

function readFacts(db: Database, instance: string, allocation: WorkerLaunchAllocation | null): LaunchFacts {
  const rows = allocation === null
    ? sqliteAll<{ readonly kind: string; readonly recorded_at: number }, [string]>(db,
      `SELECT kind,recorded_at FROM configuration_worker_launch_facts WHERE worker_instance_id=?`, instance)
    : sqliteAll<{ readonly kind: string; readonly recorded_at: number }, [string, string, number, number]>(db,
      `SELECT kind,recorded_at FROM configuration_worker_launch_facts
       WHERE worker_instance_id=? OR (mutation_id=? AND worker_slot=? AND attempt_no=?)`,
      instance, allocation.mutation_id, allocation.worker_slot, allocation.attempt_no);
  let admitted = false;
  let notStarted = false;
  let exited = false;
  let cleanup = false;
  let lastRecordedAt = 0;
  for (const row of rows) {
    if (row.kind === 'admitted') admitted = true;
    else if (row.kind === 'not_started') notStarted = true;
    else if (row.kind === 'exited') exited = true;
    else if (row.kind === 'cleanup') cleanup = true;
    lastRecordedAt = Math.max(lastRecordedAt, row.recorded_at);
  }
  return { admitted, not_started: notStarted, exited, cleanup_released: cleanup, last_recorded_at: lastRecordedAt };
}

function launchFromRow(db: Database, row: IntentRow): WorkerLaunch {
  if (!isLowercaseUuid(row.worker_instance_id) || !isLowercaseUuid(row.master_generation) ||
      !natural(row.worker_slot) || !natural(row.registered_at)) {
    throw new ConfigRepositoryError('schema_corrupt', 'worker launch intent is invalid');
  }
  const allocation = rowAllocation(row);
  if ((row.allocation_mutation_id === null) !== (row.allocation_worker_slot === null) ||
      (row.allocation_mutation_id === null) !== (row.allocation_attempt_no === null) ||
      (allocation !== null && (!validateMutationId(allocation.mutation_id) ||
        !natural(allocation.worker_slot) || !natural(allocation.attempt_no, 1) ||
        allocation.worker_slot !== row.worker_slot))) {
    throw new ConfigRepositoryError('schema_corrupt', 'worker launch allocation is invalid');
  }
  let guardJson: unknown;
  try {
    guardJson = JSON.parse(row.guard_json);
  } catch {
    throw new ConfigRepositoryError('schema_corrupt', 'worker launch guard facts are invalid');
  }
  const guard = parseGuard(guardJson);
  if (guard.process_instance_id !== row.worker_instance_id) {
    throw new ConfigRepositoryError('schema_corrupt', 'worker launch guard identity is invalid');
  }
  const facts = readFacts(db, row.worker_instance_id, allocation);
  return Object.freeze({
    identity: Object.freeze({
      master_generation: row.master_generation,
      worker_instance_id: row.worker_instance_id,
      worker_slot: row.worker_slot,
    }),
    guard,
    allocation: allocation === null ? null : Object.freeze(allocation),
    registered_at: row.registered_at,
    admitted: facts.admitted,
    not_started: facts.not_started,
    exited: facts.exited,
    cleanup_released: facts.cleanup_released,
  });
}

function requireIntentRow(db: Database, workerInstanceId: string): IntentRow {
  if (typeof workerInstanceId !== 'string' || !isLowercaseUuid(workerInstanceId)) {
    invalid('worker launch instance identity is invalid');
  }
  const row = sqliteGet<IntentRow, [string]>(db, `${INTENT_SELECT} WHERE worker_instance_id=?`, workerInstanceId);
  if (row === null) invalidOperation('worker launch intent was not registered');
  return row;
}

function requireTimestamp(updatedAt: number, minimum: number): void {
  if (!natural(updatedAt) || updatedAt < minimum) {
    invalidOperation('worker launch timestamp regressed or is unsafe');
  }
}

function hasFact(db: Database, kind: string, allocation: WorkerLaunchAllocation): boolean {
  return sqliteGet<{ readonly fact_id: number }, [string, string, number, number]>(db,
    `SELECT fact_id FROM configuration_worker_launch_facts
     WHERE kind=? AND mutation_id=? AND worker_slot=? AND attempt_no=?`,
    kind, allocation.mutation_id, allocation.worker_slot, allocation.attempt_no) !== null;
}

function insertAllocationFact(
  db: Database, kind: 'reserved' | 'not_started', allocation: WorkerLaunchAllocation, updatedAt: number,
): void {
  if (!natural(updatedAt)) invalid('worker launch fact timestamp is invalid');
  if (hasFact(db, kind, allocation)) return;
  db.run(`INSERT INTO configuration_worker_launch_facts
    (kind,mutation_id,worker_slot,attempt_no,recorded_at) VALUES (?,?,?,?,?)`,
  [kind, allocation.mutation_id, allocation.worker_slot, allocation.attempt_no, updatedAt]);
}

function insertInstanceFact(
  db: Database, kind: 'not_started' | 'admitted' | 'exited' | 'cleanup',
  intent: WorkerLaunch, updatedAt: number,
): void {
  if (!natural(updatedAt)) invalid('worker launch fact timestamp is invalid');
  const allocation = intent.allocation;
  db.run(`INSERT INTO configuration_worker_launch_facts
    (kind,mutation_id,worker_slot,attempt_no,worker_instance_id,recorded_at) VALUES (?,?,?,?,?,?)`,
  [kind, allocation?.mutation_id ?? null, allocation?.worker_slot ?? null,
    allocation?.attempt_no ?? null, intent.identity.worker_instance_id, updatedAt]);
}

type AllocationAuthorityRow = {
  readonly state: string;
  readonly cancel_requested: number;
  readonly attempt_no: number;
};

/**
 * The allocation must still be the live publication owner and the exact current attempt.
 * A reserved fact alone never authorizes registering a historical, cancelled or closed one.
 */
function requireOpenAllocation(
  db: Database, allocation: WorkerLaunchAllocation, allowCancelled: boolean,
): AllocationAuthorityRow {
  const authority = sqliteGet<AllocationAuthorityRow, [string, number]>(db,
    `SELECT o.state,o.cancel_requested,w.attempt_no
     FROM configuration_operations o
     JOIN configuration_operation_workers w ON w.mutation_id=o.mutation_id
     WHERE o.mutation_id=? AND w.worker_slot=?`,
    allocation.mutation_id, allocation.worker_slot);
  if (authority === null ||
      (authority.state !== 'committed' && authority.state !== 'publishing' && authority.state !== 'draining') ||
      authority.attempt_no !== allocation.attempt_no ||
      (!allowCancelled && authority.cancel_requested === 1)) {
    invalidOperation('worker launch allocation is not the current open attempt');
  }
  return authority;
}

function requireReservation(db: Database, allocation: WorkerLaunchAllocation): ReservationRow {
  const row = sqliteGet<ReservationRow, [string, number, number]>(db,
    `SELECT mutation_id,worker_slot,attempt_no,recorded_at FROM configuration_worker_launch_facts
     WHERE kind='reserved' AND mutation_id=? AND worker_slot=? AND attempt_no=?`,
    allocation.mutation_id, allocation.worker_slot, allocation.attempt_no);
  if (row === null) invalidOperation('worker launch allocation was not reserved');
  return row;
}

function candidateEvidenceSettled(db: Database, allocation: WorkerLaunchAllocation): boolean {
  return sqliteGet<{ readonly mutation_id: string }, [string, number, number]>(db,
    `SELECT mutation_id FROM configuration_publication_candidate_evidence
     WHERE mutation_id=? AND worker_slot=? AND attempt_no=? AND
       (exit_kind='not_started' OR (exit_kind='exited' AND cleanup='released'))`,
    allocation.mutation_id, allocation.worker_slot, allocation.attempt_no) !== null;
}

/** Persists the pre-fork attempt reservation inside the attempt transaction. */
export function writeWorkerLaunchReservation(
  db: Database, mutationId: string, workerSlot: number, attemptNo: number, updatedAt: number,
): void {
  if (typeof mutationId !== 'string' || !validateMutationId(mutationId) ||
      !natural(workerSlot) || !natural(attemptNo, 1) || !natural(updatedAt)) {
    throw new ConfigRepositoryError('invalid_operation', 'worker launch reservation is invalid');
  }
  insertAllocationFact(db, 'reserved', { mutation_id: mutationId, worker_slot: workerSlot, attempt_no: attemptNo }, updatedAt);
}

/**
 * Closes the window "attempt persisted, intent not registered". A registered intent means a
 * fork may have happened, so it can only be closed with exit evidence instead.
 */
export function fenceWorkerLaunchNotStarted(
  db: Database, mutationId: string, workerSlot: number, attemptNo: number, updatedAt: number,
): void {
  const allocation = { mutation_id: mutationId, worker_slot: workerSlot, attempt_no: attemptNo };
  if (typeof mutationId !== 'string' || !validateMutationId(mutationId) ||
      !natural(workerSlot) || !natural(attemptNo, 1)) {
    invalid('worker launch allocation is invalid');
  }
  requireOpenAllocation(db, allocation, true);
  const reservation = requireReservation(db, allocation);
  if (sqliteGet<{ readonly worker_instance_id: string }, [string, number, number]>(db,
    `SELECT worker_instance_id FROM configuration_worker_launch_intents
     WHERE allocation_mutation_id=? AND allocation_worker_slot=? AND allocation_attempt_no=? LIMIT 1`,
    mutationId, workerSlot, attemptNo) !== null) {
    invalidOperation('worker launch intent already registered');
  }
  if (hasFact(db, 'not_started', allocation)) return;
  requireTimestamp(updatedAt, reservation.recorded_at);
  insertAllocationFact(db, 'not_started', allocation, updatedAt);
}

/**
 * Immutable intent for the real pre-fork identity and original guard facts. The allocation is
 * optional so a publication-less currentStartup can be recorded without inventing an owner.
 */
export function registerWorkerLaunch(
  db: Database, identity: WorkerLaunchIdentity, guard: ProcessLifetimeGuardFacts,
  allocation: WorkerLaunchAllocation | null, updatedAt: number,
): WorkerLaunch {
  validateIdentity(identity);
  const parsedGuard = parseInputGuard(guard, identity);
  const guardJson = canonicalJson(parsedGuard);
  if (allocation !== null) validateAllocation(allocation, identity);
  if (!natural(updatedAt)) invalid('worker launch registration timestamp is invalid');

  if (allocation !== null) {
    requireOpenAllocation(db, allocation, false);
    const reservation = requireReservation(db, allocation);
    requireTimestamp(updatedAt, reservation.recorded_at);
    if (hasFact(db, 'not_started', allocation)) {
      invalidOperation('worker launch allocation is fenced not_started');
    }
    const byAllocation = sqliteGet<IntentRow, [string, number, number]>(db,
      `${INTENT_SELECT} WHERE allocation_mutation_id=? AND allocation_worker_slot=? AND allocation_attempt_no=?`,
      allocation.mutation_id, allocation.worker_slot, allocation.attempt_no);
    if (byAllocation !== null) {
      const existing = launchFromRow(db, byAllocation);
      if (existing.identity.master_generation !== identity.master_generation ||
          existing.identity.worker_instance_id !== identity.worker_instance_id ||
          existing.identity.worker_slot !== identity.worker_slot ||
          canonicalJson(existing.guard) !== guardJson || !sameAllocation(existing.allocation, allocation)) {
        throw new ConfigRepositoryError('cas_conflict', 'worker launch allocation is already registered');
      }
      return existing;
    }
  }

  const byInstance = sqliteGet<IntentRow, [string]>(db, `${INTENT_SELECT} WHERE worker_instance_id=?`,
    identity.worker_instance_id);
  if (byInstance !== null) {
    const existing = launchFromRow(db, byInstance);
    if (sameAllocation(existing.allocation, allocation) &&
        existing.identity.master_generation === identity.master_generation &&
        existing.identity.worker_slot === identity.worker_slot &&
        canonicalJson(existing.guard) === guardJson) {
      return existing;
    }
    invalidOperation('worker instance identity was already registered with another launch');
  }

  db.run(`INSERT INTO configuration_worker_launch_intents
    (worker_instance_id,master_generation,worker_slot,allocation_mutation_id,allocation_worker_slot,
     allocation_attempt_no,guard_json,registered_at) VALUES (?,?,?,?,?,?,?,?)`,
  [identity.worker_instance_id, identity.master_generation, identity.worker_slot,
    allocation?.mutation_id ?? null, allocation?.worker_slot ?? null, allocation?.attempt_no ?? null,
    guardJson, updatedAt]);
  const saved = sqliteGet<IntentRow, [string]>(db, `${INTENT_SELECT} WHERE worker_instance_id=?`,
    identity.worker_instance_id);
  if (saved === null) throw new ConfigRepositoryError('repository_failure', 'worker launch intent was not persisted');
  return launchFromRow(db, saved);
}

/** Only the trusted controller records this after real admission/handoff confirmation. */
export function recordWorkerLaunchAdmitted(
  db: Database, workerInstanceId: string, updatedAt: number,
): WorkerLaunch {
  const row = requireIntentRow(db, workerInstanceId);
  const launch = launchFromRow(db, row);
  if (launch.not_started || launch.exited) {
    invalidOperation('worker launch cannot be admitted after exit proof');
  }
  if (launch.admitted) return launch;
  requireTimestamp(updatedAt, Math.max(launch.registered_at, readFacts(db, workerInstanceId, launch.allocation).last_recorded_at));
  insertInstanceFact(db, 'admitted', launch, updatedAt);
  return launchFromRow(db, row);
}

/** Explicit exit and resource-release proof. A free guard is never accepted as cleanup proof. */
export function recordWorkerLaunchExit(
  db: Database, workerInstanceId: string, evidence: WorkerLaunchExitEvidence, updatedAt: number,
): WorkerLaunch {
  if (typeof evidence !== 'object' || evidence === null ||
      (evidence.kind !== 'not_started' &&
       (evidence.kind !== 'exited' || (evidence.cleanup !== 'released' && evidence.cleanup !== 'unknown')))) {
    invalid('worker launch exit evidence is invalid');
  }
  const row = requireIntentRow(db, workerInstanceId);
  const launch = launchFromRow(db, row);
  const candidate = launch.allocation === null ? null
    : sqliteGet<{ readonly exit_kind: string }, [string, number, number]>(db,
      `SELECT exit_kind FROM configuration_publication_candidate_evidence
       WHERE mutation_id=? AND worker_slot=? AND attempt_no=?`,
      launch.allocation.mutation_id, launch.allocation.worker_slot, launch.allocation.attempt_no);
  if (candidate !== null && ((evidence.kind === 'not_started' && candidate.exit_kind === 'exited') ||
      (evidence.kind === 'exited' && candidate.exit_kind === 'not_started'))) {
    throw new ConfigRepositoryError('cas_conflict', 'worker launch exit proof conflicts with candidate evidence');
  }
  if (evidence.kind === 'not_started') {
    if (launch.exited || launch.cleanup_released) {
      invalidOperation('worker launch exit proof conflicts with not_started');
    }
    if (launch.admitted) invalidOperation('an admitted worker launch cannot be proven not started');
    if (launch.not_started) return launch;
    requireTimestamp(updatedAt, Math.max(launch.registered_at, readFacts(db, workerInstanceId, launch.allocation).last_recorded_at));
    insertInstanceFact(db, 'not_started', launch, updatedAt);
    return launchFromRow(db, row);
  }
  if (launch.not_started) invalidOperation('worker launch was already proven not started');
  let { exited, cleanup_released: cleanupReleased, last_recorded_at: lastRecordedAt } =
    readFacts(db, workerInstanceId, launch.allocation);
  if (!exited) {
    requireTimestamp(updatedAt, Math.max(launch.registered_at, lastRecordedAt));
    insertInstanceFact(db, 'exited', launch, updatedAt);
    exited = true;
    lastRecordedAt = updatedAt;
  }
  if (evidence.cleanup === 'released' && !cleanupReleased) {
    requireTimestamp(updatedAt, Math.max(launch.registered_at, lastRecordedAt));
    insertInstanceFact(db, 'cleanup', launch, updatedAt);
    cleanupReleased = true;
  }
  return launchFromRow(db, row);
}

export function readWorkerLaunch(db: Database, workerInstanceId: string): WorkerLaunch | null {
  if (typeof workerInstanceId !== 'string' || !isLowercaseUuid(workerInstanceId)) {
    invalid('worker launch instance identity is invalid');
  }
  const row = sqliteGet<IntentRow, [string]>(db, `${INTENT_SELECT} WHERE worker_instance_id=?`, workerInstanceId);
  return row === null ? null : launchFromRow(db, row);
}

/**
 * Authoritative settled/unsettled view for one exact allocation. A fence (not_started)
 * has no intent, so callers must not infer absence from getUnsettledWorkerLaunches().
 */
export function readWorkerLaunchAllocationFacts(
  db: Database, allocation: WorkerLaunchAllocation,
): WorkerLaunchAllocationFacts | null {
  validateAllocationInput(allocation);
  const intent = sqliteGet<IntentRow, [string, number, number]>(db,
    `${INTENT_SELECT} WHERE allocation_mutation_id=? AND allocation_worker_slot=? AND allocation_attempt_no=?`,
    allocation.mutation_id, allocation.worker_slot, allocation.attempt_no);
  const launch = intent === null ? null : launchFromRow(db, intent);
  const allocationFacts = sqliteAll<{ readonly kind: string; readonly recorded_at: number },
    [string, number, number]>(db,
    `SELECT kind,recorded_at FROM configuration_worker_launch_facts
     WHERE mutation_id=? AND worker_slot=? AND attempt_no=?`,
    allocation.mutation_id, allocation.worker_slot, allocation.attempt_no);
  const instanceFacts = launch === null
    ? []
    : sqliteAll<{ readonly kind: string; readonly recorded_at: number }, [string]>(db,
      'SELECT kind,recorded_at FROM configuration_worker_launch_facts WHERE worker_instance_id=?',
      launch.identity.worker_instance_id);
  if (launch === null && allocationFacts.length === 0) return null;
  const times = new Map<string, number>();
  for (const fact of [...allocationFacts, ...instanceFacts]) {
    times.set(fact.kind, Math.max(times.get(fact.kind) ?? 0, fact.recorded_at));
  }
  const notStartedAt = times.get('not_started') ?? null;
  const exitedAt = times.get('exited') ?? null;
  const cleanupReleasedAt = times.get('cleanup') ?? null;
  const settled = notStartedAt !== null ||
    (exitedAt !== null && cleanupReleasedAt !== null) ||
    candidateEvidenceSettled(db, allocation);
  return Object.freeze({
    allocation: Object.freeze({ ...allocation }),
    launch,
    reserved_at: times.get('reserved') ?? null,
    not_started_at: notStartedAt,
    admitted_at: times.get('admitted') ?? null,
    exited_at: exitedAt,
    cleanup_released_at: cleanupReleasedAt,
    settled,
  });
}

function launchSettled(db: Database, launch: WorkerLaunch): boolean {
  return launch.not_started || (launch.exited && launch.cleanup_released) ||
    (launch.allocation !== null && candidateEvidenceSettled(db, launch.allocation));
}

/**
 * Old attempts must not be replaced while their launch has no exit+cleanup proof.
 * Attempts without a reservation belong to the pre-ledger schema and are not blocked.
 */
export function assertWorkerAttemptLaunchSettled(
  db: Database, mutationId: string, workerSlot: number, attemptNo: number,
): void {
  if (attemptNo <= 0) return;
  const allocation = { mutation_id: mutationId, worker_slot: workerSlot, attempt_no: attemptNo };
  if (!hasFact(db, 'reserved', allocation)) return;
  if (hasFact(db, 'not_started', allocation)) return;
  const row = sqliteGet<IntentRow, [string, number, number]>(db,
    `${INTENT_SELECT} WHERE allocation_mutation_id=? AND allocation_worker_slot=? AND allocation_attempt_no=?`,
    mutationId, workerSlot, attemptNo);
  if (row !== null && launchSettled(db, launchFromRow(db, row))) return;
  if (row === null && candidateEvidenceSettled(db, allocation)) return;
  invalidOperation('previous worker launch attempt has no exit and cleanup proof');
}

/**
 * A degraded terminal may release its owner only when every launch of this publication is
 * either admitted (retirement owns it) or proven not started / exited+cleaned.
 */
export function assertPublicationLaunchDebtSettled(db: Database, mutationId: string): void {
  const allocations = sqliteAll<ReservationRow, [string]>(db,
    `SELECT mutation_id,worker_slot,attempt_no,recorded_at FROM configuration_worker_launch_facts
     WHERE kind='reserved' AND mutation_id=? ORDER BY worker_slot,attempt_no`, mutationId);
  const seen = new Set<string>();
  for (const reservation of allocations) {
    const allocation: WorkerLaunchAllocation = {
      mutation_id: reservation.mutation_id,
      worker_slot: reservation.worker_slot,
      attempt_no: reservation.attempt_no,
    };
    seen.add(allocationKey(allocation));
    if (hasFact(db, 'not_started', allocation)) continue;
    const row = sqliteGet<IntentRow, [string, number, number]>(db,
      `${INTENT_SELECT} WHERE allocation_mutation_id=? AND allocation_worker_slot=? AND allocation_attempt_no=?`,
      mutationId, reservation.worker_slot, reservation.attempt_no);
    if (row === null) {
      invalidOperation('unregistered worker launch blocks degraded finalization');
    }
    const launch = launchFromRow(db, row);
    if (launch.admitted || launchSettled(db, launch)) continue;
    invalidOperation('unsettled worker launch blocks degraded finalization');
  }
  const unallocated = sqliteAll<IntentRow, [string]>(db,
    `${INTENT_SELECT} WHERE allocation_mutation_id=?`, mutationId);
  for (const row of unallocated) {
    const allocation = rowAllocation(row);
    if (allocation === null || seen.has(allocationKey(allocation))) continue;
    const launch = launchFromRow(db, row);
    if (launch.admitted || launchSettled(db, launch)) continue;
    invalidOperation('unsettled worker launch blocks degraded finalization');
  }
}

/**
 * Authoritative global inventory of launches without actual settlement proof. It includes
 * admitted launches: historical admission is not proof that a process is still a fresh signed
 * serving member, and a publication-less currentStartup has no owner or retirement to pay it.
 * An empty result is not proof for a specific allocation; use
 * readWorkerLaunchAllocationFacts for that exact allocation.
 */
export function readWorkerLaunchInventory(db: Database): readonly UnsettledWorkerLaunch[] {
  const result: UnsettledWorkerLaunch[] = [];
  const handled = new Set<string>();
  const reservations = sqliteAll<ReservationRow, []>(db,
    `SELECT mutation_id,worker_slot,attempt_no,recorded_at FROM configuration_worker_launch_facts
     WHERE kind='reserved' ORDER BY mutation_id,worker_slot,attempt_no`);
  for (const reservation of reservations) {
    const allocation: WorkerLaunchAllocation = {
      mutation_id: reservation.mutation_id,
      worker_slot: reservation.worker_slot,
      attempt_no: reservation.attempt_no,
    };
    const key = allocationKey(allocation);
    const row = sqliteGet<IntentRow, [string, number, number]>(db,
      `${INTENT_SELECT} WHERE allocation_mutation_id=? AND allocation_worker_slot=? AND allocation_attempt_no=?`,
      allocation.mutation_id, allocation.worker_slot, allocation.attempt_no);
    if (row !== null) {
      handled.add(key);
      const launch = launchFromRow(db, row);
      if (!launchSettled(db, launch)) result.push({ kind: 'launch', launch });
      continue;
    }
    if (hasFact(db, 'not_started', allocation) || candidateEvidenceSettled(db, allocation)) continue;
    result.push({ kind: 'reservation', allocation });
  }
  const intents = sqliteAll<IntentRow, []>(db, `${INTENT_SELECT} ORDER BY registered_at,worker_instance_id`);
  for (const row of intents) {
    const allocation = rowAllocation(row);
    if (allocation !== null && handled.has(allocationKey(allocation))) continue;
    const launch = launchFromRow(db, row);
    if (!launchSettled(db, launch)) result.push({ kind: 'launch', launch });
  }
  return Object.freeze(result);
}

/**
 * Claim-scoped view that leaves admitted occupancy to the runtime's fresh serving-set check.
 * Use readWorkerLaunchInventory for the complete budget inventory.
 */
export function readUnsettledWorkerLaunches(db: Database): readonly UnsettledWorkerLaunch[] {
  return Object.freeze(readWorkerLaunchInventory(db)
    .filter(item => item.kind === 'reservation' || !item.launch.admitted));
}
