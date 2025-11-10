/**
 * Plugin 系统类型定义
 */

/**
 * Plugin 可修改的 URL 字段（白名单）
 *
 * 只暴露路径相关的字段，不暴露 host/protocol 等上游信息，
 * 确保 plugin 无法修改请求的目标服务器，保证请求隔离。
 */
export interface ModifiableUrlFields {
  /**
   * 路径部分，如 /v1/chat/completions
   * Plugin 可以修改此字段来转换请求路径
   */
  pathname: string;

  /**
   * 查询参数，如 ?foo=bar
   * Plugin 可以修改此字段来添加或修改查询参数
   */
  search: string;

  /**
   * Hash 部分，如 #section
   * Plugin 可以修改此字段（通常较少使用）
   */
  hash: string;
}

/**
 * Plugin Context 中的受保护 URL 对象
 *
 * 设计理念：
 * - Plugin 可以读取完整的 URL 信息（用于判断逻辑）
 * - 但只能修改 pathname, search, hash（白名单字段）
 * - protocol, host 等字段为只读，确保请求不会被转发到错误的服务器
 *
 * 实现方式：
 * - 使用 Proxy 在运行时拦截非法修改
 * - 使用 readonly 在编译时阻止非法修改
 */
export interface PluginUrl extends ModifiableUrlFields {
  /** 只读的完整 URL 字符串，用于日志和调试 */
  readonly href: string;

  /** 只读的协议，如 https: */
  readonly protocol: string;

  /** 只读的主机名（含端口），如 api.example.com:443 */
  readonly host: string;

  /** 只读的主机名（不含端口），如 api.example.com */
  readonly hostname: string;

  /** 只读的端口，如 443 */
  readonly port: string;

  /** 只读的 origin，如 https://api.example.com */
  readonly origin: string;
}

/**
 * Plugin 上下文
 * 提供给 plugin 钩子的请求上下文信息
 */
export interface PluginContext {
  /**
   * 请求方法
   */
  method: string;

  /**
   * 请求 URL（受保护）
   *
   * Plugin 可以：
   * - 读取：所有字段（protocol, host, pathname, search, hash 等）
   * - 修改：pathname, search, hash
   *
   * 不可修改：protocol, host, hostname, port, origin
   */
  url: PluginUrl;

  /**
   * 请求 headers（可修改）
   */
  headers: Record<string, string>;

  /**
   * 请求 body（可修改）
   */
  body: any;

  /**
   * 请求日志对象
   */
  request: any;
}

/**
 * 流式 Chunk 上下文
 * 提供给流式转换钩子的上下文信息
 */
export interface StreamChunkContext {
  /**
   * 当前 chunk 的索引（从 0 开始）
   */
  chunkIndex: number;

  /**
   * 是否是第一个 chunk
   */
  isFirstChunk: boolean;

  /**
   * 是否是最后一个 chunk
   */
  isLastChunk: boolean;

  /**
   * 跨 chunk 的状态存储
   * 用于在多个 chunks 之间共享状态
   */
  streamState: Map<string, any>;

  /**
   * 请求日志对象
   */
  request: any;
}

/**
 * Plugin 接口
 * 所有 plugins 必须实现此接口
 */
export interface Plugin {
  /**
   * Plugin 名称（必需）
   */
  name: string;

  /**
   * Plugin 版本
   */
  version?: string;

  /**
   * 请求初始化时调用
   * 可以在这里初始化请求级别的状态
   */
  onRequestInit?(ctx: PluginContext): Promise<void>;

  /**
   * 在发送到 upstream 之前调用
   * 可以修改请求的 URL、headers、body
   */
  onBeforeRequest?(ctx: PluginContext): Promise<void>;

  /**
   * 拦截请求
   * 如果返回 Response 对象，则不会转发到 upstream
   * 如果返回 null，则继续正常流程
   */
  onInterceptRequest?(ctx: PluginContext): Promise<Response | null>;

  /**
   * 收到 upstream 响应后调用
   * 可以在这里记录响应或进行后处理
   * 如果返回新的 Response 对象，将使用该对象替换原响应
   */
  onResponse?(ctx: PluginContext & { response: Response }): Promise<Response | void>;

  /**
   * 发生错误时调用
   */
  onError?(ctx: PluginContext & { error: Error }): Promise<void>;

  /**
   * 处理流式响应的每个 chunk
   * 支持 N:M 转换：
   * - 返回 null/undefined: 不处理，原样输出
   * - 返回 []: 缓冲当前 chunk，不输出（N:0）
   * - 返回 [chunk]: 1:1 转换
   * - 返回 [chunk1, chunk2, ...]: 1:M 拆分或 N:M 批处理
   */
  processStreamChunk?(
    chunk: any,
    ctx: StreamChunkContext
  ): Promise<any[] | null>;

  /**
   * 流结束时调用（flush 缓冲区）
   * 用于输出缓冲区中剩余的 chunks
   */
  flushStream?(ctx: StreamChunkContext): Promise<any[]>;

  /**
   * 重置 plugin 状态（池化 plugin 专用）
   *
   * 当 plugin 使用 @Pooled 装饰器启用对象池时，此方法会在每次归还到池时被调用，
   * 用于清理请求级别的状态，确保下次被获取时状态是干净的。
   *
   * ⚠️ 注意事项：
   * - 只有使用 @Pooled 装饰器的 plugin 才需要实现此方法
   * - 非池化 plugin 每次请求都会创建新实例，不需要实现 reset
   * - 必须清理所有可变的实例状态（Map、Set、Array、对象属性等）
   * - 不应重置构造函数传入的配置选项
   *
   * @example
   * ```ts
   * @Pooled({ minSize: 2, maxSize: 10 })
   * export class MyHeavyPlugin implements Plugin {
   *   name = 'my-heavy-plugin';
   *   private requestCache = new Map<string, any>();
   *   private apiKey: string; // 构造函数传入的配置
   *
   *   constructor(options: { apiKey: string }) {
   *     this.apiKey = options.apiKey;
   *   }
   *
   *   async reset() {
   *     // ✅ 清理请求级状态
   *     this.requestCache.clear();
   *
   *     // ❌ 不要重置配置
   *     // this.apiKey = ''; // 错误！
   *   }
   * }
   * ```
   */
  reset?(): void | Promise<void>;

  /**
   * Plugin 卸载时调用
   * 可以在这里清理资源
   *
   * 生命周期说明：
   * - 非池化 plugin：每个请求结束时调用
   * - 池化 plugin：对象池销毁时调用（服务器关闭）
   */
  onDestroy?(): Promise<void>;
}
