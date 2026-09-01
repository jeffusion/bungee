// --- Type Definitions ---

/**
 * 插件配置值类型
 * 定义了插件配置中允许的值类型，比 `any` 更具体
 *
 * 这个类型约束了配置值可以是：
 * - 基本类型: string, number, boolean, null
 * - 数组: 元素可以是任意 PluginConfigValue
 * - 对象: 值可以是任意 PluginConfigValue
 */
export type PluginConfigValue =
  | string
  | number
  | boolean
  | null
  | PluginConfigValue[]
  | { [key: string]: PluginConfigValue };

/**
 * 插件配置选项类型
 */
export type PluginConfigOptions = Record<string, PluginConfigValue>;

export interface ModificationRules {
  headers?: {
    add?: Record<string, string>;
    replace?: Record<string, string>;
    remove?: string[];
  };
  body?: {
    add?: Record<string, any>;
    replace?: Record<string, any>;
    remove?: string[];
    default?: Record<string, any>;
  };
  query?: {
    add?: Record<string, string>;
    replace?: Record<string, string>;
    remove?: string[];
    default?: Record<string, string>;
  };
}

/**
 * Token 认证配置
 *
 * @example
 * // 简单 token 验证
 * {
 *   "enabled": true,
 *   "tokens": ["{{ env.API_TOKEN }}"]
 * }
 *
 * @example
 * // 多 token 支持（多租户场景）
 * {
 *   "enabled": true,
 *   "tokens": [
 *     "{{ env.TENANT_A_TOKEN }}",
 *     "{{ env.TENANT_B_TOKEN }}",
 *     "hardcoded-dev-token"
 *   ]
 * }
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

export interface Endpoint extends ModificationRules {
  id?: string;
  target: string;
  weight?: number;
  priority?: number;
  plugins?: Array<PluginConfig | string>;
  is_disabled?: boolean;
  description?: string;
  condition?: string;
}

export interface RouteTimeoutsConfig {
  request_ms?: number;
}

/**
 * Service-level transport timeouts.
 * Describes how to connect to and exchange data with this pool of upstreams.
 * Route-level request deadline (RouteTimeoutsConfig.request_ms) is unaffected.
 */
export interface ServiceTimeoutsConfig {
  connect_ms?: number;
  send_ms?: number;
  read_ms?: number;
}

export interface FailoverPassiveHealthConfig {
  consecutive_failures?: number;
  healthy_successes?: number;
  auto_disable_threshold?: number;
}

export interface FailoverRecoveryConfig {
  /** UNHEALTHY 重新允许尝试的退避基准间隔（实际退避 = base × 2^recovery_attempt_count + 20% jitter） */
  backoff_base_ms?: number;
  /** HALF_OPEN/UNHEALTHY 状态下请求的超时切片 */
  probe_timeout_ms?: number;
}

export interface FailoverSlowStartConfig {
  enabled: boolean;
  duration_ms?: number;
  initial_weight_factor?: number;
}

/**
 * Service-level active health check configuration.
 * Independent subsystem — no longer nested under FailoverConfig.
 */
export interface ServiceHealthCheckConfig {
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
  /** 主动健康检查恢复后自动 re-enable 被 auto_disable 的 upstream */
  auto_enable_on_active_health_check?: boolean;
}

export interface HashPolicyConfig {
  /** 直接读 header 名作为 hash 输入（简单场景） */
  header?: string;
  /** 表达式返回值作为 hash 输入（可 access headers/body/url/method/env 全 context） */
  expression?: string;
}

export interface LoadBalancingConfig {
  policy: 'weighted_random' | 'round_robin' | 'least_requests' | 'consistent_hash';
  /** 仅 policy='consistent_hash' 时有意义 */
  hash_policy?: HashPolicyConfig;
}

export interface Service {
  name: string;
  endpoints: Endpoint[];
  plugins?: Array<PluginConfig | string>;
  health_check?: ServiceHealthCheckConfig;
  failover?: FailoverConfig;
  load_balancing?: LoadBalancingConfig;
  timeouts?: ServiceTimeoutsConfig;
}

export interface FailoverConfig {
  enabled: boolean;
  retry_on?: number | string | (number | string)[];
  /**
   * 响应内容触发关键字列表（与 retry_on 为 OR 关系）。
   * 任一关键字在响应体中出现即触发 failover（大小写敏感子串匹配）。
   *
   * 流式：first-peek 首 4KB / 首个 SSE event；非流式：完整 body（1MB 上限）。
   * 中段（5KB 后）错误无配置层方案。
   */
  retry_on_response?: string[];
  passive_health?: FailoverPassiveHealthConfig;
  recovery?: FailoverRecoveryConfig;
  slow_start?: FailoverSlowStartConfig;
}

export interface RateLimitConfig {
  enabled: boolean;
  requests_per_second?: number;
  burst?: number;
  key_expression?: string;
}

export interface CorsConfig {
  enabled: boolean;
  allowed_origins?: string[];
  allowed_methods?: string[];
  allowed_headers?: string[];
  expose_headers?: string[];
  allow_credentials?: boolean;
  max_age?: number;
}

export interface DirectResponseConfig {
  enabled: boolean;
  status: number;
  body?: string;
  content_type?: string;
  headers?: Record<string, string>;
}

export interface RedirectConfig {
  enabled: boolean;
  url: string;
  status?: 301 | 302 | 307 | 308;
  preserve_path?: boolean;
}

export interface ResponseRuleConfig {
  enabled: boolean;
  path: string;
  match_type?: 'exact' | 'prefix' | 'regex';
  type: 'direct_response' | 'redirect';
  status?: number;
  body?: string;
  content_type?: string;
  headers?: Record<string, string>;
  url?: string;
  preserve_path?: boolean;
}

export interface RetryConfig {
  enabled: boolean;
  max_retries?: number;
  retry_on?: number[];
  per_retry_timeout_ms?: number;
}

export interface RouteConfig extends ModificationRules {
  path: string;
  service?: string;
  endpoints?: Endpoint[];
  path_rewrite?: Record<string, string>;
  auth?: AuthConfig;
  plugins?: Array<PluginConfig | string>;
  timeouts?: RouteTimeoutsConfig;
  rate_limit?: RateLimitConfig;
  cors?: CorsConfig;
  response_rules?: ResponseRuleConfig[];
  direct_response?: DirectResponseConfig;
  redirect?: RedirectConfig;
  retry?: RetryConfig;
}

export interface LoggingConfig {
  body?: {
    enabled: boolean;
    max_size: number;      // 最大大小（字节）
    retention_days: number; // 保留天数
  };
}

/**
 * Plugin 配置
 *
 * 支持两种引用方式：
 * 1. 通过 name 引用（推荐）：自动从插件目录解析路径
 * 2. 通过 path 引用（高级）：手动指定插件文件路径
 */
export interface PluginConfig {
  /**
   * Plugin 名称（唯一标识符）
   * 这是插件的唯一标识，用于引用和管理插件
   *
   * 示例: "ai-transformer", "token-cache"
   */
  name: string;

  /**
   * Plugin 文件路径（可选，仅用于高级场景）
   * 如果指定了 path，将直接加载该路径的插件文件
   * 如果未指定，将通过 name 在插件目录中查找
   *
   * 支持：
   * - 绝对路径: "/absolute/path/to/plugin.ts"
   * - 相对路径（相对于配置文件）: "./plugins/custom-plugin.ts"
   */
  path?: string;

  /**
   * 传递给 Plugin 的初始化选项
   */
  options?: PluginConfigOptions;

  /**
   * Plugin 是否启用（默认 true）
   */
  enabled?: boolean;
}

/** Plugin execution phase in the three-phase pipeline */
export type PluginPhase = 'route' | 'service' | 'upstream';

/**
 * Result of onInterceptRequest hook.
 * Distinguishes terminal short-circuit from failover trigger.
 * - respond: terminal short-circuit, no failover
 * - failover: trigger upstream switch (only valid in Phase 3/upstream)
 * - undefined: continue normal flow
 */
export type InterceptResult =
  | { action: 'respond'; response: Response }
  | { action: 'failover'; reason?: string }
  | undefined;

export interface AppConfig {
  config_version?: number;
  log_level?: string;
  body_parser_limit?: string;
  auth?: AuthConfig;
  logging?: LoggingConfig;
  plugins?: Array<PluginConfig | string>;
  services?: Service[];
  routes: RouteConfig[];
}
