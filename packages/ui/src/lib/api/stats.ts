import { api } from './client';
import type { StatsHistoryV2, TimeRange, UpstreamDistribution, UpstreamFailureStats, UpstreamStatusCodeStats, UnifiedUpstreamStats } from '../types';

/**
 * 获取历史统计数据
 * 支持时间范围：1h（1小时）、12h（12小时）、24h（24小时）
 */
export async function getStatsHistoryV2(range: TimeRange = '1h'): Promise<StatsHistoryV2> {
  return api.get<StatsHistoryV2>(`/stats/history/v2?range=${range}`);
}

/**
 * 获取 Upstream 请求分布统计
 */
export async function getUpstreamDistribution(range: TimeRange = '1h'): Promise<{ data: UpstreamDistribution[]; total: number }> {
  return api.get<{ data: UpstreamDistribution[]; total: number }>(`/stats/upstream-distribution?range=${range}`);
}

/**
 * 获取 Upstream 失败统计
 */
export async function getUpstreamFailures(range: TimeRange = '1h'): Promise<{ data: UpstreamFailureStats[] }> {
  return api.get<{ data: UpstreamFailureStats[] }>(`/stats/upstream-failures?range=${range}`);
}

/**
 * 获取 Upstream 状态码统计
 */
export async function getUpstreamStatusCodes(range: TimeRange = '1h'): Promise<{ data: UpstreamStatusCodeStats[] }> {
  return api.get<{ data: UpstreamStatusCodeStats[] }>(`/stats/upstream-status-codes?range=${range}`);
}

/**
 * 获取统一的 Upstream 统计（支持全部/成功/失败过滤）
 */
export async function getUnifiedUpstreamStats(range: TimeRange = '1h', type: 'all' | 'success' | 'failure' = 'all'): Promise<{ data: UnifiedUpstreamStats[]; type: string }> {
  return api.get<{ data: UnifiedUpstreamStats[]; type: string }>(`/stats/upstream-stats?range=${range}&type=${type}`);
}
