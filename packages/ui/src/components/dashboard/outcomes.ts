import type { DashboardStats, StatsHistoryV2, RequestCounts, UpstreamOutcomeStats } from '../../types';

export function successRate(counts: RequestCounts | undefined): number | null {
  if (!counts || counts.success + counts.failed === 0) return null;
  return counts.success / (counts.success + counts.failed) * 100;
}
export function failureRate(counts: RequestCounts | undefined): number | null {
  const success = successRate(counts);
  return success === null ? null : 100 - success;
}
export function successHistory(history: StatsHistoryV2 | null): number[] {
  if (!history?.requestCounts) return [];
  return history.requestCounts.success.map((success, index) =>
    successRate({ success, failed: history.requestCounts!.failed[index] }) ?? Number.NaN);
}
export function failureHistory(history: StatsHistoryV2 | null): number[] {
  return history?.requestCounts?.failed ?? [];
}
export function dashboardMetrics(snapshot: DashboardStats) {
  const history = snapshot.history;
  const totalRequests = history.requests.reduce((sum, value) => sum + value, 0);
  const rangeMinutes = snapshot.range === '1h' ? 60 : snapshot.range === '12h' ? 720 : 1440;
  return { totalRequests, requestsPerMinute: totalRequests / rangeMinutes,
    successRate: successRate(snapshot.requestCounts), failureRate: failureRate(snapshot.requestCounts),
    failedRequests: snapshot.requestCounts?.failed ?? null,
    avgResponseTime: history.responseTime.length ? history.responseTime.reduce((sum, value) => sum + value, 0) / history.responseTime.length : 0 };
}

export function rankFailures(rows: UpstreamOutcomeStats[]): UpstreamOutcomeStats[] {
  return rows.filter(row => (row.requestCounts?.failed ?? 0) > 0)
    .toSorted((a, b) => b.requestCounts!.failed - a.requestCounts!.failed);
}
