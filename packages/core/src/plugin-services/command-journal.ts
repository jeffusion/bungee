/**
 * P4 host-owned command journal: a real SQLite-backed `RpcCommandExecutor`.
 *
 * This leaf is the ONLY durable deduplication/transaction path behind the RPC kernel's command
 * dispatch. It owns no wire security policy: the host admission callback already chose the
 * endpoint, the `context.caller` it passes is taken as a parent-authorized logical partition,
 * and this module never authenticates a wire caller.
 *
 * What it actually guarantees:
 * - A stable journal key derived from the caller identity and the operation id. The key never
 *   contains the runtime generation, so deduplication survives a restart; it does contain caller
 *   subject/scope, so two callers cannot reuse one operation.
 * - A canonical payload fingerprint (object keys sorted, array order preserved) over the
 *   operation id, contract major, method, caller, and input. A repeat with a changed id, payload,
 *   or contract major is refused as a conflict instead of silently reusing or overwriting.
 * - Durable `pending | committed | unknown | rejected | error` entries, each carrying the kernel
 *   grant's source owner identity (process/instance/catalog/generation) so a trusted host can
 *   prove the exact old actor is terminal. Every terminal writer re-reads the exact entry inside
 *   the SAME SQL transaction, keeps an existing terminal entry immutable, makes a duplicate
 *   confirmation with the same fingerprint idempotent, refuses a contradictory one, and never
 *   returns a stale (expired) result. A `pending` entry that is not locally in flight stays
 *   `pending`; it becomes `unknown` only through explicit host recovery evidence that exactly
 *   matches the saved source owner and epoch.
 * - A per-namespace policy binding stored as one prepaid P3 record in the same namespace (no
 *   second bookkeeping table), so a namespace's quota/private-state/contract-major/method are
 *   registered atomically on first admit, must match forever after, and a failed admit cannot
 *   create an unbilled permanent row.
 * - A hard quota gate: before any side effect the real cumulative namespace charge (binding +
 *   live reservations + records + receipts + tombstones) is compared against the bound quota, and
 *   the write is rolled back if it would exceed it.
 * - Entries are padded to a fixed header size so a pending→unknown transition shrinks padding
 *   instead of growing the record: recovery never needs new quota and an accepted command can
 *   always settle.
 * - Retention is owned by the journal's own monotonic clock. The terminal reservation is always
 *   `required` with no expiry; the committed body is removed by `collect` through a bounded expiry
 *   index while the permanent receipt (old-id proof) remains.
 *
 * `local-transaction` is honest about SQLite: the runtime's async `executeBusiness` closure can
 * never be wrapped in a synchronous SQLite transaction. A synchronous host atomic planner
 * (`resolveAtomic`) is used instead. One synchronous `Database.transaction(...).immediate()`
 * contains the planner READ, its plan validation, re-reads of the current entry, the reservation
 * and quota gate, the private-state CAS applied with direct SQL (no second command history
 * table), and the terminal journal record — with no `await`. Only the planner's pure-JSON SQL
 * mutations are covered; external IO is not.
 *
 * `external-contract` and `none` commit the pending record + reservation before the single
 * `executeBusiness` call. A lost/invalid response becomes `unknown`, keeps the accepted
 * reservation, and is never retried automatically; only an explicit `reconcile` confirmed by a
 * snapshot host capability commits a result. `external-contract` never guesses exactly-once.
 *
 * The host owns migration DDL; `COMMAND_JOURNAL_SCHEMA_SQL` is exported for that and `setup`
 * exists for tests with a fresh database.
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { DurableJson, DurableMutation, DurableRecord } from '../plugin-durable-state';
import type { PluginServiceScope } from './contracts';
import {
  CommunicationStoreError,
  PLUGIN_COMMUNICATION_SCHEMA_SQL,
  PluginCommunicationStore,
  type CommunicationNamespaceStore,
  type CommunicationReservation,
  type PluginCommunicationLimits,
} from './persistence';
import {
  RPC_JSON_MAX_BYTES,
  assertRpcData,
  decodeRpcJson,
  encodeRpcJson,
  type RpcCommandPolicy,
  type RpcJson,
  type RpcMethodDefinition,
} from './wire-contract';
import type { RpcCaller, RpcCommandExecution, RpcCommandExecutor } from './rpc-runtime';

/** Private-state records shared with the durable-state store; the journal never writes its commands. */
const COMMAND_JOURNAL_RECORDS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_durable_records (
  namespace TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
  value_json TEXT NOT NULL, PRIMARY KEY(namespace, key)
) STRICT;
`;
/** Retention index for expired committed bodies; only the body row is removed, never the id. */
export const COMMAND_JOURNAL_RETENTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_command_journal_retention (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
) STRICT;
CREATE INDEX IF NOT EXISTS plugin_command_journal_retention_expiry
  ON plugin_command_journal_retention (namespace, expires_at);
`;
/** Public DDL for the migration integration. The host must run it; this module does not migrate. */
export const COMMAND_JOURNAL_SCHEMA_SQL = `${PLUGIN_COMMUNICATION_SCHEMA_SQL}\n${COMMAND_JOURNAL_RECORDS_SCHEMA_SQL}\n${COMMAND_JOURNAL_RETENTION_SCHEMA_SQL}`;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const ENTRY_KEY_PREFIX = 'j.';
/** Reserved P3 record key holding the namespace policy binding (never a command key). */
const POLICY_MARKER_KEY = 'journal-policy-binding';
const DURABLE_LIMIT_BYTES = 1024 * 1024;
const PLAN_LIMIT_BYTES = DURABLE_LIMIT_BYTES + RPC_JSON_MAX_BYTES;
/** Fixed entry-header target: pending and unknown entries share this size, so recovery cannot grow. */
const HEADER_TARGET_BYTES = 1024;
/** Slack for number-length drift between the fixed header target and the real terminal entry. */
const CAPACITY_SLACK_BYTES = 128;
/** Amortized cost of one retention-index row, prepaid by a retention-bearing command. */
const RETENTION_META_BYTES = 128;
const SUBJECT_MAX_BYTES = 256;
const MAX_MUTATIONS = 256;
const DEFAULT_ATOMIC_READ_ROWS = 256;
const DEFAULT_ATOMIC_READ_BYTES = DURABLE_LIMIT_BYTES;
const DEFAULT_ATOMIC_READ_QUERIES = 2 * DEFAULT_ATOMIC_READ_ROWS + 4;
const DEFAULT_MAX_IN_FLIGHT = 1024;
const DEFAULT_COLLECT_LIMIT = 128;
const MAX_COLLECT_LIMIT = 256;
const SCOPES = new Set<PluginServiceScope>(['global', 'binding']);
const STATES = new Set<JournalState>(['pending', 'committed', 'unknown', 'rejected', 'error']);
const ERROR_CODES = new Set<CommandJournalErrorCode>([
  'invalid_input', 'invalid_output', 'capability_unavailable', 'overloaded', 'storage_failure',
  'missing', 'pending', 'unknown', 'expired', 'rejected', 'conflict',
]);
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

type JournalState = 'pending' | 'committed' | 'unknown' | 'rejected' | 'error';
type DurableMetaRow = { key: string; version: number; bytes: number };
interface BindingValue {
  readonly quotaBytes: number;
  readonly privateNamespace: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly method: string;
}

/**
 * Fixed-code journal error. It carries the validated operation id but never a database, SQLite,
 * provider, or planner cause: hosts log the original exception separately. The journal only ever
 * mints its own instances and never propagates a provider-shaped object.
 */
export type CommandJournalErrorCode =
  | 'invalid_input'
  | 'invalid_output'
  | 'capability_unavailable'
  | 'overloaded'
  | 'storage_failure'
  | 'missing'
  | 'pending'
  | 'unknown'
  | 'expired'
  | 'rejected'
  | 'conflict';

const ERROR_MESSAGES: Record<CommandJournalErrorCode, string> = {
  invalid_input: 'command journal input is invalid',
  invalid_output: 'command journal result is invalid',
  capability_unavailable: 'command journal capability is unavailable',
  overloaded: 'command journal capacity is exhausted',
  storage_failure: 'command journal storage operation failed',
  missing: 'command journal has no record for this operation',
  pending: 'command journal operation is pending',
  unknown: 'command journal operation outcome is unknown',
  expired: 'command journal operation result has expired',
  rejected: 'command journal operation was rejected',
  conflict: 'command journal operation identity conflicts with an existing record',
};

export class CommandJournalError extends Error {
  readonly name = 'CommandJournalError';
  constructor(
    readonly code: CommandJournalErrorCode,
    readonly operationId: string | null = null,
  ) {
    super(ERROR_MESSAGES[code]);
  }
}

/** The kernel grant's source owner identity, excluded from the logical deduplication key. */
export interface CommandSourceIdentity {
  readonly process: string;
  readonly instance: string;
  readonly catalog: string;
  readonly generation: number;
}

/** Trusted parent lifecycle proof that the previous owner of a pending command is terminal. */
export interface CommandRecoveryEvidence {
  readonly owner: string;
  readonly epoch: number;
  readonly issuedAt: number;
}

export interface CommandRecoveryRequest {
  readonly key: string;
  readonly operationId: string;
  readonly caller: RpcCaller;
  readonly fingerprint: string;
  readonly source: CommandSourceIdentity;
  /** Stable logical owner id derived from the saved source (generation excluded). */
  readonly owner: string;
  /** Saved source generation; evidence must match it exactly. */
  readonly epoch: number;
}

/** Returns evidence only when the host can prove the saved source owner is terminal; else null. */
export type CommandRecoveryAuthorizer = (request: CommandRecoveryRequest) => CommandRecoveryEvidence | null | undefined;

/**
 * The host-facing command identity without the provider callback. `execute` receives the full
 * `RpcCommandExecution` and preserves its `executeBusiness` closure; `reconcile` only needs this
 * identity, so a host may reconstruct it after a restart without holding the provider closure.
 */
export type CommandJournalRequest = Omit<RpcCommandExecution<unknown>, 'executeBusiness'>;

/** Bounded, read-only durable-state view granted to one atomic planner invocation. */
export interface CommandAtomicReader {
  get(key: string): DurableRecord | null;
  list(): readonly DurableRecord[];
}

/** Pure-JSON plan produced by a host atomic planner; applied in one SQLite transaction. */
export interface CommandAtomicPlan {
  readonly mutations: readonly DurableMutation[];
  readonly result: RpcJson;
}

/** Synchronous planner with the validated invocation; no out-of-band input capture is needed. */
export type CommandAtomicPlanner = (reader: CommandAtomicReader, execution: CommandJournalRequest) => CommandAtomicPlan;

/** Sync resolver; `null`/`undefined` means the host has not bound an atomic planner. */
export type CommandAtomicResolver = (execution: CommandJournalRequest) => CommandAtomicPlanner | null | undefined;

/** Confirmed outcome of an external reconciliation; only `committed` may commit a result. */
export type CommandExternalReconciliation =
  | { readonly status: 'committed'; readonly result: RpcJson }
  | { readonly status: 'not-executed' }
  | { readonly status: 'unknown' };

/** Registered host capability for an external idempotency contract. */
export interface CommandExternalExecutor {
  reconcile(execution: CommandJournalRequest): CommandExternalReconciliation | Promise<CommandExternalReconciliation>;
}

/** `null`/`undefined` means the host does not support this external contract (never guessed). */
export type CommandExternalResolver = (execution: CommandJournalRequest) => CommandExternalExecutor | null | undefined;

export interface CommandJournalOptions {
  /** Shared database. The journal constructs its own bound stores so every write shares it. */
  readonly db: Database;
  /** Stable logical service namespace (survives restarts; never includes a runtime generation). */
  readonly namespace: string;
  /** Durable-state namespace declared by the host as the plugin's private local-transaction state. */
  readonly privateStateNamespace: string;
  /**
   * Approved namespace quota. When set it must match the persisted binding and the command's
   * declared quota; when omitted the persisted binding (or, on first admit, the command's declared
   * quota) is authoritative.
   */
  readonly quotaBytes?: number;
  readonly limits?: PluginCommunicationLimits;
  /** Test-only: create the communication + records + retention schema on this database. */
  readonly setup?: boolean;
  readonly resolveAtomic?: CommandAtomicResolver;
  readonly resolveExternal?: CommandExternalResolver;
  /** Explicit host authorization required before a pending command may be recovered. */
  readonly authorizeRecovery?: CommandRecoveryAuthorizer;
  readonly now?: () => number;
  readonly atomicReadRows?: number;
  readonly atomicReadBytes?: number;
  /** SQL-query budget for the atomic read capability, checked BEFORE each statement. */
  readonly atomicReadQueries?: number;
  readonly maxInFlight?: number;
}

export type CommandJournalStatus =
  | 'committed'
  | 'pending'
  | 'unknown'
  | 'expired'
  | 'rejected'
  | 'error'
  | 'conflict'
  | 'missing';

export type CommandJournalInspection =
  | { readonly status: 'committed'; readonly result: RpcJson; readonly expiresAt: number | null }
  | { readonly status: 'expired'; readonly expiresAt: number | null }
  | { readonly status: 'pending' }
  | { readonly status: 'unknown' }
  | { readonly status: 'rejected' }
  | { readonly status: 'error' }
  | { readonly status: 'conflict' }
  | { readonly status: 'missing' };

interface JournalEntry {
  readonly v: 1;
  readonly state: JournalState;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly contract: { readonly id: string; readonly version: number };
  readonly method: string;
  readonly caller: { readonly subject: string; readonly scope: PluginServiceScope | null };
  readonly source: CommandSourceIdentity;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly result: RpcJson | null;
  readonly recovery: CommandRecoveryEvidence | null;
}

interface PreparedCommand {
  readonly execution: CommandJournalRequest;
  readonly operationId: string;
  readonly method: string;
  readonly definition: RpcMethodDefinition;
  readonly policy: RpcCommandPolicy;
  readonly declaredQuota: number;
  readonly caller: RpcCaller;
  readonly source: CommandSourceIdentity;
  readonly owner: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly key: string;
  readonly fingerprint: string;
}

interface PendingHandle {
  readonly reservation: CommunicationReservation;
  readonly createdAt: number;
}

interface InFlight {
  readonly fingerprint: string;
  readonly promise: Promise<RpcJson>;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const type = typeof value;
  if (type !== 'object' && type !== 'function') return false;
  try { return typeof (value as { then?: unknown }).then === 'function'; } catch { return false; }
}

/** Reads a journal code only from an own data property, never through a getter/proxy trap. */
function ownJournalCode(error: unknown): CommandJournalErrorCode | null {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return null;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(error, 'code'); } catch { return null; }
  if (descriptor === undefined || !('value' in descriptor)) return null;
  const value = descriptor.value;
  return typeof value === 'string' && ERROR_CODES.has(value as CommandJournalErrorCode)
    ? value as CommandJournalErrorCode : null;
}

/** Snapshots an own plain function property without ever invoking an accessor. */
function plainFunctionProperty(target: unknown, name: string): ((...args: unknown[]) => unknown) | null {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return null;
  if (isProxy(target)) return null;
  const prototype = Object.getPrototypeOf(target);
  if (prototype !== Object.prototype && prototype !== null) return null;
  let keys: (string | symbol)[];
  try { keys = Reflect.ownKeys(target); } catch { return null; }
  if (keys.some((key) => typeof key === 'symbol')) return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
  const value = descriptor.value;
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical JSON: object keys sorted recursively, array order preserved. */
function canonicalJson(value: RpcJson): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value) ?? 'null';
  if (typeof value === 'string') return JSON.stringify(value) ?? '""';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { readonly [key: string]: RpcJson };
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Journal key: caller partition + operation id. Contract/source generation are deliberately
 * excluded so deduplication is logical and survives a restart; tampering is caught by fingerprint. */
function commandEntryKey(caller: RpcCaller, operationId: string): string {
  const identity = canonicalJson({
    caller: { subject: caller.subject, scope: caller.scope ?? null },
    operationId,
  });
  return ENTRY_KEY_PREFIX + sha256Hex(identity);
}

function commandFingerprint(
  contractId: string,
  contractVersion: number,
  method: string,
  caller: RpcCaller,
  operationId: string,
  input: RpcJson,
): string {
  return `sha256:${sha256Hex(canonicalJson({
    v: 1,
    operationId,
    contract: { id: contractId, version: contractVersion },
    method,
    caller: { subject: caller.subject, scope: caller.scope ?? null },
    input,
  }))}`;
}

function readSource(endpoint: unknown, operationId: string): CommandSourceIdentity {
  if (endpoint === null || typeof endpoint !== 'object') {
    throw new CommandJournalError('invalid_input', operationId);
  }
  const record = endpoint as Record<string, unknown>;
  const { process, instance, catalog, generation } = record;
  if (process !== 'control' && process !== 'worker' && process !== 'ingress'
    || typeof instance !== 'string' || instance.length === 0 || typeof catalog !== 'string'
    || !Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new CommandJournalError('invalid_input', operationId);
  }
  return Object.freeze({ process, instance, catalog, generation: generation as number });
}

function sourceOwner(source: CommandSourceIdentity): string {
  return sha256Hex(canonicalJson({
    process: source.process,
    instance: source.instance,
    catalog: source.catalog,
  }));
}

/** Uses the actual JSON-encoded identity and worst-case recovery fields, not raw string lengths. */
function entryHeaderBytes(entry: JournalEntry): number {
  return Math.max(HEADER_TARGET_BYTES, Buffer.byteLength(JSON.stringify({
    ...entry,
    state: 'committed',
    createdAt: -Number.MAX_VALUE,
    expiresAt: -Number.MAX_VALUE,
    result: null,
    recovery: { owner: 'x'.repeat(64), epoch: Number.MAX_SAFE_INTEGER, issuedAt: Number.MAX_SAFE_INTEGER },
    pad: '',
  }), 'utf8'));
}

/** Pending and recovered unknown retain the same prepaid encoded header size. */
function encodeEntry(entry: JournalEntry): Uint8Array {
  const probe = { ...entry, result: null, pad: '' };
  const probeBytes = Buffer.byteLength(JSON.stringify(probe), 'utf8');
  const padLength = entryHeaderBytes(entry) - probeBytes;
  if (padLength < 0) throw new CommandJournalError('invalid_input', entry.operationId);
  return ENCODER.encode(JSON.stringify({ ...entry, pad: 'x'.repeat(padLength) }));
}

function parseSource(value: unknown): CommandSourceIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandJournalError('storage_failure', null);
  }
  const record = value as Record<string, unknown>;
  const { process, instance, catalog, generation } = record;
  if (process !== 'control' && process !== 'worker' && process !== 'ingress'
    || typeof instance !== 'string' || instance.length === 0 || typeof catalog !== 'string'
    || !Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new CommandJournalError('storage_failure', null);
  }
  return Object.freeze({ process, instance, catalog, generation: generation as number });
}

function parseRecovery(value: unknown): CommandRecoveryEvidence | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new CommandJournalError('storage_failure', null);
  const record = value as Record<string, unknown>;
  const { owner, epoch, issuedAt } = record;
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)
    || !Number.isSafeInteger(epoch) || (epoch as number) < 0
    || !Number.isSafeInteger(issuedAt) || (issuedAt as number) < 0) {
    throw new CommandJournalError('storage_failure', null);
  }
  return Object.freeze({ owner, epoch: epoch as number, issuedAt: issuedAt as number });
}

function parseEntry(text: string): JournalEntry {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new CommandJournalError('storage_failure', null); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CommandJournalError('storage_failure', null);
  }
  const row = raw as Record<string, unknown>;
  const { v, state, operationId, fingerprint, method, createdAt, expiresAt, result } = row;
  const contract = row.contract;
  const caller = row.caller;
  if (v !== 1 || typeof state !== 'string' || !STATES.has(state as JournalState)
    || typeof operationId !== 'string' || typeof fingerprint !== 'string'
    || contract === null || typeof contract !== 'object' || Array.isArray(contract)
    || typeof (contract as Record<string, unknown>).id !== 'string'
    || !Number.isSafeInteger((contract as Record<string, unknown>).version)
    || typeof method !== 'string'
    || caller === null || typeof caller !== 'object' || Array.isArray(caller)
    || typeof (caller as Record<string, unknown>).subject !== 'string'
    || !(typeof createdAt === 'number' && Number.isSafeInteger(createdAt))
    || !(expiresAt === null || (typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt)))
    || !Object.prototype.hasOwnProperty.call(row, 'result')) {
    throw new CommandJournalError('storage_failure', null);
  }
  const rawScope = (caller as Record<string, unknown>).scope;
  if (rawScope !== null && (typeof rawScope !== 'string' || !SCOPES.has(rawScope as PluginServiceScope))) {
    throw new CommandJournalError('storage_failure', null);
  }
  const entry: JournalEntry = {
    v: 1,
    state: state as JournalState,
    operationId: operationId as string,
    fingerprint: fingerprint as string,
    contract: Object.freeze({
      id: (contract as Record<string, unknown>).id as string,
      version: (contract as Record<string, unknown>).version as number,
    }),
    method: method as string,
    caller: Object.freeze({
      subject: (caller as Record<string, unknown>).subject as string,
      scope: (rawScope ?? null) as PluginServiceScope | null,
    }),
    source: parseSource(row.source),
    createdAt: createdAt as number,
    expiresAt: expiresAt as number | null,
    result: result as RpcJson | null,
    recovery: parseRecovery(row.recovery),
  };
  return Object.freeze(entry);
}

function parseBinding(text: string): BindingValue {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new CommandJournalError('storage_failure', null); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CommandJournalError('storage_failure', null);
  }
  const record = raw as Record<string, unknown>;
  const { quotaBytes, privateNamespace, contractId, contractVersion, method } = record;
  if (!Number.isSafeInteger(quotaBytes) || (quotaBytes as number) < 1
    || typeof privateNamespace !== 'string' || typeof contractId !== 'string'
    || !Number.isSafeInteger(contractVersion) || (contractVersion as number) < 1
    || typeof method !== 'string') {
    throw new CommandJournalError('storage_failure', null);
  }
  return Object.freeze({
    quotaBytes: quotaBytes as number,
    privateNamespace,
    contractId,
    contractVersion: contractVersion as number,
    method,
  });
}

/**
 * Snapshots a host plan into bounded, pure JSON and validates its exact shape. The whole plan
 * passes through the wire codec first, so accessors, proxies, `Date`/class instances, functions,
 * `undefined`, hidden/symbol keys, and oversized values are rejected before any SQL mutation.
 * A mutation value that is not pure JSON is an `invalid_input` — never masked as a storage error.
 */
function normalizePlan(raw: unknown, prepared: PreparedCommand): CommandAtomicPlan {
  const operationId = prepared.operationId;
  let text: string;
  try {
    text = encodeRpcJson(raw, PLAN_LIMIT_BYTES);
  } catch {
    throw new CommandJournalError('invalid_input', operationId);
  }
  let plan: unknown;
  try {
    plan = decodeRpcJson(text, PLAN_LIMIT_BYTES);
  } catch {
    throw new CommandJournalError('invalid_input', operationId);
  }
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new CommandJournalError('capability_unavailable', operationId);
  }
  const planKeys = Object.keys(plan as Record<string, unknown>);
  if (planKeys.length !== 2 || !planKeys.includes('mutations') || !planKeys.includes('result')) {
    throw new CommandJournalError('capability_unavailable', operationId);
  }
  const record = plan as { mutations?: unknown; result?: unknown };
  if (!Array.isArray(record.mutations) || record.mutations.length > MAX_MUTATIONS) {
    throw new CommandJournalError('capability_unavailable', operationId);
  }
  const seen = new Set<string>();
  const mutations: DurableMutation[] = [];
  for (const item of record.mutations) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CommandJournalError('capability_unavailable', operationId);
    }
    const mutation = item as Record<string, unknown>;
    const itemKeys = Object.keys(mutation);
    if (itemKeys.length !== 3
      || !itemKeys.includes('key') || !itemKeys.includes('expectedVersion') || !itemKeys.includes('value')) {
      throw new CommandJournalError('capability_unavailable', operationId);
    }
    const key = mutation.key;
    const expectedVersion = mutation.expectedVersion;
    if (typeof key !== 'string' || !IDENTIFIER.test(key)) {
      throw new CommandJournalError('capability_unavailable', operationId);
    }
    if (seen.has(key)) throw new CommandJournalError('capability_unavailable', operationId);
    seen.add(key);
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0
      || (expectedVersion as number) >= Number.MAX_SAFE_INTEGER) {
      throw new CommandJournalError('capability_unavailable', operationId);
    }
    mutations.push({
      key,
      expectedVersion: expectedVersion as number,
      value: mutation.value as DurableJson,
    });
  }
  const mutationsJson = JSON.stringify(mutations);
  if (Buffer.byteLength(mutationsJson, 'utf8') > DURABLE_LIMIT_BYTES) {
    throw new CommandJournalError('invalid_input', operationId);
  }
  Object.freeze(mutations);
  return Object.freeze({ mutations, result: record.result as RpcJson });
}

/**
 * Real SQLite command journal. The host injects the shared `Database`; the journal builds its own
 * bound stores from it so every write shares one transaction.
 */
export class CommandJournal implements RpcCommandExecutor<unknown> {
  readonly #db: Database;
  readonly #privateNamespace: string;
  readonly #comm: CommunicationNamespaceStore;
  readonly #resolveAtomic: CommandAtomicResolver | undefined;
  readonly #resolveExternal: CommandExternalResolver | undefined;
  readonly #authorizeRecovery: CommandRecoveryAuthorizer | undefined;
  readonly #declaredQuota: number | null;
  readonly #now: () => number;
  readonly #atomicReadRows: number;
  readonly #atomicReadBytes: number;
  readonly #atomicReadQueries: number;
  readonly #maxInFlight: number;
  readonly #inflight = new Map<string, InFlight>();
  #recoveryCursor = '';
  #recoveryScanComplete = false;

  constructor(options: CommandJournalOptions) {
    if (options === null || typeof options !== 'object') {
      throw new CommandJournalError('invalid_input', null);
    }
    const { db, namespace, privateStateNamespace, quotaBytes } = options;
    if (db === null || typeof db !== 'object' || typeof (db as Database).transaction !== 'function') {
      throw new CommandJournalError('invalid_input', null);
    }
    assertIdentifier(namespace);
    assertIdentifier(privateStateNamespace);
    if (quotaBytes !== undefined && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1)) {
      throw new CommandJournalError('invalid_input', null);
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new CommandJournalError('invalid_input', null);
    }
    this.#declaredQuota = quotaBytes ?? null;
    this.#atomicReadRows = positiveInteger(options.atomicReadRows, DEFAULT_ATOMIC_READ_ROWS);
    this.#atomicReadBytes = positiveInteger(options.atomicReadBytes, DEFAULT_ATOMIC_READ_BYTES);
    this.#atomicReadQueries = positiveInteger(options.atomicReadQueries, DEFAULT_ATOMIC_READ_QUERIES);
    this.#maxInFlight = positiveInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT);
    this.#now = options.now ?? (() => Date.now());
    this.#resolveAtomic = options.resolveAtomic;
    this.#resolveExternal = options.resolveExternal;
    this.#authorizeRecovery = options.authorizeRecovery;
    this.#db = db;
    this.#privateNamespace = privateStateNamespace;
    if (options.setup === true) db.exec(COMMAND_JOURNAL_SCHEMA_SQL);
    const store = new PluginCommunicationStore(db, options.limits, { setup: false });
    this.#comm = store.forNamespace(namespace);
  }

  /** The ONLY execution path for commands; invoked once per delivered command by the kernel. */
  async execute(execution: RpcCommandExecution<unknown>): Promise<RpcJson> {
    const business = execution.executeBusiness;
    if (typeof business !== 'function') {
      throw new CommandJournalError('capability_unavailable', null);
    }
    const prepared = this.#prepare(execution);
    const current = this.#inflight.get(prepared.key);
    if (current !== undefined) {
      if (current.fingerprint === prepared.fingerprint) return current.promise;
      throw new CommandJournalError('conflict', prepared.operationId);
    }
    if (this.#inflight.size >= this.#maxInFlight) {
      throw new CommandJournalError('overloaded', prepared.operationId);
    }
    let resolve!: (value: RpcJson) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<RpcJson>((accept, fail) => { resolve = accept; reject = fail; });
    // Install the placeholder BEFORE any planner/business code can re-enter execute.
    this.#inflight.set(prepared.key, { fingerprint: prepared.fingerprint, promise });
    void this.#run(prepared, business).then(resolve, reject);
    void promise.then(
      () => { this.#settle(prepared.key, promise); },
      () => { this.#settle(prepared.key, promise); },
    );
    return promise;
  }

  /**
   * Status for a system service, partitioned by caller and operation id; never returns another
   * operation's data. Status resolution itself does not throw, but a durable read failure still
   * throws `storage_failure` — a missing entry is never faked for a broken read.
   */
  inspect(operationId: string, caller: RpcCaller): CommandJournalInspection {
    const key = this.#queryKey(operationId, caller);
    return this.#inspectKey(key, operationId, caller);
  }

  /** Returns the committed result DTO, or throws a fixed-code `CommandJournalError`. */
  query(operationId: string, caller: RpcCaller): RpcJson {
    const key = this.#queryKey(operationId, caller);
    const inspection = this.#inspectKey(key, operationId, caller);
    if (inspection.status === 'committed') return inspection.result;
    throw new CommandJournalError(statusCode(inspection.status), operationId);
  }

  /**
   * Explicit reconciliation for an `unknown` command. Only a `committed` outcome confirmed by a
   * snapshot host capability commits a result. The terminal writer re-reads the entry in the same
   * transaction: an existing terminal entry is immutable, a same-fingerprint duplicate is
   * idempotent, a contradictory confirmation is refused, and an expired existing result is
   * reported as `expired` rather than returned stale.
   */
  async reconcile(execution: CommandJournalRequest): Promise<RpcJson> {
    const prepared = this.#prepare(execution);
    this.#bind(prepared);
    const entry = this.#readEntry(prepared.key, prepared.operationId);
    if (entry === null) {
      const receipt = this.#write(prepared.operationId, () => this.#comm.receipt(prepared.key));
      if (receipt !== null) throw new CommandJournalError('expired', prepared.operationId);
      throw new CommandJournalError('missing', prepared.operationId);
    }
    this.#assertMatches(entry, prepared);
    const status = this.#statusOf(entry);
    if (status === 'committed') return entry.result;
    if (status === 'expired') throw new CommandJournalError('expired', prepared.operationId);
    if (status === 'pending') throw new CommandJournalError('pending', prepared.operationId);
    if (status === 'rejected' || status === 'error') throw new CommandJournalError('rejected', prepared.operationId);
    if (prepared.policy.deduplication !== 'external-contract') {
      throw new CommandJournalError('capability_unavailable', prepared.operationId);
    }
    const capability = this.#requireExternal(prepared);
    let returned: unknown;
    try {
      returned = capability.reconcile(prepared.execution);
    } catch {
      throw new CommandJournalError('unknown', prepared.operationId);
    }
    if (isThenable(returned)) {
      try { returned = await returned; } catch { throw new CommandJournalError('unknown', prepared.operationId); }
    }
    const outcome = this.#snapshotOutcome(returned, prepared);
    if (outcome.status === 'committed') {
      const result = this.#validateOutput(outcome.result, prepared);
      const committedAt = this.#now();
      const expiresAt = prepared.policy.resultRetentionMs === null
        ? null : committedAt + prepared.policy.resultRetentionMs;
      const terminal = this.#terminalEntryFrom(entry, expiresAt, result, 'committed', entry.recovery);
      return this.#confirmResult(prepared, terminal);
    }
    if (outcome.status === 'not-executed') {
      const terminal = this.#terminalEntryFrom(entry, null, null, 'rejected', entry.recovery);
      this.#recordReleased(prepared.key, terminal, prepared.operationId);
      throw new CommandJournalError('rejected', prepared.operationId);
    }
    throw new CommandJournalError('unknown', prepared.operationId);
  }

  /**
   * Removes the committed body of every operation whose retention window has passed, in bounded
   * expiry order, while keeping the permanent receipt as the old-id proof. Pending/unknown/
   * rejected entries are never indexed and are never removed.
   */
  collect(limit: number = DEFAULT_COLLECT_LIMIT): number {
    const cap = Math.min(positiveInteger(limit, DEFAULT_COLLECT_LIMIT), MAX_COLLECT_LIMIT);
    return this.#write(null, () => this.#db.transaction(() => {
      const now = this.#now();
      const rows = this.#db.query<{ key: string }, [string, number, number]>(
        `SELECT key FROM plugin_command_journal_retention
         WHERE namespace = ? AND expires_at <= ? ORDER BY expires_at, key LIMIT ?`,
      ).all(this.#comm.namespace, now, cap);
      let removed = 0;
      for (const row of rows) {
        if (this.#comm.ack(row.key)) removed += 1;
        this.#dropRetention(row.key);
      }
      return removed;
    }).immediate());
  }

  /**
   * Explicit host recovery: only entries the host authorizer proves belong to the saved terminal
   * source owner are turned into `unknown`. Without an authorizer this is a no-op; a plain restart
   * never steals another object's live command.
   */
  recoverPending(limit: number = DEFAULT_COLLECT_LIMIT): number {
    const authorizer = this.#authorizeRecovery;
    if (authorizer === undefined) return 0;
    const cap = Math.min(positiveInteger(limit, DEFAULT_COLLECT_LIMIT), MAX_COLLECT_LIMIT);
    const summaries = this.#write(null, () => this.#db.query<{ key: string }, [string, string, number]>(
      `SELECT key FROM plugin_communication_records WHERE namespace = ? AND key > ?
       AND key LIKE 'j.%' ORDER BY key LIMIT ?`,
    ).all(this.#comm.namespace, this.#recoveryCursor, cap));
    this.#recoveryScanComplete = summaries.length < cap;
    this.#recoveryCursor = this.#recoveryScanComplete ? '' : summaries.at(-1)!.key;
    let recovered = 0;
    for (const summary of summaries) {
      if (summary.key === POLICY_MARKER_KEY) continue;
      const entry = this.#readEntry(summary.key, null);
      if (entry === null || entry.state !== 'pending') continue;
      const expectedOwner = sourceOwner(entry.source);
      const request: CommandRecoveryRequest = Object.freeze({
        key: summary.key,
        operationId: entry.operationId,
        caller: Object.freeze({ subject: entry.caller.subject, scope: entry.caller.scope ?? undefined }),
        fingerprint: entry.fingerprint,
        source: entry.source,
        owner: expectedOwner,
        epoch: entry.source.generation,
      });
      let evidence: unknown;
      try { evidence = authorizer(request); }
      catch { continue; }
      const valid = validateRecoveryEvidence(evidence);
      if (valid === null || valid.owner !== expectedOwner || valid.epoch !== entry.source.generation) continue;
      const terminal = this.#terminalEntryFrom(entry, null, null, 'unknown', valid);
      if (this.#recoverOne(summary.key, entry, terminal)) recovered += 1;
    }
    return recovered;
  }

  /** Host scan progress; capability-free maintenance keeps this facade between batches. */
  recoveryScanComplete(): boolean { return this.#authorizeRecovery === undefined || this.#recoveryScanComplete; }

  /** Reopens only the persisted policy binding; it never retains execution capabilities. */
  static forMaintenance(options: Pick<CommandJournalOptions, 'db' | 'namespace' | 'authorizeRecovery' | 'now'>): CommandJournal {
    const store = new PluginCommunicationStore(options.db, undefined, { setup: false }).forNamespace(options.namespace);
    const record = store.get(POLICY_MARKER_KEY);
    if (record === null) throw new CommandJournalError('storage_failure');
    const binding = parseBinding(DECODER.decode(record.payload));
    return new CommandJournal({ ...options, privateStateNamespace: binding.privateNamespace, quotaBytes: binding.quotaBytes });
  }

  /** Exposes the underlying namespace accounting for host observability. */
  status(): { readonly usedBytes: number; readonly reservedBytes: number; readonly recordCount: number; readonly namespaceQuotaBytes: number } {
    const status = this.#write(null, () => this.#comm.status());
    return Object.freeze({
      usedBytes: status.usedBytes,
      reservedBytes: status.reservedBytes,
      recordCount: status.recordCount,
      namespaceQuotaBytes: status.namespaceQuotaBytes,
    });
  }

  async #run(prepared: PreparedCommand, business: () => Promise<RpcJson>): Promise<RpcJson> {
    const quota = this.#bind(prepared);
    const existing = this.#readEntry(prepared.key, prepared.operationId);
    if (existing !== null) {
      this.#assertMatches(existing, prepared);
      return this.#resolveExisting(existing, prepared);
    }
    const receipt = this.#write(prepared.operationId, () => this.#comm.receipt(prepared.key));
    if (receipt !== null) throw new CommandJournalError('expired', prepared.operationId);
    if (prepared.policy.deduplication === 'local-transaction') return this.#runAtomic(prepared, quota);
    return this.#runInvoked(prepared, business, quota);
  }

  #settle(key: string, promise: Promise<RpcJson>): void {
    const current = this.#inflight.get(key);
    if (current !== undefined && current.promise === promise) this.#inflight.delete(key);
  }

  #resolveExisting(entry: JournalEntry, prepared: PreparedCommand): RpcJson {
    const status = this.#statusOf(entry);
    if (status === 'committed') return entry.result;
    if (status === 'expired') throw new CommandJournalError('expired', prepared.operationId);
    if (status === 'pending') throw new CommandJournalError('pending', prepared.operationId);
    if (status === 'unknown') throw new CommandJournalError('unknown', prepared.operationId);
    throw new CommandJournalError('rejected', prepared.operationId);
  }

  /**
   * Local transaction: planner READ + plan validation + entry re-read + reservation/quota gate +
   * private-state CAS + terminal record run in ONE synchronous `Database.transaction(...)
   * .immediate()` with no `await`. Only the planner's pure-JSON SQL mutations are covered.
   */
  #runAtomic(prepared: PreparedCommand, quota: number): RpcJson {
    const resolver = this.#resolveAtomic;
    if (resolver === undefined) throw new CommandJournalError('capability_unavailable', prepared.operationId);
    let planner: unknown;
    try { planner = resolver(prepared.execution); }
    catch { throw new CommandJournalError('capability_unavailable', prepared.operationId); }
    if (planner === null || planner === undefined || typeof planner !== 'function' || isThenable(planner)) {
      throw new CommandJournalError('capability_unavailable', prepared.operationId);
    }
    const reader = this.#openReader();
    try {
      return this.#write(prepared.operationId, () => this.#db.transaction(() => {
        const beforePlan = this.#readEntry(prepared.key, prepared.operationId);
        if (beforePlan !== null) {
          this.#assertMatches(beforePlan, prepared);
          return this.#resolveExisting(beforePlan, prepared);
        }
        let raw: unknown;
        try { raw = (planner as CommandAtomicPlanner)(reader.capability, prepared.execution); }
        catch (error) {
          if (error instanceof CommandJournalError) throw error;
          throw new CommandJournalError('capability_unavailable', prepared.operationId);
        }
        if (isThenable(raw)) {
          try { void Promise.resolve(raw).then(undefined, () => undefined); } catch { /* observed */ }
          throw new CommandJournalError('capability_unavailable', prepared.operationId);
        }
        const plan = normalizePlan(raw, prepared);
        const result = this.#validateOutput(plan.result, prepared);
        const beforeCommit = this.#readEntry(prepared.key, prepared.operationId);
        if (beforeCommit !== null) {
          this.#assertMatches(beforeCommit, prepared);
          return this.#resolveExisting(beforeCommit, prepared);
        }
        const committedAt = this.#now();
        const expiresAt = prepared.policy.resultRetentionMs === null
          ? null : committedAt + prepared.policy.resultRetentionMs;
        const reservation = this.#comm.reserve(prepared.key, this.#capacityFor(prepared), { required: true });
        this.#assertPolicyQuota(prepared, quota);
        this.#applyMutations(prepared, plan.mutations);
        const terminal = this.#terminalEntry(prepared, committedAt, expiresAt, result, 'committed', null);
        this.#comm.commit(reservation, prepared.key, encodeEntry(terminal), null);
        this.#indexRetention(prepared.key, expiresAt);
        return result;
      }).immediate());
    } catch (error) {
      const mapped = this.#mapStoreError(error, prepared.operationId);
      if (mapped.code === 'conflict') {
        const stored = this.#maybeStoredResult(prepared);
        if (stored !== null) return stored.result;
        this.#recordConflictIfAbsent(prepared);
      }
      throw mapped;
    } finally {
      reader.revoke();
    }
  }

  async #runInvoked(prepared: PreparedCommand, business: () => Promise<RpcJson>, quota: number): Promise<RpcJson> {
    if (prepared.policy.deduplication === 'external-contract') this.#requireExternal(prepared);
    let handle: PendingHandle;
    try {
      handle = this.#begin(prepared, quota);
    } catch (error) {
      const mapped = this.#mapStoreError(error, prepared.operationId);
      if (mapped.code === 'conflict') {
        const stored = this.#maybeStoredResult(prepared);
        if (stored !== null) return stored.result;
      }
      throw mapped;
    }
    let output: unknown;
    try {
      output = await business();
    } catch {
      this.#recordUnknown(prepared.key, this.#terminalEntry(prepared, handle.createdAt, null, null, 'unknown', null), prepared.operationId, true);
      throw new CommandJournalError('unknown', prepared.operationId);
    }
    let result: RpcJson;
    try {
      result = this.#validateOutput(output, prepared);
    } catch {
      this.#recordUnknown(prepared.key, this.#terminalEntry(prepared, handle.createdAt, null, null, 'unknown', null), prepared.operationId, true);
      throw new CommandJournalError('unknown', prepared.operationId);
    }
    const committedAt = this.#now();
    const expiresAt = prepared.policy.resultRetentionMs === null
      ? null : committedAt + prepared.policy.resultRetentionMs;
    const terminal = this.#terminalEntry(prepared, committedAt, expiresAt, result, 'committed', null);
    let sawCommitted = false;
    let storedResult: RpcJson = null;
    try {
      this.#write(prepared.operationId, () => this.#db.transaction(() => {
        const existing = this.#readEntry(prepared.key, prepared.operationId);
        if (existing === null) throw new CommandJournalError('conflict', prepared.operationId);
        this.#assertMatches(existing, prepared);
        if (existing.state === 'committed') {
          if (this.#statusOf(existing) !== 'committed') {
            throw new CommandJournalError('expired', prepared.operationId);
          }
          sawCommitted = true;
          storedResult = existing.result;
          return;
        }
        if (existing.state !== 'pending') throw new CommandJournalError('conflict', prepared.operationId);
        this.#comm.ack(prepared.key);
        this.#comm.commit(handle.reservation, prepared.key, encodeEntry(terminal), null);
        this.#indexRetention(prepared.key, expiresAt);
      }).immediate());
    } catch (error) {
      const mapped = this.#mapStoreError(error, prepared.operationId);
      if (mapped.code === 'conflict') {
        const stored = this.#maybeStoredResult(prepared);
        if (stored !== null) return stored.result;
      }
      this.#recordUnknown(prepared.key, this.#terminalEntry(prepared, handle.createdAt, null, null, 'unknown', null), prepared.operationId, true);
      throw mapped;
    }
    return sawCommitted ? storedResult : result;
  }

  #begin(prepared: PreparedCommand, quota: number): PendingHandle {
    const createdAt = this.#now();
    const pending = this.#terminalEntry(prepared, createdAt, null, null, 'pending', null);
    const capacity = this.#capacityFor(prepared);
    const reservation = this.#write(prepared.operationId, () => this.#db.transaction(() => {
      // Pending own row and the terminal reservation are prepaid in the same transaction.
      this.#comm.put(prepared.key, encodeEntry(pending), { required: true });
      const created = this.#comm.reserve(prepared.key, capacity, { required: true });
      this.#assertPolicyQuota(prepared, quota);
      return created;
    }).immediate());
    return Object.freeze({ reservation, createdAt });
  }

  /** Exact worst-case encoded header plus the bounded result and retention index overhead. */
  #capacityFor(prepared: PreparedCommand, entry?: JournalEntry): number {
    const retentionMeta = prepared.policy.resultRetentionMs === null ? 0 : RETENTION_META_BYTES;
    const header = entryHeaderBytes(entry ?? this.#terminalEntry(prepared, 0, null, null, 'pending', null));
    return header + prepared.policy.maxResultBytes + CAPACITY_SLACK_BYTES + retentionMeta;
  }

  /** Hard per-namespace policy gate over the real cumulative charge, applied before side effects. */
  #assertPolicyQuota(prepared: PreparedCommand, quota: number): void {
    const status = this.#comm.status();
    if (status.usedBytes + status.reservedBytes > quota) {
      throw new CommandJournalError('overloaded', prepared.operationId);
    }
  }

  /**
   * Persistent, atomic namespace policy binding kept as one prepaid P3 record in this namespace.
   * The constructor's declared quota and the command's declared quota must agree on first admit;
   * afterwards the persisted binding is authoritative and any mismatch is refused explicitly.
   */
  #bind(prepared: PreparedCommand): number {
    return this.#write(prepared.operationId, () => this.#db.transaction(() => {
      const record = this.#comm.get(POLICY_MARKER_KEY);
      if (record === null) {
        if (this.#declaredQuota !== null && this.#declaredQuota !== prepared.declaredQuota) {
          throw new CommandJournalError('invalid_input', prepared.operationId);
        }
        const quota = this.#declaredQuota ?? prepared.declaredQuota;
        const binding: BindingValue = Object.freeze({
          quotaBytes: quota,
          privateNamespace: this.#privateNamespace,
          contractId: prepared.contractId,
          contractVersion: prepared.contractVersion,
          method: prepared.method,
        });
        this.#comm.put(POLICY_MARKER_KEY, ENCODER.encode(JSON.stringify(binding)), { required: true });
        this.#assertPolicyQuota(prepared, quota);
        return quota;
      }
      const binding = parseBinding(DECODER.decode(record.payload));
      if (binding.privateNamespace !== this.#privateNamespace
        || binding.contractId !== prepared.contractId
        || binding.contractVersion !== prepared.contractVersion
        || binding.method !== prepared.method) {
        throw new CommandJournalError('conflict', prepared.operationId);
      }
      if (binding.quotaBytes !== prepared.declaredQuota
        || (this.#declaredQuota !== null && this.#declaredQuota !== binding.quotaBytes)) {
        throw new CommandJournalError('invalid_input', prepared.operationId);
      }
      return binding.quotaBytes;
    }).immediate());
  }

  /**
   * Applies private-state mutations with direct SQL CAS in the caller's transaction. The journal
   * receipt is the only idempotency evidence: no second command-history table is written.
   */
  #applyMutations(prepared: PreparedCommand, mutations: readonly DurableMutation[]): void {
    for (const mutation of mutations) {
      const row = this.#db.query<{ version: number }, [string, string]>(
        'SELECT version FROM plugin_durable_records WHERE namespace = ? AND key = ?',
      ).get(this.#privateNamespace, mutation.key);
      const current = row === null ? 0 : row.version;
      if (!Number.isSafeInteger(current) || current < 0) {
        throw new CommandJournalError('storage_failure', prepared.operationId);
      }
      if (current !== mutation.expectedVersion) {
        throw new CommandJournalError('conflict', prepared.operationId);
      }
      const json = JSON.stringify(mutation.value);
      if (Buffer.byteLength(json, 'utf8') > DURABLE_LIMIT_BYTES) {
        throw new CommandJournalError('invalid_input', prepared.operationId);
      }
      if (row === null) {
        this.#db.run(
          'INSERT INTO plugin_durable_records(namespace,key,version,value_json) VALUES (?,?,?,?)',
          [this.#privateNamespace, mutation.key, 1, json],
        );
      } else {
        const changed = this.#db.run(
          'UPDATE plugin_durable_records SET version = ?, value_json = ? WHERE namespace = ? AND key = ? AND version = ?',
          [mutation.expectedVersion + 1, json, this.#privateNamespace, mutation.key, mutation.expectedVersion],
        );
        if (changed.changes !== 1) {
          throw new CommandJournalError('conflict', prepared.operationId);
        }
      }
    }
  }

  #indexRetention(key: string, expiresAt: number | null): void {
    if (expiresAt === null) return;
    this.#db.run(
      'INSERT OR REPLACE INTO plugin_command_journal_retention(namespace, key, expires_at) VALUES (?,?,?)',
      [this.#comm.namespace, key, expiresAt],
    );
  }

  #dropRetention(key: string): void {
    this.#db.run(
      'DELETE FROM plugin_command_journal_retention WHERE namespace = ? AND key = ?',
      [this.#comm.namespace, key],
    );
  }

  /** Keeps the accepted reservation and writes a permanent unknown entry over the pending row. */
  #recordUnknown(key: string, terminal: JournalEntry, operationId: string | null, swallow: boolean): void {
    const body = (): void => {
      this.#db.transaction(() => {
        const existing = this.#readEntry(key, operationId);
        if (existing !== null) {
          if (!sameIdentity(existing, terminal)) throw new CommandJournalError('conflict', operationId);
          if (existing.state !== 'pending') return; // already terminal/unknown: immutable
        } else {
          const receipt = this.#comm.receipt(key);
          if (receipt !== null) return; // a terminal old op exists
        }
        this.#comm.ack(key);
        this.#comm.put(key, encodeEntry(terminal), { required: true });
        this.#dropRetention(key);
      }).immediate();
    };
    if (swallow) {
      try { this.#write(operationId, body); } catch { /* keep the pending evidence */ }
    } else {
      this.#write(operationId, body);
    }
  }

  /** Releases any reservation and writes a permanent rejected entry; never overwrites a terminal. */
  #recordReleased(key: string, terminal: JournalEntry, operationId: string | null): void {
    this.#write(operationId, () => this.#db.transaction(() => {
      const existing = this.#readEntry(key, operationId);
      if (existing !== null) {
        if (!sameIdentity(existing, terminal)) throw new CommandJournalError('conflict', operationId);
        if (existing.state === 'rejected' || existing.state === 'error') return;
        if (existing.state === 'committed') throw new CommandJournalError('conflict', operationId);
      } else {
        const receipt = this.#comm.receipt(key);
        if (receipt !== null) throw new CommandJournalError('conflict', operationId);
      }
      this.#comm.cancel(key);
      this.#comm.ack(key);
      this.#comm.put(key, encodeEntry(terminal), { required: true });
      this.#dropRetention(key);
    }).immediate());
  }

  /** Records a conflict judgement only when no live/terminal old operation exists. */
  #recordConflictIfAbsent(prepared: PreparedCommand): void {
    try {
      this.#write(prepared.operationId, () => this.#db.transaction(() => {
        if (this.#readEntry(prepared.key, prepared.operationId) !== null) return;
        if (this.#comm.receipt(prepared.key) !== null) return;
        const terminal = this.#terminalEntry(prepared, this.#now(), null, null, 'rejected', null);
        this.#comm.put(prepared.key, encodeEntry(terminal), { required: true });
        this.#dropRetention(prepared.key);
      }).immediate());
    } catch { /* no durable judgement leaves the operation retryable */ }
  }

  /** Commits a confirmed result over an unknown/pending entry; an existing result stays immutable. */
  #confirmResult(prepared: PreparedCommand, terminal: JournalEntry): RpcJson {
    const capacity = this.#capacityFor(prepared, terminal);
    const bytes = encodeEntry(terminal);
    let effective: RpcJson = terminal.result;
    this.#write(prepared.operationId, () => this.#db.transaction(() => {
      const existing = this.#readEntry(prepared.key, prepared.operationId);
      if (existing === null) throw new CommandJournalError('conflict', prepared.operationId);
      this.#assertMatches(existing, prepared);
      if (existing.state === 'committed') {
        if (this.#statusOf(existing) !== 'committed') {
          // A stale (expired) committed result must never be returned as a fresh confirmation.
          throw new CommandJournalError('expired', prepared.operationId);
        }
        effective = existing.result;
        return;
      }
      if (existing.state !== 'unknown' && existing.state !== 'pending') {
        throw new CommandJournalError('conflict', prepared.operationId);
      }
      const reservation = this.#comm.reserve(prepared.key, capacity, { required: true });
      this.#comm.ack(prepared.key);
      this.#comm.commit(reservation, prepared.key, bytes, null);
      this.#indexRetention(prepared.key, terminal.expiresAt);
      effective = terminal.result;
    }).immediate());
    return effective;
  }

  #recoverOne(key: string, observed: JournalEntry, terminal: JournalEntry): boolean {
    return this.#write(null, () => this.#db.transaction(() => {
      const current = this.#readEntry(key, null);
      if (current === null || current.fingerprint !== observed.fingerprint
        || current.state !== 'pending' || !sameIdentity(current, terminal)) {
        return false;
      }
      // Fixed-size entries: pending -> unknown shrinks padding, so the record charge does not grow.
      this.#comm.ack(key);
      this.#comm.put(key, encodeEntry(terminal), { required: true });
      this.#dropRetention(key);
      return true;
    }).immediate());
  }

  /**
   * Returns `{ result }` for a committed same-fingerprint entry, else null. A wrapper is used so a
   * legitimate committed `null` result is never confused with "no stored result". An expired
   * committed entry throws `expired` instead of returning a stale result. Tamper conflicts.
   */
  #maybeStoredResult(prepared: PreparedCommand): { readonly result: RpcJson } | null {
    const entry = this.#readEntry(prepared.key, prepared.operationId);
    if (entry === null) return null;
    this.#assertMatches(entry, prepared);
    if (entry.state !== 'committed') return null;
    if (this.#statusOf(entry) !== 'committed') {
      throw new CommandJournalError('expired', prepared.operationId);
    }
    return Object.freeze({ result: entry.result });
  }

  #terminalEntry(
    prepared: PreparedCommand,
    createdAt: number,
    expiresAt: number | null,
    result: RpcJson | null,
    state: JournalState,
    recovery: CommandRecoveryEvidence | null,
  ): JournalEntry {
    const entry: JournalEntry = {
      v: 1,
      state,
      operationId: prepared.operationId,
      fingerprint: prepared.fingerprint,
      contract: Object.freeze({ id: prepared.contractId, version: prepared.contractVersion }),
      method: prepared.method,
      caller: Object.freeze({ subject: prepared.caller.subject, scope: prepared.caller.scope ?? null }),
      source: prepared.source,
      createdAt,
      expiresAt,
      result,
      recovery,
    };
    return Object.freeze(entry);
  }

  #terminalEntryFrom(
    base: JournalEntry,
    expiresAt: number | null,
    result: RpcJson | null,
    state: JournalState,
    recovery: CommandRecoveryEvidence | null,
  ): JournalEntry {
    const entry: JournalEntry = {
      v: 1,
      state,
      operationId: base.operationId,
      fingerprint: base.fingerprint,
      contract: Object.freeze({ id: base.contract.id, version: base.contract.version }),
      method: base.method,
      caller: Object.freeze({ subject: base.caller.subject, scope: base.caller.scope ?? null }),
      source: base.source,
      createdAt: base.createdAt,
      expiresAt,
      result,
      recovery,
    };
    return Object.freeze(entry);
  }

  #requireExternal(prepared: PreparedCommand): { reconcile: (execution: CommandJournalRequest) => CommandExternalReconciliation | Promise<CommandExternalReconciliation> } {
    const resolver = this.#resolveExternal;
    if (resolver === undefined) throw new CommandJournalError('capability_unavailable', prepared.operationId);
    let capability: unknown;
    try { capability = resolver(prepared.execution); }
    catch { throw new CommandJournalError('capability_unavailable', prepared.operationId); }
    const reconcile = plainFunctionProperty(capability, 'reconcile');
    if (reconcile === null) throw new CommandJournalError('capability_unavailable', prepared.operationId);
    return Object.freeze({
      reconcile: (execution: CommandJournalRequest): CommandExternalReconciliation | Promise<CommandExternalReconciliation> =>
        reconcile.call(capability, execution) as CommandExternalReconciliation | Promise<CommandExternalReconciliation>,
    });
  }

  /** Snapshots a reconciliation outcome through the wire codec; hostile accessors never run. */
  #snapshotOutcome(returned: unknown, prepared: PreparedCommand): CommandExternalReconciliation {
    let text: string;
    try { text = encodeRpcJson(returned, RPC_JSON_MAX_BYTES); }
    catch { throw new CommandJournalError('unknown', prepared.operationId); }
    let clone: unknown;
    try { clone = decodeRpcJson(text, RPC_JSON_MAX_BYTES); }
    catch { throw new CommandJournalError('unknown', prepared.operationId); }
    if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
      throw new CommandJournalError('unknown', prepared.operationId);
    }
    const record = clone as Record<string, unknown>;
    const keys = Object.keys(record);
    const status = record.status;
    if (status === 'unknown' || status === 'not-executed') {
      if (keys.length !== 1) throw new CommandJournalError('unknown', prepared.operationId);
      return Object.freeze({ status });
    }
    if (status === 'committed') {
      if (keys.length !== 2 || !keys.includes('result')) {
        throw new CommandJournalError('unknown', prepared.operationId);
      }
      return Object.freeze({ status: 'committed' as const, result: record.result as RpcJson });
    }
    throw new CommandJournalError('unknown', prepared.operationId);
  }

  #openReader(): { readonly capability: CommandAtomicReader; readonly revoke: () => void } {
    const db = this.#db;
    const namespace = this.#privateNamespace;
    const rowLimit = this.#atomicReadRows;
    const byteLimit = this.#atomicReadBytes;
    const queryLimit = this.#atomicReadQueries;
    let live = true;
    let rowsRead = 0;
    let bytesRead = 0;
    let queries = 0;
    const guard = (): void => {
      if (!live) throw new CommandJournalError('capability_unavailable', null);
    };
    /** Checked BEFORE issuing any statement so an exhausted budget performs no IO. */
    const spendQuery = (): void => {
      if (queries >= queryLimit) throw new CommandJournalError('capability_unavailable', null);
      queries += 1;
    };
    const spend = (rows: number, bytes: number): void => {
      rowsRead += rows;
      bytesRead += bytes;
      if (rowsRead > rowLimit || bytesRead > byteLimit) {
        throw new CommandJournalError('capability_unavailable', null);
      }
    };
    const fetchValue = (key: string): DurableJson => {
      spendQuery();
      let row: { value_json: string } | null;
      try {
        row = db.query<{ value_json: string }, [string, string]>(
          'SELECT value_json FROM plugin_durable_records WHERE namespace = ? AND key = ?',
        ).get(namespace, key);
      } catch { throw new CommandJournalError('storage_failure', null); }
      if (row === null) throw new CommandJournalError('storage_failure', null);
      let value: unknown;
      try { value = JSON.parse(row.value_json); } catch { throw new CommandJournalError('storage_failure', null); }
      return deepFreeze(value as DurableJson);
    };
    const capability: CommandAtomicReader = Object.freeze({
      get: (key: string): DurableRecord | null => {
        guard();
        if (typeof key !== 'string' || !IDENTIFIER.test(key)) throw new CommandJournalError('invalid_input', null);
        if (rowsRead >= rowLimit) throw new CommandJournalError('capability_unavailable', null);
        spendQuery();
        let meta: { version: number; bytes: number } | null;
        try {
          meta = db.query<{ version: number; bytes: number }, [string, string]>(
            'SELECT version, length(CAST(value_json AS BLOB)) AS bytes FROM plugin_durable_records WHERE namespace = ? AND key = ?',
          ).get(namespace, key);
        } catch { throw new CommandJournalError('storage_failure', null); }
        spend(1, 0);
        if (meta === null) return null;
        if (!Number.isSafeInteger(meta.version) || meta.version < 1
          || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0) {
          throw new CommandJournalError('storage_failure', null);
        }
        spend(0, meta.bytes); // reject on budget BEFORE fetching/parsing the body
        const value = fetchValue(key);
        return Object.freeze({ key, version: meta.version, value });
      },
      list: (): readonly DurableRecord[] => {
        guard();
        const remaining = rowLimit - rowsRead;
        if (remaining <= 0) throw new CommandJournalError('capability_unavailable', null);
        spendQuery();
        let metas: DurableMetaRow[];
        try {
          metas = db.query<DurableMetaRow, [string, number]>(
            `SELECT key, version, length(CAST(value_json AS BLOB)) AS bytes
             FROM plugin_durable_records WHERE namespace = ? ORDER BY key LIMIT ?`,
          ).all(namespace, remaining);
        } catch { throw new CommandJournalError('storage_failure', null); }
        let bytes = 0;
        for (const meta of metas) {
          if (typeof meta.key !== 'string' || !Number.isSafeInteger(meta.version) || meta.version < 1
            || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0) {
            throw new CommandJournalError('storage_failure', null);
          }
          bytes += meta.bytes;
        }
        spend(metas.length, bytes); // reject on budget BEFORE fetching/parsing any body
        const records: DurableRecord[] = [];
        for (const meta of metas) {
          records.push(Object.freeze({ key: meta.key, version: meta.version, value: fetchValue(meta.key) }));
        }
        return Object.freeze(records);
      },
    });
    return Object.freeze({ capability, revoke: () => { live = false; } });
  }

  #validateOutput(value: unknown, prepared: PreparedCommand): RpcJson {
    try {
      assertRpcData(prepared.definition.output, value, prepared.policy.maxResultBytes);
    } catch {
      throw new CommandJournalError('invalid_output', prepared.operationId);
    }
    let encoded: string;
    try {
      encoded = encodeRpcJson(value, prepared.policy.maxResultBytes);
    } catch {
      throw new CommandJournalError('invalid_output', prepared.operationId);
    }
    return JSON.parse(encoded) as RpcJson;
  }

  #prepare(execution: CommandJournalRequest): PreparedCommand {
    if (execution === null || typeof execution !== 'object') {
      throw new CommandJournalError('invalid_input', null);
    }
    const operationId = execution.operationId;
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
      throw new CommandJournalError('invalid_input', null);
    }
    const context = execution.context;
    const caller = context === null || typeof context !== 'object' ? undefined : context.caller;
    if (caller === null || caller === undefined || typeof caller !== 'object'
      || typeof caller.subject !== 'string' || caller.subject.length === 0
      || Buffer.byteLength(caller.subject, 'utf8') > SUBJECT_MAX_BYTES) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const rawScope = caller.scope;
    if (rawScope !== undefined && (typeof rawScope !== 'string' || !SCOPES.has(rawScope as PluginServiceScope))) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const contract = execution.contract;
    if (contract === null || contract === undefined || typeof contract !== 'object'
      || typeof contract.id !== 'string' || contract.id.length === 0
      || !Number.isSafeInteger(contract.version) || contract.version < 1) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const method = execution.method;
    if (typeof method !== 'string' || method.length === 0) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const definition = execution.definition;
    if (definition === null || definition === undefined || typeof definition !== 'object') {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const policy = definition.command;
    if (policy === null || policy === undefined || typeof policy !== 'object') {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const deduplication = policy.deduplication;
    if (deduplication !== 'local-transaction' && deduplication !== 'external-contract' && deduplication !== 'none') {
      throw new CommandJournalError('invalid_input', operationId);
    }
    if (!Number.isSafeInteger(policy.maxResultBytes) || policy.maxResultBytes < 1) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const retention = policy.resultRetentionMs;
    if (retention !== null && (!Number.isSafeInteger(retention) || retention < 1)) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    if (!Number.isSafeInteger(policy.quotaBytes) || policy.quotaBytes < policy.maxResultBytes) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const endpoint = context === null || typeof context !== 'object' ? undefined : context.endpoint;
    const source = readSource(endpoint, operationId);
    const frozenCaller: RpcCaller = Object.freeze(rawScope === undefined
      ? { subject: caller.subject }
      : { subject: caller.subject, scope: rawScope as PluginServiceScope });
    return Object.freeze({
      // `Omit` only hides a type member. Explicitly remove the business capability
      // before granting the invocation to resolvers and atomic planners.
      execution: Object.freeze({ contract, method, definition, context, operationId, input: execution.input }),
      operationId,
      method,
      definition,
      policy,
      declaredQuota: policy.quotaBytes,
      caller: frozenCaller,
      source,
      owner: sourceOwner(source),
      contractId: contract.id,
      contractVersion: contract.version,
      key: commandEntryKey(frozenCaller, operationId),
      fingerprint: commandFingerprint(contract.id, contract.version, method, frozenCaller, operationId, execution.input),
    });
  }

  #assertMatches(entry: JournalEntry, prepared: PreparedCommand): void {
    if (entry.operationId !== prepared.operationId
      || entry.fingerprint !== prepared.fingerprint
      || entry.contract.id !== prepared.contractId
      || entry.contract.version !== prepared.contractVersion
      || entry.method !== prepared.method
      || entry.caller.subject !== prepared.caller.subject
      || (entry.caller.scope ?? null) !== (prepared.caller.scope ?? null)) {
      throw new CommandJournalError('conflict', prepared.operationId);
    }
  }

  #statusOf(entry: JournalEntry): CommandJournalStatus {
    if (entry.state === 'committed') {
      if (entry.expiresAt !== null && this.#now() >= entry.expiresAt) return 'expired';
      return 'committed';
    }
    if (entry.state === 'pending') return 'pending';
    if (entry.state === 'unknown') return 'unknown';
    if (entry.state === 'error') return 'error';
    return 'rejected';
  }

  #readEntry(key: string, operationId: string | null): JournalEntry | null {
    const record = this.#write(operationId, () => this.#comm.get(key));
    if (record === null) return null;
    return parseEntry(DECODER.decode(record.payload));
  }

  #queryKey(operationId: string, caller: RpcCaller): string {
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
      throw new CommandJournalError('invalid_input', null);
    }
    if (caller === null || caller === undefined || typeof caller !== 'object'
      || typeof caller.subject !== 'string' || caller.subject.length === 0) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const scope = caller.scope;
    if (scope !== undefined && (typeof scope !== 'string' || !SCOPES.has(scope as PluginServiceScope))) {
      throw new CommandJournalError('invalid_input', operationId);
    }
    const frozenCaller: RpcCaller = Object.freeze(scope === undefined
      ? { subject: caller.subject }
      : { subject: caller.subject, scope: scope as PluginServiceScope });
    return commandEntryKey(frozenCaller, operationId);
  }

  #inspectKey(key: string, operationId: string, caller: RpcCaller): CommandJournalInspection {
    const entry = this.#readEntry(key, operationId);
    if (entry !== null) {
      if (entry.operationId !== operationId || entry.caller.subject !== caller.subject
        || (entry.caller.scope ?? null) !== (caller.scope ?? null)) {
        return Object.freeze({ status: 'conflict' as const });
      }
      if (entry.state === 'committed' && this.#now() >= (entry.expiresAt ?? Infinity)) {
        return Object.freeze({ status: 'expired' as const, expiresAt: entry.expiresAt });
      }
      const status = this.#statusOf(entry);
      switch (status) {
        case 'committed':
          return Object.freeze({ status: 'committed' as const, result: entry.result, expiresAt: entry.expiresAt });
        case 'expired':
          return Object.freeze({ status: 'expired' as const, expiresAt: entry.expiresAt });
        case 'pending':
          return Object.freeze({ status: 'pending' as const });
        case 'unknown':
          return Object.freeze({ status: 'unknown' as const });
        case 'error':
          return Object.freeze({ status: 'error' as const });
        case 'conflict':
          return Object.freeze({ status: 'conflict' as const });
        case 'missing':
          return Object.freeze({ status: 'missing' as const });
        default:
          return Object.freeze({ status: 'rejected' as const });
      }
    }
    const receipt = this.#write(operationId, () => this.#comm.receipt(key));
    if (receipt !== null) return Object.freeze({ status: 'expired' as const, expiresAt: null });
    return Object.freeze({ status: 'missing' as const });
  }

  #write<Result>(operationId: string | null, action: () => Result): Result {
    try {
      return action();
    } catch (error) {
      throw this.#mapStoreError(error, operationId);
    }
  }

  #mapStoreError(error: unknown, operationId: string | null): CommandJournalError {
    if (error instanceof CommunicationStoreError) {
      switch (error.code) {
        case 'storage_failure': return new CommandJournalError('storage_failure', operationId);
        case 'corruption': return new CommandJournalError('storage_failure', operationId);
        case 'quota_exceeded': return new CommandJournalError('overloaded', operationId);
        case 'overloaded': return new CommandJournalError('overloaded', operationId);
        case 'reservation_conflict': return new CommandJournalError('conflict', operationId);
        case 'reservation_missing': return new CommandJournalError('conflict', operationId);
        case 'record_protected': return new CommandJournalError('conflict', operationId);
        default: return new CommandJournalError('invalid_input', operationId);
      }
    }
    const code = ownJournalCode(error);
    return new CommandJournalError(code ?? 'storage_failure', operationId);
  }
}

/** Identity comparison used by every guarded terminal writer. */
function sameIdentity(entry: JournalEntry, terminal: JournalEntry): boolean {
  return entry.operationId === terminal.operationId
    && entry.fingerprint === terminal.fingerprint
    && entry.contract.id === terminal.contract.id
    && entry.contract.version === terminal.contract.version
    && entry.method === terminal.method
    && entry.caller.subject === terminal.caller.subject
    && (entry.caller.scope ?? null) === (terminal.caller.scope ?? null);
}

function validateRecoveryEvidence(value: unknown): CommandRecoveryEvidence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (isProxy(value)) return null;
  const ownerDescriptor = Object.getOwnPropertyDescriptor(value, 'owner');
  const epochDescriptor = Object.getOwnPropertyDescriptor(value, 'epoch');
  const issuedDescriptor = Object.getOwnPropertyDescriptor(value, 'issuedAt');
  if (ownerDescriptor === undefined || !('value' in ownerDescriptor)
    || typeof ownerDescriptor.value !== 'string' || !OWNER_PATTERN.test(ownerDescriptor.value)) return null;
  if (epochDescriptor === undefined || !('value' in epochDescriptor)
    || !Number.isSafeInteger(epochDescriptor.value) || (epochDescriptor.value as number) < 0) return null;
  if (issuedDescriptor === undefined || !('value' in issuedDescriptor)
    || !Number.isSafeInteger(issuedDescriptor.value) || (issuedDescriptor.value as number) < 0) return null;
  return Object.freeze({
    owner: ownerDescriptor.value as string,
    epoch: epochDescriptor.value as number,
    issuedAt: issuedDescriptor.value as number,
  });
}

function statusCode(status: CommandJournalStatus): CommandJournalErrorCode {
  switch (status) {
    case 'expired': return 'expired';
    case 'pending': return 'pending';
    case 'unknown': return 'unknown';
    case 'rejected': return 'rejected';
    case 'error': return 'rejected';
    case 'conflict': return 'conflict';
    case 'missing': return 'missing';
    case 'committed': return 'rejected';
  }
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new CommandJournalError('invalid_input', null);
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CommandJournalError('invalid_input', null);
  }
  return value as number;
}
