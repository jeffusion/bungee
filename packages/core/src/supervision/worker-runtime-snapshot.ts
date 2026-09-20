import { validateDigest } from '../config-storage/repository-validation';
import { isLowercaseUuid } from '../config-storage/validation';
import {
  getRuntimeStateSnapshot,
  MAX_RUNTIME_STATE_SNAPSHOT_RECORDS,
  RuntimeStateSnapshotError,
} from '../worker/state/runtime-state';

export const WORKER_RUNTIME_SNAPSHOT_SCHEMA = 'bungee-worker-runtime-snapshot-v1' as const;
export const MAX_WORKER_RUNTIME_SNAPSHOT_RECORDS = MAX_RUNTIME_STATE_SNAPSHOT_RECORDS;
/** The signed HTTP wrapper has a 256 KiB limit; this reserves space for it. */
export const MAX_WORKER_RUNTIME_SNAPSHOT_BODY_BYTES = 240 * 1024;

export type WorkerRuntimeCircuitState = 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';

export interface WorkerRuntimeSnapshotRecord {
  readonly state_key: string;
  readonly upstream_id: string;
  /** Circuit-breaker state only; this is not proof of an active health probe. */
  readonly circuit_state: WorkerRuntimeCircuitState;
  readonly active_request_count: number;
  readonly last_used_time: number | null;
  readonly last_failure_time: number | null;
  readonly consecutive_failures: number;
  readonly consecutive_successes: number;
  readonly health_check_successes: number;
  readonly health_check_failures: number;
  readonly recovery_attempt_count: number;
}

export interface WorkerRuntimeSnapshotIdentity {
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
  readonly pid: number;
  readonly private_port: number;
  readonly revision: number;
  readonly content_hash: string;
  readonly plugin_catalog_hash: string;
}

export interface WorkerRuntimeSnapshotComplete {
  readonly kind: 'complete';
  readonly records: readonly WorkerRuntimeSnapshotRecord[];
}

export type WorkerRuntimeSnapshotOverflowReason = 'record_count' | 'payload_bytes';

export interface WorkerRuntimeSnapshotOverflow {
  readonly kind: 'overflow';
  readonly reason: WorkerRuntimeSnapshotOverflowReason;
  readonly upstream_count: number;
}

export type WorkerRuntimeSnapshotResult = WorkerRuntimeSnapshotComplete | WorkerRuntimeSnapshotOverflow;

export interface WorkerRuntimeSnapshot extends WorkerRuntimeSnapshotIdentity {
  readonly schema: typeof WORKER_RUNTIME_SNAPSHOT_SCHEMA;
  readonly captured_at: number;
  readonly result: WorkerRuntimeSnapshotResult;
}

export type WorkerRuntimeSnapshotInput = WorkerRuntimeSnapshotIdentity & {
  readonly captured_at: number;
};

/** Synchronous state source injected by the worker lifecycle/composition boundary. */
export type WorkerRuntimeSnapshotProvider = (input: WorkerRuntimeSnapshotInput) => WorkerRuntimeSnapshot;

export type WorkerRuntimeSnapshotErrorCode = 'invalid_snapshot' | 'runtime_state_invalid';

export class WorkerRuntimeSnapshotError extends Error {
  readonly name = 'WorkerRuntimeSnapshotError';

  constructor(
    readonly code: WorkerRuntimeSnapshotErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
  }
}

const ROOT_KEYS = [
  'boot_nonce', 'captured_at', 'content_hash', 'master_generation', 'pid',
  'plugin_catalog_hash', 'private_port', 'result', 'revision', 'schema',
  'worker_instance_id', 'worker_slot',
] as const;
const COMPLETE_RESULT_KEYS = ['kind', 'records'] as const;
const OVERFLOW_RESULT_KEYS = ['kind', 'reason', 'upstream_count'] as const;
const RECORD_KEYS = [
  'active_request_count', 'circuit_state', 'consecutive_failures', 'consecutive_successes',
  'health_check_failures', 'health_check_successes', 'last_failure_time', 'last_used_time',
  'recovery_attempt_count', 'state_key', 'upstream_id',
] as const;
const CIRCUIT_STATES = new Set<WorkerRuntimeCircuitState>(['HEALTHY', 'UNHEALTHY', 'HALF_OPEN']);

function invalid(message: string, cause?: unknown): never {
  throw new WorkerRuntimeSnapshotError('invalid_snapshot', `invalid worker runtime snapshot: ${message}`, cause);
}

function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('expected a plain object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid('expected a plain object');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid('unexpected or missing field');
  }
}

function text(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || value[key].length === 0) invalid(`${key} must be a non-empty string`);
  return value[key] as string;
}

function safeInteger(value: Record<string, unknown>, key: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    invalid(`${key} must be a safe integer >= ${minimum}`);
  }
  return candidate;
}

function epoch(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
    invalid(`${key} must be a non-negative safe epoch integer`);
  }
  return candidate;
}

function nullableEpoch(value: Record<string, unknown>, key: string): number | null {
  return value[key] === null ? null : epoch(value, key);
}

function normalizeRecord(value: unknown, index: number): WorkerRuntimeSnapshotRecord {
  const input = plain(value);
  exact(input, RECORD_KEYS);
  const stateKey = text(input, 'state_key');
  const upstreamId = text(input, 'upstream_id');
  const circuitState = text(input, 'circuit_state') as WorkerRuntimeCircuitState;
  if (!CIRCUIT_STATES.has(circuitState)) invalid(`result.records[${index}].circuit_state is invalid`);
  return {
    state_key: stateKey,
    upstream_id: upstreamId,
    circuit_state: circuitState,
    active_request_count: safeInteger(input, 'active_request_count', 0),
    last_used_time: nullableEpoch(input, 'last_used_time'),
    last_failure_time: nullableEpoch(input, 'last_failure_time'),
    consecutive_failures: safeInteger(input, 'consecutive_failures', 0),
    consecutive_successes: safeInteger(input, 'consecutive_successes', 0),
    health_check_successes: safeInteger(input, 'health_check_successes', 0),
    health_check_failures: safeInteger(input, 'health_check_failures', 0),
    recovery_attempt_count: safeInteger(input, 'recovery_attempt_count', 0),
  };
}

function compareRecords(left: WorkerRuntimeSnapshotRecord, right: WorkerRuntimeSnapshotRecord): number {
  return left.state_key < right.state_key ? -1
    : left.state_key > right.state_key ? 1
      : left.upstream_id < right.upstream_id ? -1
        : left.upstream_id > right.upstream_id ? 1 : 0;
}

function digest(value: Record<string, unknown>, key: string): string {
  const candidate = text(value, key);
  if (!validateDigest(candidate)) invalid(`${key} is invalid`);
  return candidate;
}

function normalizeRoot(value: unknown): WorkerRuntimeSnapshot {
  const input = plain(value);
  exact(input, ROOT_KEYS);
  if (input.schema !== WORKER_RUNTIME_SNAPSHOT_SCHEMA) invalid('schema is invalid');

  const masterGeneration = text(input, 'master_generation');
  const workerInstanceId = text(input, 'worker_instance_id');
  const bootNonce = text(input, 'boot_nonce');
  if (!isLowercaseUuid(masterGeneration) || !isLowercaseUuid(workerInstanceId) || !isLowercaseUuid(bootNonce)) {
    invalid('worker identity is invalid');
  }
  const identity: WorkerRuntimeSnapshotInput = {
    master_generation: masterGeneration,
    worker_instance_id: workerInstanceId,
    worker_slot: safeInteger(input, 'worker_slot', 0),
    boot_nonce: bootNonce,
    pid: safeInteger(input, 'pid', 1),
    private_port: safeInteger(input, 'private_port', 1, 65_535),
    revision: safeInteger(input, 'revision', 1),
    content_hash: digest(input, 'content_hash'),
    plugin_catalog_hash: digest(input, 'plugin_catalog_hash'),
    captured_at: epoch(input, 'captured_at'),
  };

  const resultInput = plain(input.result);
  let result: WorkerRuntimeSnapshotResult;
  if (resultInput.kind === 'complete') {
    exact(resultInput, COMPLETE_RESULT_KEYS);
    if (!Array.isArray(resultInput.records)) invalid('result.records must be an array');
    // Check cardinality before touching any record; hostile entries stay unread.
    if (resultInput.records.length > MAX_WORKER_RUNTIME_SNAPSHOT_RECORDS) {
      return overflowRoot(identity, 'record_count', resultInput.records.length);
    }
    const records = resultInput.records.map((record, index) => normalizeRecord(record, index)).sort(compareRecords);
    const seen = new Set<string>();
    for (const record of records) {
      const key = JSON.stringify([record.state_key, record.upstream_id]);
      if (seen.has(key)) invalid('records contain a duplicate state_key/upstream_id pair');
      seen.add(key);
    }
    result = { kind: 'complete', records };
  } else if (resultInput.kind === 'overflow') {
    exact(resultInput, OVERFLOW_RESULT_KEYS);
    const reason = resultInput.reason;
    if (reason !== 'record_count' && reason !== 'payload_bytes') invalid('result.reason is invalid');
    const upstreamCount = safeInteger(resultInput, 'upstream_count', reason === 'record_count'
      ? MAX_WORKER_RUNTIME_SNAPSHOT_RECORDS + 1 : 1);
    result = {
      kind: 'overflow',
      reason,
      upstream_count: upstreamCount,
    };
  } else {
    invalid('result.kind is invalid');
  }

  const root: WorkerRuntimeSnapshot = {
    schema: WORKER_RUNTIME_SNAPSHOT_SCHEMA,
    ...identity,
    result,
  };
  return freezeSnapshot(root);
}

function freezeSnapshot(snapshot: WorkerRuntimeSnapshot): WorkerRuntimeSnapshot {
  Object.freeze(snapshot.result);
  if (snapshot.result.kind === 'complete') {
    Object.freeze(snapshot.result.records);
    for (const record of snapshot.result.records) Object.freeze(record);
  }
  return Object.freeze(snapshot);
}

function payloadBytes(value: WorkerRuntimeSnapshot): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function overflowRoot(input: WorkerRuntimeSnapshotInput, reason: WorkerRuntimeSnapshotOverflow['reason'], upstream_count: number): WorkerRuntimeSnapshot {
  return freezeSnapshot({
    schema: WORKER_RUNTIME_SNAPSHOT_SCHEMA,
    ...input,
    result: { kind: 'overflow', reason, upstream_count },
  });
}

/** Normalizes the plain snapshot body; it returns no JSON bytes. */
export function normalizeWorkerRuntimeSnapshotBody(value: unknown): WorkerRuntimeSnapshot {
  const snapshot = normalizeRoot(value);
  if (snapshot.result.kind === 'overflow') return snapshot;
  if (payloadBytes(snapshot) <= MAX_WORKER_RUNTIME_SNAPSHOT_BODY_BYTES) return snapshot;
  return overflowRoot(snapshot, 'payload_bytes', snapshot.result.records.length);
}

/** Creates a bounded, identity-preserving snapshot body from runtime state. */
export function createWorkerRuntimeSnapshotFromState(input: WorkerRuntimeSnapshotInput): WorkerRuntimeSnapshot {
  let runtime;
  try { runtime = getRuntimeStateSnapshot(); }
  catch (cause) {
    if (cause instanceof RuntimeStateSnapshotError) {
      throw new WorkerRuntimeSnapshotError('runtime_state_invalid', cause.message, cause);
    }
    throw cause;
  }
  if (runtime.overflow > 0) {
    return normalizeWorkerRuntimeSnapshotBody(overflowRoot(
      input,
      'record_count',
      runtime.overflow + MAX_WORKER_RUNTIME_SNAPSHOT_RECORDS,
    ));
  }
  return normalizeWorkerRuntimeSnapshotBody({
    schema: WORKER_RUNTIME_SNAPSHOT_SCHEMA,
    ...input,
    result: { kind: 'complete', records: runtime.records },
  });
}

/** Parses only a strict JSON-body-reader plain object; JSON parsing is external. */
export function parseWorkerRuntimeSnapshot(value: unknown): WorkerRuntimeSnapshot {
  return normalizeWorkerRuntimeSnapshotBody(value);
}
