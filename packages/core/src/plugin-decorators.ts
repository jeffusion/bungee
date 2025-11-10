/**
 * Plugin 装饰器
 *
 * 提供用于增强 plugin 功能的装饰器，如对象池化
 */

/**
 * 对象池配置选项
 */
export interface PooledOptions {
  /**
   * 池中最小对象数（预热时创建）
   * @default 2
   */
  minSize?: number;

  /**
   * 池中最大对象数（防止无限增长）
   * @default 20
   */
  maxSize?: number;

  /**
   * 对象空闲超时时间（毫秒）
   * 超时后将被销毁以释放内存
   * @default undefined（不超时）
   */
  idleTimeout?: number;
}

/**
 * @Pooled 装饰器
 *
 * 启用 plugin 的对象池机制以提升性能。适用于：
 * - 初始化成本高的 plugin（如加载 ML 模型）
 * - 需要维护长连接的 plugin（如数据库连接）
 * - 创建开销大的 plugin（如大量内存分配）
 *
 * 使用此装饰器的 plugin 必须：
 * 1. 实现 reset() 方法来清理请求级状态
 * 2. 确保 reset() 方法能正确清理所有可变状态
 * 3. 在 onDestroy() 中清理全局资源（如关闭连接）
 *
 * ⚠️ 注意事项：
 * - 轻量级 plugin 不应使用池化（每请求实例化更简单）
 * - 池化会使对象常驻内存，增加基线内存占用
 * - reset() 方法如果遗漏状态清理，会导致请求间状态污染
 *
 * @param options 池配置选项
 *
 * @example
 * ```ts
 * import { Pooled } from './plugin-decorators';
 * import type { Plugin, PluginContext } from './plugin.types';
 *
 * @Pooled({ minSize: 2, maxSize: 10 })
 * export class MLModelPlugin implements Plugin {
 *   name = 'ml-model';
 *   private model: any; // 重量级 ML 模型
 *   private requestData = new Map<string, any>(); // 请求级状态
 *
 *   constructor(options: { modelPath: string }) {
 *     // 加载模型（耗时操作）
 *     this.model = loadModel(options.modelPath);
 *   }
 *
 *   async onBeforeRequest(ctx: PluginContext) {
 *     // 使用请求级状态
 *     this.requestData.set('timestamp', Date.now());
 *   }
 *
 *   async reset() {
 *     // 清理请求级状态
 *     this.requestData.clear();
 *     // 不要清理 this.model（全局资源）
 *   }
 *
 *   async onDestroy() {
 *     // 清理全局资源
 *     this.model.unload();
 *   }
 * }
 * ```
 */
export function Pooled(options?: PooledOptions) {
  return function <T extends { new (...args: any[]): any }>(target: T) {
    // 在类上附加元数据，供 PluginRegistry 检测
    (target as any).__pooled__ = true;
    (target as any).__poolOptions__ = options || {};

    return target;
  };
}

/**
 * 检测类是否使用了 @Pooled 装饰器
 *
 * @param target Plugin 类构造函数
 * @returns true 如果使用了 @Pooled
 */
export function isPooled(target: any): boolean {
  return !!(target && target.__pooled__);
}

/**
 * 获取 @Pooled 装饰器的配置选项
 *
 * @param target Plugin 类构造函数
 * @returns 池配置选项，如果未使用装饰器则返回 undefined
 */
export function getPoolOptions(target: any): PooledOptions | undefined {
  return target?.__poolOptions__;
}
