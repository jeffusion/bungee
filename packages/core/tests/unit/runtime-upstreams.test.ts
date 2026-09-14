import { describe, expect, test } from 'bun:test';
import { runtimeUpstreams } from '../../src/master-runtime/runtime-upstreams';
import type { AdmissionSet } from '../../src/ingress';
import type { WorkerRuntimeSnapshot, WorkerRuntimeSnapshotRecord } from '../../src/supervision';

const HASH = `sha256:${'a'.repeat(64)}`;
const CATALOG = `sha256:${'b'.repeat(64)}`;
const generation = '10000000-0000-4000-8000-000000000001';

function admission(sequence = 1): AdmissionSet {
  return { master_generation: generation, admission_sequence: sequence, revision: 7,
    content_hash: HASH as never, plugin_catalog_hash: CATALOG as never,
    workers: [0, 1].map((slot) => ({ master_generation: generation,
      worker_instance_id: `20000000-0000-4000-8000-00000000000${slot + 1}`,
      worker_slot: slot, boot_nonce: `30000000-0000-4000-8000-00000000000${slot + 1}`,
      private_port: 41000 + slot })) };
}

function record(state = 'state', upstream = 'upstream', circuit_state: 'HEALTHY' | 'UNHEALTHY' = 'HEALTHY'): WorkerRuntimeSnapshotRecord {
  return { state_key: state, upstream_id: upstream, circuit_state, active_request_count: 1,
    last_used_time: 10, last_failure_time: null, consecutive_failures: 0, consecutive_successes: 1,
    health_check_successes: 0, health_check_failures: 0, recovery_attempt_count: 0 };
}

function snapshot(set: AdmissionSet, slot: number, records: readonly WorkerRuntimeSnapshotRecord[]): WorkerRuntimeSnapshot {
  const worker = set.workers[slot]!;
  return { schema: 'bungee-worker-runtime-snapshot-v1', ...worker, pid: 100 + slot, revision: set.revision,
    content_hash: set.content_hash, plugin_catalog_hash: set.plugin_catalog_hash, captured_at: 50 + slot,
    result: { kind: 'complete', records } };
}

async function collect(set: AdmissionSet, snapshots: Map<string, WorkerRuntimeSnapshot>, active = () => set) {
  const response = await runtimeUpstreams({ activeAdmission: active, now: () => 99,
    lookupExactSession: (identity) => {
      const value = snapshots.get(identity.worker_instance_id);
      return value === undefined ? null : { runtimeSnapshot: async () => value };
    } });
  return await response.json() as any;
}

describe('master runtime upstream aggregation', () => {
  test('marks missing records unknown and only sums complete upstreams', async () => {
    const set = admission();
    const body = await collect(set, new Map([[set.workers[0]!.worker_instance_id, snapshot(set, 0, [record()])]]));
    expect(body.availability).toBe('partial');
    expect(body.workers.missing[0].reason).toBe('session_unavailable');
    expect(body.upstreams[0].circuit_state).toBe('UNKNOWN');
    expect(body.upstreams[0].active_request_count).toBeNull();
    expect(body.upstreams[0].last_used_complete).toBe(false);
  });

  test('reports mixed circuit state without inventing a shared consecutive count', async () => {
    const set = admission();
    const body = await collect(set, new Map([
      [set.workers[0]!.worker_instance_id, snapshot(set, 0, [record('state', 'upstream', 'HEALTHY')])],
      [set.workers[1]!.worker_instance_id, snapshot(set, 1, [record('state', 'upstream', 'UNHEALTHY')])],
    ]));
    expect(body.availability).toBe('complete');
    expect(body.upstreams[0].circuit_state).toBe('MIXED');
    expect(body.upstreams[0].active_request_count).toBe(2);
    expect(body.upstreams[0].workers).toHaveLength(2);
    expect(body.upstreams[0].consecutive_failures).toBeUndefined();
  });

  test('returns compact overflow for worker overflow', async () => {
    const set = admission();
    const overflow = { ...snapshot(set, 0, []), result: { kind: 'overflow' as const, reason: 'record_count' as const, upstream_count: 4097 } };
    const overflowBody = await collect(set, new Map([[set.workers[0]!.worker_instance_id, overflow]]));
    expect(overflowBody.availability).toBe('overflow');
    expect(overflowBody.upstreams).toEqual([]);
  });

  test('marks missing sessions and duplicate records as partial', async () => {
    const set = admission();
    const missingSession = await collect(set, new Map());
    expect(missingSession.availability).toBe('partial');
    expect(missingSession.workers.missing).toHaveLength(2);
    expect(missingSession.workers.missing.every(({ reason }: { reason: string }) => reason === 'session_unavailable')).toBe(true);
    const duplicateBody = await collect(set, new Map([
      [set.workers[0]!.worker_instance_id, snapshot(set, 0, [record(), record()])],
      [set.workers[1]!.worker_instance_id, snapshot(set, 1, [record()])],
    ]));
    expect(duplicateBody.availability).toBe('partial');
    expect(duplicateBody.workers.missing[0].reason).toBe('duplicate_record');
  });

  test('rejects mismatched snapshots and discards a batch when admission changes', async () => {
    const set = admission();
    const mismatched = { ...snapshot(set, 0, [record()]), boot_nonce: '40000000-0000-4000-8000-000000000001' };
    const identityBody = await collect(set, new Map([[set.workers[0]!.worker_instance_id, mismatched]]));
    expect(identityBody.workers.missing[0].reason).toBe('invalid_identity');
    let active: AdmissionSet = set;
    const changedBody = await runtimeUpstreams({ activeAdmission: () => active, now: () => 99,
      lookupExactSession: (identity) => ({ runtimeSnapshot: async () => {
        active = admission(2);
        return snapshot(set, identity.worker_slot, [record()]);
      } }) });
    const body = await changedBody.json() as any;
    expect(body.availability).toBe('unknown');
    expect(body.reason).toBe('admission_changed');
    expect(body.workers.observed).toEqual([]);
  });

  test('uses tuple identities without NUL collisions', async () => {
    const set = admission();
    const body = await collect(set, new Map([
      [set.workers[0]!.worker_instance_id, snapshot(set, 0, [record('a\u0000b', 'c'), record('a', 'b\u0000c')])],
      [set.workers[1]!.worker_instance_id, snapshot(set, 1, [record('a\u0000b', 'c'), record('a', 'b\u0000c')])],
    ]));
    expect(body.availability).toBe('complete');
    expect(body.upstreams).toHaveLength(2);
    expect(body.upstreams.map((upstream: any) => [upstream.state_key, upstream.upstream_id])).toEqual([
      ['a', 'b\u0000c'], ['a\u0000b', 'c'],
    ]);
    expect(body.upstreams.every((upstream: any) => upstream.circuit_state === 'HEALTHY')).toBe(true);
  });

  test('checks record budgets before reading records and stops scanning after the global budget', async () => {
    const set = admission();
    const oversized = snapshot(set, 0, []);
    const unreadable = new Array(4097);
    Object.defineProperty(unreadable, 0, { get() { throw new Error('record getter must not run'); } });
    Object.defineProperty(oversized.result, 'records', { value: unreadable });
    const body = await collect(set, new Map([[set.workers[0]!.worker_instance_id, oversized]]));
    expect(body).toMatchObject({ availability: 'overflow', reason: 'record_count', workers: { observed: [], missing: [] }, upstreams: [] });

    const first = snapshot(set, 0, Array.from({ length: 3000 }, (_, index) => record(`first-${index}`)));
    const later = snapshot(set, 1, []);
    const laterUnreadable = new Array(2000);
    Object.defineProperty(laterUnreadable, 0, { get() { throw new Error('later records must not run'); } });
    Object.defineProperty(later.result, 'records', { value: laterUnreadable });
    const response = await runtimeUpstreams({ activeAdmission: () => set, now: () => 99,
      lookupExactSession: (identity) => identity.worker_slot === 0
        ? { runtimeSnapshot: async () => first }
        : { runtimeSnapshot: async () => { await Bun.sleep(5); return later; } },
    });
    expect(await response.json()).toMatchObject({ availability: 'overflow', reason: 'record_count' });
  });

  test('uses UTF-8 rather than UTF-16 code-unit budgets and returns a bounded overflow envelope', async () => {
    const set = admission();
    const multiByte = '😀'.repeat(6_000);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBe(multiByte.length * 2);
    const records = (count: number) => Array.from({ length: count }, (_, index) => record(`${multiByte}-${index}`, `upstream-${index}`));
    const below = await runtimeUpstreams({ activeAdmission: () => set, now: () => 99,
      lookupExactSession: (identity) => ({ runtimeSnapshot: async () => snapshot(set, identity.worker_slot, records(40)) }),
    });
    const belowBody = await below.text();
    expect(Buffer.byteLength(belowBody, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    const parsedBelow = JSON.parse(belowBody) as { availability: string; upstreams: readonly { workers: readonly unknown[] }[] };
    expect(parsedBelow.availability).toBe('complete');
    expect(parsedBelow.upstreams).toHaveLength(40);
    expect(parsedBelow.upstreams.every(({ workers }) => workers.length === 2)).toBe(true);
    const above = await runtimeUpstreams({ activeAdmission: () => set, now: () => 99,
      lookupExactSession: (identity) => ({ runtimeSnapshot: async () => snapshot(set, identity.worker_slot, records(44)) }),
    });
    expect(await above.json()).toEqual(expect.objectContaining({ availability: 'overflow', reason: 'response_too_large', admission: null,
      workers: { observed: [], missing: [] }, upstreams: [] }));
  });

  test('does not publish incomplete keys or unsafe active request sums', async () => {
    const set = admission();
    const missingKey = await collect(set, new Map([
      [set.workers[0]!.worker_instance_id, snapshot(set, 0, [record()])],
      [set.workers[1]!.worker_instance_id, snapshot(set, 1, [])],
    ]));
    expect(missingKey.availability).toBe('partial');
    expect(missingKey.upstreams[0]).toMatchObject({ circuit_state: 'UNKNOWN', active_request_count: null });
    const overflow = record();
    Object.assign(overflow, { active_request_count: Number.MAX_SAFE_INTEGER });
    const sum = await collect(set, new Map([
      [set.workers[0]!.worker_instance_id, snapshot(set, 0, [overflow])],
      [set.workers[1]!.worker_instance_id, snapshot(set, 1, [overflow])],
    ]));
    expect(sum).toMatchObject({ availability: 'overflow', reason: 'active_request_count_overflow' });
  });

  test('aggregates timestamp maxima and validates the complete worker identity matrix', async () => {
    const set = admission();
    const older = { ...record(), last_used_time: 3, last_failure_time: 4 };
    const newer = { ...record(), last_used_time: 9, last_failure_time: 8 };
    const body = await collect(set, new Map([
      [set.workers[0]!.worker_instance_id, snapshot(set, 0, [older])],
      [set.workers[1]!.worker_instance_id, snapshot(set, 1, [newer])],
    ]));
    expect(body.upstreams[0]).toMatchObject({ last_used_time: 9, last_failure_time: 8 });
    for (const field of ['master_generation', 'worker_instance_id', 'worker_slot', 'boot_nonce', 'private_port', 'revision', 'content_hash', 'plugin_catalog_hash'] as const) {
      const invalid = { ...snapshot(set, 0, [record()]), [field]: field === 'worker_slot' || field === 'private_port' || field === 'revision' ? 999 : `wrong-${field}` };
      const invalidBody = await collect(set, new Map([[set.workers[0]!.worker_instance_id, invalid]]));
      expect(invalidBody.workers.missing[0]).toMatchObject({ reason: 'invalid_identity' });
    }
  });

  test('aborts a hanging collector before its deadline and never reads a late snapshot', async () => {
    const set = admission();
    const stop = new AbortController();
    let resolveSnapshot: ((value: WorkerRuntimeSnapshot) => void) | undefined;
    let snapshotStarted: (() => void) | undefined;
    let lateRecordsRead = false;
    const pending = runtimeUpstreams({ activeAdmission: () => set, now: () => 99, stopSignal: stop.signal,
      lookupExactSession: (identity) => ({ runtimeSnapshot: async () => await new Promise((resolve) => {
        resolveSnapshot = resolve as (value: WorkerRuntimeSnapshot) => void;
        snapshotStarted?.();
      }) }),
    });
    await new Promise<void>((resolve) => { snapshotStarted = resolve; });
    const abortedAt = Date.now();
    stop.abort();
    const response = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(250);
    expect(await response.json()).toMatchObject({ availability: 'unknown', reason: 'runtime_unavailable' });
    const late = snapshot(set, 0, []);
    Object.defineProperty(late.result, 'records', { get() { lateRecordsRead = true; return []; } });
    resolveSnapshot?.(late);
    await Promise.resolve();
    expect(lateRecordsRead).toBe(false);
  });
});
