/**
 * Hook 实现类
 *
 * 提供 4 种 Hook 类型的实现：
 * - AsyncParallelHook: 异步并行执行
 * - AsyncSeriesHook: 异步串行执行
 * - AsyncSeriesBailHook: 异步串行可中断
 * - AsyncSeriesWaterfallHook: 异步串行瀑布
 */

import { logger } from '../logger';
import type {
  TapInfo,
  Tap,
  IAsyncParallelHook,
  IAsyncSeriesHook,
  IAsyncSeriesBailHook,
  IAsyncSeriesWaterfallHook,
  IAsyncSeriesMapHook,
  HookStats,
} from './types';

/**
 * 标准化 TapInfo
 */
function normalizeTapInfo(info: TapInfo | string): TapInfo {
  if (typeof info === 'string') {
    return { name: info, stage: 0 };
  }
  return { ...info, stage: info.stage ?? 0 };
}

/**
 * 基础 Hook 类
 */
abstract class BaseHook<T extends any[]> {
  protected taps: Tap<T, any>[] = [];
  protected name: string;
  protected callCount = 0;
  protected totalTimeMs = 0;

  constructor(name?: string) {
    this.name = name ?? 'anonymous';
  }

  /**
   * 同步注册
   */
  tap(info: TapInfo | string, fn: (...args: T) => any): void {
    const tapInfo = normalizeTapInfo(info);
    this.taps.push({ info: tapInfo, type: 'sync', fn });
    this.sortTaps();
  }

  /**
   * 异步回调风格注册
   */
  tapAsync(info: TapInfo | string, fn: (...args: any[]) => void): void {
    const tapInfo = normalizeTapInfo(info);
    this.taps.push({ info: tapInfo, type: 'async', fn });
    this.sortTaps();
  }

  /**
   * Promise 风格注册
   */
  tapPromise(info: TapInfo | string, fn: (...args: T) => Promise<any>): void {
    const tapInfo = normalizeTapInfo(info);
    this.taps.push({ info: tapInfo, type: 'promise', fn });
    this.sortTaps();
  }

  /**
   * 检查是否有注册的回调
   */
  hasCallbacks(): boolean {
    return this.taps.length > 0;
  }

  /**
   * 获取统计信息
   */
  getStats(): HookStats {
    return {
      name: this.name,
      tapCount: this.taps.length,
      callCount: this.callCount,
      totalTimeMs: this.totalTimeMs,
      avgTimeMs: this.callCount > 0 ? this.totalTimeMs / this.callCount : 0,
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.callCount = 0;
    this.totalTimeMs = 0;
  }

  /**
   * 清空所有注册的回调
   */
  clear(): void {
    this.taps = [];
  }

  /**
   * 按 stage 排序（稳定排序）
   */
  private sortTaps(): void {
    this.taps.sort((a, b) => (a.info.stage ?? 0) - (b.info.stage ?? 0));
  }

  /**
   * 执行单个 tap
   */
  protected async executeTap<R>(
    tap: Tap<T, R>,
    args: T
  ): Promise<R | undefined> {
    try {
      if (tap.type === 'sync') {
        return tap.fn(...args);
      } else if (tap.type === 'promise') {
        return await tap.fn(...args);
      } else {
        // async (callback style)
        return await new Promise<R | undefined>((resolve, reject) => {
          const done = (err?: Error, result?: R) => {
            if (err) reject(err);
            else resolve(result);
          };
          tap.fn(...args, done);
        });
      }
    } catch (error) {
      logger.error(
        { error, hookName: this.name, pluginName: tap.info.name },
        'Error in hook callback'
      );
      throw error;
    }
  }
}

/**
 * 异步并行 Hook
 * 所有回调并行执行，全部完成后返回
 */
export class AsyncParallelHook<T extends any[] = []>
  extends BaseHook<T>
  implements IAsyncParallelHook<T>
{
  async promise(...args: T): Promise<void> {
    if (this.taps.length === 0) return;

    const startTime = performance.now();
    this.callCount++;

    try {
      // 并行执行所有回调，错误独立处理不影响其他
      await Promise.all(
        this.taps.map(async (tap) => {
          try {
            await this.executeTap(tap, args);
          } catch (error) {
            // 并行 Hook 中单个回调的错误不应影响其他回调
            logger.error(
              { error, hookName: this.name, pluginName: tap.info.name },
              'Error in parallel hook callback (ignored)'
            );
          }
        })
      );
    } finally {
      this.totalTimeMs += performance.now() - startTime;
    }
  }
}

/**
 * 异步串行 Hook
 * 所有回调按顺序串行执行
 */
export class AsyncSeriesHook<T extends any[] = []>
  extends BaseHook<T>
  implements IAsyncSeriesHook<T>
{
  async promise(...args: T): Promise<void> {
    if (this.taps.length === 0) return;

    const startTime = performance.now();
    this.callCount++;

    try {
      for (const tap of this.taps) {
        await this.executeTap(tap, args);
      }
    } finally {
      this.totalTimeMs += performance.now() - startTime;
    }
  }
}

/**
 * 异步串行可中断 Hook
 * 任意回调返回非 undefined 值则停止执行并返回该值
 */
export class AsyncSeriesBailHook<T extends any[] = [], R = any>
  extends BaseHook<T>
  implements IAsyncSeriesBailHook<T, R>
{
  async promise(...args: T): Promise<R | undefined> {
    if (this.taps.length === 0) return undefined;

    const startTime = performance.now();
    this.callCount++;

    try {
      for (const tap of this.taps) {
        const result = await this.executeTap<R>(tap, args);
        if (result !== undefined) {
          logger.debug(
            { hookName: this.name, pluginName: tap.info.name },
            'Hook bailed with result'
          );
          return result;
        }
      }
      return undefined;
    } finally {
      this.totalTimeMs += performance.now() - startTime;
    }
  }
}

/**
 * 异步串行瀑布 Hook
 * 每个回调的返回值作为下一个回调的第一个参数
 */
export class AsyncSeriesWaterfallHook<T, A extends any[] = []>
  extends BaseHook<[T, ...A]>
  implements IAsyncSeriesWaterfallHook<T, A>
{
  async promise(value: T, ...args: A): Promise<T> {
    if (this.taps.length === 0) return value;

    const startTime = performance.now();
    this.callCount++;

    try {
      let current = value;
      for (const tap of this.taps) {
        const result = await this.executeTap<T>(tap, [current, ...args] as [T, ...A]);
        // 只有返回非 undefined 时才更新值
        if (result !== undefined) {
          current = result;
        }
      }
      return current;
    } finally {
      this.totalTimeMs += performance.now() - startTime;
    }
  }
}

/**
 * 异步串行映射 Hook
 * 支持 N:M 转换：每个回调处理输入，可以返回 0 到多个输出
 *
 * 执行流程：
 * 1. 初始输入：单个 chunk
 * 2. 每个插件处理当前的所有 chunks，返回新的 chunks 数组
 * 3. 下一个插件处理上一步的所有输出
 *
 * 返回值约定：
 * - null/undefined: 不处理，原样输出当前 chunk
 * - []: 缓冲当前 chunk，不输出（N:0）
 * - [chunk]: 1:1 转换
 * - [chunk1, chunk2, ...]: 1:M 拆分
 *
 * 性能优化：
 * - 同步优先执行：sync tap 直接同步调用，跳过 Promise 开销
 * - 适用于流式响应处理等高频调用场景
 */
export class AsyncSeriesMapHook<T, A extends any[] = []>
  extends BaseHook<[T, ...A]>
  implements IAsyncSeriesMapHook<T, A>
{
  /**
   * 同步执行单个 tap（跳过 Promise 开销）
   */
  private executeTapSync<R>(tap: Tap<[T, ...A], R>, args: [T, ...A]): R | undefined {
    try {
      return tap.fn(...args);
    } catch (error) {
      logger.error(
        { error, hookName: this.name, pluginName: tap.info.name },
        'Error in hook callback'
      );
      throw error;
    }
  }

  async promise(value: T, ...args: A): Promise<T[]> {
    // 如果没有注册任何回调，直接返回原始值
    if (this.taps.length === 0) return [value];

    const startTime = performance.now();
    this.callCount++;

    try {
      // 初始输入为单个 chunk
      let chunks: T[] = [value];

      // 依次应用每个插件的转换
      for (const tap of this.taps) {
        const newChunks: T[] = [];

        // 对当前的每个 chunk 应用转换
        for (const chunk of chunks) {
          try {
            // 同步优先执行：sync tap 直接同步调用，跳过 Promise 开销
            const result = tap.type === 'sync'
              ? this.executeTapSync<T[] | null | undefined>(tap, [chunk, ...args] as [T, ...A])
              : await this.executeTap<T[] | null | undefined>(tap, [chunk, ...args] as [T, ...A]);

            if (result === null || result === undefined) {
              // 不处理，原样输出
              newChunks.push(chunk);
            } else if (Array.isArray(result)) {
              // N:M 转换
              // [] = 缓冲（不输出）
              // [item] = 1:1 转换
              // [item1, item2, ...] = 1:M 拆分
              newChunks.push(...result);
            } else {
              // 非法返回值，警告并原样输出
              logger.warn(
                { hookName: this.name, pluginName: tap.info.name, result },
                'AsyncSeriesMapHook callback must return an array or null'
              );
              newChunks.push(chunk);
            }
          } catch (error) {
            // 单个 chunk 处理失败，记录错误并原样输出
            logger.error(
              { error, hookName: this.name, pluginName: tap.info.name },
              'Error in AsyncSeriesMapHook callback'
            );
            if ((args[0] as { strict?: boolean } | undefined)?.strict) {
              throw error;
            }
            newChunks.push(chunk);
          }
        }

        chunks = newChunks;
      }

      return chunks;
    } finally {
      this.totalTimeMs += performance.now() - startTime;
    }
  }
}
