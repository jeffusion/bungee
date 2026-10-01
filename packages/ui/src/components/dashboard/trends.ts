import type { TimeRange } from '../../types';

export interface BucketComparison {
  previous: number;
  current: number;
  intervalMs: number;
}

/** Use the snapshot's bounds, not the browser clock; never skip an empty or missing bucket. */
export function completedBuckets(
  timestamps: string[], startTime: number, endTime: number, range: TimeRange,
): BucketComparison | null {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) return null;
  const intervalMs = range === '1h' ? 60_000 : range === '12h' ? 1_800_000 : 3_600_000;
  const currentStart = Math.floor(endTime / intervalMs) * intervalMs - intervalMs;
  const previousStart = currentStart - intervalMs;
  if (previousStart < startTime) return null;
  const previous = timestamps.findIndex(timestamp => Date.parse(timestamp) === previousStart);
  const current = timestamps.findIndex(timestamp => Date.parse(timestamp) === currentStart);
  return previous >= 0 && current === previous + 1 ? { previous, current, intervalMs } : null;
}

/** Compare two selected time buckets, never invent a previous-range aggregate. */
export function bucketTrend(values: number[], percentagePoints = false): number | null {
  if (values.length < 2) return null;
  const previous = values.at(-2)!;
  const current = values.at(-1)!;
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  if (percentagePoints) return current - previous;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous) * 100;
}
