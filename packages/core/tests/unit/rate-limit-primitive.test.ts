import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  IngressTokenBucketStore,
  RateLimitProtocolError,
  createRateLimitCredential,
  deriveRateLimitBucketId,
  normalizeRateLimitKey,
  parseRateLimitDebitRequest,
  signRateLimitDebitRequest,
  signRateLimitDebitResponse,
  verifyRateLimitDebitResponse,
  type RateLimitDebitRequest,
  type RateLimitWorkerIdentity,
} from '../../src/rate-limit';

const routeId = '00000000-0000-4000-8000-000000000001';
const ingress = {
  role: 'ingress' as const,
  process_instance_id: '00000000-0000-4000-8000-000000000010',
  boot_nonce: '00000000-0000-4000-8000-000000000011',
};
const secret = new Uint8Array(32).fill(7);
let wall = 10_000;
let mono = 0;
const stores: IngressTokenBucketStore[] = [];

beforeEach(() => { wall = 10_000; mono = 0; });
afterEach(() => { for (const instance of stores.splice(0)) instance.dispose(); });

function worker(bootNonce = '00000000-0000-4000-8000-000000000020', slot = 0): RateLimitWorkerIdentity {
  return {
    role: 'worker', process_instance_id: `00000000-0000-4000-8000-${String(20 + slot).padStart(12, '0')}`,
    boot_nonce: bootNonce, master_generation: '00000000-0000-4000-8000-000000000021', worker_slot: slot,
  };
}

function request(credential: ReturnType<typeof createRateLimitCredential>, bucketId: string, overrides: Partial<RateLimitDebitRequest['body']> = {}, debitId: string = randomUUID(), deadlineAt = wall + 1_000, requestId: string = randomUUID()): RateLimitDebitRequest {
  return signRateLimitDebitRequest({
    request_id: requestId, debit_id: debitId, deadline_at: deadlineAt,
    body: { bucket_id: bucketId, policy_id: 'policy', revision: 1, rps: 1, burst: 2, ...overrides },
  }, credential);
}

function expectCode(action: () => unknown, code: RateLimitProtocolError['code']): void {
  try { action(); expect.unreachable(`expected ${code}`); }
  catch (error) { expect(error).toBeInstanceOf(RateLimitProtocolError); expect((error as RateLimitProtocolError).code).toBe(code); }
}

function bucket(expression: string, value: string): string {
  return deriveRateLimitBucketId(secret, routeId, expression, normalizeRateLimitKey(value));
}

function store(authorization: (value: RateLimitWorkerIdentity) => 'active' | 'retired' | 'unknown' | 'prepared' = () => 'active', options: Partial<ConstructorParameters<typeof IngressTokenBucketStore>[0]> = {}, credential = createRateLimitCredential(secret, ingress)): IngressTokenBucketStore {
  const instance = new IngressTokenBucketStore({
    credential, authorizeWorker: authorization,
    wallClock: () => wall, monotonicClock: () => mono, ...options,
  });
  stores.push(instance);
  return instance;
}

describe('W4 rate-limit primitive', () => {
  test('derives a secret, independent bucket domain without exposing raw key', () => {
    const first = bucket('header["x-user"]', 'alice@example.test');
    const second = bucket('header["x-user"]', 'bob@example.test');
    expect(first).toMatch(/^rlb-v1:[0-9a-f]{64}$/);
    expect(first).not.toContain('alice');
    expect(first).not.toBe(second);
    expect(() => bucket('bad\nexpression', 'x')).toThrow(RateLimitProtocolError);
  });

  test('strictly signs and verifies request/response with worker and ingress boots', () => {
    const workerCredential = createRateLimitCredential(secret, worker());
    const ingressCredential = createRateLimitCredential(secret, ingress);
    const signed = request(workerCredential, bucket('ip', '127.0.0.1'));
    const response = store(() => 'active', {}, ingressCredential).handleDebitRequest(signed);
    expect(verifyRateLimitDebitResponse(response, workerCredential, ingress, signed).body.reason).toBe('consumed');
    const tampered = { ...signed, deadline_at: signed.deadline_at + 1 };
    expectCode(() => store(() => 'active', {}, ingressCredential).handleDebitRequest(tampered), 'invalid_mac');
  });

  test('rejects duplicate escaped JSON keys on raw string and byte wire inputs', () => {
    const credential = createRateLimitCredential(secret, worker());
    const signed = request(credential, bucket('raw', 'duplicate'));
    const wire = JSON.stringify(signed).replace(
      '"protocol":"bungee-rate-limit"',
      '"\\u0070rotocol":"bungee-rate-limit","protocol":"bungee-rate-limit"',
    );
    expectCode(() => parseRateLimitDebitRequest(wire), 'malformed_message');
    expectCode(() => parseRateLimitDebitRequest(new TextEncoder().encode(wire)), 'malformed_message');
  });

  test('worker client verification rejects rogue authority, worker, and deadline', () => {
    const workerCredential = createRateLimitCredential(secret, worker());
    const rogueIngress = createRateLimitCredential(secret, {
      role: 'ingress', process_instance_id: '00000000-0000-4000-8000-000000000012', boot_nonce: ingress.boot_nonce,
    });
    const debit = request(workerCredential, bucket('ip', '192.0.2.1'));
    const response = store().handleDebitRequest(debit);
    expect(verifyRateLimitDebitResponse(response, workerCredential, ingress, debit).body.allowed).toBe(true);
    const responseInput = { worker: debit.worker, request_id: debit.request_id, debit_id: debit.debit_id,
      deadline_at: debit.deadline_at, body: response.body };
    const rogue = signRateLimitDebitResponse(responseInput, rogueIngress);
    expectCode(() => verifyRateLimitDebitResponse(rogue, workerCredential, ingress, debit), 'identity_mismatch');
    const wrongDeadline = signRateLimitDebitResponse({ ...responseInput, deadline_at: debit.deadline_at + 1 }, createRateLimitCredential(secret, ingress));
    expectCode(() => verifyRateLimitDebitResponse(wrongDeadline, workerCredential, ingress, debit), 'invalid_response');
    const wrongWorker = signRateLimitDebitResponse({ ...responseInput, worker: worker(undefined, 1) }, createRateLimitCredential(secret, ingress));
    expectCode(() => verifyRateLimitDebitResponse(wrongWorker, workerCredential, ingress, debit), 'identity_mismatch');
  });

  test('normalizes typed primitive keys and requires the branded result', () => {
    expect(normalizeRateLimitKey(' e\u0301 ')).toEqual({ kind: 'string', value: 'é', _brand: 'RateLimitNormalizedKey' });
    expect(normalizeRateLimitKey(1.5)).toEqual({ kind: 'number', value: '1.5', _brand: 'RateLimitNormalizedKey' });
    expect(normalizeRateLimitKey(true)).toEqual({ kind: 'boolean', value: 'true', _brand: 'RateLimitNormalizedKey' });
    expect(normalizeRateLimitKey('2001:db8::1', 'ip').kind).toBe('ip');
    expect(() => normalizeRateLimitKey(' ')).toThrow(RateLimitProtocolError);
    expect(() => normalizeRateLimitKey('bad\nkey')).toThrow(RateLimitProtocolError);
    expect(() => normalizeRateLimitKey(Number.NaN)).toThrow(RateLimitProtocolError);
    expect(() => normalizeRateLimitKey('\ud800')).toThrow(RateLimitProtocolError);
    expect(() => normalizeRateLimitKey('x\ud800')).toThrow(RateLimitProtocolError);
    expect(() => normalizeRateLimitKey('\udc00')).toThrow(RateLimitProtocolError);
    expect(normalizeRateLimitKey('😀').value).toBe('😀');
    expect(normalizeRateLimitKey('é'.repeat(1_024)).value).toHaveLength(1_024);
    expect(() => normalizeRateLimitKey('é'.repeat(1_025))).toThrow(RateLimitProtocolError);
    expect(() => deriveRateLimitBucketId(secret, routeId, 'ip', 'raw' as never)).toThrow(RateLimitProtocolError);
    expect(bucket('ip', 'one')).not.toBe(bucket('ip2', 'one'));
    expect(bucket('ip', 'one')).not.toBe(deriveRateLimitBucketId(secret, routeId, 'ip', normalizeRateLimitKey('two')));
    expect(bucket('ip', 'one')).not.toBe(deriveRateLimitBucketId(secret, '00000000-0000-4000-8000-000000000002', 'ip', normalizeRateLimitKey('one')));
    expect(deriveRateLimitBucketId(secret, routeId, 'key', normalizeRateLimitKey('1')))
      .not.toBe(deriveRateLimitBucketId(secret, routeId, 'key', normalizeRateLimitKey(1)));
  });

  test('four workers sharing a bucket cannot exceed capacity', async () => {
    const ingressStore = store();
    const bucketId = bucket('tenant', 'same');
    const results = await Promise.all([0, 1, 2, 3].map((slot) => Promise.resolve().then(() => ingressStore.handleDebitRequest(request(createRateLimitCredential(secret, worker(undefined, slot)), bucketId)))));
    expect(results.filter((result) => result.body.allowed)).toHaveLength(2);
    expect(results.filter((result) => result.body.reason === 'rate_limited')).toHaveLength(2);
  });

  test('replacement boot keeps bucket state but gets a fresh idempotency namespace', () => {
    const ingressStore = store();
    const bucketId = bucket('tenant', 'replacement');
    const oldCredential = createRateLimitCredential(secret, worker());
    const newCredential = createRateLimitCredential(secret, worker('00000000-0000-4000-8000-000000000022'));
    expect(ingressStore.handleDebitRequest(request(oldCredential, bucketId, { burst: 1 })).body.allowed).toBe(true);
    expect(ingressStore.handleDebitRequest(request(newCredential, bucketId, { burst: 1 })).body.reason).toBe('rate_limited');
  });

  test('policy revisions refill under old policy, cap on upgrade, and never roll back', () => {
    const ingressStore = store();
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'revision');
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { rps: 1, burst: 2 })).body.allowed).toBe(true);
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { rps: 1, burst: 2 })).body.allowed).toBe(true);
    mono = 500;
    // The upgrade must refill with old rps=1 before applying new burst/rps.
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { revision: 2, rps: 10, burst: 4 })).body.reason).toBe('rate_limited');
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { revision: 1, rps: 1, burst: 100 })).body.reason).toBe('rate_limited');
    mono = 550;
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { revision: 2, rps: 10, burst: 4 })).body.allowed).toBe(true);
    expectCode(() => ingressStore.handleDebitRequest(request(credential, bucketId, { revision: 2, rps: 9, burst: 4 })), 'policy_conflict');
  });

  test('retains the latest policy after its idle bucket is reclaimed', () => {
    const ingressStore = store(() => 'retired', { maxBuckets: 1, idleTtlMs: 10 });
    const current = createRateLimitCredential(secret, worker());
    const retired = createRateLimitCredential(secret, worker('00000000-0000-4000-8000-000000000022'));
    const bucketId = bucket('tenant', 'reclaimed-policy');
    expect(ingressStore.handleDebitRequest(request(current, bucketId, { revision: 2, rps: 1, burst: 1 })).body.allowed).toBe(true);

    mono = 60_001;
    wall = 70_000;
    expect(ingressStore.handleDebitRequest(request(current, bucket('tenant', 'other-policy'), { policy_id: 'other', rps: 1, burst: 1 })).body.allowed).toBe(true);
    expect(ingressStore.bucketCount).toBe(1);
    expect(ingressStore.policyCount).toBe(2);

    mono = 61_001;
    wall = 71_000;
    expect(ingressStore.handleDebitRequest(request(retired, bucketId, { revision: 1, rps: 1, burst: 100 })).body.allowed).toBe(true);
    expect(ingressStore.handleDebitRequest(request(retired, bucketId, { revision: 1, rps: 1, burst: 100 })).body.reason).toBe('rate_limited');
  });

  test('policy shrink caps an existing bucket immediately', () => {
    const ingressStore = store();
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'shrink');
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { burst: 4, rps: 1 })).body.allowed).toBe(true);
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { burst: 4, rps: 1 })).body.allowed).toBe(true);
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { revision: 2, burst: 1, rps: 1 })).body.allowed).toBe(true);
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { revision: 2, burst: 1, rps: 1 })).body.reason).toBe('rate_limited');
  });

  test('ACK loss is idempotent, while conflicting and expired replays fail', () => {
    let authorization: 'active' | 'retired' | 'unknown' | 'prepared' = 'active';
    const ingressStore = store(() => authorization);
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'ack');
    const debit = request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000099');
    const first = ingressStore.handleDebitRequest(debit);
    const second = ingressStore.handleDebitRequest(debit);
    expect(first.body).toEqual(second.body);
    authorization = 'unknown';
    expectCode(() => ingressStore.handleDebitRequest(debit), 'worker_unknown');
    authorization = 'prepared';
    expectCode(() => ingressStore.handleDebitRequest(debit), 'worker_prepared');
    authorization = 'active';
    expectCode(() => ingressStore.handleDebitRequest(request(credential, bucketId, {}, debit.debit_id, debit.deadline_at, randomUUID())), 'field_conflict');
    expectCode(() => ingressStore.handleDebitRequest(request(credential, bucketId, {}, debit.debit_id, debit.deadline_at + 1, debit.request_id)), 'field_conflict');
    expectCode(() => ingressStore.handleDebitRequest(request(credential, bucketId, { burst: 1 }, debit.debit_id, debit.deadline_at, debit.request_id)), 'field_conflict');
    expectCode(() => ingressStore.handleDebitRequest({ ...debit, body: { ...debit.body, bucket_id: bucket('tenant', 'other') } }), 'invalid_mac');
    wall += 2_000;
    expectCode(() => ingressStore.handleDebitRequest(debit), 'deadline_expired');
  });

  test('monotonic refill survives wall-clock rollback', () => {
    const ingressStore = store();
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'clock');
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { burst: 1, rps: 1 })).body.allowed).toBe(true);
    wall -= 5_000;
    mono += 1_000;
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { burst: 1, rps: 1 }, randomUUID(), 12_000)).body.allowed).toBe(true);
  });

  test('keeps logical wall time monotonic across a forward jump and rollback', () => {
    const ingressStore = store(() => 'active', { graceMs: 0 });
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'logical-wall');
    const debit = request(credential, bucketId, { burst: 1 }, '00000000-0000-4000-8000-000000000099', 10_100);
    expect(ingressStore.handleDebitRequest(debit).body.allowed).toBe(true);

    wall = 20_000;
    mono = 1_000;
    expectCode(() => ingressStore.handleDebitRequest(debit), 'deadline_expired');
    wall = 10_000;
    mono = 1_001;
    expectCode(() => ingressStore.handleDebitRequest(debit), 'deadline_expired');
  });

  test('keeps monotonic high-water stable across rollback and recovery', () => {
    const ingressStore = store();
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'mono-high-water');
    const debit = (id: string) => request(credential, bucketId, { burst: 1, rps: 1_000 }, id, 11_500);

    expect(ingressStore.handleDebitRequest(debit('00000000-0000-4000-8000-000000000001')).body.allowed).toBe(true);
    mono = 1_000;
    expect(ingressStore.handleDebitRequest(debit('00000000-0000-4000-8000-000000000002')).body.allowed).toBe(true);
    mono = 0;
    expect(ingressStore.handleDebitRequest(debit('00000000-0000-4000-8000-000000000003')).body.reason).toBe('rate_limited');
    mono = 1_000;
    expect(ingressStore.handleDebitRequest(debit('00000000-0000-4000-8000-000000000004')).body.reason).toBe('rate_limited');
    mono = 1_001;
    expect(ingressStore.handleDebitRequest(debit('00000000-0000-4000-8000-000000000005')).body.allowed).toBe(true);
  });

  test('fails closed for invalid monotonic clocks and logical wall overflow', () => {
    const credential = createRateLimitCredential(secret, worker());
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const ingressStore = store(() => 'active', { monotonicClock: () => value });
      expectCode(() => ingressStore.handleDebitRequest(request(credential, bucket('tenant', `invalid-mono-${String(value)}`))), 'capacity');
    }

    const ingressStore = store();
    const overflowRequest = (id: string) => request(credential, bucket('tenant', 'mono-overflow'), {}, id, 20_000);
    ingressStore.handleDebitRequest(overflowRequest('00000000-0000-4000-8000-000000000006'));
    wall = Number.MAX_VALUE;
    expectCode(() => ingressStore.handleDebitRequest(overflowRequest('00000000-0000-4000-8000-000000000007')), 'deadline_expired');
    wall = 0;
    mono = Number.MAX_VALUE;
    expectCode(() => ingressStore.handleDebitRequest(overflowRequest('00000000-0000-4000-8000-000000000008')), 'capacity');
  });

  test('sweeps replay capacity only when the cached expiry is reachable', () => {
    const ingressStore = store(() => 'active', { maxReplayEntries: 2, graceMs: 0 });
    const credential = createRateLimitCredential(secret, worker());
    const firstDeadline = wall + 100;
    const bucketId = bucket('tenant', 'replay-capacity');
    ingressStore.handleDebitRequest(request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000001', firstDeadline));
    ingressStore.handleDebitRequest(request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000002', firstDeadline));
    expect(ingressStore.replayPruneCount).toBe(0);

    wall = firstDeadline - 1;
    expectCode(() => ingressStore.handleDebitRequest(request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000003')), 'busy');
    wall = firstDeadline;
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000003')).body.reason).toBe('rate_limited');
    expect(ingressStore.replayPruneCount).toBe(1);
  });

  test('recomputes a dirty replay expiry bound after deleting its earliest entry', () => {
    const ingressStore = store(() => 'active', { maxReplayEntries: 2, graceMs: 0 });
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'dirty-replay-bound');
    const firstDeadline = wall + 100;
    const first = request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000009', firstDeadline);
    ingressStore.handleDebitRequest(first);
    ingressStore.handleDebitRequest(request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000010', firstDeadline + 100));

    wall = firstDeadline;
    expectCode(() => ingressStore.handleDebitRequest(first), 'deadline_expired');
    expect(ingressStore.replayPruneCount).toBe(0);
    wall = firstDeadline + 1;
    ingressStore.handleDebitRequest(request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000011'));
    wall = firstDeadline + 100;
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, {}, '00000000-0000-4000-8000-000000000012')).body.reason).toBe('rate_limited');
    expect(ingressStore.replayPruneCount).toBe(1);
  });

  test('handles 5000 distinct same-bucket debits without replay-capacity busy responses', () => {
    const ingressStore = store();
    const credential = createRateLimitCredential(secret, worker());
    const bucketId = bucket('tenant', 'large-burst');
    let allowed = 0;
    let retained!: RateLimitDebitRequest;
    let retainedResponse!: ReturnType<IngressTokenBucketStore['handleDebitRequest']>;
    for (let index = 0; index < 5_000; index += 1) {
      wall += 1;
      mono += 1;
      const debit = request(
        credential,
        bucketId,
        { burst: 5_001, rps: Number.MIN_VALUE },
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        wall + 500,
      );
      const response = ingressStore.handleDebitRequest(debit);
      if (response.body.allowed) allowed += 1;
      if (index === 3_999) {
        retained = debit;
        retainedResponse = response;
      }
      if (index === 4_095) expect(ingressStore.replayPruneCount).toBe(0);
    }
    expect(allowed).toBe(5_000);
    // Capacity pressure removes the expired prefix in one sweep.
    expect(ingressStore.replayPruneCount).toBe(1);
    expect(ingressStore.handleDebitRequest(retained)).toEqual(retainedResponse);
    wall += 1;
    mono += 1;
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { burst: 5_001, rps: Number.MIN_VALUE }, '00000000-0000-4000-8000-000000000013', wall + 500)).body.allowed).toBe(true);
    wall += 1;
    mono += 1;
    expect(ingressStore.handleDebitRequest(request(credential, bucketId, { burst: 5_001, rps: Number.MIN_VALUE }, '00000000-0000-4000-8000-000000000014', wall + 500)).body.reason).toBe('rate_limited');
  });

  test('policy IDs bind buckets and historical policy capacity remains hard after bucket reclamation', () => {
    const ingressStore = store(() => 'active', { maxBuckets: 1, maxPolicies: 1, idleTtlMs: 10 });
    const credential = createRateLimitCredential(secret, worker());
    const firstBucket = bucket('tenant', 'policy-a');
    ingressStore.handleDebitRequest(request(credential, firstBucket, { burst: 1, rps: 1 }));
    expect(ingressStore.policyCount).toBe(1);
    expectCode(() => ingressStore.handleDebitRequest(request(credential, firstBucket, { policy_id: 'other' })), 'policy_conflict');
    expectCode(() => ingressStore.handleDebitRequest(request(credential, bucket('tenant', 'policy-b'), { policy_id: 'other' })), 'busy');
    mono = 1_000;
    wall = 11_000;
    expectCode(() => ingressStore.handleDebitRequest(request(credential, bucket('tenant', 'policy-c'), { policy_id: 'other' })), 'busy');
    expect(ingressStore.handleDebitRequest(request(credential, firstBucket, { burst: 1, rps: 1 })).body.allowed).toBe(true);
    expect(ingressStore.policyCount).toBe(1);
  });

  test('authorization, hard cardinality, disposal, and wire-size boundaries fail closed', () => {
    const credential = createRateLimitCredential(secret, worker());
    const bucketA = bucket('tenant', 'a');
    const bucketB = bucket('tenant', 'b');
    const limited = store(() => 'unknown', { maxBuckets: 1 });
    expectCode(() => limited.handleDebitRequest(request(credential, bucketA)), 'worker_unknown');
    const prepared = store(() => 'prepared');
    expectCode(() => prepared.handleDebitRequest(request(credential, bucketA)), 'worker_prepared');
    expect(store(() => 'retired').handleDebitRequest(request(credential, bucketA)).body.allowed).toBe(true);
    expect((createRateLimitCredential(secret, worker(undefined, 65_535)).identity as RateLimitWorkerIdentity).worker_slot).toBe(65_535);
    expectCode(() => createRateLimitCredential(secret, worker(undefined, 65_536)), 'malformed_message');
    const full = store(() => 'active', { maxBuckets: 1 });
    full.handleDebitRequest(request(credential, bucketA));
    expect(full.bucketCount).toBe(1);
    expect(full.policyCount).toBe(1);
    expect(full.replayCount).toBe(1);
    expectCode(() => request(credential, bucketA, { rps: 0 }), 'invalid_policy');
    expectCode(() => full.handleDebitRequest(request(credential, bucketB)), 'busy');
    full.dispose();
    expect(full.bucketCount).toBe(0);
    expect(full.policyCount).toBe(0);
    expect(full.replayCount).toBe(0);
    expectCode(() => full.handleDebitRequest(request(credential, bucketA)), 'disposed');
    expectCode(() => parseRateLimitRequestBytes(), 'message_too_large');
    expectCode(() => parseRateLimitDebitRequest({ ...request(credential, bucketA), extra: 'x'.repeat(5_000) }), 'message_too_large');
    expectCode(() => parseRateLimitDebitRequest({ ...request(credential, bucketA), extra: true }), 'malformed_message');
  });
});

function parseRateLimitRequestBytes(): unknown {
  return parseRateLimitDebitRequest(new Uint8Array(4_097));
}
