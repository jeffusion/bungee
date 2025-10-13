import { api } from './client';
import type { StatsSnapshot, StatsHistory, StatsHistoryV2, TimeRange } from '../types';

export async function getStatsSnapshot(): Promise<StatsSnapshot> {
  return api.get<StatsSnapshot>('/stats');
}

export async function getStatsHistory(interval: '10s' | '1m' | '5m' = '10s'): Promise<StatsHistory> {
  return api.get<StatsHistory>(`/stats/history?interval=${interval}`);
}

// 新的历史数据API，支持新的时间范围
export async function getStatsHistoryV2(range: TimeRange = '1h'): Promise<StatsHistoryV2> {
  return api.get<StatsHistoryV2>(`/stats/history/v2?range=${range}`);
}
