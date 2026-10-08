import { expect, test } from 'bun:test';
import { overviewTrends, PAGE_METRICS } from '../ui/overview-trends';
import type { StatsResponse } from '../ui/stats-resource';

const bucketMs = 300_000;
const row = (bucket: number, input: number, output: number, cost: number | null) => ({
  dimension: 'model', bucketStartMs: bucket * bucketMs,
  officialInputTokens: input, officialOutputTokens: output, estimatedCostUsd: cost,
  authorityBreakdown: { input: { official: 1 }, output: { official: 1 } },
});
const snapshot = (data: StatsResponse['data']): StatsResponse => ({
  groupBy: 'time', bucketMs, asOfMs: bucketMs * 10 + 10, estimatedCostUsd: null, data,
});

test('compares completed server buckets, combining models and excluding the live bucket', () => {
  const result = overviewTrends(snapshot([row(8, 100, 200, 0.02), row(9, 100, 100, 0.02),
    { ...row(9, 50, 0, 0.01), dimension: 'other' }, row(10, 9999, 9999, 9999)]));
  expect(result.slice(0, 2)).toEqual([
    { metric: 'input', percent: 50, change: 'up', isNew: false },
    { metric: 'output', percent: -50, change: 'down', isNew: false },
  ]);
  expect(result[2]).toMatchObject({ metric: 'cost', change: 'up', isNew: false });
  expect(result[2].percent).toBeCloseTo(50);
});

test('empty adjacent buckets are zero; older active buckets cannot replace them', () => {
  expect(overviewTrends(snapshot([row(7, 999, 999, 999), row(9, 10, 20, 0.01)]))
    .every(item => item.isNew && item.percent === null && item.change === 'up')).toBe(true);
  expect(overviewTrends(snapshot([])).every(item => item.percent === 0 && item.change === 'flat')).toBe(true);
  expect(overviewTrends(snapshot([row(8, 10, 20, 0.01)])).every(item => item.percent === -100 && item.change === 'down')).toBe(true);
});

test('unpriced or unreported usage remains unknown, independently for each metric', () => {
  const unmetered = { dimension: 'unknown', bucketStartMs: 9 * bucketMs, logicalRequests: 1, upstreamAttempts: 1 };
  const unknown = overviewTrends(snapshot([row(8, 100, 200, 0.02), row(9, 100, 100, 0.02), unmetered]));
  expect(unknown.every(item => item.percent === null && item.change === null && !item.isNew)).toBe(true);
  const unpriced = overviewTrends(snapshot([row(8, 100, 200, null), row(9, 200, 100, 0.02)]));
  expect(unpriced[0].percent).toBe(100);
  expect(unpriced[1].percent).toBe(-50);
  expect(unpriced[2].percent).toBeNull();
});

test('an exact server boundary includes the just-completed bucket; missing metadata is unknown', () => {
  const value = snapshot([row(8, 100, 200, 0.02), row(9, 150, 100, 0.03)]);
  expect(overviewTrends({ ...value, asOfMs: bucketMs * 10 })).toEqual(overviewTrends(value));
  for (const invalid of [null, { ...value, asOfMs: undefined }, { ...value, bucketMs: 0 }, { ...value, groupBy: 'model' as const }]) {
    expect(overviewTrends(invalid).every(item => item.percent === null && item.change === null)).toBe(true);
  }
});

test('page total-token trend combines input and output without counting cache again', () => {
  const value = snapshot([
    { ...row(8, 100, 20, 0.02), cacheReadTokens: 70, cacheWriteTokens: 10 },
    { ...row(9, 100, 80, 0.01), cacheReadTokens: 30, cacheWriteTokens: 20 },
  ]);
  expect(overviewTrends(value, PAGE_METRICS)).toEqual([
    { metric: 'input', percent: 0, change: 'flat', isNew: false },
    { metric: 'output', percent: 300, change: 'up', isNew: false },
    { metric: 'tokens', percent: 50, change: 'up', isNew: false },
    { metric: 'cost', percent: -50, change: 'down', isNew: false },
  ]);
});

test('page trends use server boundaries instead of rounding rolling windows to UTC', () => {
  const starts = [123, 3_600_123, 7_200_123, 10_800_123];
  const value: StatsResponse = { ...snapshot([]), bucketMs: 3_600_000,
    asOfMs: 10_800_123, bucketStarts: starts, bucketEndMs: 14_400_123,
    data: starts.map((bucketStartMs, index) => ({ ...row(0, [10, 20, 30, 9999][index]!, 1, 1), bucketStartMs })) };
  expect(overviewTrends(value, PAGE_METRICS)[0]).toMatchObject({ percent: 50, change: 'up' });
  expect(overviewTrends({ ...value, asOfMs: value.bucketEndMs }, PAGE_METRICS)[0]?.percent).toBe(33230);
});

test('calendar trends compare adjacent complete local days across a 25-hour DST day', () => {
  const starts = ['2026-10-31T04:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-03T05:00:00Z'].map(Date.parse);
  const value: StatsResponse = { ...snapshot([]), bucketMs: 86_400_000,
    bucketStarts: starts, bucketEndMs: Date.parse('2026-11-04T05:00:00Z'), asOfMs: starts[2]! + 3_600_000,
    data: starts.map((bucketStartMs, index) => ({ ...row(0, [100, 150, 9999, 9999][index]!, 1, 1), bucketStartMs })) };
  expect(overviewTrends(value, PAGE_METRICS)[0]).toMatchObject({ percent: 50, change: 'up' });
});

test('a page period with fewer than two complete buckets has no comparison', () => {
  const value = { ...snapshot([row(0, 10, 20, 1)]), bucketStarts: [0, bucketMs, bucketMs * 2] };
  for (const asOfMs of [0, bucketMs - 1, bucketMs, bucketMs * 2 - 1]) {
    expect(overviewTrends({ ...value, asOfMs }, PAGE_METRICS).every(trend => trend.percent === null && trend.change === null && !trend.isNew)).toBe(true);
  }
  expect(overviewTrends({ ...value, asOfMs: bucketMs * 2 }, PAGE_METRICS)[0]?.percent).toBe(-100);
  expect(overviewTrends({ ...value, bucketStarts: [], asOfMs: bucketMs * 2 }, PAGE_METRICS).every(trend => trend.percent === null)).toBe(true);
});
