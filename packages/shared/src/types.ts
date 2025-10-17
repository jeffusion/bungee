// --- Type Definitions for config.json ---

interface PathRule {
  action: 'replace';
  match: string;
  replace: string;
}

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

/**
 * SSE 事件类型映射（用于带 event: 字段的 SSE）
 *
 * @example
 * // Anthropic SSE 格式
 * {
 *   'message_start': 'start',
 *   'content_block_delta': 'chunk',
 *   'message_delta': 'end',
 *   'message_stop': 'skip',
 *   'ping': 'skip'
 * }
 */
export interface EventTypeMapping {
  [eventType: string]: 'start' | 'chunk' | 'end' | 'skip';
}

/**
 * 流阶段检测（用于基于 body 内容判断，适用于不带 event: 的 SSE）
 *
 * @example
 * // Gemini SSE 格式
 * {
 *   isEnd: '{{ body.candidates && body.candidates[0].finishReason }}'
 * }
 */
export interface PhaseDetection {
  isStart?: string;   // 表达式，返回 boolean
  isChunk?: string;   // 表达式，返回 boolean
  isEnd?: string;     // 表达式，返回 boolean
}

/**
 * 流转换规则（扩展）
 */
export interface StreamTransformRules {
  /**
   * 事件类型映射（适用于 Anthropic 等带 event: 的 SSE）
   *
   * 当 SSE 事件包含 "event: xxx" 行时，使用此映射决定如何处理
   */
  eventTypeMapping?: EventTypeMapping;

  /**
   * 阶段检测表达式（适用于 Gemini 等不带 event: 的 SSE）
   *
   * 当 SSE 事件不包含 event: 行时，使用表达式检测事件类型
   */
  phaseDetection?: PhaseDetection;

  /**
   * 开始阶段转换规则
   */
  start?: ModificationRules;

  /**
   * 数据块阶段转换规则
   */
  chunk?: ModificationRules;

  /**
   * 结束阶段转换规则
   */
  end?: ModificationRules;
}

export interface ResponseRuleSet {
  default?: ModificationRules;
  stream?: ModificationRules | StreamTransformRules;
}

export interface ResponseRule {
  match: {
    status: string;
    headers?: Record<string, string>;
  };
  rules: ResponseRuleSet;
}

export interface TransformerConfig {
  path: PathRule;
  request?: ModificationRules;
  response?: ResponseRule[];
}

export interface Upstream extends ModificationRules {
  target: string;
  weight?: number; // 权重，默认为 100
  priority?: number; // 数字越小优先级越高，默认为 1
  transformer?: string | TransformerConfig | TransformerConfig[];
}

export interface RouteConfig extends ModificationRules {
  path: string;
  pathRewrite?: Record<string, string>;
  transformer?: string | TransformerConfig | TransformerConfig[];
  auth?: AuthConfig; // 路由级认证配置（可覆盖全局配置）
  upstreams: Upstream[];
  failover?: {
    enabled: boolean;
    retryableStatusCodes: number[];
  };
  healthCheck?: {
    enabled: boolean;
    intervalSeconds: number;
  };
}

export interface AppConfig {
  bodyParserLimit?: string;
  auth?: AuthConfig; // 全局认证配置（适用于所有 routes，可被路由级配置覆盖）
  routes: RouteConfig[];
}