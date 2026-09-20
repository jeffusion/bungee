import { describe, expect, test } from 'bun:test';
import {
  RATE_LIMIT_PROFILE_BUCKETS,
  createRateLimitProfileCollector,
  type RateLimitFailure,
} from '../../src/rate-limit';

const failure: RateLimitFailure = {
  reason: 'network_error', stage: 'fetch', attempts: 2, totalMs: 1,
};

describe('rate-limit profile collector', () => {
  test('uses fixed saturated counters, histograms, and an eight-entry failure ring', () => {
    const profile = createRateLimitProfileCollector();
    for (let index = 0; index < 10; index += 1) {
      profile.recordFailure({ ...failure, totalMs: index });
    }
    profile.recordTiming({ stage: 'total', durationMs: 0.3 });
    const snapshot = profile.snapshot();
    expect(snapshot.counters.network_error.fetch).toBe(10);
    expect(snapshot.recentFailures).toHaveLength(8);
    expect(snapshot.dropped).toBe(2);
    expect(snapshot.histograms.total.buckets).toEqual([...RATE_LIMIT_PROFILE_BUCKETS].map((value) => Number.isFinite(value) ? value : null));
    expect(snapshot.histograms.total.counts[1]).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('bucket_id');
    expect(JSON.stringify(snapshot)).not.toContain('normalized_key');
  });
});
