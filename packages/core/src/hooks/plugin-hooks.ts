/**
 * Bungee Plugin Hooks 定义
 *
 * 定义了插件系统中所有可用的 Hook 及其上下文类型。
 * 每个 Hook 有预设的执行模式（Parallel/Series/Bail/Waterfall），
 * 插件通过 register() 方法选择合适的注册方式。
 */

import {
  AsyncParallelHook,
  AsyncSeriesHook,
  AsyncSeriesBailHook,
  AsyncSeriesWaterfallHook,
  AsyncSeriesMapHook,
} from './impl';
import type { PluginStorage } from '../plugin.types';

// ============ 上下文类型定义 ============

/**
 * 请求上下文（只读部分）
 */
export interface RequestContext {
  /** HTTP 方法 */
  readonly method: string;
  /** 原始请求 URL */
  readonly originalUrl: URL;
  /** 客户端 IP */
  readonly clientIP: string;
  /** 请求唯一 ID */
  readonly requestId: string;
  /** 路由 ID */
  readonly routeId?: string;
  /** 上游 ID */
  readonly upstreamId?: string;
}

/**
 * 可修改的请求上下文
 */
export interface MutableRequestContext extends RequestContext {
  /** 目标 URL（可修改） */
  url: URL;
  /** 请求头（可修改） */
  headers: Record<string, string>;
  /** 请求体（可修改） */
  body: any;
}

/**
 * 响应上下文
 */
export interface ResponseContext extends RequestContext {
  /** 响应对象 */
  response: Response;
  /** 请求延迟（毫秒） */
  readonly latencyMs: number;
}

/**
 * 错误上下文
 */
export interface ErrorContext extends RequestContext {
  /** 错误对象 */
  readonly error: Error;
  /** 请求头 */
  headers: Record<string, string>;
  /** 请求体 */
  body: any;
}

/**
 * 流式数据块上下文
 *
 * 性能优化：chunkIndex/isFirstChunk/isLastChunk 不再是 readonly，
 * 允许 StreamExecutor 复用 context 对象以减少 GC 压力
 */
export interface StreamChunkContext extends RequestContext {
  /** 块索引 */
  chunkIndex: number;
  /** 是否为第一个块 */
  isFirstChunk: boolean;
  /** 是否为最后一个块 */
  isLastChunk: boolean;
  /**
   * 流状态存储
   * 每个插件可以使用此 Map 存储跨 chunk 的状态
   * Key 由插件自行管理
   */
  streamState: Map<string, any>;
  /**
   * 请求日志对象（用于调试）
   */
  readonly request?: any;
}

/**
 * 请求完成上下文
 */
export interface FinallyContext extends RequestContext {
  /** 请求是否成功 */
  readonly success: boolean;
  /** 请求延迟（毫秒） */
  readonly latencyMs: number;
  /** 响应状态码（如果有） */
  readonly statusCode?: number;
}

/**
 * 插件作用域信息
 * 用于需要按作用域隔离数据的插件
 */
export interface PluginScopeInfo {
  /** 作用域类型 */
  type: 'global' | 'route' | 'upstream';
  /** 作用域 ID（route 时为 routeId，upstream 时为 upstreamId） */
  id?: string;
}

/**
 * 插件初始化上下文
 */
export interface PluginInitContext {
  /** 插件配置 */
  config: Record<string, any>;
  /** 插件存储 */
  storage: PluginStorage;
  /** 插件日志 */
  logger: PluginLogger;
  /**
   * 作用域信息（可选）
   *
   * 用于需要按作用域隔离数据的插件。
   * 注意：Storage 默认是插件级别共享的，如需隔离请在 key 中添加作用域前缀
   *
   * @example
   * // 按作用域隔离 storage key
   * const scopedKey = ctx.scope
   *   ? `${ctx.scope.type}:${ctx.scope.id || 'default'}:${key}`
   *   : key;
   * await this.storage.set(scopedKey, value);
   */
  scope?: PluginScopeInfo;
}

/**
 * 插件日志接口
 */
export interface PluginLogger {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

// ============ Plugin Hooks 工厂 ============

/**
 * 创建一组新的 Plugin Hooks
 *
 * 每个请求应该创建独立的 hooks 实例，以避免状态污染。
 * 或者使用单例 hooks，在请求处理开始前清理状态。
 */
export function createPluginHooks() {
  return {
    /**
     * 请求初始化
     *
     * 执行模式：AsyncParallel（并行）
     * 用途：初始化插件状态、记录请求开始、早期验证
     * 注意：此阶段不应修改请求，仅用于初始化
     */
    onRequestInit: new AsyncParallelHook<[RequestContext]>('onRequestInit'),

    /**
     * 请求前处理
     *
     * 执行模式：AsyncSeriesWaterfall（串行瀑布）
     * 用途：修改请求 URL、Headers、Body
     * 每个插件接收上一个插件修改后的 context，返回修改后的 context
     */
    onBeforeRequest: new AsyncSeriesWaterfallHook<MutableRequestContext>('onBeforeRequest'),

    /**
     * 请求拦截
     *
     * 执行模式：AsyncSeriesBail（串行可中断）
     * 用途：短路请求，直接返回响应（如缓存命中、限流拒绝）
     * 返回 Response 则停止后续处理并返回该响应
     */
    onInterceptRequest: new AsyncSeriesBailHook<[MutableRequestContext], Response>('onInterceptRequest'),

    /**
     * 响应处理
     *
     * 执行模式：AsyncSeriesWaterfall（串行瀑布）
     * 用途：修改响应、记录日志、缓存响应
     * 每个插件接收上一个插件处理后的 Response
     */
    onResponse: new AsyncSeriesWaterfallHook<Response, [ResponseContext]>('onResponse'),

    /**
     * 流式响应块处理
     *
     * 执行模式：AsyncSeriesMap（串行映射，支持 N:M 转换）
     * 用途：处理 SSE 流的每个数据块，支持拆分、合并、过滤
     *
     * 返回值约定：
     * - null/undefined: 不处理，原样输出
     * - []: 缓冲当前 chunk，不输出（N:0）
     * - [chunk]: 1:1 转换
     * - [chunk1, chunk2, ...]: 1:M 拆分
     */
    onStreamChunk: new AsyncSeriesMapHook<any, [StreamChunkContext]>('onStreamChunk'),

    /**
     * 流结束时刷新缓冲区
     *
     * 执行模式：AsyncSeriesWaterfall（串行瀑布）
     * 用途：在流结束时输出缓冲区中剩余的数据
     *
     * 每个插件接收上一个插件输出的 chunks 数组，返回处理后的 chunks 数组
     */
    onFlushStream: new AsyncSeriesWaterfallHook<any[], [StreamChunkContext]>('onFlushStream'),

    /**
     * 错误处理
     *
     * 执行模式：AsyncParallel（并行）
     * 用途：错误日志、错误上报、告警
     * 注意：错误处理插件的异常会被捕获但不影响其他插件
     */
    onError: new AsyncParallelHook<[ErrorContext]>('onError'),

    /**
     * 请求完成（无论成功失败）
     *
     * 执行模式：AsyncParallel（并行）
     * 用途：清理资源、记录指标、完成统计
     */
    onFinally: new AsyncParallelHook<[FinallyContext]>('onFinally'),
  };
}

/**
 * Plugin Hooks 类型
 */
export type PluginHooks = ReturnType<typeof createPluginHooks>;

/**
 * 获取所有 Hook 的统计信息
 */
export function getHooksStats(hooks: PluginHooks) {
  return {
    onRequestInit: hooks.onRequestInit.getStats(),
    onBeforeRequest: hooks.onBeforeRequest.getStats(),
    onInterceptRequest: hooks.onInterceptRequest.getStats(),
    onResponse: hooks.onResponse.getStats(),
    onStreamChunk: hooks.onStreamChunk.getStats(),
    onFlushStream: hooks.onFlushStream.getStats(),
    onError: hooks.onError.getStats(),
    onFinally: hooks.onFinally.getStats(),
  };
}

/**
 * 重置所有 Hook 的统计信息
 */
export function resetHooksStats(hooks: PluginHooks): void {
  hooks.onRequestInit.resetStats();
  hooks.onBeforeRequest.resetStats();
  hooks.onInterceptRequest.resetStats();
  hooks.onResponse.resetStats();
  hooks.onStreamChunk.resetStats();
  hooks.onFlushStream.resetStats();
  hooks.onError.resetStats();
  hooks.onFinally.resetStats();
}

/**
 * 清空所有 Hook 的注册回调
 */
export function clearHooks(hooks: PluginHooks): void {
  hooks.onRequestInit.clear();
  hooks.onBeforeRequest.clear();
  hooks.onInterceptRequest.clear();
  hooks.onResponse.clear();
  hooks.onStreamChunk.clear();
  hooks.onFlushStream.clear();
  hooks.onError.clear();
  hooks.onFinally.clear();
}
