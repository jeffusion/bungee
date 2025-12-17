/**
 * Metrics Example Plugin
 *
 * 功能：
 * - 记录请求计数
 * - 记录错误计数
 * - 记录请求延迟
 */

import type { PluginStorage, Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks, PluginInitContext, PluginLogger } from '../../../packages/core/src/hooks';

export const MetricsExamplePlugin = definePlugin(
  class implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'metrics-example';
    static readonly version = '1.0.0';

    /** @internal */
    storage!: PluginStorage;
    /** @internal */
    logger!: PluginLogger;

    async init(context: PluginInitContext): Promise<void> {
      this.storage = context.storage;
      this.logger = context.logger;
      this.logger.info('MetricsExamplePlugin initialized');
    }

    register(hooks: PluginHooks): void {
      // 1. 请求初始化：使用 tapAsync 实现 fire-and-forget
      hooks.onRequestInit.tapAsync(
        { name: 'metrics-example', stage: 100 },
        (ctx, done) => {
          this.storage
            .increment('metrics', 'totalRequests')
            .then(() => done())
            .catch((err) => {
              this.logger.error('Failed to increment request count', { error: err });
              done();
            });
        }
      );

      // 2. 错误处理：并行记录错误
      hooks.onError.tapPromise(
        { name: 'metrics-example' },
        async (ctx) => {
          await this.storage.increment('metrics', 'totalErrors');
          this.logger.warn('Request error recorded', {
            error: ctx.error.message,
            requestId: ctx.requestId,
          });
        }
      );

      // 3. 请求完成：记录延迟
      hooks.onFinally.tapPromise(
        { name: 'metrics-example' },
        async (ctx) => {
          const bucket = this.getLatencyBucket(ctx.latencyMs);
          await this.storage.increment('metrics', `latency_${bucket}`);

          this.logger.debug('Request completed', {
            requestId: ctx.requestId,
            success: ctx.success,
            latencyMs: ctx.latencyMs,
          });
        }
      );
    }

    /** @internal */
    getLatencyBucket(latencyMs: number): string {
      if (latencyMs < 100) return 'fast';
      if (latencyMs < 500) return 'normal';
      if (latencyMs < 1000) return 'slow';
      return 'very_slow';
    }

    async reset(): Promise<void> {}

    async onDestroy(): Promise<void> {
      this.logger.info('MetricsExamplePlugin destroyed');
    }
  }
);

export default MetricsExamplePlugin;
