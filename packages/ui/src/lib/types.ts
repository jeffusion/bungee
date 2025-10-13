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

// New monitoring types for dashboard refactor
export type TimeRange = '1h' | '12h' | '24h';

export interface StatsHistoryV2 {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
  successRate: number[];  // 新增字段
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

export interface AppConfig {
  routes?: Route[];
  [key: string]: any;
}

export interface Route {
  path: string;
  pathRewrite?: { [pattern: string]: string };
  upstreams: Upstream[];
  headers?: ModificationRules;
  body?: ModificationRules;
  transformer?: string | object;
  failover?: FailoverConfig;
  healthCheck?: HealthCheckConfig;
}

export interface Upstream {
  target: string;
  weight?: number;
  priority?: number;
  transformer?: string | object;
  headers?: ModificationRules;
  body?: ModificationRules;
}

export interface ModificationRules {
  add?: Record<string, any>;
  remove?: string[];
  replace?: Record<string, any>;
  default?: Record<string, any>;
}

export interface FailoverConfig {
  enabled: boolean;
  retryableStatusCodes?: number[];
}

export interface HealthCheckConfig {
  enabled: boolean;
  interval?: number;
  timeout?: number;
  path?: string;
  healthyStatuses?: number[];
}