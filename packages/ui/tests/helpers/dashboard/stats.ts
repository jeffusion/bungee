import assert from 'node:assert/strict';
import type { UpstreamOutcomeStats } from '../../../../core/src/api/logs';
import type { HttpStatusCounts, RequestCounts, TransportCounts } from '../../../../core/src/logger/transport-outcome';
import type { CountHistory, DashboardStats, StatsHistoryV2, TimeRange } from '../../../src/types';

export type CompleteHistory = Required<StatsHistoryV2>;
export type CompleteDashboardStats = Required<Omit<DashboardStats, 'history' | 'upstreams'>> & {
  history: CompleteHistory; upstreams: UpstreamOutcomeStats[];
};
const httpKeys = ['status2xx', 'status3xx', 'status4xx', 'status5xx', 'statusOther'] as const;
const transportKeys = ['pending', 'completed', 'failed', 'cancelled', 'unknown'] as const;
const total = (values: object) => (Object.values(values) as number[]).reduce((sum, value) => sum + value, 0);
const percentage = (count: number, denominator: number, empty = 0) => denominator ? Math.round(count / denominator * 10_000) / 100 : empty;
export const emptyHttp = (): HttpStatusCounts => ({ status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0 });
export const emptyTransport = (): TransportCounts => ({ pending: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 });

export interface OutcomeSample {
  requestCounts: RequestCounts;
  httpStatusCounts: HttpStatusCounts;
  transportCounts: TransportCounts;
  // Protocol outcomes and joint HTTP/transport outcomes describe different dimensions.
  successRequests: number; failedRequests: number;
}
function checkSample(sample: OutcomeSample) {
  for (const count of [...Object.values(sample.requestCounts), ...Object.values(sample.httpStatusCounts), ...Object.values(sample.transportCounts), sample.successRequests, sample.failedRequests]) {
    assert(Number.isSafeInteger(count) && count >= 0, `Fixture counts must be nonnegative integers: ${count}`);
  }
  const requests = total(sample.httpStatusCounts);
  assert.equal(total(sample.transportCounts), requests, 'HTTP and transport dimensions describe the same requests');
  assert.equal(sample.successRequests + sample.failedRequests, requests, 'Protocol outcome dimension covers the same requests');
  assert(sample.requestCounts.success <= sample.httpStatusCounts.status2xx, 'Joint success requires HTTP 2xx');
  assert(sample.requestCounts.success <= sample.transportCounts.completed, 'Joint success requires completed transport');
  assert.equal(sample.requestCounts.success + sample.requestCounts.failed, sample.transportCounts.completed + sample.transportCounts.failed,
    'Cancelled, pending and unknown transport do not enter the joint outcome denominator');
  return requests;
}
export function upstreamSample(upstream: string, sample: OutcomeSample, failed2xx = 0): UpstreamOutcomeStats {
  const totalRequests = checkSample(sample);
  assert(Number.isSafeInteger(failed2xx) && failed2xx >= 0 && failed2xx <= sample.httpStatusCounts.status2xx && failed2xx <= sample.failedRequests);
  return { ...sample, ...sample.httpStatusCounts, upstream, totalRequests, count: totalRequests, percentage: 0,
    successRate: percentage(sample.successRequests, totalRequests), failureRate: percentage(sample.failedRequests, totalRequests), failed2xx };
}
export function upstreamPercentages(rows: readonly UpstreamOutcomeStats[]): UpstreamOutcomeStats[] {
  const attempts = rows.reduce((sum, row) => sum + row.totalRequests, 0);
  return rows.map(row => ({ ...row, percentage: percentage(row.totalRequests, attempts) }));
}
export function historySample(samples: readonly (OutcomeSample & { timestamp: number; responseTime: number })[]): CompleteHistory {
  samples.forEach(checkSample);
  return {
    timestamps: samples.map(sample => new Date(sample.timestamp).toISOString()),
    requests: samples.map(sample => total(sample.httpStatusCounts)),
    errors: samples.map(sample => sample.failedRequests), responseTime: samples.map(sample => sample.responseTime),
    successRate: samples.map(sample => percentage(sample.successRequests, total(sample.httpStatusCounts), 100)),
    failureRate: samples.map(sample => percentage(sample.failedRequests, total(sample.httpStatusCounts))),
    requestCounts: { success: samples.map(sample => sample.requestCounts.success), failed: samples.map(sample => sample.requestCounts.failed) },
    httpStatusCounts: Object.fromEntries(httpKeys.map(key => [key, samples.map(sample => sample.httpStatusCounts[key])])) as CountHistory<HttpStatusCounts>,
    transportCounts: Object.fromEntries(transportKeys.map(key => [key, samples.map(sample => sample.transportCounts[key])])) as CountHistory<TransportCounts>,
  };
}
export function dashboardSample(range: TimeRange, endTime: number, history: CompleteHistory, upstreams: readonly UpstreamOutcomeStats[] = []): CompleteDashboardStats {
  const sum = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
  return {
    range, startTime: endTime - ({ '1h': 3_600_000, '12h': 43_200_000, '24h': 86_400_000 }[range]), endTime,
    units: { history: 'request_chain', upstreams: 'upstream_attempt' }, history, upstreams: upstreamPercentages(upstreams),
    requestCounts: { success: sum(history.requestCounts.success), failed: sum(history.requestCounts.failed) },
    httpStatusCounts: Object.fromEntries(httpKeys.map(key => [key, sum(history.httpStatusCounts[key])])) as unknown as HttpStatusCounts,
    transportCounts: Object.fromEntries(transportKeys.map(key => [key, sum(history.transportCounts[key])])) as unknown as TransportCounts,
  };
}
