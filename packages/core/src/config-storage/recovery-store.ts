import type { Database } from 'bun:sqlite';
import type {
  ConfigurationRecovery,
  ConfigurationRecoveryReasonCode,
} from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { requireSafeInteger } from './persisted-validation';
import { sqliteAll, sqliteGet } from './sqlite-query';
import { isLowercaseUuid } from './validation';

export const RECOVERY_MAX_ATTEMPTS = 6 as const;
const RECOVERY_INITIAL_DELAY_MS = 250;

const REASON_CODES = [
  'target_serving', 'already_serving', 'deterministic_worker_rejection',
  'deterministic_protocol_failure', 'deterministic_control_failure',
  'retry_exhausted', 'revision_superseded', 'safety_outcome_unknown', 'fatal_source_failure',
] as const satisfies readonly ConfigurationRecoveryReasonCode[];

type RecoveryRow = {
  readonly recovery_sequence: unknown;
  readonly recovery_id: unknown;
  readonly source_mutation_id: unknown;
  readonly target_revision: unknown;
  readonly trigger: unknown;
  readonly state: unknown;
  readonly attempt_count: unknown;
  readonly max_attempts: unknown;
  readonly next_retry_at: unknown;
  readonly final_reason_code: unknown;
  readonly final_reason_detail: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
};

const RECOVERY_SELECT = `SELECT recovery_sequence,recovery_id,source_mutation_id,target_revision,trigger,state,
  attempt_count,max_attempts,next_retry_at,final_reason_code,final_reason_detail,created_at,updated_at
  FROM configuration_recoveries`;

function invalid(message: string): never {
  throw new ConfigRepositoryError('invalid_operation', message);
}

function corrupt(message: string): never {
  throw new ConfigRepositoryError('schema_corrupt', message);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') corrupt(`configuration_recoveries.${field} is invalid`);
  return value;
}

function nullableStringValue(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') corrupt(`configuration_recoveries.${field} is invalid`);
  return value;
}

function reasonCode(value: unknown): ConfigurationRecoveryReasonCode | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !(REASON_CODES as readonly string[]).includes(value)) {
    corrupt('configuration_recoveries.final_reason_code is invalid');
  }
  return value as ConfigurationRecoveryReasonCode;
}

function validateTerminalMatrix(
  state: 'succeeded' | 'stopped', attemptCount: number, finalReasonCode: ConfigurationRecoveryReasonCode | null,
  fail: (message: string) => never,
): void {
  if (finalReasonCode === null || !(REASON_CODES as readonly string[]).includes(finalReasonCode)) {
    fail('terminal recovery reason is invalid');
  }
  if (state === 'succeeded') {
    if ((finalReasonCode === 'already_serving' && attemptCount !== 0) ||
        (finalReasonCode === 'target_serving' && attemptCount < 1) ||
        (finalReasonCode !== 'already_serving' && finalReasonCode !== 'target_serving')) {
      fail('successful recovery reason is invalid');
    }
    return;
  }
  if (finalReasonCode === 'target_serving' || finalReasonCode === 'already_serving' ||
      (finalReasonCode === 'retry_exhausted' && attemptCount !== RECOVERY_MAX_ATTEMPTS) ||
      (finalReasonCode === 'safety_outcome_unknown' && attemptCount < 1)) {
    fail('stopped recovery reason is invalid');
  }
}

function recoveryFromRow(row: RecoveryRow): ConfigurationRecovery {
  if (typeof row.recovery_sequence !== 'number') corrupt('configuration_recoveries.recovery_sequence is invalid');
  requireSafeInteger(row.recovery_sequence, 'configuration_recoveries.recovery_sequence', 1);
  const recoveryId = stringValue(row.recovery_id, 'recovery_id');
  const sourceMutationId = stringValue(row.source_mutation_id, 'source_mutation_id');
  if (!isLowercaseUuid(recoveryId) || sourceMutationId.length < 1 || sourceMutationId.length > 128) {
    corrupt('configuration_recoveries identifier bounds are invalid');
  }
  const targetRevision = typeof row.target_revision === 'number'
    ? requireSafeInteger(row.target_revision, 'configuration_recoveries.target_revision', 1) : corrupt('configuration_recoveries.target_revision is invalid');
  const trigger = stringValue(row.trigger, 'trigger');
  if (trigger !== 'automatic' && trigger !== 'manual') corrupt('configuration_recoveries.trigger is invalid');
  const state = stringValue(row.state, 'state');
  if (state !== 'scheduled' && state !== 'running' && state !== 'succeeded' && state !== 'stopped') {
    corrupt('configuration_recoveries.state is invalid');
  }
  const attemptCount = typeof row.attempt_count === 'number'
    ? requireSafeInteger(row.attempt_count, 'configuration_recoveries.attempt_count') : corrupt('configuration_recoveries.attempt_count is invalid');
  const maxAttempts = typeof row.max_attempts === 'number'
    ? requireSafeInteger(row.max_attempts, 'configuration_recoveries.max_attempts') : corrupt('configuration_recoveries.max_attempts is invalid');
  if (maxAttempts !== RECOVERY_MAX_ATTEMPTS || attemptCount > maxAttempts) {
    corrupt('configuration_recoveries attempt bounds are invalid');
  }
  const nextRetryAt = row.next_retry_at === null ? null
    : typeof row.next_retry_at === 'number'
      ? requireSafeInteger(row.next_retry_at, 'configuration_recoveries.next_retry_at')
      : corrupt('configuration_recoveries.next_retry_at is invalid');
  const finalReasonCode = reasonCode(row.final_reason_code);
  const finalReasonDetail = nullableStringValue(row.final_reason_detail, 'final_reason_detail');
  if (finalReasonDetail !== null && (finalReasonDetail.length > 512 || finalReasonDetail.trim().length === 0)) {
    corrupt('configuration_recoveries.final_reason_detail is invalid');
  }
  const createdAt = typeof row.created_at === 'number'
    ? requireSafeInteger(row.created_at, 'configuration_recoveries.created_at') : corrupt('configuration_recoveries.created_at is invalid');
  const updatedAt = typeof row.updated_at === 'number'
    ? requireSafeInteger(row.updated_at, 'configuration_recoveries.updated_at', createdAt) : corrupt('configuration_recoveries.updated_at is invalid');
  if ((state === 'scheduled' || state === 'running') && (finalReasonCode !== null || finalReasonDetail !== null)) {
    corrupt('active recovery has a final reason');
  }
  if (state === 'running' && (nextRetryAt !== null || attemptCount < 1)) corrupt('running recovery fields are invalid');
  if (state === 'scheduled' && attemptCount >= RECOVERY_MAX_ATTEMPTS) corrupt('scheduled recovery attempt limit is invalid');
  if (state === 'scheduled' && nextRetryAt !== null && nextRetryAt <= updatedAt) {
    corrupt('scheduled recovery retry time is not in the future');
  }
  if ((state === 'succeeded' || state === 'stopped') && (finalReasonCode === null || nextRetryAt !== null)) {
    corrupt('terminal recovery fields are invalid');
  }
  if (state === 'succeeded' || state === 'stopped') validateTerminalMatrix(state, attemptCount, finalReasonCode, corrupt);
  return {
    recovery_id: recoveryId,
    source_mutation_id: sourceMutationId,
    target_revision: targetRevision,
    trigger: trigger as ConfigurationRecovery['trigger'],
    state: state as ConfigurationRecovery['state'],
    attempt_count: attemptCount,
    max_attempts: RECOVERY_MAX_ATTEMPTS,
    next_retry_at: nextRetryAt,
    final_reason_code: finalReasonCode,
    final_reason_detail: finalReasonDetail,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function readRecovery(db: Database, recoveryId: string): ConfigurationRecovery | null {
  const row = sqliteGet<RecoveryRow, [string]>(db, `${RECOVERY_SELECT} WHERE recovery_id=?`, recoveryId);
  return row === null ? null : recoveryFromRow(row);
}

function readRecoveryRows(db: Database, sql: string, ...params: (string | number)[]): ConfigurationRecovery[] {
  return sqliteAll<RecoveryRow, (string | number)[]>(db, sql, ...params).map(recoveryFromRow);
}

export function readLatestRecovery(db: Database, targetRevision: number): ConfigurationRecovery | null {
  return readRecoveryRows(db, `${RECOVERY_SELECT} WHERE target_revision=?
    ORDER BY recovery_sequence DESC LIMIT 1`, targetRevision)[0] ?? null;
}

export function readCurrentRecovery(db: Database, targetRevision: number): ConfigurationRecovery | null {
  return readRecoveryRows(db, `${RECOVERY_SELECT} WHERE target_revision=?
    ORDER BY CASE WHEN state IN ('scheduled','running') THEN 0 ELSE 1 END,
      recovery_sequence DESC LIMIT 1`, targetRevision)[0] ?? null;
}

export function readActiveRecovery(db: Database, targetRevision: number): ConfigurationRecovery | null {
  return readRecoveryRows(db, `${RECOVERY_SELECT} WHERE target_revision=? AND state IN ('scheduled','running')
    ORDER BY recovery_sequence DESC LIMIT 1`, targetRevision)[0] ?? null;
}

function requireRecoveryId(recoveryId: string): void {
  if (typeof recoveryId !== 'string' || !isLowercaseUuid(recoveryId)) {
    invalid('recovery_id is invalid');
  }
}

function requireNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) invalid('recovery timestamp is invalid');
}

function initialRetryAt(trigger: ConfigurationRecovery['trigger'], now: number): number | null {
  if (trigger === 'manual') return null;
  if (now > Number.MAX_SAFE_INTEGER - RECOVERY_INITIAL_DELAY_MS) invalid('automatic recovery retry timestamp would overflow');
  return now + RECOVERY_INITIAL_DELAY_MS;
}

function requireAttempt(attemptCount: number): void {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0 || attemptCount > RECOVERY_MAX_ATTEMPTS) {
    invalid('recovery attempt count is invalid');
  }
}

function requireDetail(detail: string | null): void {
  if (detail !== null && (detail.length > 512 || detail.trim().length === 0)) invalid('recovery reason detail is invalid');
}

function requireReasonCompatible(db: Database, recovery: ConfigurationRecovery, reason: ConfigurationRecoveryReasonCode): void {
  if (reason !== 'deterministic_worker_rejection' && reason !== 'deterministic_protocol_failure' &&
      reason !== 'deterministic_control_failure' && reason !== 'fatal_source_failure') return;
  const source = sqliteGet<{ readonly error_code: string | null }, [string]>(db,
    'SELECT error_code FROM configuration_operations WHERE mutation_id=?', recovery.source_mutation_id);
  const compatible = reason === 'deterministic_control_failure'
    ? source?.error_code === 'control_readiness_failed'
    : source?.error_code === 'replacement_convergence_failed';
  if (!compatible) throw new ConfigRepositoryError('source_not_retryable', 'recovery reason is incompatible with its source operation');
}

function requireRevisionDrift(db: Database, recovery: ConfigurationRecovery): void {
  const currentRevision = sqliteGet<{ readonly active_revision: number }, []>(db,
    'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
  if (currentRevision === undefined || currentRevision <= recovery.target_revision) invalid('revision has not been superseded');
}

function requireTimestamp(now: number, recovery: ConfigurationRecovery): void {
  requireNow(now);
  if (now < recovery.updated_at) invalid('recovery timestamp regressed');
}

function sameIdentity(recovery: ConfigurationRecovery, trigger: ConfigurationRecovery['trigger'], sourceMutationId: string, targetRevision: number): boolean {
  return recovery.trigger === trigger && recovery.source_mutation_id === sourceMutationId && recovery.target_revision === targetRevision;
}

function requireCurrentTarget(db: Database, recovery: ConfigurationRecovery): void {
  const currentRevision = sqliteGet<{ readonly active_revision: number }, []>(db,
    'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
  if (currentRevision !== recovery.target_revision) {
    throw new ConfigRepositoryError('stale_revision', 'recovery target revision is no longer active');
  }
}

function requireSource(db: Database, sourceMutationId: string): { readonly committed_revision: number } {
  const source = sqliteGet<{ readonly state: string; readonly error_code: string | null; readonly committed_revision: number }, [string]>(
    db, 'SELECT state,error_code,committed_revision FROM configuration_operations WHERE mutation_id=?', sourceMutationId,
  );
  if (source === null || source.state !== 'degraded' ||
      (source.error_code !== 'replacement_convergence_failed' && source.error_code !== 'control_readiness_failed')) {
    throw new ConfigRepositoryError('source_not_retryable', 'recovery source operation is not retryable');
  }
  return source;
}

function requireNoActivePublication(db: Database): void {
  const active = sqliteGet<{ readonly count: number }, []>(db,
    `SELECT count(*) AS count FROM configuration_operations WHERE state IN ('committed','publishing','draining')`)?.count ?? 0;
  if (active !== 0) invalid('an active publication already exists');
}

function insertRecovery(
  db: Database,
  recoveryId: string,
  sourceMutationId: string,
  targetRevision: number,
  trigger: ConfigurationRecovery['trigger'],
  now: number,
  initial: {
    readonly state: 'scheduled' | 'stopped';
    readonly final_reason_code: ConfigurationRecoveryReasonCode | null;
    readonly final_reason_detail: string | null;
  } = { state: 'scheduled', final_reason_code: null, final_reason_detail: null },
): ConfigurationRecovery {
  requireRecoveryId(recoveryId);
  requireNow(now);
  const existing = readRecovery(db, recoveryId);
  if (existing !== null) {
    if (!sameIdentity(existing, trigger, sourceMutationId, targetRevision)) {
      throw new ConfigRepositoryError('idempotency_key_reused', 'recovery request_id was reused with a different payload');
    }
    return existing;
  }
  const active = readActiveRecovery(db, targetRevision);
  if (active !== null) {
    throw new ConfigRepositoryError('recovery_in_progress', 'target revision already has an active recovery', undefined, active);
  }
  const latest = readLatestRecovery(db, targetRevision);
  if (latest !== null && now < latest.updated_at) invalid('recovery timestamp regressed');
  const latestCreatedAt = sqliteGet<{ readonly created_at: number | null }, []>(db,
    'SELECT max(created_at) AS created_at FROM configuration_recoveries')?.created_at;
  if (latestCreatedAt !== null && latestCreatedAt !== undefined && now < latestCreatedAt) {
    invalid('recovery creation timestamp regressed');
  }
  const nextRetryAt = initial.state === 'scheduled' ? initialRetryAt(trigger, now) : null;
  if (initial.state === 'stopped' && (initial.final_reason_code === null
    || initial.final_reason_code === 'target_serving' || initial.final_reason_code === 'already_serving'
    || initial.final_reason_code === 'retry_exhausted' || initial.final_reason_code === 'revision_superseded'
    || initial.final_reason_code === 'safety_outcome_unknown')) {
    invalid('initial stopped recovery reason is invalid');
  }
  if (initial.final_reason_detail !== null) requireDetail(initial.final_reason_detail);
  db.run(`INSERT INTO configuration_recoveries
    (recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,
     next_retry_at,final_reason_code,final_reason_detail,created_at,updated_at)
    VALUES (?,?,?, ?,?,0,6,?,?,?,?,?)`,
  [recoveryId, sourceMutationId, targetRevision, trigger, initial.state, nextRetryAt,
    initial.final_reason_code, initial.final_reason_detail, now, now]);
  const created = readRecovery(db, recoveryId);
  if (created === null) throw new ConfigRepositoryError('repository_failure', 'recovery creation failed');
  return created;
}

export function createAutomaticRecovery(
  db: Database, recoveryId: string, sourceMutationId: string, targetRevision: number, now: number,
): ConfigurationRecovery {
  return insertRecovery(db, recoveryId, sourceMutationId, targetRevision, 'automatic', now);
}

export function createStoppedRecovery(
  db: Database, recoveryId: string, sourceMutationId: string, targetRevision: number,
  reasonCode: Extract<ConfigurationRecoveryReasonCode,
    'deterministic_worker_rejection' | 'deterministic_protocol_failure' | 'deterministic_control_failure' | 'fatal_source_failure'>,
  reasonDetail: string | null, now: number,
): ConfigurationRecovery {
  return insertRecovery(db, recoveryId, sourceMutationId, targetRevision, 'automatic', now,
    { state: 'stopped', final_reason_code: reasonCode, final_reason_detail: reasonDetail });
}

export function createManualRecovery(
  db: Database, recoveryId: string, sourceMutationId: string, expectedRevision: number, now: number,
): ConfigurationRecovery {
  requireRecoveryId(recoveryId);
  const existing = readRecovery(db, recoveryId);
  if (existing !== null) {
    if (!sameIdentity(existing, 'manual', sourceMutationId, expectedRevision)) {
      throw new ConfigRepositoryError('idempotency_key_reused', 'recovery request_id was reused with a different payload');
    }
    return existing;
  }
  const currentRevision = sqliteGet<{ readonly active_revision: number }, []>(db,
    'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
  if (currentRevision !== expectedRevision) throw new ConfigRepositoryError('stale_revision', 'recovery expected revision is stale');
  const source = requireSource(db, sourceMutationId);
  if (source.committed_revision !== expectedRevision) {
    throw new ConfigRepositoryError('source_not_retryable', 'recovery source operation is not retryable');
  }
  requireNoActivePublication(db);
  return insertRecovery(db, recoveryId, sourceMutationId, expectedRevision, 'manual', now);
}

export function claimRecoveryAttempt(
  db: Database, recoveryId: string, previousAttemptCount: number, now: number,
): ConfigurationRecovery {
  const recovery = readRecovery(db, recoveryId);
  if (recovery === null) invalid('recovery was not found');
  requireCurrentTarget(db, recovery);
  requireAttempt(previousAttemptCount);
  requireNow(now);
  if (recovery.state === 'running' && recovery.attempt_count === previousAttemptCount + 1) return recovery;
  if (recovery.state !== 'scheduled' || recovery.attempt_count !== previousAttemptCount) {
    throw new ConfigRepositoryError('cas_conflict', 'recovery claim CAS failed');
  }
  requireTimestamp(now, recovery);
  if (previousAttemptCount >= recovery.max_attempts) {
    throw new ConfigRepositoryError('attempts_exhausted', 'recovery attempt limit reached');
  }
  if (recovery.next_retry_at !== null && now < recovery.next_retry_at) {
    throw new ConfigRepositoryError('retry_not_due', 'recovery retry is not due');
  }
  const result = db.run(`UPDATE configuration_recoveries SET attempt_count=attempt_count+1,
    state='running',next_retry_at=NULL,updated_at=?
    WHERE recovery_id=? AND state='scheduled' AND attempt_count=?`, [now, recoveryId, previousAttemptCount]);
  if (result.changes !== 1) throw new ConfigRepositoryError('cas_conflict', 'recovery claim CAS failed');
  const claimed = readRecovery(db, recoveryId);
  if (claimed === null) throw new ConfigRepositoryError('repository_failure', 'recovery claim failed');
  return claimed;
}

export function scheduleRecoveryRetry(
  db: Database, recoveryId: string, attemptCount: number, nextRetryAt: number, now: number,
): ConfigurationRecovery {
  const recovery = readRecovery(db, recoveryId);
  if (recovery === null) invalid('recovery was not found');
  requireCurrentTarget(db, recovery);
  requireAttempt(attemptCount);
  requireNow(nextRetryAt);
  if (recovery.state === 'scheduled' && recovery.attempt_count === attemptCount && recovery.next_retry_at === nextRetryAt) return recovery;
  if (recovery.state !== 'running' || recovery.attempt_count !== attemptCount) throw new ConfigRepositoryError('cas_conflict', 'recovery retry CAS failed');
  requireTimestamp(now, recovery);
  if (attemptCount >= recovery.max_attempts) {
    throw new ConfigRepositoryError('attempts_exhausted', 'recovery attempt limit reached');
  }
  if (nextRetryAt <= now) invalid('next retry time must be in the future');
  const result = db.run(`UPDATE configuration_recoveries SET state='scheduled',next_retry_at=?,updated_at=?
    WHERE recovery_id=? AND state='running' AND attempt_count=?`, [nextRetryAt, now, recoveryId, attemptCount]);
  if (result.changes !== 1) throw new ConfigRepositoryError('cas_conflict', 'recovery retry CAS failed');
  const scheduled = readRecovery(db, recoveryId);
  if (scheduled === null) throw new ConfigRepositoryError('repository_failure', 'recovery retry scheduling failed');
  return scheduled;
}

function terminalTransition(
  db: Database,
  recoveryId: string,
  attemptCount: number,
  state: 'succeeded' | 'stopped',
  finalReasonCode: ConfigurationRecoveryReasonCode,
  finalReasonDetail: string | null,
  now: number,
): ConfigurationRecovery {
  const recovery = readRecovery(db, recoveryId);
  if (recovery === null) invalid('recovery was not found');
  requireAttempt(attemptCount);
  validateTerminalMatrix(state, attemptCount, finalReasonCode, invalid);
  requireDetail(finalReasonDetail);
  if (recovery.state === state && recovery.attempt_count === attemptCount &&
      recovery.final_reason_code === finalReasonCode && recovery.final_reason_detail === finalReasonDetail) return recovery;
  if ((state === 'succeeded' && recovery.state !== 'running' && recovery.state !== 'scheduled') ||
      (state === 'stopped' && recovery.state !== 'running' && recovery.state !== 'scheduled') ||
      recovery.attempt_count !== attemptCount) throw new ConfigRepositoryError('cas_conflict', 'recovery terminal transition CAS failed');
  if (state === 'succeeded') requireCurrentTarget(db, recovery);
  if (state === 'stopped' && finalReasonCode === 'revision_superseded') requireRevisionDrift(db, recovery);
  requireReasonCompatible(db, recovery, finalReasonCode);
  requireTimestamp(now, recovery);
  const result = db.run(`UPDATE configuration_recoveries SET state=?,next_retry_at=NULL,
    final_reason_code=?,final_reason_detail=?,updated_at=?
    WHERE recovery_id=? AND state IN ('scheduled','running') AND attempt_count=?`,
  [state, finalReasonCode, finalReasonDetail, now, recoveryId, attemptCount]);
  if (result.changes !== 1) throw new ConfigRepositoryError('cas_conflict', 'recovery terminal transition CAS failed');
  const terminal = readRecovery(db, recoveryId);
  if (terminal === null) throw new ConfigRepositoryError('repository_failure', 'recovery terminal transition failed');
  return terminal;
}

export function succeedRecovery(
  db: Database, recoveryId: string, attemptCount: number,
  finalReasonCode: ConfigurationRecoveryReasonCode, finalReasonDetail: string | null, now: number,
): ConfigurationRecovery {
  return terminalTransition(db, recoveryId, attemptCount, 'succeeded', finalReasonCode, finalReasonDetail, now);
}

export function stopRecovery(
  db: Database, recoveryId: string, attemptCount: number,
  finalReasonCode: ConfigurationRecoveryReasonCode, finalReasonDetail: string | null, now: number,
): ConfigurationRecovery {
  return terminalTransition(db, recoveryId, attemptCount, 'stopped', finalReasonCode, finalReasonDetail, now);
}

export function requeueRecovery(
  db: Database, recoveryId: string, attemptCount: number, now: number,
): ConfigurationRecovery {
  const recovery = readRecovery(db, recoveryId);
  if (recovery === null) invalid('recovery was not found');
  requireCurrentTarget(db, recovery);
  requireAttempt(attemptCount);
  requireNow(now);
  if (attemptCount >= recovery.max_attempts) {
    throw new ConfigRepositoryError('attempts_exhausted', 'recovery attempt limit reached');
  }
  if (recovery.state === 'scheduled' && recovery.attempt_count === attemptCount && recovery.next_retry_at === null) return recovery;
  if (recovery.state !== 'running' || recovery.attempt_count !== attemptCount) throw new ConfigRepositoryError('cas_conflict', 'recovery requeue CAS failed');
  requireTimestamp(now, recovery);
  const result = db.run(`UPDATE configuration_recoveries SET state='scheduled',next_retry_at=NULL,updated_at=?
    WHERE recovery_id=? AND state='running' AND attempt_count=?`, [now, recoveryId, attemptCount]);
  if (result.changes !== 1) throw new ConfigRepositoryError('cas_conflict', 'recovery requeue CAS failed');
  const queued = readRecovery(db, recoveryId);
  if (queued === null) throw new ConfigRepositoryError('repository_failure', 'recovery requeue failed');
  return queued;
}

export function verifyRecoveryIntegrity(db: Database, allowActiveRecoveryDrift = false): void {
  const rows = readRecoveryRows(db, `${RECOVERY_SELECT} ORDER BY recovery_sequence`);
  const sequences = sqliteAll<{ readonly recovery_sequence: number; readonly created_at: number }, []>(db,
    'SELECT recovery_sequence,created_at FROM configuration_recoveries ORDER BY recovery_sequence');
  if (sequences.length !== rows.length || sequences.some((row, index) => row.recovery_sequence !== index + 1) ||
      sequences.some((row, index) => index > 0 && row.created_at < sequences[index - 1]!.created_at)) {
    corrupt('configuration recovery sequences are not contiguous');
  }
  const sqliteSequence = sqliteGet<{ readonly seq: number | null }, []>(db,
    "SELECT seq FROM sqlite_sequence WHERE name='configuration_recoveries'");
  const maxSequence = rows.length === 0 ? 0 : rows.length;
  if ((sqliteSequence === null && maxSequence !== 0) ||
      (sqliteSequence !== null && sqliteSequence.seq !== maxSequence)) {
    corrupt('configuration recovery sqlite sequence is incoherent');
  }
  // This detects accidental or host-code corruption, not a database owner with write access.
  const activeByTarget = new Set<number>();
  const currentRevision = sqliteGet<{ readonly active_revision: number }, []>(db,
    'SELECT active_revision FROM configuration_state WHERE id=1')?.active_revision;
  if (currentRevision === undefined) corrupt('configuration state is missing for recovery audit');
  for (const recovery of rows) {
    const source = sqliteGet<{
      readonly state: string; readonly error_code: string | null; readonly committed_revision: number;
    }, [string]>(db, 'SELECT state,error_code,committed_revision FROM configuration_operations WHERE mutation_id=?', recovery.source_mutation_id);
    if (source === null || source.state !== 'degraded' || source.committed_revision !== recovery.target_revision ||
        (source.error_code !== 'replacement_convergence_failed' && source.error_code !== 'control_readiness_failed')) {
      corrupt('configuration recovery source metadata is incoherent');
    }
    if (recovery.final_reason_code === 'deterministic_control_failure' && source.error_code !== 'control_readiness_failed') {
      corrupt('configuration recovery reason is incompatible with its source');
    }
    if ((recovery.final_reason_code === 'deterministic_worker_rejection' ||
        recovery.final_reason_code === 'deterministic_protocol_failure') &&
        source.error_code !== 'replacement_convergence_failed') {
      corrupt('configuration recovery reason is incompatible with its source');
    }
    if (recovery.final_reason_code === 'fatal_source_failure' &&
        source.error_code !== 'replacement_convergence_failed' && source.error_code !== 'control_readiness_failed') {
      corrupt('fatal recovery reason is incompatible with its source');
    }
    const target = sqliteGet<{ readonly revision: number }, [number]>(db,
      'SELECT revision FROM configuration_revisions WHERE revision=?', recovery.target_revision);
    if (target === null) corrupt('configuration recovery target revision is missing');
    if ((recovery.state === 'scheduled' || recovery.state === 'running') && activeByTarget.has(recovery.target_revision)) {
      corrupt('multiple active recoveries target one revision');
    }
    if (recovery.final_reason_code === 'revision_superseded' && recovery.target_revision >= currentRevision) {
      corrupt('superseded recovery target is not older than the active revision');
    }
    if (!allowActiveRecoveryDrift && (recovery.state === 'scheduled' || recovery.state === 'running') &&
        recovery.target_revision !== currentRevision) {
      corrupt('active recovery does not target the current revision');
    }
    if (recovery.state === 'scheduled' || recovery.state === 'running') activeByTarget.add(recovery.target_revision);
  }
}
