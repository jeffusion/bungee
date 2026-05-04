// --- Type Definitions for config.json ---

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

export interface Upstream extends ModificationRules {
  id?: string; // 可选的唯一标识符，如果未提供则使用索引
  target: string;
  weight?: number; // 权重，默认为 100
  priority?: number; // 数字越小优先级越高，默认为 1
  plugins?: Array<PluginConfig | string>; // Upstream 级别的 plugins（覆盖路由和全局配置）
  disabled?: boolean; // 是否禁用该上游，默认为 false（未禁用）
  description?: string; // 上游服务器的描述信息
  condition?: string; // 条件表达式，使用 {{ }} 包裹，例如: "{{ body.model === 'gpt-4' }}"
}

export interface StickySessionConfig {
  enabled: boolean;
  keyExpression?: string;
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

export interface FailoverSlowStartConfig {
  enabled: boolean;
  durationMs?: number;
  initialWeightFactor?: number;
}

export interface FailoverHealthCheckConfig {
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
}

export interface FailoverConfig {
  enabled: boolean;
  retryOn?: number | string | (number | string)[];
  passiveHealth?: FailoverPassiveHealthConfig;
  recovery?: FailoverRecoveryConfig;
  slowStart?: FailoverSlowStartConfig;
  healthCheck?: FailoverHealthCheckConfig;
}

export interface RouteConfig extends ModificationRules {
  path: string;
  pathRewrite?: Record<string, string>;
  auth?: AuthConfig; // 路由级认证配置（可覆盖全局配置）
  plugins?: Array<PluginConfig | string>; // 路由级别的 plugins（支持字符串引用内置 plugin）
  stickySession?: StickySessionConfig;
  upstreams: Upstream[];
  timeouts?: RouteTimeoutsConfig;
  failover?: FailoverConfig;
}

export interface LoggingConfig {
  body?: {
    enabled: boolean;
    maxSize: number;      // 最大大小（字节）
    retentionDays: number; // 保留天数
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

export interface AppConfig {
  configVersion?: number;
  logLevel?: string;
  bodyParserLimit?: string;
  auth?: AuthConfig; // 全局认证配置（适用于所有 routes，可被路由级配置覆盖）
  logging?: LoggingConfig; // 日志配置
  plugins?: Array<PluginConfig | string>; // 全局 plugins 配置（支持字符串引用内置 plugin）
  routes: RouteConfig[];
}
