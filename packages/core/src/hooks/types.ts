/**
 * Hook 类型定义
 *
 * 参考 Webpack Tapable 设计，提供多种 Hook 类型以支持不同的执行模式。
 * 插件可以根据需要选择合适的注册方式（tap/tapAsync/tapPromise）。
 */

/**
 * Hook 注册回调的元信息
 */
export interface TapInfo {
  /** 插件名称（用于调试和日志） */
  name: string;
  /** 执行优先级（可选，默认 0，负数优先执行） */
  stage?: number;
}

/**
 * 已注册的 Tap 项
 */
export interface Tap<_T extends any[], _R = void> {
  info: TapInfo;
  type: 'sync' | 'async' | 'promise';
  fn: (...args: any[]) => any;
}

/**
 * 异步并行 Hook 接口
 * 所有回调并行执行，全部完成后返回
 */
export interface IAsyncParallelHook<T extends any[] = []> {
  /** 同步注册（会被包装为 Promise） */
  tap(info: TapInfo | string, fn: (...args: T) => void): void;
  /** 异步回调风格注册 */
  tapAsync(info: TapInfo | string, fn: (...args: [...T, done: (err?: Error) => void]) => void): void;
  /** Promise 风格注册 */
  tapPromise(info: TapInfo | string, fn: (...args: T) => Promise<void>): void;
  /** 执行所有回调（并行） */
  promise(...args: T): Promise<void>;
  /** 检查是否有注册的回调 */
  hasCallbacks(): boolean;
}

/**
 * 异步串行 Hook 接口
 * 所有回调按顺序串行执行
 */
export interface IAsyncSeriesHook<T extends any[] = []> {
  /** 同步注册 */
  tap(info: TapInfo | string, fn: (...args: T) => void): void;
  /** 异步回调风格注册 */
  tapAsync(info: TapInfo | string, fn: (...args: [...T, done: (err?: Error) => void]) => void): void;
  /** Promise 风格注册 */
  tapPromise(info: TapInfo | string, fn: (...args: T) => Promise<void>): void;
  /** 执行所有回调（串行） */
  promise(...args: T): Promise<void>;
  /** 检查是否有注册的回调 */
  hasCallbacks(): boolean;
}

/**
 * 异步串行可中断 Hook 接口
 * 任意回调返回非 undefined 值则停止执行并返回该值
 */
export interface IAsyncSeriesBailHook<T extends any[] = [], R = any> {
  /** 同步注册 */
  tap(info: TapInfo | string, fn: (...args: T) => R | undefined): void;
  /** 异步回调风格注册 */
  tapAsync(info: TapInfo | string, fn: (...args: [...T, done: (err?: Error, result?: R) => void]) => void): void;
  /** Promise 风格注册 */
  tapPromise(info: TapInfo | string, fn: (...args: T) => Promise<R | undefined>): void;
  /** 执行所有回调（串行可中断） */
  promise(...args: T): Promise<R | undefined>;
  /** 检查是否有注册的回调 */
  hasCallbacks(): boolean;
}

/**
 * 异步串行瀑布 Hook 接口
 * 每个回调的返回值作为下一个回调的第一个参数
 */
export interface IAsyncSeriesWaterfallHook<T, A extends any[] = []> {
  /** 同步注册 */
  tap(info: TapInfo | string, fn: (value: T, ...args: A) => T): void;
  /** 异步回调风格注册 */
  tapAsync(info: TapInfo | string, fn: (value: T, ...args: [...A, done: (err?: Error, result?: T) => void]) => void): void;
  /** Promise 风格注册 */
  tapPromise(info: TapInfo | string, fn: (value: T, ...args: A) => Promise<T>): void;
  /** 执行所有回调（串行瀑布） */
  promise(value: T, ...args: A): Promise<T>;
  /** 检查是否有注册的回调 */
  hasCallbacks(): boolean;
}

/**
 * 异步串行映射 Hook 接口
 * 支持 N:M 转换：每个回调处理一批输入，返回一批输出
 *
 * 执行流程：
 * 1. 初始输入：[chunk]
 * 2. 第一个插件处理所有输入，返回新的输出数组
 * 3. 第二个插件处理上一步的所有输出，返回新的输出数组
 * 4. 以此类推...
 *
 * 返回值约定：
 * - null/undefined: 不处理，原样输出当前 chunk
 * - []: 缓冲当前 chunk，不输出（N:0）
 * - [chunk]: 1:1 转换
 * - [chunk1, chunk2, ...]: 1:M 拆分
 */
export interface IAsyncSeriesMapHook<T, A extends any[] = []> {
  /** 同步注册 */
  tap(info: TapInfo | string, fn: (value: T, ...args: A) => T[] | null | undefined): void;
  /** 异步回调风格注册 */
  tapAsync(info: TapInfo | string, fn: (value: T, ...args: [...A, done: (err?: Error, result?: T[] | null) => void]) => void): void;
  /** Promise 风格注册 */
  tapPromise(info: TapInfo | string, fn: (value: T, ...args: A) => Promise<T[] | null | undefined>): void;
  /** 执行所有回调（串行映射） */
  promise(value: T, ...args: A): Promise<T[]>;
  /** 检查是否有注册的回调 */
  hasCallbacks(): boolean;
}

/**
 * Hook 统计信息
 */
export interface HookStats {
  /** Hook 名称 */
  name: string;
  /** 注册的回调数量 */
  tapCount: number;
  /** 调用次数 */
  callCount: number;
  /** 总执行时间（毫秒） */
  totalTimeMs: number;
  /** 平均执行时间（毫秒） */
  avgTimeMs: number;
}
