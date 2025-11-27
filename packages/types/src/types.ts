// --- Type Definitions for config.json ---

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
  target: string;
  weight?: number; // 权重，默认为 100
  priority?: number; // 数字越小优先级越高，默认为 1
  plugins?: Array<PluginConfig | string>; // Upstream 级别的 plugins（覆盖路由和全局配置）
}

export interface RouteConfig extends ModificationRules {
  path: string;
  pathRewrite?: Record<string, string>;
  auth?: AuthConfig; // 路由级认证配置（可覆盖全局配置）
  plugins?: Array<PluginConfig | string>; // 路由级别的 plugins（支持字符串引用内置 plugin）
  upstreams: Upstream[];
  failover?: {
    enabled: boolean;
    retryableStatusCodes: number[];
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
  };
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
 */
export interface PluginConfig {
  /**
   * Plugin 文件路径（绝对路径或相对于配置文件的路径）
   */
  path: string;

  /**
   * 传递给 Plugin 的初始化选项
   */
  options?: Record<string, any>;

  /**
   * Plugin 是否启用（默认 true）
   */
  enabled?: boolean;
}

export interface AppConfig {
  bodyParserLimit?: string;
  auth?: AuthConfig; // 全局认证配置（适用于所有 routes，可被路由级配置覆盖）
  logging?: LoggingConfig; // 日志配置
  plugins?: Array<PluginConfig | string>; // 全局 plugins 配置（支持字符串引用内置 plugin）
  routes: RouteConfig[];
}