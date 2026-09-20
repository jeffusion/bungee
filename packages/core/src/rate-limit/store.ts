import {
  RATE_LIMIT_MAX_DEADLINE_MS,
  RATE_LIMIT_MAX_GRACE_MS,
  RATE_LIMIT_MAX_RETRY_AFTER_MS,
  RateLimitProtocolError,
  disposeRateLimitCredential,
  getRateLimitDebitRequestFingerprint,
  signRateLimitDebitResponse,
  verifyRateLimitDebitRequest,
  type RateLimitCredential,
  type RateLimitDebitRequest,
  type RateLimitDebitResponse,
  type RateLimitPolicy,
  type RateLimitWireCounters,
  type RateLimitWorkerIdentity,
} from './protocol';

export type RateLimitWorkerAuthorization = 'active' | 'retired' | 'unknown' | 'prepared';

export type IngressTokenBucketStoreClock = {
  readonly monotonicMs?: () => number;
  readonly wallClockMs?: () => number;
  readonly monotonic?: () => number;
  readonly wall?: () => number;
};

export type IngressTokenBucketStoreOptions = {
  readonly credential: RateLimitCredential;
  readonly authorizeWorker: (worker: RateLimitWorkerIdentity) => RateLimitWorkerAuthorization;
  readonly clock?: IngressTokenBucketStoreClock;
  readonly monotonicClock?: () => number;
  readonly wallClock?: () => number;
  readonly graceMs?: number;
  readonly idleTtlMs?: number;
  readonly maxBuckets?: number;
  readonly maxPolicies?: number;
  readonly maxReplayEntries?: number;
};

type CurrentPolicy = RateLimitPolicy;
type Bucket = {
  tokens: number;
  lastRefill: number;
  lastAccess: number;
  policy: CurrentPolicy;
};
type ReplayEntry = {
  readonly fingerprint: string;
  readonly outcome: RateLimitDebitResponse['body'];
  readonly expiresAt: number;
};

const DEFAULT_GRACE_MS = 1_000;
const DEFAULT_IDLE_TTL_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 10_000;
const DEFAULT_MAX_POLICIES = 4_096;
// Bound replay memory; expired entries are swept only when capacity is under pressure.
const DEFAULT_MAX_REPLAY_ENTRIES = 4_096;

function fail(code: ConstructorParameters<typeof RateLimitProtocolError>[0], message: string): never {
  throw new RateLimitProtocolError(code, message);
}

function clockValue(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) return fail('capacity', `${name} must be finite and non-negative`);
  return value;
}

function positiveBounded(value: number | undefined, name: string, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 1_000_000) return fail('capacity', `${name} is outside the hard limit`);
  return result;
}

function nonNegativeBounded(value: number | undefined, name: string, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) return fail('capacity', `${name} is outside the hard limit`);
  return result;
}

export class IngressTokenBucketStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly policies = new Map<string, CurrentPolicy>();
  private readonly replays = new Map<string, ReplayEntry>();
  private readonly monotonicClock: () => number;
  private readonly wallClock: () => number;
  private readonly graceMs: number;
  private readonly idleTtlMs: number;
  private readonly maxBuckets: number;
  private readonly maxPolicies: number;
  private readonly maxReplayEntries: number;
  private nextReplayExpiry: number | undefined = Infinity;
  private replayPruneCountValue = 0;
  private logicalWall: number | undefined;
  private previousMono: number | undefined;
  private closed = false;

  constructor(private readonly options: IngressTokenBucketStoreOptions) {
    this.monotonicClock = options.monotonicClock ?? options.clock?.monotonicMs ?? options.clock?.monotonic ?? (() => performance.now());
    this.wallClock = options.wallClock ?? options.clock?.wallClockMs ?? options.clock?.wall ?? (() => Date.now());
    this.graceMs = nonNegativeBounded(options.graceMs, 'graceMs', DEFAULT_GRACE_MS, RATE_LIMIT_MAX_GRACE_MS);
    this.idleTtlMs = positiveBounded(options.idleTtlMs, 'idleTtlMs', DEFAULT_IDLE_TTL_MS);
    this.maxBuckets = positiveBounded(options.maxBuckets, 'maxBuckets', DEFAULT_MAX_BUCKETS);
    this.maxPolicies = positiveBounded(options.maxPolicies, 'maxPolicies', DEFAULT_MAX_POLICIES);
    this.maxReplayEntries = positiveBounded(options.maxReplayEntries, 'maxReplayEntries', DEFAULT_MAX_REPLAY_ENTRIES);
    if (options.credential.identity.role !== 'ingress') fail('identity_mismatch', 'store requires an ingress credential');
  }

  get bucketCount(): number { return this.buckets.size; }
  get replayCount(): number { return this.replays.size; }
  get replayPruneCount(): number { return this.replayPruneCountValue; }
  get policyCount(): number { return this.policies.size; }

  handleDebitRequest(value: unknown): RateLimitDebitResponse {
    this.assertOpen();
    return this.handleVerifiedDebitRequest(verifyRateLimitDebitRequest(value, this.options.credential));
  }

  handleDebitWire(value: string | Uint8Array, counters?: RateLimitWireCounters): RateLimitDebitResponse {
    this.assertOpen();
    return this.handleVerifiedDebitRequest(verifyRateLimitDebitRequest(value, this.options.credential, counters));
  }

  private handleVerifiedDebitRequest(request: RateLimitDebitRequest): RateLimitDebitResponse {
    const rawWall = clockValue(this.wallClock(), 'wall clock');
    const monoNow = clockValue(this.monotonicClock(), 'monotonic clock');
    const wallNow = this.readLogicalWall(rawWall, monoNow);
    const workerState = this.authorize(request.worker);
    if (workerState === 'unknown') return fail('worker_unknown', 'worker is not known to ingress');
    if (workerState === 'prepared') return fail('worker_prepared', 'worker is not admitted');
    if (workerState !== 'active' && workerState !== 'retired') return fail('unauthorized', 'worker is not authorized');
    const replayKey = `${request.worker.process_instance_id}:${request.worker.boot_nonce}:${request.debit_id}`;
    const fingerprint = getRateLimitDebitRequestFingerprint(request);
    const existing = this.replays.get(replayKey);
    if (existing !== undefined) {
      if (wallNow >= existing.expiresAt) {
        this.deleteReplay(replayKey, existing);
        return fail('deadline_expired', 'debit replay grace has expired');
      }
      if (existing.fingerprint !== fingerprint) return fail('field_conflict', 'debit ID has different fields');
      return signRateLimitDebitResponse({ worker: request.worker, request_id: request.request_id, debit_id: request.debit_id,
        deadline_at: request.deadline_at, body: existing.outcome }, this.options.credential);
    }
    this.checkDeadline(request.deadline_at, wallNow);
    this.prepareReplayCapacity(wallNow);

    const existingBucket = this.buckets.get(request.body.bucket_id);
    if (existingBucket !== undefined && existingBucket.policy.policy_id !== request.body.policy_id) {
      return fail('policy_conflict', 'bucket is permanently bound to another policy');
    }
    if (existingBucket === undefined) this.prepareBucketCapacity(monoNow);
    const policy = this.acceptPolicy(request.body, monoNow);
    const bucket = this.getBucket(request.body.bucket_id, policy, monoNow);
    this.syncBucketPolicy(bucket, policy, monoNow);
    bucket.lastAccess = Math.max(bucket.lastAccess, monoNow);
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    const outcome: RateLimitDebitResponse['body'] = allowed
      ? { allowed: true, reason: 'consumed', retry_after_ms: 0 }
      : { allowed: false, reason: 'rate_limited', retry_after_ms: this.retryAfter(bucket, policy) };
    const expiresAt = request.deadline_at + this.graceMs;
    this.replays.set(replayKey, { fingerprint, outcome, expiresAt });
    if (this.nextReplayExpiry !== undefined) this.nextReplayExpiry = Math.min(this.nextReplayExpiry, expiresAt);
    return signRateLimitDebitResponse({ worker: request.worker, request_id: request.request_id, debit_id: request.debit_id,
      deadline_at: request.deadline_at, body: outcome }, this.options.credential);
  }

  consume(value: unknown): RateLimitDebitResponse { return this.handleDebitRequest(value); }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.buckets.clear();
    this.policies.clear();
    this.replays.clear();
    this.nextReplayExpiry = Infinity;
    this.replayPruneCountValue = 0;
    this.logicalWall = undefined;
    this.previousMono = undefined;
    const credential = this.options.credential;
    // The credential owns the only module-held copy of the derived secret.
    disposeRateLimitCredential(credential);
  }

  private assertOpen(): void {
    if (this.closed) fail('disposed', 'rate-limit store is disposed');
  }

  private authorize(worker: RateLimitWorkerIdentity): RateLimitWorkerAuthorization {
    try {
      const state = this.options.authorizeWorker(worker);
      if (state !== 'active' && state !== 'retired' && state !== 'unknown' && state !== 'prepared') {
        return fail('unauthorized', 'worker authorization callback returned an invalid state');
      }
      return state;
    } catch (cause) {
      if (cause instanceof RateLimitProtocolError) throw cause;
      return fail('unauthorized', 'worker authorization callback failed');
    }
  }

  private checkDeadline(deadlineAt: number, now: number): void {
    if (deadlineAt <= now) fail('deadline_expired', 'debit deadline has expired');
    if (deadlineAt - now > RATE_LIMIT_MAX_DEADLINE_MS) fail('deadline_too_far', 'debit deadline is too far in the future');
  }

  private readLogicalWall(rawWall: number, rawMono: number): number {
    const previousWall = this.logicalWall;
    const previousMono = this.previousMono;
    const monoDelta = previousMono === undefined ? 0 : Math.max(0, rawMono - previousMono);
    const advancedWall = previousWall === undefined ? rawWall : previousWall + monoDelta;
    if (!Number.isFinite(advancedWall)) fail('capacity', 'logical wall clock overflow');
    const logicalWall = Math.max(rawWall, advancedWall);
    this.logicalWall = logicalWall;
    this.previousMono = Math.max(previousMono ?? rawMono, rawMono);
    return logicalWall;
  }

  private prepareReplayCapacity(now: number): void {
    if (this.replays.size < this.maxReplayEntries) return;
    if (this.nextReplayExpiry !== undefined && now < this.nextReplayExpiry) return fail('busy', 'debit replay cache is full');
    this.pruneReplays(now);
    if (this.replays.size >= this.maxReplayEntries) return fail('busy', 'debit replay cache is full');
  }

  private pruneReplays(now: number): void {
    this.replayPruneCountValue += 1;
    let nextExpiry = Infinity;
    for (const [key, entry] of this.replays) {
      if (entry.expiresAt <= now) this.replays.delete(key);
      else nextExpiry = Math.min(nextExpiry, entry.expiresAt);
    }
    this.nextReplayExpiry = nextExpiry;
  }

  private deleteReplay(key: string, entry: ReplayEntry): void {
    this.replays.delete(key);
    if (this.replays.size === 0) this.nextReplayExpiry = Infinity;
    else if (this.nextReplayExpiry !== undefined && entry.expiresAt === this.nextReplayExpiry) this.nextReplayExpiry = undefined;
  }

  private acceptPolicy(input: RateLimitPolicy, now: number): CurrentPolicy {
    const next = { policy_id: input.policy_id, revision: input.revision, rps: input.rps, burst: input.burst };
    const current = this.policies.get(input.policy_id);
    if (current === undefined) {
      if (this.policies.size >= this.maxPolicies) return fail('busy', 'policy capacity is full');
      this.policies.set(input.policy_id, next);
      return next;
    }
    if (input.revision === current.revision) {
      if (input.rps !== current.rps || input.burst !== current.burst) fail('policy_conflict', 'same policy revision has different parameters');
      return current;
    }
    if (input.revision > current.revision) {
      this.policies.set(input.policy_id, next);
      for (const bucket of this.buckets.values()) {
        if (bucket.policy.policy_id === input.policy_id) this.syncBucketPolicy(bucket, next, now);
      }
      return next;
    }
    return current;
  }

  private getBucket(bucketId: string, policy: CurrentPolicy, now: number): Bucket {
    const existing = this.buckets.get(bucketId);
    if (existing !== undefined) return existing;
    if (this.buckets.size >= this.maxBuckets) return fail('busy', 'token bucket capacity is full');
    const bucket: Bucket = { tokens: policy.burst, lastRefill: now, lastAccess: now, policy };
    this.buckets.set(bucketId, bucket);
    return bucket;
  }

  private prepareBucketCapacity(now: number): void {
    if (this.buckets.size < this.maxBuckets) return;
    this.pruneBuckets(now);
    if (this.buckets.size >= this.maxBuckets) return fail('busy', 'token bucket capacity is full');
  }

  private pruneBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) {
      this.syncBucketPolicy(bucket, bucket.policy, now);
      const idle = Math.max(0, now - bucket.lastAccess);
      if (bucket.tokens >= bucket.policy.burst && idle > this.idleTtlMs) {
        this.buckets.delete(key);
      }
    }
  }

  private syncBucketPolicy(bucket: Bucket, policy: CurrentPolicy, now: number): void {
    const refillNow = Math.max(now, bucket.lastRefill);
    const elapsed = refillNow - bucket.lastRefill;
    if (elapsed > 0 && bucket.policy.rps > 0) bucket.tokens = Math.min(bucket.policy.burst, bucket.tokens + elapsed * bucket.policy.rps / 1_000);
    bucket.lastRefill = refillNow;
    if (bucket.policy.revision !== policy.revision) {
      bucket.tokens = Math.min(bucket.tokens, policy.burst);
      bucket.policy = policy;
    }
  }

  private retryAfter(bucket: Bucket, policy: CurrentPolicy): number {
    if (policy.rps <= 0) return RATE_LIMIT_MAX_RETRY_AFTER_MS;
    return Math.min(RATE_LIMIT_MAX_RETRY_AFTER_MS, Math.max(1, Math.ceil((1 - bucket.tokens) * 1_000 / policy.rps)));
  }
}
