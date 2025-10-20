/**
 * Plugin 系统类型定义
 */

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
   * 请求 URL
   */
  url: URL;

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
   * Plugin 卸载时调用
   * 可以在这里清理资源
   */
  onDestroy?(): Promise<void>;
}
