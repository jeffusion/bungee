import type { LogQueryService, StatsHistoryInterval } from '../logs';
import type { StatsHistory, StatsHistoryV2, TimeRange } from '../types';

export type StatsQueryService = Pick<LogQueryService,
  'getStats' | 'getChainCount' | 'getCumulativeHistory' | 'getTimeSeriesStats'
  | 'getUpstreamDistribution' | 'getUpstreamFailureStats' | 'getUnifiedUpstreamStats'
  | 'getUpstreamStatusCodeStats'>;

export type PluginStats = {
  readonly globalInstances: number;
  readonly routeInstances: number;
  readonly serviceInstances: number;
  readonly upstreamInstances: number;
  readonly [key: string]: unknown;
};

function getSingleQueryParam(url: URL, name: string): string | undefined | null {
  const values = url.searchParams.getAll(name);
  return values.length === 0 ? undefined : values.length === 1 && values[0] !== '' ? values[0] : null;
}

function getTimeRange(url: URL): TimeRange | null {
  const range = getSingleQueryParam(url, 'range');
  if (range === undefined) return '1h';
  return range === '1h' || range === '12h' || range === '24h' ? range : null;
}

function badRequest(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isDatabaseFailure(error: unknown): boolean {
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = String(value?.code ?? value?.name ?? '').toUpperCase();
  const message = String(value?.message ?? '').toUpperCase();
  return code.includes('BUSY') || code.includes('LOCKED') || code.includes('CORRUPT')
    || code.includes('NOTADB') || message.includes('DATABASE IS LOCKED') || message.includes('NOT A DATABASE')
    || message.includes('MALFORMED');
}

/** Runtime-only compatibility endpoint; it is not backed by access-log SQL. */
export function getUpstreamLastUsed(
  states: Iterable<readonly [string, { readonly upstreams: readonly { readonly upstream_id: string; readonly last_used_time?: number }[] }]>,
): Response {
  const data: Array<{ state_key: string; upstream_id: string; last_used_at: number }> = [];
  for (const [stateKey, state] of states) {
    for (const upstream of state.upstreams) {
      if (upstream.last_used_time !== undefined) {
        data.push({ state_key: stateKey, upstream_id: upstream.upstream_id, last_used_at: upstream.last_used_time });
      }
    }
  }
  return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
}

export class StatsHandler {
  constructor(
    private readonly logQueryService: StatsQueryService,
    private readonly getPluginStats?: () => PluginStats | undefined,
  ) {}

  async getSnapshot(queryTime = Date.now()): Promise<Response> {
    try {
      const bucketEnd = Math.floor(queryTime / 60_000) * 60_000;
      const [stats, recentRequests] = await Promise.all([
        this.logQueryService.getStats(),
        this.logQueryService.getChainCount(bucketEnd - 60_000, bucketEnd),
      ]);

      const snapshot = {
        totalRequests: stats.totalRequests,
        requestsPerSecond: recentRequests / 60,
        successRate: stats.totalRequests > 0 ? (stats.successRequests / stats.totalRequests) * 100 : 100,
        averageResponseTime: stats.avgResponseTime,
        timestamp: new Date(queryTime).toISOString(),
      };
      const pluginStats = this.getPluginStats?.();
      const response = pluginStats
        ? {
          ...snapshot,
          pluginScopes: {
            global: pluginStats.globalInstances,
            routes: pluginStats.routeInstances,
            services: pluginStats.serviceInstances,
            upstreams: pluginStats.upstreamInstances,
          },
          plugins: pluginStats,
        }
        : snapshot;

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (isDatabaseFailure(error)) throw error;
      console.error('Failed to get snapshot data:', error);
      return new Response(JSON.stringify({ error: 'Failed to get snapshot data' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  async getHistory(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const interval = getSingleQueryParam(url, 'interval');
    if (interval === null) {
      return new Response(JSON.stringify({ error: 'interval must be one of 10s, 1m, 5m' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    const selectedInterval = interval || '10s';
    if (selectedInterval !== '10s' && selectedInterval !== '1m' && selectedInterval !== '5m') {
      return new Response(JSON.stringify({ error: 'interval must be one of 10s, 1m, 5m' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const intervalMs = selectedInterval === '10s' ? 10_000 : selectedInterval === '1m' ? 60_000 : 300_000;
      const endTime = Math.floor(Date.now() / intervalMs) * intervalMs;
      const history = await this.logQueryService.getCumulativeHistory(
        endTime - 60 * 60 * 1000,
        endTime,
        selectedInterval as StatsHistoryInterval,
      );
      const result: StatsHistory = {
        timestamps: history.map(h => new Date(h.timestamp).toISOString()),
        requests: history.map(h => h.requests),
        errors: history.map(h => h.errors),
        responseTime: history.map(h => h.responseTime),
      };

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (isDatabaseFailure(error)) throw error;
      console.error('Failed to get history data:', error);
      return new Response(JSON.stringify({ error: 'Failed to get history data' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // 新的历史数据API，支持新的时间范围
  // 现在从数据库查询而不是文件系统
  async getHistoryV2(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const range = getTimeRange(url);
    if (range === null) return badRequest('range must be one of 1h, 12h, 24h');

    try {
      // 计算时间范围
      const endTime = Date.now();
      const startTime = this.getStartTimeForRange(range, endTime);

      // 确定数据聚合间隔
      const interval = this.getIntervalForRange(range);

      // 从数据库查询时间序列数据
      const timeSeriesData = await this.logQueryService.getTimeSeriesStats(startTime, endTime, interval);

      // 转换为前端需要的格式
      const result: StatsHistoryV2 = {
        timestamps: timeSeriesData.map(d => new Date(d.timestamp).toISOString()),
        requests: timeSeriesData.map(d => d.totalRequests),
        errors: timeSeriesData.map(d => d.failedRequests),
        // responseTime 字段语义自此次起为 chain wall-clock（含 retry gap），非 attempt duration
        responseTime: timeSeriesData.map(d => Math.round(d.avgResponseTime)),
        successRate: timeSeriesData.map(d => {
          const rate = d.totalRequests > 0
            ? (d.successRequests / d.totalRequests) * 100
            : 100;
          return Math.round(rate * 100) / 100;
        })
      };

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (isDatabaseFailure(error)) throw error;
      console.error('Failed to get history data:', error);
      return new Response(JSON.stringify({ error: 'Failed to get history data' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取 Endpoint 请求分布统计
   */
  async getUpstreamDistribution(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const range = getTimeRange(url);
    if (range === null) return badRequest('range must be one of 1h, 12h, 24h');

    try {
      const endTime = Date.now();
      const startTime = this.getStartTimeForRange(range, endTime);

      const data = await this.logQueryService.getUpstreamDistribution(startTime, endTime);

      return new Response(JSON.stringify({ data, total: data.reduce((sum, d) => sum + d.count, 0) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (isDatabaseFailure(error)) throw error;
      console.error('Failed to get upstream distribution:', error);
      return new Response(JSON.stringify({ error: 'Failed to get upstream distribution' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取 Endpoint 失败统计
   */
  async getUpstreamFailures(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const range = getTimeRange(url);
    if (range === null) return badRequest('range must be one of 1h, 12h, 24h');

    try {
      const endTime = Date.now();
      const startTime = this.getStartTimeForRange(range, endTime);

      const data = await this.logQueryService.getUpstreamFailureStats(startTime, endTime);

      return new Response(JSON.stringify({ data }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (isDatabaseFailure(error)) throw error;
      console.error('Failed to get upstream failures:', error);
      return new Response(JSON.stringify({ error: 'Failed to get upstream failures' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取统一的 Endpoint 统计（支持全部/成功/失败过滤）
   */
  async getUnifiedUpstreamStats(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const range = getTimeRange(url);
    const typeParam = getSingleQueryParam(url, 'type');
    if (range === null) return badRequest('range must be one of 1h, 12h, 24h');
    if (typeParam !== undefined && typeParam !== 'all' && typeParam !== 'success' && typeParam !== 'failure') {
      return badRequest('type must be one of all, success, failure');
    }
    const type = typeParam ?? 'all';

    try {
      const endTime = Date.now();
      const startTime = this.getStartTimeForRange(range, endTime);

      const data = await this.logQueryService.getUnifiedUpstreamStats(startTime, endTime, type);

      return new Response(JSON.stringify({ data, type }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (isDatabaseFailure(error)) throw error;
      console.error('Failed to get unified upstream stats:', error);
      return new Response(JSON.stringify({ error: 'Failed to get unified upstream stats' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取 Endpoint 状态码统计
   */
  async getUpstreamStatusCodes(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const range = getTimeRange(url);
    if (range === null) return badRequest('range must be one of 1h, 12h, 24h');

    try {
      const endTime = Date.now();
      const startTime = this.getStartTimeForRange(range, endTime);

      const data = await this.logQueryService.getUpstreamStatusCodeStats(startTime, endTime);

      return new Response(JSON.stringify({ data }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (isDatabaseFailure(error)) throw error;
      console.error('Failed to get upstream status codes:', error);
      return new Response(JSON.stringify({ error: 'Failed to get upstream status codes' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 根据时间范围计算起始时间
   */
  private getStartTimeForRange(range: TimeRange, endTime: number): number {
    switch (range) {
      case '1h':
        return endTime - 60 * 60 * 1000; // 1小时前
      case '12h':
        return endTime - 12 * 60 * 60 * 1000; // 12小时前
      case '24h':
        return endTime - 24 * 60 * 60 * 1000; // 24小时前
      default:
        return endTime - 60 * 60 * 1000;
    }
  }

  /**
   * 根据时间范围确定数据聚合间隔
   */
  private getIntervalForRange(range: TimeRange): 'minute' | '30min' | 'hour' | 'day' {
    switch (range) {
      case '1h':
        return 'minute'; // 1小时：每分钟一个点（60个点）
      case '12h':
        return '30min'; // 12小时：每30分钟一个点（24个点）
      case '24h':
        return 'hour'; // 24小时：每小时一个点（24个点）
      default:
        return 'minute';
    }
  }

}
