// Monitoring types for dashboard
export type TimeRange = '1h' | '12h' | '24h';

/**
 * 插件配置值类型
 * 定义了插件配置中允许的值类型
 */
export type PluginConfigValue =
  | string
  | number
  | boolean
  | null
  | PluginConfigValue[]
  | { [key: string]: PluginConfigValue };

export interface StatsHistoryV2 {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
  successRate: number[];
}

export interface UpstreamDistribution {
  upstream: string;
  count: number;
  percentage: number;
}

export interface UpstreamFailureStats {
  upstream: string;
  totalRequests: number;
  failedRequests: number;
  successRequests: number;
  failureRate: number;
}

export interface UnifiedUpstreamStats {
  upstream: string;
  count: number;
  percentage: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  failureRate: number;
}

export interface UpstreamStatusCodeStats {
  upstream: string;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  totalRequests: number;
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

export interface AuthConfig {
  enabled: boolean;
  tokens: string[];
}

export interface AppConfig {
  configVersion?: number;
  auth?: AuthConfig;
  routes?: Route[];
  [key: string]: any;
}

export interface Route {
  path: string;
  pathRewrite?: { [pattern: string]: string };
  upstreams: Upstream[];
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  transformer?: string | object;
  auth?: AuthConfig;
  timeouts?: RouteTimeoutsConfig;
  failover?: FailoverConfig;
  stickySession?: StickySessionConfig;
}

export interface StickySessionConfig {
  enabled: boolean;
  keyExpression?: string;
}

export interface Upstream {
  _uid?: string;
  target: string;
  weight?: number;
  priority?: number;
  transformer?: string | object;
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  disabled?: boolean;
  description?: string;
  condition?: string;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  lastFailureTime?: number;
}

export interface ModificationRules {
  add?: Record<string, any>;
  remove?: string[];
  replace?: Record<string, any>;
  default?: Record<string, any>;
}

export interface RouteTimeoutsConfig {
  connectMs?: number;
  requestMs?: number;
}

export interface FailoverPassiveHealthConfig {
  consecutiveFailures?: number;
  healthySuccesses?: number;
  autoDisableThreshold?: number;
  autoEnableOnActiveHealthCheck?: boolean;
}

export interface FailoverRecoveryConfig {
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
}

export interface FailoverConfig {
  enabled: boolean;
  retryOn?: number | string | (number | string)[];
  passiveHealth?: FailoverPassiveHealthConfig;
  recovery?: FailoverRecoveryConfig;
  slowStart?: {
    enabled: boolean;
    durationMs?: number;
    initialWeightFactor?: number;
  };
  healthCheck?: {
    enabled: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    path?: string;
    method?: string;
    expectedStatus?: number[];
    unhealthyThreshold?: number;
    healthyThreshold?: number;
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  };
}
