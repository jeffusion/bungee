// Monitoring types for dashboard
export type TimeRange = '1h' | '12h' | '24h';

export interface StatsHistoryV2 {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
  successRate: number[];  // 新增字段
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

/**
 * Token 认证配置
 *
 * 行为说明：
 * - 从 Authorization header 提取 token（支持 "Bearer <token>" 或直接 "<token>"）
 * - 使用恒定时间比较进行 token 验证（防止时序攻击）
 * - 认证通过后，自动移除 Authorization header（不会转发给 upstream）
 */
export interface AuthConfig {
  /**
   * 是否启用认证
   */
  enabled: boolean;

  /**
   * 有效的 token 列表（支持表达式）
   * 支持多个 token，适用于多租户、多客户端场景
   * 示例: ["{{ env.API_TOKEN }}", "sk-1234567890"]
   */
  tokens: string[];
}

export interface AppConfig {
  auth?: AuthConfig; // 全局认证配置（适用于所有 routes，可被路由级配置覆盖）
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
  auth?: AuthConfig; // 路由级认证配置（可覆盖全局配置）
  failover?: FailoverConfig;
}

export interface Upstream {
  _uid?: string;  // Frontend-only unique identifier, not saved to backend
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
  consecutiveFailuresThreshold?: number;  // 默认 3，连续失败几次后标记为 UNHEALTHY
  recoveryIntervalMs?: number;  // 默认 5000，失败后等待多久尝试恢复
  recoveryTimeoutMs?: number;   // 默认 3000，恢复请求的超时时间
  healthyThreshold?: number;    // 默认 2，连续成功几次后标记为 HEALTHY
  requestTimeoutMs?: number;    // 默认 30000，正常请求的超时时间
  connectTimeoutMs?: number;    // 默认 5000，连接超时时间
  slowStart?: {
    enabled: boolean;            // 是否启用慢启动
    durationMs?: number;         // 慢启动持续时间（默认 30000ms = 30秒）
    initialWeightFactor?: number; // 初始权重因子（默认 0.1 = 10%）
  };
  healthCheck?: {
    enabled: boolean;              // 是否启用主动健康检查
    intervalMs?: number;           // 检查间隔（默认 10000ms = 10秒）
    timeoutMs?: number;            // 健康检查超时（默认 3000ms）
    path?: string;                 // 健康检查路径（默认 /health）
    method?: string;               // HTTP 方法（默认 GET）
    expectedStatus?: number[];     // 期望的状态码（默认 [200]）
    unhealthyThreshold?: number;   // 连续失败多少次标记为 UNHEALTHY（默认 3）
    healthyThreshold?: number;     // 连续成功多少次标记为 HEALTHY（默认 2）
  };
}
