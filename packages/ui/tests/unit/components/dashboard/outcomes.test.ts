import { expect, test } from 'bun:test';
import { dashboardMetrics, failureHistory, successHistory, successRate, rankFailures } from '../../../../src/components/dashboard/outcomes';
import type { DashboardStats, UpstreamOutcomeStats } from '../../../../src/types';

const snapshot: DashboardStats = { startTime: 0, endTime: 3600000, range: '1h', units: { history: 'request_chain', upstreams: 'upstream_attempt' },
  history: { timestamps: ['a', 'b'], requests: [4, 4], errors: [999, 999], responseTime: [2, 4], successRate: [99, 99], failureRate: [99, 99],
    requestCounts: { success: [2, 1], failed: [1, 0] } },
  requestCounts: { success: 3, failed: 1 },
  httpStatusCounts: { status2xx: 4, status3xx: 0, status4xx: 1, status5xx: 2, statusOther: 1 },
  transportCounts: { pending: 1, completed: 3, failed: 1, cancelled: 2, unknown: 1 }, upstreams: [] };

test('request success and failure use joint counts and exclude cancellation from both denominators', () => {
  const metrics = dashboardMetrics(snapshot);
  expect(metrics.totalRequests).toBe(8);
  expect(metrics.successRate).toBe(75); expect(metrics.failureRate).toBe(25); expect(metrics.failedRequests).toBe(1);
  expect(successHistory(snapshot.history)).toEqual([2 / 3 * 100, 100]);
  expect(failureHistory(snapshot.history)).toEqual([1, 0]);
  expect(dashboardMetrics({ ...snapshot, transportCounts: { pending: 0, completed: 3, failed: 1, cancelled: 999, unknown: 0 } }).successRate).toBe(75);
});

test('missing joint counts never infer success from independent totals or legacy metrics', () => {
  const old = { ...snapshot, requestCounts: undefined, history: { ...snapshot.history, requestCounts: undefined } };
  expect(dashboardMetrics(old).successRate).toBeNull(); expect(dashboardMetrics(old).failureRate).toBeNull(); expect(dashboardMetrics(old).failedRequests).toBeNull();
  expect(successHistory(old.history)).toEqual([]); expect(failureHistory(old.history)).toEqual([]);
});

test('empty or cancelled-only buckets have no success rate and do not invent a comparison value', () => {
  expect(successRate({ success: 0, failed: 0 })).toBeNull();
  expect(successHistory({ ...snapshot.history, requestCounts: { success: [0, 1], failed: [0, 0] } })[0]).toBeNaN();
});

test('failure ranking ignores cancellation, pending, unknown and legacy failure counts', () => {
  const rows = [
    { upstream: 'cancelled', failedRequests: 999, requestCounts: { success: 0, failed: 0 } },
    { upstream: 'one-failure', failedRequests: 999, requestCounts: { success: 1, failed: 1 } },
    { upstream: 'two-failures', failedRequests: 0, requestCounts: { success: 0, failed: 2 } },
    { upstream: 'legacy', failedRequests: 999 },
  ] as UpstreamOutcomeStats[];
  expect(rankFailures(rows).map(row => row.upstream)).toEqual(['two-failures', 'one-failure']);
  expect(rows.map(row => row.upstream)).toEqual(['cancelled', 'one-failure', 'two-failures', 'legacy']);
});
