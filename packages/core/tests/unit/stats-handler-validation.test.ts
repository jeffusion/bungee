import { describe, expect, test } from 'bun:test';
import { StatsHandler } from '../../src/api/handlers/stats';
import { LogsHandler } from '../../src/api/handlers/logs';

const logsHandler = new LogsHandler({
  logQueryService: {} as any,
  bodyStorage: {} as any,
  headerStorage: {} as any,
  cleanupService: {} as any,
});

const statsHandler = new StatsHandler({
  getStats: async () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, avgResponseTime: 0 }),
  getChainCount: async () => 0,
  getCumulativeHistory: async () => [],
  getTimeSeriesStats: async () => [],
  getUpstreamDistribution: async () => [],
  getUpstreamFailureStats: async () => [],
  getUnifiedUpstreamStats: async () => [],
  getUpstreamStatusCodeStats: async () => [],
});

describe('stats handler query validation', () => {
  test('rejects empty and repeated history intervals', async () => {
    expect((await statsHandler.getHistory(new Request('http://localhost/api/stats/history?interval='))).status).toBe(400);
    expect((await statsHandler.getHistory(new Request('http://localhost/api/stats/history?interval=10s&interval=1m'))).status).toBe(400);
  });

  test('rejects empty and repeated history v2 ranges', async () => {
    expect((await statsHandler.getHistoryV2(new Request('http://localhost/api/stats/history/v2?range='))).status).toBe(400);
    expect((await statsHandler.getHistoryV2(new Request('http://localhost/api/stats/history/v2?range=1h&range=wat'))).status).toBe(400);
  });

  test('validates every range-based upstream stats endpoint consistently', async () => {
    const handlers = [
      statsHandler.getUpstreamDistribution.bind(statsHandler),
      statsHandler.getUpstreamFailures.bind(statsHandler),
      statsHandler.getUpstreamStatusCodes.bind(statsHandler),
      statsHandler.getUnifiedUpstreamStats.bind(statsHandler),
    ];
    const invalidQueries = ['range=', 'range=1h&range=24h', 'range=123junk'];

    for (const handler of handlers) {
      for (const query of invalidQueries) {
        expect((await handler(new Request(`http://localhost/api/stats/upstream?${query}`))).status).toBe(400);
      }
      expect((await handler(new Request('http://localhost/api/stats/upstream?range=1h'))).status).not.toBe(400);
    }

    expect((await statsHandler.getUnifiedUpstreamStats(new Request('http://localhost/api/stats/upstream-stats?range=1h&type=wat'))).status).toBe(400);
    expect((await statsHandler.getUnifiedUpstreamStats(new Request('http://localhost/api/stats/upstream-stats?range=1h&type='))).status).toBe(400);
    expect((await statsHandler.getUnifiedUpstreamStats(new Request('http://localhost/api/stats/upstream-stats?range=1h&type=all&type=failure'))).status).toBe(400);
  });

  test('rejects malformed, empty, and repeated log stats parameters', async () => {
    expect((await logsHandler.getStats(new Request('http://localhost/api/logs/stats?startTime=123junk'))).status).toBe(400);
    expect((await logsHandler.getStats(new Request('http://localhost/api/logs/stats?endTime='))).status).toBe(400);
    expect((await logsHandler.getStats(new Request('http://localhost/api/logs/stats?startTime=2&endTime=1'))).status).toBe(400);
    expect((await logsHandler.getTimeSeriesStats(new Request('http://localhost/api/logs/stats/timeseries?startTime=1&endTime=2&interval=minute&interval=hour'))).status).toBe(400);
    expect((await logsHandler.getTimeSeriesStats(new Request('http://localhost/api/logs/stats/timeseries?startTime=1&endTime=2&interval='))).status).toBe(400);
    expect((await logsHandler.getTimeSeriesStats(new Request('http://localhost/api/logs/stats/timeseries?startTime=2&endTime=1'))).status).toBe(400);
  });
});
