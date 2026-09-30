import { expect, test } from 'bun:test';
import { bucketTrend } from './trends';

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
