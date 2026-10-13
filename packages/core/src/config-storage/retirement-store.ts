import type { Database } from 'bun:sqlite';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import type { ConfigProcessIdentity, ConfigPublicationIdentity } from '../config-publication/types';
import type { ProcessLifetimeGuardFacts } from '../supervision/process-lifetime-guard';
import { parseProcessLifetimeGuardFacts } from '../supervision/process-lifetime-guard';
import { ConfigRepositoryError } from './repository-types';
import { canonicalJson } from './content-hash';
import { snapshotJsonGraph } from './json-preflight';
import { validateDigest } from './repository-validation';
import { isLowercaseUuid } from './validation';
import { sqliteAll, sqliteGet } from './sqlite-query';

export type RetirementExitState = 'live' | 'confirmed' | 'unknown';
export type RetirementCleanupState = 'success' | 'failed' | 'unknown';
export type RetirementStopReason = 'exit_unknown' | 'cleanup_unknown' | 'release_unknown';
export type PublicationRetirementMember = Readonly<{
  identity: ConfigProcessIdentity;
  boot_nonce: string;
  pid: number;
  private_port: number;
  revision: number;
  content_hash: Sha256Digest;
  plugin_catalog_hash: Sha256Digest;
  publication: ConfigPublicationIdentity | null;
  guard: ProcessLifetimeGuardFacts | null;
  drain_id: string;
  deadline_boot_id: string;
  start_deadline_ns: string | null;
}>;
export type PublicationRetirement = Readonly<{
  mutation_id: string;
  generation: number;
  members: readonly PublicationRetirementMember[];
  state: 'pending' | 'stopped' | 'released';
  reason_code: RetirementStopReason | null;
  evidence: readonly Readonly<{ member_id: string; exit_state: RetirementExitState; cleanup_state: RetirementCleanupState; exit_boot_id: string | null; exit_deadline_ns: string | null; start_boot_id:string|null; start_deadline_ns:string|null }>[];
}>;
export type PublicationRetirementRetry = Readonly<{request_id:string;source_mutation_id:string;target_revision:number;status:'accepted'}>;
export function readPublicationRetirementRetry(db:Database,requestId:string):PublicationRetirementRetry|null {
  if(!isLowercaseUuid(requestId)) invalid('retirement retry identity is invalid');
  const row=sqliteGet<{request_id:string;mutation_id:string;expected_revision:number},[string]>(db,
    'SELECT request_id,mutation_id,expected_revision FROM configuration_retirement_retry_requests WHERE request_id=?',requestId);
  return row ? {request_id:row.request_id,source_mutation_id:row.mutation_id,target_revision:row.expected_revision,status:'accepted'} : null;
}
/** Acceptance and un-stopping the same frozen cleanup are one durable transaction. */
export function requestPublicationRetirementRetry(db:Database,requestId:string,mutationId:string,revision:number,now:number):PublicationRetirementRetry {
  if(!isLowercaseUuid(requestId)||!natural(revision,1)||!natural(now)) invalid('retirement retry request is invalid');
  const existing=readPublicationRetirementRetry(db,requestId);
  if(existing) {
    if(existing.source_mutation_id!==mutationId||existing.target_revision!==revision) throw new ConfigRepositoryError('cas_conflict','retirement retry identity was reused');
    return existing;
  }
  const operation=sqliteGet<{state:string;committed_revision:number},[string]>(db,
    'SELECT state,committed_revision FROM configuration_operations WHERE mutation_id=?',mutationId);
  const retirement=readPublicationRetirement(db,mutationId);
  if(operation?.state!=='draining'||operation.committed_revision!==revision||retirement?.state!=='stopped') invalid('only stopped active draining cleanup may retry');
  db.run('INSERT INTO configuration_retirement_retry_requests(request_id,mutation_id,expected_revision,created_at) VALUES(?,?,?,?)',[requestId,mutationId,revision,now]);
  retryPublicationRetirement(db,mutationId,now);
  return readPublicationRetirementRetry(db,requestId)!;
}
function invalid(message: string): never { throw new ConfigRepositoryError('invalid_operation', message); }
function natural(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function parseMembers(value: unknown): readonly PublicationRetirementMember[] {
  const input = snapshotJsonGraph(value);
  if (!Array.isArray(input)) invalid('retirement members must be an array');
  const seen = new Set<string>();
  const result = input.map((raw): PublicationRetirementMember => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid('retirement member is invalid');
    const item = raw as unknown as PublicationRetirementMember;
    const identity = item.identity;
    if (!identity || !isLowercaseUuid(identity.master_generation) || !isLowercaseUuid(identity.worker_instance_id)
      || !natural(identity.worker_slot) || !isLowercaseUuid(item.boot_nonce) || !natural(item.pid, 1)
      || !natural(item.private_port, 1) || item.private_port > 65_535 || !natural(item.revision, 1)
      || !validateDigest(item.content_hash) || !validateDigest(item.plugin_catalog_hash)
      || !isLowercaseUuid(item.drain_id) || typeof item.deadline_boot_id !== 'string' || !item.deadline_boot_id.length
      || (item.start_deadline_ns!==null && (typeof item.start_deadline_ns !== 'string' || !/^[1-9]\d{0,24}$/.test(item.start_deadline_ns)))) invalid('retirement member identity or deadline is invalid');
    if (seen.has(identity.worker_instance_id)) invalid('retirement members contain duplicate identities');
    seen.add(identity.worker_instance_id);
    if (item.publication !== null && (!item.publication || typeof item.publication.mutation_id !== 'string'
      || !natural(item.publication.attempt_no, 1) || !natural(item.publication.drain_recovery_generation))) invalid('retirement publication attempt is invalid');
    const guard = item.guard === null ? null : parseProcessLifetimeGuardFacts(item.guard);
    if (guard !== null && guard.process_instance_id !== identity.worker_instance_id) invalid('retirement guard belongs to another process');
    return Object.freeze({ ...item, identity: Object.freeze({ ...identity }), guard });
  });
  return Object.freeze(result);
}
export function readPublicationRetirement(db: Database, mutationId: string): PublicationRetirement | null {
  const row = sqliteGet<{ generation: number; members_json: string; state: PublicationRetirement['state']; reason_code: RetirementStopReason | null }, [string]>(db,
    'SELECT generation,members_json,state,reason_code FROM configuration_retirements WHERE mutation_id=?', mutationId);
  if (row === null) return null;
  const members = parseMembers(JSON.parse(row.members_json));
  const evidence = sqliteAll<PublicationRetirement['evidence'][number], [string]>(db,
    'SELECT member_id,exit_state,cleanup_state,exit_boot_id,exit_deadline_ns,start_boot_id,start_deadline_ns FROM configuration_retirement_evidence WHERE mutation_id=? ORDER BY member_id', mutationId);
  if (evidence.length !== members.length || evidence.some(item => !members.some(member => member.identity.worker_instance_id === item.member_id))) {
    throw new ConfigRepositoryError('schema_corrupt', 'retirement evidence does not cover the frozen members');
  }
  return Object.freeze({ mutation_id: mutationId, generation: row.generation, members, state: row.state, reason_code: row.reason_code,
    evidence: Object.freeze(evidence.map(item => Object.freeze(item))) });
}
/** Immutable complete membership is durable before admission can retire any worker. */
export function freezePublicationRetirement(db: Database, mutationId: string, generation: number,
  value: readonly PublicationRetirementMember[], now: number): PublicationRetirement {
  if (!natural(generation) || !natural(now)) invalid('retirement generation or timestamp is invalid');
  const members = parseMembers(value);
  const prior = readPublicationRetirement(db, mutationId);
  if (prior !== null) {
    if (prior.generation !== generation || canonicalJson(prior.members) !== canonicalJson(members)) {
      throw new ConfigRepositoryError('cas_conflict', 'retirement membership is already frozen');
    }
    return prior;
  }
  const operation = sqliteGet<{ state: string; drain_recovery_generation: number }, [string]>(db, 'SELECT state,drain_recovery_generation FROM configuration_operations WHERE mutation_id=?', mutationId);
  if (operation === null || operation.state === 'converged' || operation.state === 'degraded' || operation.drain_recovery_generation !== generation) invalid('retirement must match the active publication generation');
  db.run('INSERT INTO configuration_retirements(mutation_id,generation,members_json,state,updated_at) VALUES(?,?,?,\'pending\',?)',
    [mutationId, generation, canonicalJson(members), now]);
  for (const member of members) db.run(`INSERT INTO configuration_retirement_evidence(mutation_id,member_id,exit_state,cleanup_state,updated_at)
    VALUES(?,?,'unknown','unknown',?)`, [mutationId, member.identity.worker_instance_id, now]);
  return readPublicationRetirement(db, mutationId)!;
}
/** The first C deadline is durable after handoff and before sending a drain command. */
export function freezePublicationRetirementDrainStart(db:Database,mutationId:string,memberId:string,bootId:string,deadlineNs:string,now:number):PublicationRetirement {
  const before=readPublicationRetirement(db,mutationId);
  const member=before?.members.find(item=>item.identity.worker_instance_id===memberId);
  if(!before||!member||member.deadline_boot_id!==bootId||!natural(now)||!(/^[1-9]\d{0,24}$/.test(deadlineNs))) invalid('retirement drain start is invalid');
  const saved=before.evidence.find(item=>item.member_id===memberId)!;
  if(saved.start_deadline_ns!==null) return before;
  const deadline=member.start_deadline_ns??deadlineNs;
  db.run('UPDATE configuration_retirement_evidence SET start_boot_id=?,start_deadline_ns=?,updated_at=? WHERE mutation_id=? AND member_id=?',
    [bootId,deadline,now,mutationId,memberId]);
  return readPublicationRetirement(db,mutationId)!;
}
/** Confirmed exit is irreversible. Cleanup remains an independent observation. */
export function recordPublicationRetirementEvidence(db: Database, mutationId: string, memberId: string,
  exit: RetirementExitState, cleanup: RetirementCleanupState, now: number,
  deadline?: { readonly boot_id: string; readonly exit_deadline_ns: string }): PublicationRetirement {
  if (!['live', 'confirmed', 'unknown'].includes(exit) || !['success', 'failed', 'unknown'].includes(cleanup) || !natural(now)) invalid('retirement evidence is invalid');
  const before = readPublicationRetirement(db, mutationId);
  const evidence = before?.evidence.find(item => item.member_id === memberId);
  if (!before || !evidence) invalid('retirement member is not part of the frozen authority');
  if (deadline !== undefined && (deadline.boot_id !== before.members.find(member => member.identity.worker_instance_id === memberId)!.deadline_boot_id
    || !/^[1-9]\d{0,24}$/.test(deadline.exit_deadline_ns))) invalid('retirement terminal exit deadline is invalid');
  if (evidence.exit_deadline_ns !== null && deadline !== undefined &&
    (evidence.exit_boot_id !== deadline.boot_id || evidence.exit_deadline_ns !== deadline.exit_deadline_ns)) invalid('retirement terminal exit deadline is already frozen');
  if (evidence.cleanup_state !== 'unknown') {
    if (cleanup !== 'unknown' && cleanup !== evidence.cleanup_state) invalid('terminal retirement cleanup cannot be changed');
    cleanup = evidence.cleanup_state;
  }
  if (before.state === 'released') {
    if (evidence.exit_state === exit && evidence.cleanup_state === cleanup) return before;
    throw new ConfigRepositoryError('cas_conflict', 'released retirement is immutable');
  }
  if (evidence.exit_state === 'confirmed' && exit !== 'confirmed') invalid('confirmed retirement exit cannot be revoked');
  db.run('UPDATE configuration_retirement_evidence SET exit_state=?,cleanup_state=?,exit_boot_id=?,exit_deadline_ns=?,updated_at=? WHERE mutation_id=? AND member_id=?',
    [exit, cleanup, evidence.exit_boot_id ?? deadline?.boot_id ?? null, evidence.exit_deadline_ns ?? deadline?.exit_deadline_ns ?? null, now, mutationId, memberId]);
  return readPublicationRetirement(db, mutationId)!;
}
export function stopPublicationRetirement(db: Database, mutationId: string, reason: RetirementStopReason, now: number): PublicationRetirement {
  if (!['exit_unknown', 'cleanup_unknown', 'release_unknown'].includes(reason) || !natural(now)) invalid('retirement stop reason is invalid');
  const before = readPublicationRetirement(db, mutationId);
  if (!before) invalid('retirement is not frozen');
  if (before.state === 'released') return before;
  db.run("UPDATE configuration_retirements SET state='stopped',reason_code=?,updated_at=? WHERE mutation_id=?", [reason, now, mutationId]);
  return readPublicationRetirement(db, mutationId)!;
}
/** Typed retry reuses the same members/deadlines and never begins worker attempts. */
export function retryPublicationRetirement(db: Database, mutationId: string, now: number): PublicationRetirement {
  const before = readPublicationRetirement(db, mutationId);
  if (!before || !natural(now)) invalid('retirement retry is invalid');
  if (before.state === 'released' || before.state === 'pending') return before;
  db.run("UPDATE configuration_retirements SET state='pending',reason_code=NULL,updated_at=? WHERE mutation_id=?", [now, mutationId]);
  return readPublicationRetirement(db, mutationId)!;
}
export function markPublicationRetirementReleased(db: Database, mutationId: string, now: number): PublicationRetirement {
  const before = readPublicationRetirement(db, mutationId);
  if (!before || !natural(now)) invalid('retirement release is invalid');
  if (before.state === 'released') return before;
  if (before.evidence.some(item => item.exit_state !== 'confirmed')) invalid('retirement release requires every durable exit fence');
  db.run("UPDATE configuration_retirements SET state='released',reason_code=NULL,updated_at=? WHERE mutation_id=?", [now, mutationId]);
  return readPublicationRetirement(db, mutationId)!;
}

/** Durable confirmed identities cannot be re-admitted by a later controller. */
export function readRetiredWorkerInstanceIds(db: Database): readonly string[] {
  const rows = sqliteAll<{ member_id: string }, []>(db,
    "SELECT member_id FROM configuration_retirement_evidence WHERE exit_state='confirmed' UNION SELECT value AS member_id FROM configuration_publication_serving_sets,json_each(exited_json) ORDER BY member_id");
  if (rows.some(row => !isLowercaseUuid(row.member_id))) throw new ConfigRepositoryError('schema_corrupt', 'retired process identity is invalid');
  return Object.freeze(rows.map(row => row.member_id));
}

export function readRetirementDescriptorCleanupState(db: Database, workerInstanceId: string): 'absent' | 'pending' | 'terminal' {
  if (!isLowercaseUuid(workerInstanceId)) invalid('retirement descriptor identity is invalid');
  const rows = sqliteAll<{ state: string }, [string]>(db, `SELECT o.state FROM configuration_retirement_evidence e
    JOIN configuration_operations o USING(mutation_id) WHERE e.member_id=?`, workerInstanceId);
  if (!rows.length) return 'absent';
  return rows.every(row => row.state === 'converged' || row.state === 'degraded') ? 'terminal' : 'pending';
}

export type PublicationServingMember = Omit<PublicationRetirementMember, 'drain_id' | 'deadline_boot_id' | 'start_deadline_ns'> & { readonly kernel_boot_id: string };
export type PublicationServingSet = Readonly<{ mutation_id: string; generation: number; attempt_key: string;
  workers: readonly PublicationServingMember[]; exited: readonly string[] }>;
function parseServingMembers(value: unknown): readonly PublicationServingMember[] {
  const input = snapshotJsonGraph(value);
  if (!Array.isArray(input)) invalid('publication serving members are invalid');
  const identities = new Set<string>();
  return Object.freeze(input.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid('publication serving member is invalid');
    const item = raw as unknown as PublicationServingMember;
    const identity = item.identity;
    if (!identity || !isLowercaseUuid(identity.master_generation) || !isLowercaseUuid(identity.worker_instance_id)
      || !natural(identity.worker_slot) || !isLowercaseUuid(item.boot_nonce) || !natural(item.pid, 1)
      || !natural(item.private_port, 1) || item.private_port > 65_535 || !natural(item.revision, 1)
      || !validateDigest(item.content_hash) || !validateDigest(item.plugin_catalog_hash)
      || item.publication === null || !item.publication || typeof item.publication.mutation_id !== 'string'
      || !natural(item.publication.attempt_no, 1) || !natural(item.publication.drain_recovery_generation)
      || typeof item.kernel_boot_id !== 'string' || !item.kernel_boot_id.length || identities.has(identity.worker_instance_id)) invalid('publication serving member identity or attempt is invalid');
    identities.add(identity.worker_instance_id);
    const guard = item.guard === null ? null : parseProcessLifetimeGuardFacts(item.guard);
    if (guard !== null && guard.process_instance_id !== identity.worker_instance_id) invalid('publication serving guard identity is invalid');
    return Object.freeze({ ...item, identity: Object.freeze({ ...identity }), guard });
  }));
}
export function readPublicationServingSet(db: Database, mutationId: string, generation: number): PublicationServingSet | null {
  if (!natural(generation)) invalid('publication serving generation is invalid');
  const attemptKey = currentServingAttemptKey(db, mutationId);
  const row = sqliteGet<{ workers_json: string; exited_json: string }, [string, number, string]>(db,
    'SELECT workers_json,exited_json FROM configuration_publication_serving_sets WHERE mutation_id=? AND generation=? AND attempt_key=?', mutationId, generation, attemptKey);
  if (row === null) return null;
  const workers = parseServingMembers(JSON.parse(row.workers_json));
  if (canonicalJson(workers.map(worker => [worker.identity.worker_slot, worker.publication!.attempt_no]).sort((a, b) => a[0]! - b[0]!)) !== attemptKey
    || workers.some(worker => worker.publication!.mutation_id !== mutationId || worker.publication!.drain_recovery_generation !== generation)) {
    throw new ConfigRepositoryError('schema_corrupt', 'publication serving attempt identity is invalid');
  }
  const exited: unknown = JSON.parse(row.exited_json);
  if (!Array.isArray(exited) || new Set(exited).size !== exited.length
    || exited.some(id => typeof id !== 'string' || !workers.some(worker => worker.identity.worker_instance_id === id))) {
    throw new ConfigRepositoryError('schema_corrupt', 'publication serving exit fence is invalid');
  }
  return Object.freeze({ mutation_id: mutationId, generation, attempt_key: attemptKey, workers, exited: Object.freeze(exited as string[]) });
}
function currentServingAttemptKey(db: Database, mutationId: string): string {
  const targets = sqliteAll<{ worker_slot: number; attempt_no: number }, [string]>(db,
    'SELECT worker_slot,attempt_no FROM configuration_operation_workers WHERE mutation_id=? ORDER BY worker_slot', mutationId);
  return canonicalJson(targets.map(target => [target.worker_slot, target.attempt_no]));
}
/** Any next attempt must preserve and retire every previously frozen authority. */
export function assertPublicationServingAttemptsExited(db: Database, mutationId: string): void {
  const history = sqliteAll<{ workers_json: string; exited_json: string }, [string]>(db,
    'SELECT workers_json,exited_json FROM configuration_publication_serving_sets WHERE mutation_id=?', mutationId);
  for (const prior of history) {
    const exited: unknown = JSON.parse(prior.exited_json);
    const workers = parseServingMembers(JSON.parse(prior.workers_json));
    if (!Array.isArray(exited) || exited.some(id => typeof id !== 'string' || !workers.some(worker => worker.identity.worker_instance_id === id))) {
      throw new ConfigRepositoryError('schema_corrupt', 'publication serving exit fence is invalid');
    }
    if (workers.some(worker => !exited.includes(worker.identity.worker_instance_id))) {
      invalid('a prior serving attempt has no complete durable exit fence');
    }
  }
}
export function freezePublicationServingSet(db: Database, mutationId: string, generation: number,
  input: readonly PublicationServingMember[]): PublicationServingSet {
  const workers = parseServingMembers(input);
  const before = readPublicationServingSet(db, mutationId, generation);
  if (before !== null) {
    if (canonicalJson(before.workers) !== canonicalJson(workers)) throw new ConfigRepositoryError('cas_conflict', 'publication serving members are already frozen');
    return before;
  }
  const operation = sqliteGet<{ state: string; committed_revision: number; target_worker_count: number; drain_recovery_generation: number }, [string]>(db,
    'SELECT state,committed_revision,target_worker_count,drain_recovery_generation FROM configuration_operations WHERE mutation_id=?', mutationId);
  if (!operation || operation.state === 'converged' || operation.state === 'degraded' || operation.drain_recovery_generation !== generation
    || workers.length !== operation.target_worker_count || workers.some(worker => worker.revision !== operation.committed_revision
      || worker.publication?.mutation_id !== mutationId || worker.publication.drain_recovery_generation !== generation)) invalid('publication serving authority does not match the current attempt');
  const attemptKey = currentServingAttemptKey(db, mutationId);
  if (canonicalJson(workers.map(worker => [worker.identity.worker_slot, worker.publication!.attempt_no]).sort((a, b) => a[0]! - b[0]!)) !== attemptKey) {
    invalid('publication serving authority does not cover every target attempt');
  }
  for (const worker of workers) {
    const target = sqliteGet<{ attempt_no: number; state: string }, [string, number]>(db,
      'SELECT attempt_no,state FROM configuration_operation_workers WHERE mutation_id=? AND worker_slot=?', mutationId, worker.identity.worker_slot);
    if (target === null || target.state !== 'converged' || target.attempt_no !== worker.publication?.attempt_no) invalid('publication serving attempt is not converged');
  }
  assertPublicationServingAttemptsExited(db, mutationId);
  db.run('INSERT INTO configuration_publication_serving_sets(mutation_id,generation,attempt_key,workers_json,exited_json) VALUES(?,?,?,?,\'[]\')',
    [mutationId, generation, attemptKey, canonicalJson(workers)]);
  return readPublicationServingSet(db, mutationId, generation)!;
}
export function confirmPublicationServingMemberExit(db: Database, mutationId: string, generation: number, workerInstanceId: string): PublicationServingSet {
  const before = readPublicationServingSet(db, mutationId, generation);
  if (!before || !before.workers.some(worker => worker.identity.worker_instance_id === workerInstanceId)) invalid('publication serving member is outside durable authority');
  if (before.exited.includes(workerInstanceId)) return before;
  db.run('UPDATE configuration_publication_serving_sets SET exited_json=? WHERE mutation_id=? AND generation=? AND attempt_key=?',
    [canonicalJson([...before.exited, workerInstanceId].sort()), mutationId, generation, before.attempt_key]);
  return readPublicationServingSet(db, mutationId, generation)!;
}
