import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createWorkerRuntimeSnapshotFromState,
  MAX_WORKER_RUNTIME_SNAPSHOT_BODY_BYTES,
  normalizeWorkerRuntimeSnapshotBody,
  parseWorkerRuntimeSnapshot,
  WorkerRuntimeSnapshotError,
} from '../../src/supervision';
import {
  cleanupRuntimeState,
  decrementActiveRequests,
  getActiveRequestCount,
  incrementActiveRequests,
  runtimeState,
  tryAcquireHalfOpenSlot,
} from '../../src/worker/state/runtime-state';
import type { RuntimeUpstream } from '../../src/worker/types';

const IDENTITY = {
  master_generation: '00000000-0000-0000-0000-000000000001',
  worker_instance_id: '00000000-0000-0000-0000-000000000002',
  worker_slot: 0,
  boot_nonce: '00000000-0000-0000-0000-000000000003',
  pid: 123,
  private_port: 41001,
  revision: 7,
  content_hash: `sha256:${'a'.repeat(64)}`,
  plugin_catalog_hash: `sha256:${'b'.repeat(64)}`,
  captured_at: 1_700_000_000_000,
} as const;

function upstream(upstream_id: string, extra: Partial<RuntimeUpstream> = {}): RuntimeUpstream {
  return {
    target: `http://${upstream_id}.test`, upstream_id, status: 'HEALTHY',
    consecutive_failures: 0, consecutive_successes: 0, recovery_attempt_count: 0,
    health_check_successes: 0, health_check_failures: 0, active_request_count: 99,
    ...extra,
  } as RuntimeUpstream;
}

function complete() {
  const result = createWorkerRuntimeSnapshotFromState(IDENTITY);
  if (result.result.kind !== 'complete') throw new Error(`unexpected ${result.result.reason} overflow`);
  return result;
}

function record(state_key = 'state', upstream_id = 'a'): Record<string, unknown> {
  return {
    state_key, upstream_id, circuit_state: 'HEALTHY', active_request_count: 0,
    last_used_time: null, last_failure_time: null, consecutive_failures: 0,
    consecutive_successes: 0, health_check_successes: 0, health_check_failures: 0,
    recovery_attempt_count: 0,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'bungee-worker-runtime-snapshot-v1', ...IDENTITY,
    result: { kind: 'complete', records: [record()] }, ...overrides,
  };
}

describe('worker runtime snapshot', () => {
  beforeEach(() => cleanupRuntimeState());
  afterEach(() => cleanupRuntimeState());

  test('uses live active counters and recursively freezes the complete result', () => {
    runtimeState.set('z-state', { upstreams: [upstream('b')] });
    runtimeState.set('a-state', { upstreams: [upstream('a', { status: 'HALF_OPEN', last_used_time: 12 })] });
    incrementActiveRequests('z-state', 'b');
    incrementActiveRequests('z-state', 'b');
    try {
      const result = complete();
      if (result.result.kind !== 'complete') throw new Error('expected complete');
      const records = result.result.records;
      expect(records.map((item) => `${item.state_key}/${item.upstream_id}`)).toEqual([
        'a-state/a', 'z-state/b',
      ]);
      expect(records[1]?.active_request_count).toBe(2);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.result)).toBe(true);
      expect(Object.isFrozen(records)).toBe(true);
      expect(Object.isFrozen(records[0])).toBe(true);
      expect(() => ((records as unknown as Array<unknown>).pop())).toThrow();
      expect(() => ((records[0] as unknown as { last_used_time: number }).last_used_time = 999)).toThrow();
      expect((runtimeState.get('a-state')?.upstreams[0] as RuntimeUpstream).last_used_time).toBe(12);
    } finally {
      decrementActiveRequests('z-state', 'b');
      decrementActiveRequests('z-state', 'b');
    }
  });

  test('produces identical serialized bytes for different insertion orders', () => {
    runtimeState.set('z', { upstreams: [upstream('b')] });
    runtimeState.set('a', { upstreams: [upstream('a')] });
    const first = normalizeWorkerRuntimeSnapshotBody(complete());
    runtimeState.clear();
    runtimeState.set('a', { upstreams: [upstream('a')] });
    runtimeState.set('z', { upstreams: [upstream('b')] });
    const second = normalizeWorkerRuntimeSnapshotBody(complete());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const parsed = parseWorkerRuntimeSnapshot(JSON.parse(JSON.stringify(first)));
    expect(parsed).toEqual(first);
    if (parsed.result.kind !== 'complete') throw new Error('expected complete');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.result)).toBe(true);
    expect(Object.isFrozen(parsed.result.records)).toBe(true);
    expect(Object.isFrozen(parsed.result.records[0])).toBe(true);
  });

  test('rejects duplicate IDs in real runtime state with a typed error', () => {
    runtimeState.set('state', { upstreams: [upstream('a'), upstream('a')] });
    expect(() => createWorkerRuntimeSnapshotFromState(IDENTITY)).toThrow(WorkerRuntimeSnapshotError);
    try { createWorkerRuntimeSnapshotFromState(IDENTITY); }
    catch (error) { expect((error as WorkerRuntimeSnapshotError).code).toBe('runtime_state_invalid'); }
  });

  test('counts 1026 by length without reading the overflowing upstream', () => {
    const upstreams = Array.from({ length: 1026 }, (_, index) => upstream(String(index)));
    Object.defineProperty(upstreams, '1025', { configurable: true, get() { throw new Error('must not read'); } });
    runtimeState.set('state', { upstreams });
    const result = createWorkerRuntimeSnapshotFromState(IDENTITY);
    expect(result.result).toEqual({ kind: 'overflow', reason: 'record_count', upstream_count: 1026 });
  });

  test('returns record-count overflow without records at 1025', () => {
    runtimeState.set('state', {
      upstreams: Array.from({ length: 1025 }, (_, index) => upstream(String(index))),
    });
    const result = createWorkerRuntimeSnapshotFromState(IDENTITY);
    expect(result.result).toEqual({ kind: 'overflow', reason: 'record_count', upstream_count: 1025 });
    const wireBody = JSON.parse(JSON.stringify(result));
    expect(Buffer.byteLength(JSON.stringify(wireBody), 'utf8')).toBeLessThanOrEqual(MAX_WORKER_RUNTIME_SNAPSHOT_BODY_BYTES);
    const parsed = parseWorkerRuntimeSnapshot(wireBody);
    expect(parsed).toEqual(result);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.result)).toBe(true);
  });

  test('short-circuits hostile complete records into a frozen identity-preserving overflow', () => {
    const records: unknown[] = new Array(1025);
    Object.defineProperty(records, '0', { get() { throw new Error('first record must not be read'); } });
    Object.defineProperty(records, '1024', { get() { throw new Error('last record must not be read'); } });
    const parsed = parseWorkerRuntimeSnapshot(body({ result: { kind: 'complete', records } }));
    expect(parsed).toMatchObject({ ...IDENTITY, result: { kind: 'overflow', reason: 'record_count', upstream_count: 1025 } });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.result)).toBe(true);

    const roundTripped = parseWorkerRuntimeSnapshot(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
    expect(Object.isFrozen(roundTripped)).toBe(true);
    expect(Object.isFrozen(roundTripped.result)).toBe(true);
  });

  test('returns identity-preserving payload overflow within the 240 KiB fallback limit', () => {
    runtimeState.set('x'.repeat(300), {
      upstreams: Array.from({ length: 1024 }, (_, index) => upstream(String(index))),
    });
    const result = createWorkerRuntimeSnapshotFromState(IDENTITY);
    expect(result.result).toMatchObject({ kind: 'overflow', reason: 'payload_bytes', upstream_count: 1024 });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(MAX_WORKER_RUNTIME_SNAPSHOT_BODY_BYTES);
    const parsed = parseWorkerRuntimeSnapshot(JSON.parse(JSON.stringify(result)));
    expect(parsed).toEqual(result);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.result)).toBe(true);
  });

  test('accepts exact 240 KiB and reports one-byte/multibyte overflow', () => {
    const withState = (state_key: string) => body({ result: { kind: 'complete', records: [record(state_key)] } });
    const emptyBytes = Buffer.byteLength(JSON.stringify(withState('')), 'utf8');
    const stateKey = 'x'.repeat(MAX_WORKER_RUNTIME_SNAPSHOT_BODY_BYTES - emptyBytes);
    const exact = withState(stateKey);
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(MAX_WORKER_RUNTIME_SNAPSHOT_BODY_BYTES);
    expect(normalizeWorkerRuntimeSnapshotBody(exact).result.kind).toBe('complete');
    expect(normalizeWorkerRuntimeSnapshotBody(withState(`${stateKey}x`)).result).toMatchObject({
      kind: 'overflow', reason: 'payload_bytes', upstream_count: 1,
    });
    expect(normalizeWorkerRuntimeSnapshotBody(withState(`${stateKey}界`)).result.kind).toBe('overflow');
  });

  test('strictly parses object bodies and validates epochs, fields and identity', () => {
    const valid = body();
    expect(() => parseWorkerRuntimeSnapshot(JSON.stringify(valid))).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, captured_at: 1.5 })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, captured_at: Number.MAX_SAFE_INTEGER + 1 })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, result: { kind: 'complete', records: [{ ...record(), last_used_time: 1.5 }] } })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, unexpected: true })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, result: { kind: 'complete', records: [{ ...record(), extra: true }] } })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot(Object.assign(Object.create({}), valid))).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, worker_instance_id: 'not-a-uuid' })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, content_hash: 'sha256:bad' })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, private_port: 65_536 })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, revision: 0 })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, result: { kind: 'overflow', reason: 'record_count', upstream_count: 1, extra: true } })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, result: { kind: 'overflow', reason: 'record_count', upstream_count: 1024 } })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, result: { kind: 'overflow', reason: 'payload_bytes', upstream_count: 0 } })).toThrow(WorkerRuntimeSnapshotError);
    expect(() => parseWorkerRuntimeSnapshot({ ...valid, result: { kind: 'overflow', reason: 'payload_bytes', upstream_count: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(WorkerRuntimeSnapshotError);
  });

  test('cleanup clears counters and half-open slots', () => {
    runtimeState.set('state', { upstreams: [upstream('a')] });
    incrementActiveRequests('state', 'a');
    expect(tryAcquireHalfOpenSlot('state', 'a')).toBe(true);
    cleanupRuntimeState();
    expect(getActiveRequestCount('state', 'a')).toBe(0);
    expect(tryAcquireHalfOpenSlot('state', 'a')).toBe(true);
  });

  test('cleanup removes producer state before the next snapshot', () => {
    runtimeState.set('sticky-service', { upstreams: [upstream('sticky')] });
    cleanupRuntimeState();

    const result = complete();
    if (result.result.kind !== 'complete') throw new Error('expected complete');
    expect(result.result.records).toEqual([]);
  });
});
