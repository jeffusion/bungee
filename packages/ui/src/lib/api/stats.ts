import { api } from './client';
import type { StatsHistoryV2, TimeRange } from '../types';

/**
 * 获取历史统计数据
 * 支持时间范围：1h（1小时）、12h（12小时）、24h（24小时）
 */
export async function getStatsHistoryV2(range: TimeRange = '1h'): Promise<StatsHistoryV2> {
  return api.get<StatsHistoryV2>(`/stats/history/v2?range=${range}`);
}
