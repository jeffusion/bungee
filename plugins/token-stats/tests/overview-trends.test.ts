import { expect, test } from 'bun:test';
import { overviewTrends } from '../ui/overview-trends';
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
