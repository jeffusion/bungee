import { bucketTrend } from '../../../packages/ui/src/components/dashboard/trends';
import { usagePresentation } from './labels';
import type { StatsResponse } from './stats-resource';

export const OVERVIEW_METRICS = ['input', 'output', 'cost'] as const;
export type OverviewMetric = typeof OVERVIEW_METRICS[number];
export type OverviewTrend = { metric: OverviewMetric; percent: number | null; change: 'up' | 'down' | 'flat' | null; isNew: boolean };

/** Compare adjacent completed server buckets. Missing traffic is zero; missing metering stays unknown. */
export function overviewTrends(snapshot: StatsResponse | null): OverviewTrend[] {
  const { asOfMs, bucketMs } = snapshot ?? {};
  const valid = snapshot?.groupBy === 'time' && Number.isSafeInteger(asOfMs) && Number.isSafeInteger(bucketMs) && bucketMs! > 0;
  const currentStart = valid ? Math.floor(asOfMs! / bucketMs!) * bucketMs! - bucketMs! : NaN;
  return OVERVIEW_METRICS.map(metric => {
    const amount = (start: number): number | null => {
      if (!valid) return null;
      const rows = snapshot!.data.filter(row => row.bucketStartMs === start);
      let total = 0;
      for (const row of rows) {
        const value = metric === 'cost' ? row.estimatedCostUsd : usagePresentation(row)[metric];
        if (value == null || !Number.isFinite(value) || value < 0) return null;
        total += value;
      }
      return total;
    };
    const previous = amount(currentStart - bucketMs!), current = amount(currentStart);
    const known = previous !== null && current !== null;
    const percent = known ? bucketTrend([previous, current]) : null;
    return { metric, percent: Number.isFinite(percent) ? percent : null,
      change: !known ? null : current > previous ? 'up' : current < previous ? 'down' : 'flat',
      isNew: known && previous === 0 && current > 0 };
  });
}
