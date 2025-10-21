// Monitoring types for dashboard
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
  recoveryIntervalMs?: number;
  recoveryTimeoutMs?: number;
}
