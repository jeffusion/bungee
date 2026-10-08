import { bucketTrend } from '../../../packages/ui/src/components/dashboard/trends';
import { modelTokenTotal, usagePresentation } from './labels';
import type { StatsResponse } from './stats-resource';

export const OVERVIEW_METRICS = ['input', 'output', 'cost'] as const;
export type OverviewMetric = typeof OVERVIEW_METRICS[number];
export const PAGE_METRICS = ['input', 'output', 'tokens', 'cost'] as const;
export type SummaryMetric = typeof PAGE_METRICS[number];
export type OverviewTrend = { metric: SummaryMetric; percent: number | null; change: 'up' | 'down' | 'flat' | null; isNew: boolean };

/** Compare adjacent completed server buckets. Missing traffic is zero; missing metering stays unknown. */
export function overviewTrends(snapshot: StatsResponse | null, metrics: readonly SummaryMetric[] = OVERVIEW_METRICS): OverviewTrend[] {
  const { asOfMs, bucketMs } = snapshot ?? {};
  let valid = snapshot?.groupBy === 'time' && Number.isSafeInteger(asOfMs) && Number.isSafeInteger(bucketMs) && bucketMs! > 0;
  let currentStart = valid ? Math.floor(asOfMs! / bucketMs!) * bucketMs! - bucketMs! : NaN;
  let previousStart = currentStart - bucketMs!;
  if (valid && snapshot?.bucketStarts) {
    const starts = snapshot.bucketStarts;
    valid = starts.every((start, index) => Number.isSafeInteger(start) && (index === 0 || start > starts[index - 1]!));
    // Calendar days can span 23/25 hours; rolling page windows need not align with the UTC clock.
    const current = valid ? starts.findLastIndex((start, index) =>
      (starts[index + 1] ?? snapshot.bucketEndMs ?? start + bucketMs!) <= asOfMs!) : -1;
    valid = current >= 1;
    currentStart = valid ? starts[current]! : NaN;
    previousStart = valid ? starts[current - 1]! : NaN;
  }
  return metrics.map(metric => {
    const amount = (start: number): number | null => {
      if (!valid) return null;
      const rows = snapshot!.data.filter(row => row.bucketStartMs === start);
      let total = 0;
      for (const row of rows) {
        const value = metric === 'cost' ? row.estimatedCostUsd : metric === 'tokens' ? modelTokenTotal(row) : usagePresentation(row)[metric];
        if (value == null || !Number.isFinite(value) || value < 0) return null;
        total += value;
      }
      return total;
    };
    const previous = amount(previousStart), current = amount(currentStart);
    const known = previous !== null && current !== null;
    const percent = known ? bucketTrend([previous, current]) : null;
    return { metric, percent: Number.isFinite(percent) ? percent : null,
      change: !known ? null : current > previous ? 'up' : current < previous ? 'down' : 'flat',
      isNew: known && previous === 0 && current > 0 };
  });
}
