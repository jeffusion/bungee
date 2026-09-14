export type TimeRange = '1h' | '12h' | '24h';

export interface StatsHistory {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
}

export interface StatsHistoryV2 extends StatsHistory {
  successRate: number[];
}
