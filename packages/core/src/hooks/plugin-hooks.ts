import type { WebSocketObservationEvent, WebSocketHandshakeContext, GatewayWebSocketInput, GatewayWebSocketResult } from '../gateway/websocket-contracts';
/**
 * Bungee Plugin Hooks 定义
 *
 * 定义了插件系统中所有可用的 Hook 及其上下文类型。
 * 每个 Hook 有预设的执行模式（Parallel/Series/Bail/Waterfall），
 * 插件通过 register() 方法选择合适的注册方式。
 */

import {
  SyncBailHook,
  AsyncParallelHook,
  AsyncSeriesBailHook,
  AsyncSeriesWaterfallHook,
  AsyncSeriesMapHook,
} from './impl';
import type { PluginServices } from '../plugin-services';
import type { PluginStorage, SSEEnvelope } from '../plugin.types';
import type { InterceptResult, PluginPhase } from '@jeffusion/bungee-types';
import type { RawResponseResult } from '../plugin-control/contracts';
import type { GatewayBodyArguments, GatewayRequestArguments, GatewayForwardArguments, GatewayResponseRuleArguments, GatewayBodyRuleArguments, GatewayQueryRuleArguments, GatewayHeaderRuleArguments, GatewayCorsArguments, GatewayRouteInput, GatewayRouteDecision, GatewayDispatchInput, GatewayDispatchDecision, DispatchRequestInput, DispatchRequestDecision, GatewayAdmissionInput, GatewayAdmissionDecision, GatewayAdmissionSessionInput, GatewayAdmissionPrepareInput, GatewaySelectInput, GatewaySelectDecision, GatewayFailoverInput, GatewayRetryInput, GatewayLogInput, GatewayLogResult } from '../gateway/contracts';
import type { WorkerRequestAdmission, PreparedAdmissionAttempt } from '../data-admission/worker';
import type { FailoverCoordinator } from '../worker/upstream/failover-coordinator';
import type { ProxyRequestResult } from '../gateway/forward-plugin';
import type { PrepareResponseResult } from '../gateway/response-plugin';
import type { BodySource } from '../gateway/body-service';
import type { BodyHandle, BodyViewIdentity } from '../gateway/body-contracts';

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
  readonly bodyHandle?: BodyHandle;
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
  readonly bodyHandle?: BodyHandle;
  /** 响应对象 */
  response: Response;
  /** 请求延迟（毫秒） */
  readonly latencyMs: number;
}

/** Strict raw response boundary. Unlike legacy response hooks, failures propagate. */
export interface RawResponseContext extends RequestContext {
  readonly bodyHandle?: BodyHandle;
  readonly signal: AbortSignal;
  readonly attemptId: string;
  /** Redacts credentials acquired by the host without exposing them to plugins. */
  readonly redactDiagnostic?: (message: string) => string;
}

export type AttemptObservationOutcome = 'completed' | 'failed' | 'cancelled';
export type AttemptObservationEvent = Readonly<{
  /** Host-derived credential identity; never copied from client headers. */
  keyId?: string | null;
  requestId: string;
  routeId: string;
  attemptId: string;
  upstreamId: string;
  /** Identifies the independent observation branch and the exact body version. */
  direction?: 'request' | 'response';
  representation?: 'wire' | 'decoded' | 'json' | 'sse';
  view?: BodyViewIdentity;
  consumerId?: string;
  /**
   * Cooperative validity lease for this delivery. It becomes false after the callback
   * resolves/rejects or the host times it out. Plugins must check it after every await
   * and immediately before mutating state; a timed-out callback cannot be forcibly stopped.
   */
  isActive: () => boolean;
} & (
  | { phase: 'selected' }
  | { phase: 'request'; url: string; body: unknown }
  | { phase: 'response'; status: number; protocol: 'json' | 'sse'; body: Record<string, unknown>; envelope?: SSEEnvelope }
  | { phase: 'incomplete'; reason: 'observer-timeout' | 'observer-error' | 'raw-response-incomplete' | 'buffer-limit' | 'frame-limit' | 'frame-truncated' | 'decode-error' | 'unsupported-encoding' }
  | { phase: 'end'; outcome: AttemptObservationOutcome; sent: boolean }
  | { phase: 'request-end' }
)>;

/** Parallel observer dispatch must surface failures so the request host can disable a broken observer. */
class AttemptObservationHook extends AsyncParallelHook<[AttemptObservationEvent]> {
  override async promise(...args: [AttemptObservationEvent]): Promise<void> {
    if (this.taps.length === 0) return;
    const startedAt = performance.now();
    this.callCount++;
    try {
      await Promise.all(this.taps.map((tap) => this.executeTap(tap, args)));
    } finally {
      this.totalTimeMs += performance.now() - startedAt;
    }
  }
}

/** Strict, isolated WebSocket observers use the same plugin registration contract. */
class WebSocketObservationHook extends AsyncParallelHook<[WebSocketObservationEvent]> {
  override async promise(...args: [WebSocketObservationEvent]): Promise<void> {
    this.callCount++;
    const started = performance.now();
    try { await Promise.all(this.taps.map(tap => this.executeTap(tap, args))); }
    finally { this.totalTimeMs += performance.now() - started; }
  }
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
 * 保存当前事件序号与本次响应内的插件状态
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
  /** Strict raw-response processing must propagate plugin failures. */
  readonly strict?: boolean;
  /** Metadata of the current SSE event, independent from its JSON payload. */
  readonly sseEvent?: SSEEnvelope;
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
  type: 'global' | 'route' | 'service' | 'upstream';
  phase?: PluginPhase;
  routeId?: string;
  serviceName?: string;
  upstreamId?: string;
  /** @deprecated Use phase + routeId/serviceName/upstreamId instead */
  id?: string;
}

/**
 * 插件初始化上下文
 */
export interface PluginInitContext {
  /** Host-controlled, dependency-restricted public service facade. */
  readonly services?: PluginServices;
  readonly dispatchTargets?: readonly (import('../gateway/contracts').GatewayDispatchTarget & {readonly protocol?: import('@jeffusion/bungee-types').LLMProtocol})[];
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
export function createPluginHooks(): PluginHooks {
  return {
    onGatewayWebSocket: new AsyncSeriesBailHook<[GatewayWebSocketInput], GatewayWebSocketResult>('onGatewayWebSocket'),
    onWebSocketSessionMode: new AsyncSeriesBailHook<[URL], 'responses'>('onWebSocketSessionMode'),
    onWebSocketHandshake: new AsyncSeriesWaterfallHook<WebSocketHandshakeContext>('onWebSocketHandshake'),
    onWebSocketObservation: new WebSocketObservationHook('onWebSocketObservation'),
    onGatewayBody: new SyncBailHook<GatewayBodyArguments, BodySource>('onGatewayBody'),
    onGatewayRequest: new AsyncSeriesBailHook<GatewayRequestArguments, Response>('onGatewayRequest'),
    onGatewayRoute: new AsyncSeriesBailHook<[GatewayRouteInput], GatewayRouteDecision>('onGatewayRoute'),
    onGatewayDispatch: new AsyncSeriesBailHook<[GatewayDispatchInput], GatewayDispatchDecision>('onGatewayDispatch'),
    onDispatchRequest: new AsyncSeriesBailHook<[DispatchRequestInput], DispatchRequestDecision>('onDispatchRequest'),
    onGatewayAdmission: new AsyncSeriesBailHook<[GatewayAdmissionInput], GatewayAdmissionDecision>('onGatewayAdmission'),
    onGatewayAdmissionSession: new AsyncSeriesBailHook<[GatewayAdmissionSessionInput], WorkerRequestAdmission>('onGatewayAdmissionSession'),
    onGatewayAdmissionPrepare: new AsyncSeriesBailHook<[GatewayAdmissionPrepareInput], PreparedAdmissionAttempt[]>('onGatewayAdmissionPrepare'),
    onGatewaySelect: new AsyncSeriesBailHook<[GatewaySelectInput], GatewaySelectDecision>('onGatewaySelect'),
    onGatewayFailover: new AsyncSeriesBailHook<[GatewayFailoverInput], FailoverCoordinator>('onGatewayFailover'),
    onGatewayRetry: new AsyncSeriesBailHook<[GatewayRetryInput], ProxyRequestResult>('onGatewayRetry'),
    onGatewayHeaderRules: new AsyncSeriesBailHook<GatewayHeaderRuleArguments, true>('onGatewayHeaderRules'),
    onGatewayCors: new AsyncSeriesBailHook<GatewayCorsArguments, Response>('onGatewayCors'),
    onGatewayForward: new AsyncSeriesBailHook<GatewayForwardArguments, ProxyRequestResult>('onGatewayForward'),
    onGatewayBodyRules: new AsyncSeriesBailHook<GatewayBodyRuleArguments, Record<string, any>>('onGatewayBodyRules'),
    onGatewayQueryRules: new AsyncSeriesBailHook<GatewayQueryRuleArguments, URLSearchParams>('onGatewayQueryRules'),
    onGatewayResponseRules: new AsyncSeriesBailHook<GatewayResponseRuleArguments, PrepareResponseResult>('onGatewayResponseRules'),
    onGatewayLog: new AsyncSeriesBailHook<[GatewayLogInput], GatewayLogResult>('onGatewayLog'),
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
     * 返回 respond action 则停止后续处理并返回该响应
     */
    onInterceptRequest: new AsyncSeriesBailHook<[MutableRequestContext], InterceptResult>('onInterceptRequest'),

    /**
     * 响应处理
     *
     * 执行模式：AsyncSeriesWaterfall（串行瀑布）
     * 用途：修改响应、记录日志、缓存响应
     * 每个插件接收上一个插件处理后的 Response
     */
    onResponse: new AsyncSeriesWaterfallHook<Response, [ResponseContext]>('onResponse'),

    /**
     * Raw upstream response hook. This runs once after fetch and before any
     * legacy response/SSE processing. Its completion promise is part of the
     * request outcome and must not be swallowed by resilient stream wrappers.
     */
    onRawResponse: new AsyncSeriesWaterfallHook<RawResponseResult, [RawResponseContext]>('onRawResponse'),

    /** Independent read-only attempt lifecycle observer. */
    onAttemptObservation: new AttemptObservationHook('onAttemptObservation'),

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
    onStreamChunk: new AsyncSeriesMapHook<SSEEnvelope, [StreamChunkContext]>('onStreamChunk'),

    /**
     * 流结束时刷新缓冲区
     *
     * 执行模式：AsyncSeriesWaterfall（串行瀑布）
     * 用途：在流结束时输出缓冲区中剩余的数据
     *
     * 每个插件接收上一个插件输出的 chunks 数组，返回处理后的 chunks 数组
     */
    onFlushStream: new AsyncSeriesWaterfallHook<SSEEnvelope[], [StreamChunkContext]>('onFlushStream'),

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
export interface PluginHooks {
  onGatewayWebSocket: AsyncSeriesBailHook<[GatewayWebSocketInput], GatewayWebSocketResult>;
  onWebSocketSessionMode: AsyncSeriesBailHook<[URL], 'responses'>;
  onWebSocketHandshake: AsyncSeriesWaterfallHook<WebSocketHandshakeContext>;
  onWebSocketObservation: WebSocketObservationHook;
  onGatewayBody: SyncBailHook<GatewayBodyArguments, BodySource>;
  onGatewayHeaderRules: AsyncSeriesBailHook<GatewayHeaderRuleArguments, true>;
  onGatewayCors: AsyncSeriesBailHook<GatewayCorsArguments, Response>;
  onGatewayRequest: AsyncSeriesBailHook<GatewayRequestArguments, Response>;
  onGatewayRoute: AsyncSeriesBailHook<[GatewayRouteInput], GatewayRouteDecision>;
  onGatewayDispatch: AsyncSeriesBailHook<[GatewayDispatchInput], GatewayDispatchDecision>;
  onDispatchRequest: AsyncSeriesBailHook<[DispatchRequestInput], DispatchRequestDecision>;
  onGatewayAdmission: AsyncSeriesBailHook<[GatewayAdmissionInput], GatewayAdmissionDecision>;
  onGatewayAdmissionSession: AsyncSeriesBailHook<[GatewayAdmissionSessionInput], WorkerRequestAdmission>;
  onGatewayAdmissionPrepare: AsyncSeriesBailHook<[GatewayAdmissionPrepareInput], PreparedAdmissionAttempt[]>;
  onGatewaySelect: AsyncSeriesBailHook<[GatewaySelectInput], GatewaySelectDecision>;
  onGatewayFailover: AsyncSeriesBailHook<[GatewayFailoverInput], FailoverCoordinator>;
  onGatewayRetry: AsyncSeriesBailHook<[GatewayRetryInput], ProxyRequestResult>;
  onGatewayForward: AsyncSeriesBailHook<GatewayForwardArguments, ProxyRequestResult>;
  onGatewayBodyRules: AsyncSeriesBailHook<GatewayBodyRuleArguments, Record<string, any>>;
  onGatewayQueryRules: AsyncSeriesBailHook<GatewayQueryRuleArguments, URLSearchParams>;
  onGatewayResponseRules: AsyncSeriesBailHook<GatewayResponseRuleArguments, PrepareResponseResult>;
  onGatewayLog: AsyncSeriesBailHook<[GatewayLogInput], GatewayLogResult>;
  onRequestInit: AsyncParallelHook<[RequestContext]>;
  onBeforeRequest: AsyncSeriesWaterfallHook<MutableRequestContext>;
  onInterceptRequest: AsyncSeriesBailHook<[MutableRequestContext], InterceptResult>;
  onResponse: AsyncSeriesWaterfallHook<Response, [ResponseContext]>;
  onRawResponse: AsyncSeriesWaterfallHook<RawResponseResult, [RawResponseContext]>;
  onAttemptObservation: AttemptObservationHook;
  onStreamChunk: AsyncSeriesMapHook<SSEEnvelope, [StreamChunkContext]>;
  onFlushStream: AsyncSeriesWaterfallHook<SSEEnvelope[], [StreamChunkContext]>;
  onError: AsyncParallelHook<[ErrorContext]>;
  onFinally: AsyncParallelHook<[FinallyContext]>;
}

/**
 * 获取所有 Hook 的统计信息
 */
export function getHooksStats(hooks: PluginHooks) {
  return Object.fromEntries(Object.entries(hooks).map(([name, hook]) => [name, hook.getStats()]));
}
export function resetHooksStats(hooks: PluginHooks): void {
  for (const hook of Object.values(hooks)) hook.resetStats();
}
export function clearHooks(hooks: PluginHooks): void {
  for (const hook of Object.values(hooks)) hook.clear();
}
