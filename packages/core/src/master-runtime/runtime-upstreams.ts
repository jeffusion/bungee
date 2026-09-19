import type { AdmissionSet } from '../ingress';
import type { WorkerRuntimeSnapshot, WorkerRuntimeSnapshotRecord } from '../supervision';
import type { SupervisedWorkerAdmissionIdentity } from './supervised-worker-factory';

const MAX_RECORDS = 4096;
const MAX_WORKERS = 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const SNAPSHOT_DEADLINE_MS = 750;

type ExpectedWorker = SupervisedWorkerAdmissionIdentity & { readonly admission_sequence: number };
type MissingReason = 'session_unavailable' | 'snapshot_unavailable' | 'timeout' | 'network' | 'protocol' | 'response_too_large' | 'invalid_identity' | 'duplicate_record' | 'snapshot_overflow' | 'admission_changed';
type MissingWorker = { readonly identity: ExpectedWorker; readonly reason: MissingReason; readonly at: number };
type ObservedWorker = { readonly identity: ExpectedWorker; readonly pid: number; readonly captured_at: number };
type StoredRecord = { readonly worker: ExpectedWorker; readonly record: WorkerRuntimeSnapshotRecord; readonly workerJson: string };

export type RuntimeUpstreamsSession = {
  runtimeSnapshot?: (signal?: AbortSignal) => Promise<WorkerRuntimeSnapshot>;
};

export type RuntimeUpstreamsOptions = {
  readonly activeAdmission: () => AdmissionSet | null;
  readonly lookupExactSession: (identity: SupervisedWorkerAdmissionIdentity) => RuntimeUpstreamsSession | null;
  readonly now: () => number;
  /** Aborts collection when this master is no longer allowed to publish runtime state. */
  readonly stopSignal?: AbortSignal;
};

function expectedWorkers(admission: AdmissionSet): readonly ExpectedWorker[] | null {
  const seen = new Set<string>();
  const workers = admission.workers.map((worker) => {
    const identity = { ...worker, revision: admission.revision, content_hash: admission.content_hash,
      plugin_catalog_hash: admission.plugin_catalog_hash, admission_sequence: admission.admission_sequence };
    const key = `${identity.master_generation}:${identity.worker_instance_id}:${identity.worker_slot}:${identity.boot_nonce}:${identity.private_port}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return identity;
  });
  return workers.some((worker) => worker === null) ? null : workers as ExpectedWorker[];
}

function sameAdmission(left: AdmissionSet | null, right: AdmissionSet | null): boolean {
  if (left === null || right === null || left.master_generation !== right.master_generation
    || left.admission_sequence !== right.admission_sequence || left.revision !== right.revision
    || left.content_hash !== right.content_hash || left.plugin_catalog_hash !== right.plugin_catalog_hash
    || left.workers.length !== right.workers.length) return false;
  const workerKey = (worker: AdmissionSet['workers'][number]) =>
    `${worker.master_generation}:${worker.worker_instance_id}:${worker.worker_slot}:${worker.boot_nonce}:${worker.private_port}`;
  return [...left.workers].map(workerKey).sort().every((key, index) => key === [...right.workers].map(workerKey).sort()[index]);
}

function snapshotMatches(snapshot: WorkerRuntimeSnapshot, worker: ExpectedWorker): boolean {
  return snapshot.master_generation === worker.master_generation && snapshot.worker_instance_id === worker.worker_instance_id
    && snapshot.worker_slot === worker.worker_slot && snapshot.boot_nonce === worker.boot_nonce
    && snapshot.private_port === worker.private_port && snapshot.revision === worker.revision
    && snapshot.content_hash === worker.content_hash && snapshot.plugin_catalog_hash === worker.plugin_catalog_hash;
}

function missingReason(error: unknown): MissingReason {
  const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined;
  return code === 'timeout' || code === 'network' || code === 'protocol' || code === 'response_too_large'
    ? code : 'snapshot_unavailable';
}

function admissionBody(admission: AdmissionSet | null): object | null {
  return admission === null ? null : {
    master_generation: admission.master_generation, admission_sequence: admission.admission_sequence,
    revision: admission.revision, content_hash: admission.content_hash, plugin_catalog_hash: admission.plugin_catalog_hash,
    workers: admission.workers,
  };
}

function response(generatedAt: number, availability: 'complete' | 'partial' | 'unknown' | 'overflow', reason: string | null,
  admission: object | null, observed: readonly ObservedWorker[], missing: readonly MissingWorker[], upstreams: readonly object[]): object {
  return { schema: 'bungee-runtime-upstreams-v1', generated_at: generatedAt, availability, reason,
    admission, workers: { observed, missing }, upstreams };
}

function compactOverflow(generatedAt: number, reason: string): Response {
  // Do not reflect an oversized admission/observation set in the fallback envelope.
  return Response.json(response(generatedAt, 'overflow', reason, null, [], [], []));
}

function unknown(generatedAt: number, reason: string, admission: AdmissionSet | null = null): Response {
  return Response.json(response(generatedAt, 'unknown', reason, admissionBody(admission), [], [], []));
}

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }

function append(chunks: string[], bytes: { value: number }, value: string): boolean {
  const next = bytes.value + byteLength(value);
  if (next > MAX_BODY_BYTES) return false;
  bytes.value = next;
  chunks.push(value);
  return true;
}

function appendJson(chunks: string[], bytes: { value: number }, value: unknown): boolean {
  return append(chunks, bytes, JSON.stringify(value));
}

function appendList(chunks: string[], bytes: { value: number }, values: readonly unknown[]): boolean {
  if (!append(chunks, bytes, '[')) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && !append(chunks, bytes, ',')) return false;
    if (!appendJson(chunks, bytes, values[index])) return false;
  }
  return append(chunks, bytes, ']');
}

function appendUpstream(
  chunks: string[], bytes: { value: number }, stateKey: string, upstreamId: string,
  entries: readonly StoredRecord[], expectedCount: number, missingCount: number,
): 'ok' | 'active_request_count_overflow' | 'response_too_large' {
  const complete = missingCount === 0 && entries.length === expectedCount;
  let active = 0;
  let activeOverflow = false;
  let lastUsed: number | null = null;
  let lastFailure: number | null = null;
  const circuitStates = new Set(entries.map(({ record }) => record.circuit_state));
  for (const { record } of entries) {
    if (record.active_request_count > Number.MAX_SAFE_INTEGER - active) activeOverflow = true;
    else active += record.active_request_count;
    if (record.last_used_time !== null && (lastUsed === null || record.last_used_time > lastUsed)) lastUsed = record.last_used_time;
    if (record.last_failure_time !== null && (lastFailure === null || record.last_failure_time > lastFailure)) lastFailure = record.last_failure_time;
  }
  if (activeOverflow) return 'active_request_count_overflow';
  const prefix = JSON.stringify({ state_key: stateKey, upstream_id: upstreamId,
    circuit_state: !complete ? 'UNKNOWN' : circuitStates.size === 1 ? entries[0]!.record.circuit_state : 'MIXED',
    active_request_count: complete ? active : null, last_used_time: lastUsed, last_used_complete: complete,
    last_failure_time: lastFailure, last_failure_complete: complete }).slice(0, -1);
  if (!append(chunks, bytes, `${prefix},"workers":`)) return 'response_too_large';
  if (!append(chunks, bytes, '[')) return 'response_too_large';
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && !append(chunks, bytes, ',')) return 'response_too_large';
    if (!append(chunks, bytes, entries[index]!.workerJson)) return 'response_too_large';
  }
  return append(chunks, bytes, ']}') ? 'ok' : 'response_too_large';
}

function render(
  generatedAt: number, availability: 'complete' | 'partial', admissionJson: string,
  observed: readonly ObservedWorker[], missing: readonly MissingWorker[], records: ReadonlyMap<string, ReadonlyMap<string, StoredRecord>>,
  expectedCount: number,
): { readonly kind: 'ok'; readonly body: string } | { readonly kind: 'overflow'; readonly reason: string } {
  const chunks: string[] = [];
  const bytes = { value: 0 };
  if (!append(chunks, bytes, '{"schema":"bungee-runtime-upstreams-v1","generated_at":')
    || !appendJson(chunks, bytes, generatedAt)
    || !append(chunks, bytes, `,"availability":"${availability}","reason":null,"admission":${admissionJson},"workers":{"observed":`)
    || !appendList(chunks, bytes, observed)
    || !append(chunks, bytes, ',"missing":') || !appendList(chunks, bytes, missing)
    || !append(chunks, bytes, '},"upstreams":[')) return { kind: 'overflow', reason: 'response_too_large' };
  let index = 0;
  for (const [key, values] of [...records.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [stateKey, upstreamId] = JSON.parse(key) as [string, string];
    if (index > 0 && !append(chunks, bytes, ',')) return { kind: 'overflow', reason: 'response_too_large' };
    const result = appendUpstream(chunks, bytes, stateKey, upstreamId,
      [...values.values()].sort((left, right) => left.worker.worker_slot - right.worker.worker_slot), expectedCount, missing.length);
    if (result !== 'ok') return { kind: 'overflow', reason: result };
    index += 1;
  }
  return append(chunks, bytes, ']}') ? { kind: 'ok', body: chunks.join('') } : { kind: 'overflow', reason: 'response_too_large' };
}

async function observe(
  identity: ExpectedWorker, options: RuntimeUpstreamsOptions, signal: AbortSignal, deadline: number,
): Promise<{ readonly identity: ExpectedWorker; readonly snapshot?: WorkerRuntimeSnapshot; readonly missing?: MissingReason }> {
  if (signal.aborted) return { identity, missing: 'timeout' };
  const session = options.lookupExactSession(identity);
  if (session === null) return { identity, missing: 'session_unavailable' };
  if (session.runtimeSnapshot === undefined) return { identity, missing: 'snapshot_unavailable' };
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { readonly identity: ExpectedWorker; readonly snapshot?: WorkerRuntimeSnapshot; readonly missing?: MissingReason }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(result);
    };
    const aborted = () => finish({ identity, missing: 'timeout' });
    const timer = setTimeout(aborted, Math.max(0, deadline - Date.now()));
    signal.addEventListener('abort', aborted, { once: true });
    // The late handler intentionally discards a snapshot from a session that ignores cancellation.
    void Promise.resolve().then(() => session.runtimeSnapshot!(signal)).then(
      (snapshot) => finish({ identity, snapshot }),
      (error) => finish({ identity, missing: missingReason(error) }),
    );
  });
}

export async function runtimeUpstreams(options: RuntimeUpstreamsOptions): Promise<Response> {
  const generatedAt = options.now();
  if (options.stopSignal?.aborted) return unknown(generatedAt, 'runtime_unavailable');
  const admission = options.activeAdmission();
  if (admission === null) return unknown(generatedAt, 'no_fresh_active_admission');
  if (admission.workers.length > MAX_WORKERS) return compactOverflow(generatedAt, 'worker_count');
  const admissionJson = JSON.stringify(admissionBody(admission));
  if (byteLength(admissionJson) > MAX_METADATA_BYTES) return compactOverflow(generatedAt, 'admission_metadata_too_large');
  const expected = expectedWorkers(admission);
  if (expected === null) return unknown(generatedAt, 'invalid_admission', admission);

  const controller = new AbortController();
  const deadline = Date.now() + SNAPSHOT_DEADLINE_MS;
  const timeout = setTimeout(() => controller.abort('deadline'), SNAPSHOT_DEADLINE_MS);
  const stop = () => controller.abort('stopping');
  options.stopSignal?.addEventListener('abort', stop, { once: true });
  const observed: ObservedWorker[] = [];
  const missing: MissingWorker[] = [];
  const records = new Map<string, Map<string, StoredRecord>>();
  let overflow: string | null = null;
  let totalRecords = 0;
  try {
    await Promise.all(expected.map(async (identity) => {
      const result = await observe(identity, options, controller.signal, deadline);
      if (options.stopSignal?.aborted || overflow !== null) return;
      if (result.missing !== undefined) {
        missing.push({ identity, reason: result.missing, at: generatedAt });
        return;
      }
      const snapshot = result.snapshot!;
      if (!snapshotMatches(snapshot, identity)) {
        missing.push({ identity, reason: 'invalid_identity', at: generatedAt });
        return;
      }
      if (snapshot.result.kind === 'overflow') {
        overflow = 'worker_snapshot_overflow';
        return;
      }
      // Check length before touching an individual record; do not retain records beyond the global budget.
      if (snapshot.result.records.length > MAX_RECORDS - totalRecords) {
        overflow = 'record_count';
        return;
      }
      const unique = new Set<string>();
      const prepared: Array<{ readonly key: string; readonly record: WorkerRuntimeSnapshotRecord; readonly workerJson: string }> = [];
      for (const record of snapshot.result.records) {
        const key = JSON.stringify([record.state_key, record.upstream_id]);
        if (unique.has(key)) {
          missing.push({ identity, reason: 'duplicate_record', at: snapshot.captured_at });
          return;
        }
        unique.add(key);
        const workerJson = JSON.stringify({ identity, circuit_state: record.circuit_state,
          active_request_count: record.active_request_count, last_used_time: record.last_used_time,
          last_failure_time: record.last_failure_time, consecutive_failures: record.consecutive_failures,
          consecutive_successes: record.consecutive_successes, health_check_successes: record.health_check_successes,
          health_check_failures: record.health_check_failures, recovery_attempt_count: record.recovery_attempt_count });
        if (byteLength(workerJson) > MAX_RECORD_BYTES) {
          overflow = 'record_metadata_too_large';
          return;
        }
        prepared.push({ key, record, workerJson });
      }
      totalRecords += prepared.length;
      observed.push({ identity, pid: snapshot.pid, captured_at: snapshot.captured_at });
      for (const entry of prepared) {
        let byWorker = records.get(entry.key);
        if (byWorker === undefined) { byWorker = new Map(); records.set(entry.key, byWorker); }
        byWorker.set(identity.worker_instance_id, { worker: identity, record: entry.record, workerJson: entry.workerJson });
      }
    }));
  } finally {
    clearTimeout(timeout);
    options.stopSignal?.removeEventListener('abort', stop);
  }
  if (options.stopSignal?.aborted) return unknown(generatedAt, 'runtime_unavailable');
  if (!sameAdmission(admission, options.activeAdmission())) return unknown(generatedAt, 'admission_changed', admission);
  if (overflow !== null) return compactOverflow(generatedAt, overflow);
  observed.sort((left, right) => left.identity.worker_slot - right.identity.worker_slot);
  missing.sort((left, right) => left.identity.worker_slot - right.identity.worker_slot);
  const complete = missing.length === 0 && [...records.values()].every((workers) => workers.size === expected.length);
  const output = render(generatedAt, complete ? 'complete' : 'partial', admissionJson, observed, missing, records, expected.length);
  if (options.stopSignal?.aborted) return unknown(generatedAt, 'runtime_unavailable');
  return output.kind === 'ok'
    ? new Response(output.body, { headers: { 'content-type': 'application/json' } })
    : compactOverflow(generatedAt, output.reason);
}
