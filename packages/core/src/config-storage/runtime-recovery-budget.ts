import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from './repository-types';
import { isLowercaseUuid } from './validation';
import { sqliteGet } from './sqlite-query';

export type RuntimeRecoverySample = Readonly<{ owner: string; boot_id: string; monotonic_ns: string }>;
export type RuntimeRecoveryBudget = Readonly<{
  tickets: number;
  last_ticket_id: string | null;
  retry_boot_id: string | null;
  retry_at_ns: string | null;
  healthy_owner: string | null;
  healthy_boot_id: string | null;
  healthy_since_ns: string | null;
  healthy_last_ns: string | null;
}>;
export type RuntimeRecoveryStartupGate =
  | { readonly kind: 'ready'; readonly budget: RuntimeRecoveryBudget }
  | { readonly kind: 'waiting'; readonly remaining_ms: number; readonly budget: RuntimeRecoveryBudget }
  | { readonly kind: 'stopped'; readonly reason: 'restart_budget_exhausted' | 'clock_domain_unknown'; readonly budget: RuntimeRecoveryBudget };
const BACKOFF_NS = [5_000_000_000n, 30_000_000_000n] as const;
const HEALTHY_RESET_NS = 30n * 60n * 1_000_000_000n;
const MAX_HEALTH_SAMPLE_GAP_NS = 60n * 1_000_000_000n;
function sample(input: RuntimeRecoverySample): bigint {
  if (!isLowercaseUuid(input.owner) || typeof input.boot_id !== 'string' || input.boot_id.length < 1 || input.boot_id.length > 256
    || typeof input.monotonic_ns !== 'string' || !/^(0|[1-9]\d{0,24})$/.test(input.monotonic_ns)) {
    throw new ConfigRepositoryError('invalid_operation', 'runtime recovery sample is invalid');
  }
  return BigInt(input.monotonic_ns);
}
export function readRuntimeRecoveryBudget(db: Database): RuntimeRecoveryBudget {
  const row = sqliteGet<{ tickets: number; ticket_id: string | null; ticket_boot_id: string | null; retry_at_ns: string | null;
    healthy_owner: string | null; healthy_boot_id: string | null; healthy_since_ns: string | null; healthy_last_ns: string | null }, []>(db,
    'SELECT tickets,ticket_id,ticket_boot_id,retry_at_ns,healthy_owner,healthy_boot_id,healthy_since_ns,healthy_last_ns FROM runtime_recovery_budget WHERE id=1');
  if (row === null || !Number.isSafeInteger(row.tickets) || row.tickets < 0 || row.tickets > 2
    || (row.tickets > 0 && (row.ticket_id === null || !isLowercaseUuid(row.ticket_id) || typeof row.ticket_boot_id !== 'string' || !row.ticket_boot_id.length || row.retry_at_ns === null))
    || (row.healthy_owner !== null && (!isLowercaseUuid(row.healthy_owner) || typeof row.healthy_boot_id !== 'string' || !row.healthy_boot_id.length || row.healthy_since_ns === null || row.healthy_last_ns === null))
    || [row.retry_at_ns, row.healthy_since_ns, row.healthy_last_ns].some(value => value !== null && !/^(0|[1-9]\d{0,24})$/.test(value))) {
    throw new ConfigRepositoryError('schema_corrupt', 'runtime recovery budget is corrupt');
  }
  return Object.freeze({ tickets: row.tickets, last_ticket_id: row.ticket_id, retry_boot_id: row.ticket_boot_id,
    retry_at_ns: row.retry_at_ns, healthy_owner: row.healthy_owner, healthy_boot_id: row.healthy_boot_id,
    healthy_since_ns: row.healthy_since_ns, healthy_last_ns: row.healthy_last_ns });
}
/** Called once BEFORE exiting; the same ticket is idempotent and never counts twice. */
export function consumeRuntimeRecoveryRestartTicket(db: Database, ticketId: string, input: RuntimeRecoverySample): RuntimeRecoveryBudget {
  const now = sample(input);
  if (!isLowercaseUuid(ticketId)) throw new ConfigRepositoryError('invalid_operation', 'runtime recovery ticket identity is invalid');
  const before = readRuntimeRecoveryBudget(db);
  const prior = sqliteGet<{ owner: string; boot_id: string }, [string]>(db,
    'SELECT owner,boot_id FROM runtime_recovery_tickets WHERE ticket_id=?', ticketId);
  if (prior !== null) {
    if (prior.owner !== input.owner || prior.boot_id !== input.boot_id) {
      throw new ConfigRepositoryError('invalid_operation', 'runtime recovery ticket belongs to another owner or kernel boot');
    }
    return before;
  }
  if (before.tickets >= 2) throw new ConfigRepositoryError('attempts_exhausted', 'runtime recovery restart budget is exhausted');
  if (before.retry_at_ns !== null && before.retry_boot_id === input.boot_id && now < BigInt(before.retry_at_ns)) {
    throw new ConfigRepositoryError('retry_not_due', 'runtime recovery restart backoff has not elapsed');
  }
  const retry = now + BACKOFF_NS[before.tickets]!;
  db.run('INSERT INTO runtime_recovery_tickets(ticket_id,owner,boot_id,consumed_at_ns,retry_at_ns) VALUES(?,?,?,?,?)',
    [ticketId, input.owner, input.boot_id, now.toString(), retry.toString()]);
  db.run(`UPDATE runtime_recovery_budget SET tickets=tickets+1,ticket_id=?,ticket_boot_id=?,retry_at_ns=?,
    healthy_owner=NULL,healthy_boot_id=NULL,healthy_since_ns=NULL,healthy_last_ns=NULL WHERE id=1`, [ticketId, input.boot_id, retry.toString()]);
  return readRuntimeRecoveryBudget(db);
}
/** A startup reads the already consumed ticket and waits; it never consumes another. */
export function readRuntimeRecoveryStartupGate(db: Database, input: RuntimeRecoverySample): RuntimeRecoveryStartupGate {
  const now = sample(input);
  const budget = readRuntimeRecoveryBudget(db);
  if (budget.retry_at_ns === null) return { kind: 'ready', budget };
  if (budget.retry_boot_id !== input.boot_id) return { kind: 'stopped', reason: 'clock_domain_unknown', budget };
  const remaining = BigInt(budget.retry_at_ns) - now;
  if (remaining > 0n) return { kind: 'waiting', remaining_ms: Number((remaining + 999_999n) / 1_000_000n), budget };
  // The second ticket authorizes the second start; exhaustion affects a third exit,
  // not the start whose ticket has already been durably consumed.
  return { kind: 'ready', budget };
}
/** Frequent verified healthy samples from the SAME physical runtime can reset tickets. */
export function observeRuntimeRecoveryHealth(db: Database, input: RuntimeRecoverySample, healthy: boolean): RuntimeRecoveryBudget {
  const now = sample(input);
  const before = readRuntimeRecoveryBudget(db);
  if (typeof healthy !== 'boolean') throw new ConfigRepositoryError('invalid_operation', 'runtime health sample is invalid');
  if (!healthy) {
    db.run('UPDATE runtime_recovery_budget SET healthy_owner=NULL,healthy_boot_id=NULL,healthy_since_ns=NULL,healthy_last_ns=NULL WHERE id=1');
    return readRuntimeRecoveryBudget(db);
  }
  const continuous = before.healthy_owner === input.owner && before.healthy_boot_id === input.boot_id
    && before.healthy_since_ns !== null && before.healthy_last_ns !== null
    && now >= BigInt(before.healthy_last_ns) && now - BigInt(before.healthy_last_ns) <= MAX_HEALTH_SAMPLE_GAP_NS;
  const since = continuous ? BigInt(before.healthy_since_ns!) : now;
  if (now - since >= HEALTHY_RESET_NS) {
    db.run(`UPDATE runtime_recovery_budget SET tickets=0,ticket_id=NULL,ticket_boot_id=NULL,retry_at_ns=NULL,
      healthy_owner=?,healthy_boot_id=?,healthy_since_ns=?,healthy_last_ns=? WHERE id=1`, [input.owner, input.boot_id, since.toString(), now.toString()]);
  } else {
    db.run('UPDATE runtime_recovery_budget SET healthy_owner=?,healthy_boot_id=?,healthy_since_ns=?,healthy_last_ns=? WHERE id=1',
      [input.owner, input.boot_id, since.toString(), now.toString()]);
  }
  return readRuntimeRecoveryBudget(db);
}
