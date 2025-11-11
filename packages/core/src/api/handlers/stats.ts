import { statsCollector, persistentStatsCollector } from '../collectors/stats-collector';
import { logQueryService } from '../logs';
import type { StatsHistory, StatsHistoryV2, TimeRange } from '../types';

export class StatsHandler {
  static getSnapshot(): Response {
    const snapshot = statsCollector.getSnapshot();
    return new Response(JSON.stringify(snapshot), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  static getHistory(req: Request): Response {
    const url = new URL(req.url);
    const interval = url.searchParams.get('interval') || '10s';

    const history = statsCollector.getHistory();

    // 根据interval参数采样数据
    let sampledHistory = history;
    if (interval === '1m') {
      sampledHistory = this.sampleData(history, 6); // 每6个点取1个
    } else if (interval === '5m') {
      sampledHistory = this.sampleData(history, 30); // 每30个点取1个
    }

    const result: StatsHistory = {
      timestamps: sampledHistory.map(h => h.timestamp),
      requests: sampledHistory.map(h => h.totalRequests),
      errors: sampledHistory.map(h => h.errors),
      responseTime: sampledHistory.map(h => h.averageResponseTime)
    };

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 新的历史数据API，支持新的时间范围
  // 现在从数据库查询而不是文件系统
  static async getHistoryV2(req: Request): Response {
    const url = new URL(req.url);
    const range = (url.searchParams.get('range') as TimeRange) || '1h';

    try {
      // 计算时间范围
      const endTime = Date.now();
      const startTime = StatsHandler.getStartTimeForRange(range, endTime);

      // 确定数据聚合间隔
      const interval = StatsHandler.getIntervalForRange(range);

      // 从数据库查询时间序列数据
      const timeSeriesData = await logQueryService.getTimeSeriesStats(startTime, endTime, interval);

      // 转换为前端需要的格式
      const result: StatsHistoryV2 = {
        timestamps: timeSeriesData.map(d => new Date(d.timestamp).toISOString()),
        requests: timeSeriesData.map(d => d.totalRequests),
        errors: timeSeriesData.map(d => d.failedRequests),
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
      console.error('Failed to get history data:', error);
      return new Response(JSON.stringify({ error: 'Failed to get history data' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取 Upstream 请求分布统计
   */
  static async getUpstreamDistribution(req: Request): Response {
    const url = new URL(req.url);
    const range = (url.searchParams.get('range') as TimeRange) || '1h';

    try {
      const endTime = Date.now();
      const startTime = StatsHandler.getStartTimeForRange(range, endTime);

      const data = await logQueryService.getUpstreamDistribution(startTime, endTime);

      return new Response(JSON.stringify({ data, total: data.reduce((sum, d) => sum + d.count, 0) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Failed to get upstream distribution:', error);
      return new Response(JSON.stringify({ error: 'Failed to get upstream distribution' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取 Upstream 失败统计
   */
  static async getUpstreamFailures(req: Request): Response {
    const url = new URL(req.url);
    const range = (url.searchParams.get('range') as TimeRange) || '1h';

    try {
      const endTime = Date.now();
      const startTime = StatsHandler.getStartTimeForRange(range, endTime);

      const data = await logQueryService.getUpstreamFailureStats(startTime, endTime);

      return new Response(JSON.stringify({ data }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Failed to get upstream failures:', error);
      return new Response(JSON.stringify({ error: 'Failed to get upstream failures' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取 Upstream 状态码统计
   */
  static async getUpstreamStatusCodes(req: Request): Response {
    const url = new URL(req.url);
    const range = (url.searchParams.get('range') as TimeRange) || '1h';

    try {
      const endTime = Date.now();
      const startTime = StatsHandler.getStartTimeForRange(range, endTime);

      const data = await logQueryService.getUpstreamStatusCodeStats(startTime, endTime);

      return new Response(JSON.stringify({ data }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
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
  private static getStartTimeForRange(range: TimeRange, endTime: number): number {
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
  private static getIntervalForRange(range: TimeRange): 'minute' | '30min' | 'hour' | 'day' {
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

  private static sampleData<T>(data: T[], step: number): T[] {
    if (step <= 1) return data;
    return data.filter((_, index) => index % step === 0);
  }
}
