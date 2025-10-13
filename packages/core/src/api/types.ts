export interface StatsSnapshot {
  totalRequests: number;
  requestsPerSecond: number;
  successRate: number;
  averageResponseTime: number;
  timestamp: string;
}

export interface HistoryEntry extends StatsSnapshot {
  errors: number;
}

export interface StatsHistory {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
}

export interface SystemInfo {
  version: string;
  uptime: number;
  workers: WorkerInfo[];
}

export interface WorkerInfo {
  workerId: number;
  pid: number;
  status: 'ready' | 'starting' | 'shutting_down' | 'stopped';
  startTime: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// New monitoring types for dashboard refactor
export type TimeRange = '1h' | '12h' | '24h';

export interface TimeRangeConfig {
  range: TimeRange;
  interval: number;    // 数据点间隔（毫秒）
  maxPoints: number;   // 最大数据点数
  displayName: string;
}

export interface TimeSlotData {
  slotStart: number;          // 时间槽开始时间戳
  requests: number;           // 该槽内请求总数
  errors: number;             // 该槽内错误总数
  responseTimes: number[];    // 响应时间样本
  maxResponseTimes: number;   // 最大样本数（防止内存泄漏）
}

export interface AggregatedDataPoint {
  timestamp: string;
  requests: number;        // 该时段内实际请求数
  errors: number;          // 该时段内实际错误数
  avgResponseTime: number; // 该时段内平均响应时间
  successRate: number;     // 该时段内成功率
}

export interface StatsHistoryV2 {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
  successRate: number[];  // 新增字段
}
