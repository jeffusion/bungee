import { expect, test } from 'bun:test';
import { tokenComposition, usagePresentation, buildTimeSeries, modelTokenTotal, type ModelUsageRow } from '../../../../plugins/token-stats/ui/labels';

test('Token composition does not count cache twice and unknown usage remains unknown', () => {
  const row = { officialInputTokens: 100, officialOutputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10 };
  expect(tokenComposition(row)).toEqual({ input: 20, output: 20, cacheRead: 70, cacheWrite: 10, total: 120 });
  expect(modelTokenTotal(row)).toBe(120);
  expect(tokenComposition({ ...row, cacheReadTokens: 200 })).toEqual({ input: 0, output: 20, cacheRead: 100, cacheWrite: 0, total: 120 });
  expect(usagePresentation({ logicalRequests: 1, upstreamAttempts: 1 }).state).toBe('unknown');
});

test('time buckets preserve gaps, count totals once, and retain long-tail details', () => {
  const now = 3_900_000;
  const rows: ModelUsageRow[] = ['a', 'b', 'c', 'd', 'e', 'unknown'].map((dimension, index) => ({
    dimension, bucketStartMs: 3_600_000, officialInputTokens: 10 - index, officialOutputTokens: 0,
  }));
  const series = buildTimeSeries(rows, '1h', 300_000, now);
  expect(series.buckets.find(bucket => bucket.startMs === 3_600_000)?.total).toBe(45);
  expect(series.buckets.find(bucket => bucket.startMs === 3_600_000)?.details).toHaveLength(6);
  expect(series.models).toHaveLength(6);
  expect(series.buckets.some(bucket => bucket.total === 0)).toBe(true);
});

test('page charts preserve server calendar boundaries, including a 25-hour day and empty days', () => {
  const starts = [Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5), Date.UTC(2026, 10, 3, 5)];
  const series = buildTimeSeries([
    { dimension: 'model-a', bucketStartMs: starts[0], officialInputTokens: 10, officialOutputTokens: 5 },
    { dimension: 'model-b', bucketStartMs: starts[2], officialInputTokens: 3, officialOutputTokens: 2 },
  ], 'month', 86_400_000, Date.UTC(2026, 10, 3, 18), starts);
  expect(series.buckets.map(bucket => bucket.startMs)).toEqual(starts);
  expect(series.buckets.map(bucket => bucket.total)).toEqual([15, 0, 5]);
  expect(series.models).toEqual(['model-a', 'model-b']);
});
