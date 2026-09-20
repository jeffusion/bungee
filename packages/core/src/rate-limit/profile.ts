export const RATE_LIMIT_FAILURE_REASONS = [
  'unavailable', 'busy', 'aborted', 'disposed', 'timeout', 'network_error',
  'transport_invalid', 'protocol_error', 'configuration_invalid', 'unexpected',
] as const;

export const RATE_LIMIT_FAILURE_STAGES = [
  'precondition', 'session', 'sign', 'fetch', 'read', 'verify',
  'server_read', 'server_store', 'server_serialize',
] as const;

export const RATE_LIMIT_TIMING_STAGES = [
  'session', 'sign', 'fetch1', 'fetch2', 'read', 'verify', 'total',
  'server_read', 'server_store_total', 'server_serialize', 'server_total',
] as const;

export const RATE_LIMIT_PROFILE_BUCKETS = [
  0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 500, Infinity,
] as const;

export type RateLimitFailureReason = typeof RATE_LIMIT_FAILURE_REASONS[number];
export type RateLimitFailureStage = typeof RATE_LIMIT_FAILURE_STAGES[number];
export type RateLimitTimingStage = typeof RATE_LIMIT_TIMING_STAGES[number];

export type RateLimitFailure = {
  readonly reason: RateLimitFailureReason;
  readonly stage: RateLimitFailureStage;
  readonly protocolCode?: string;
  readonly remoteStatus?: number;
  readonly attempts: number;
  readonly totalMs: number;
};

export type RateLimitFailureInput = Omit<RateLimitFailure, 'attempts' | 'totalMs'> & {
  readonly attempts?: number;
  readonly totalMs?: number;
};

export type RateLimitTiming = {
  readonly stage: RateLimitTimingStage;
  readonly durationMs: number;
};

export type RateLimitObserver = {
  readonly failure?: (failure: RateLimitFailure) => void;
  readonly timing?: (timing: RateLimitTiming) => void;
};

export type RateLimitProfileSnapshot = {
  readonly counters: Record<RateLimitFailureReason, Record<RateLimitFailureStage, number>>;
  readonly histograms: Record<RateLimitTimingStage, { readonly buckets: Array<number | null>; readonly counts: number[] }>;
  readonly recentFailures: RateLimitFailure[];
  readonly dropped: number;
};

const MAX_FAILURES = 8;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function createCounters(): Record<RateLimitFailureReason, Record<RateLimitFailureStage, number>> {
  return Object.fromEntries(RATE_LIMIT_FAILURE_REASONS.map((reason) => [
    reason,
    Object.fromEntries(RATE_LIMIT_FAILURE_STAGES.map((stage) => [stage, 0])),
  ])) as Record<RateLimitFailureReason, Record<RateLimitFailureStage, number>>;
}

function createHistograms(): Record<RateLimitTimingStage, { buckets: number[]; counts: number[] }> {
  return Object.fromEntries(RATE_LIMIT_TIMING_STAGES.map((stage) => [stage, {
    buckets: [...RATE_LIMIT_PROFILE_BUCKETS], counts: RATE_LIMIT_PROFILE_BUCKETS.map(() => 0),
  }])) as Record<RateLimitTimingStage, { buckets: number[]; counts: number[] }>;
}

export type RateLimitProfileCollector = RateLimitObserver & {
  readonly observer: RateLimitObserver;
  readonly recordFailure: (failure: RateLimitFailure) => void;
  readonly recordTiming: (timing: RateLimitTiming) => void;
  snapshot(): RateLimitProfileSnapshot;
};

export function rateLimitFailureReasonForProtocolCode(code: string): RateLimitFailureReason {
  if (code === 'busy') return 'busy';
  if (code === 'disposed') return 'disposed';
  if (code === 'deadline_expired') return 'timeout';
  if (code === 'message_too_large') return 'transport_invalid';
  return 'protocol_error';
}

export function createRateLimitProfileCollector(): RateLimitProfileCollector {
  const counters = createCounters();
  const histograms = createHistograms();
  const recentFailures: RateLimitFailure[] = [];
  let dropped = 0;

  const failure = (event: RateLimitFailure): void => {
    const count = counters[event.reason][event.stage];
    counters[event.reason][event.stage] = count === MAX_COUNTER ? MAX_COUNTER : count + 1;
    if (recentFailures.length < MAX_FAILURES) {
      recentFailures.push({
        reason: event.reason,
        stage: event.stage,
        ...(event.protocolCode === undefined ? {} : { protocolCode: event.protocolCode }),
        ...(event.remoteStatus === undefined ? {} : { remoteStatus: event.remoteStatus }),
        attempts: event.attempts,
        totalMs: event.totalMs,
      });
    } else dropped = dropped === MAX_COUNTER ? MAX_COUNTER : dropped + 1;
  };
  const timing = (event: RateLimitTiming): void => {
    const value = Number.isFinite(event.durationMs) && event.durationMs >= 0 ? event.durationMs : Infinity;
    const index = RATE_LIMIT_PROFILE_BUCKETS.findIndex((bucket) => value <= bucket);
    const counts = histograms[event.stage].counts;
    const current = counts[index < 0 ? counts.length - 1 : index]!;
    counts[index < 0 ? counts.length - 1 : index] = current === MAX_COUNTER ? MAX_COUNTER : current + 1;
  };
  return {
    failure,
    timing,
    observer: { failure, timing },
    recordFailure: failure,
    recordTiming: timing,
    snapshot(): RateLimitProfileSnapshot {
      return {
        counters: structuredClone(counters),
        histograms: Object.fromEntries(RATE_LIMIT_TIMING_STAGES.map((stage) => [stage, {
          buckets: histograms[stage].buckets.map((bucket) => Number.isFinite(bucket) ? bucket : null),
          counts: [...histograms[stage].counts],
        }])) as RateLimitProfileSnapshot['histograms'],
        recentFailures: structuredClone(recentFailures),
        dropped,
      };
    },
  };
}

export function rateLimitProfileEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.BUNGEE_RATE_LIMIT_PROFILE === '1';
}

export function writeRateLimitProfileSummary(
  role: 'worker' | 'ingress',
  collector: RateLimitProfileCollector,
  workerSlot?: number,
): void {
  const summary: Record<string, unknown> = {
    kind: 'rate_limit_profile', role, pid: process.pid,
    ...(workerSlot === undefined ? {} : { worker_slot: workerSlot }),
    collector: collector.snapshot(),
  };
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}
