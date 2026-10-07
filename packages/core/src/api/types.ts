import type { HttpStatusCounts, TransportCounts, RequestCounts } from '../logger/transport-outcome';
export type TimeRange = '1h' | '12h' | '24h';

export interface StatsHistory {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
}

export interface StatsHistoryV2 extends StatsHistory {
  requestCounts?: { [K in keyof RequestCounts]: number[] };
  httpStatusCounts?: { [K in keyof HttpStatusCounts]: number[] };
  transportCounts?: { [K in keyof TransportCounts]: number[] };
  successRate: number[];
  failureRate: number[];
}
