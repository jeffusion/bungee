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

export interface PluginConfig {
  name: string;
  options?: Record<string, PluginConfigValue>;
}

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
  config_version?: number;
  log_level?: string;
  body_parser_limit?: string;
  auth?: AuthConfig;
  services?: Service[];
  routes?: Route[];
  [key: string]: any;
}

export interface Route {
  path: string;
  path_rewrite?: { [pattern: string]: string };
  service?: string;
  endpoints?: Upstream[];
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  transformer?: string | object;
  auth?: AuthConfig;
  timeouts?: RouteTimeoutsConfig;
  failover?: FailoverConfig;
}

export interface Service {
  name: string;
  endpoints: Upstream[];
  health_check?: FailoverConfig['health_check'];
  failover?: FailoverConfig;
  plugins?: Array<PluginConfig | string>;
  load_balancing?: LoadBalancingConfig;
  timeouts?: ServiceTimeoutsConfig;
}

export interface Upstream {
  _uid?: string;
  id?: string;
  target: string;
  weight?: number;
  priority?: number;
  transformer?: string | object;
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  is_disabled?: boolean;
  description?: string;
  condition?: string;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  upstream_id?: string;
  last_failure_time?: number;
  consecutive_failures?: number;
  consecutive_successes?: number;
  recovery_attempt_count?: number;
  health_check_successes?: number;
  health_check_failures?: number;
}

export interface ModificationRules {
  add?: Record<string, any>;
  remove?: string[];
  replace?: Record<string, any>;
  default?: Record<string, any>;
}

export interface RouteTimeoutsConfig {
  request_ms?: number;
}

export interface ServiceTimeoutsConfig {
  connect_ms?: number;
  send_ms?: number;
  read_ms?: number;
}

export interface HashPolicyConfig {
  header?: string;
  expression?: string;
}

export interface LoadBalancingConfig {
  policy: 'weighted_random' | 'round_robin' | 'least_requests' | 'consistent_hash';
  hash_policy?: HashPolicyConfig;
}

export interface FailoverPassiveHealthConfig {
  consecutive_failures?: number;
  healthy_successes?: number;
  auto_disable_threshold?: number;
  auto_enable_on_active_health_check?: boolean;
}

export interface FailoverRecoveryConfig {
  probe_interval_ms?: number;
  probe_timeout_ms?: number;
}

export interface FailoverConfig {
  enabled: boolean;
  retry_on?: number | string | (number | string)[];
  passive_health?: FailoverPassiveHealthConfig;
  recovery?: FailoverRecoveryConfig;
  slow_start?: {
    enabled: boolean;
    duration_ms?: number;
    initial_weight_factor?: number;
  };
  health_check?: {
    enabled: boolean;
    interval_ms?: number;
    timeout_ms?: number;
    path?: string;
    method?: string;
    expected_status?: number[];
    unhealthy_threshold?: number;
    healthy_threshold?: number;
    body?: string;
    content_type?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  };
}
