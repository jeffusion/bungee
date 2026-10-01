import { expect, test } from 'bun:test';
import { bucketTrend, completedBuckets } from './trends';
import type { TimeRange } from '../../types';

const timestamp = (ms: number) => new Date(ms).toISOString();

test.each([
  ['1h', 60_000], ['12h', 1_800_000], ['24h', 3_600_000],
] as [TimeRange, number][])('%s compares equal completed intervals using the snapshot time', (range, intervalMs) => {
  const endTime = intervalMs * 10 + intervalMs / 2;
  const timestamps = [7, 8, 9, 10].map(n => timestamp(intervalMs * n));
  const comparison = completedBuckets(timestamps, intervalMs * 7, endTime, range);
  expect(comparison).toEqual({ previous: 1, current: 2, intervalMs });
  const values = [50, 60, 60, 30];
  expect(bucketTrend([values[comparison!.previous], values[comparison!.current]])).toBe(0);
});

test('an exact boundary includes the interval that just ended', () => {
  const timestamps = [7, 8, 9, 10].map(n => timestamp(n * 60_000));
  expect(completedBuckets(timestamps, 7 * 60_000, 10 * 60_000, '1h'))
    .toEqual({ previous: 1, current: 2, intervalMs: 60_000 });
  expect(completedBuckets(timestamps, 7 * 60_000, 10 * 60_000 - 1, '1h'))
    .toEqual({ previous: 0, current: 1, intervalMs: 60_000 });
});

test('missing, partial or invalid windows cannot substitute older intervals', () => {
  const timestamps = [7, 8, 9, 10].map(n => timestamp(n * 60_000));
  expect(completedBuckets(timestamps, 8 * 60_000 + 1, 10 * 60_000, '1h')).toBeNull();
  expect(completedBuckets(timestamps.filter((_, i) => i !== 2), 7 * 60_000, 10 * 60_000, '1h')).toBeNull();
  expect(completedBuckets([timestamps[2]], 7 * 60_000, 10 * 60_000, '1h')).toBeNull();
  expect(completedBuckets([], 7 * 60_000, 10 * 60_000, '1h')).toBeNull();
  expect(completedBuckets(timestamps, NaN, 10 * 60_000, '1h')).toBeNull();
  expect(completedBuckets(timestamps, 7 * 60_000, Infinity, '1h')).toBeNull();
  expect(completedBuckets(timestamps, 10 * 60_000, 10 * 60_000, '1h')).toBeNull();
});

test('completed growth and declines use actual adjacent intervals, including zeros', () => {
  const comparison = completedBuckets([7, 8, 9, 10].map(n => timestamp(n * 60_000)), 7 * 60_000, 10.5 * 60_000, '1h')!;
  const values = [100, 515, 542, 220];
  expect(bucketTrend([values[comparison.previous], values[comparison.current]])).toBeCloseTo(5.242718);
  expect(bucketTrend([9, 0])).toBe(-100);
});

test('bucket trends compare the latest intervals and express rates as percentage points', () => {
  expect(bucketTrend([500, 100, 120])).toBe(20);
  expect(bucketTrend([120, 100])).toBeCloseTo(-16.6667);
  expect(bucketTrend([99, 99.5], true)).toBe(.5);
});
test('missing or zero baselines do not fabricate a trend', () => {
  expect(bucketTrend([])).toBeNull();
  expect(bucketTrend([10])).toBeNull();
  expect(bucketTrend([0, 20])).toBeNull();
  expect(bucketTrend([0, 0])).toBe(0);
  expect(bucketTrend([NaN, 1])).toBeNull();
});
