/**
 * Cache Example Plugin
 *
 * 功能：
 * - 检查缓存命中
 * - 缓存响应
 */

import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks, PluginInitContext } from '../../../packages/core/src/hooks';

export const CacheExamplePlugin = definePlugin(
  class implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'cache-example';
    static readonly version = '1.0.0';

    /** @internal */
    cache = new Map<string, { response: Response; expireAt: number }>();
    /** @internal */
    ttlMs = 60000;

    async init(context: PluginInitContext): Promise<void> {
      this.ttlMs = context.config.ttlMs || 60000;
    }

    register(hooks: PluginHooks): void {
      // 1. 拦截请求：检查缓存
      hooks.onInterceptRequest.tapPromise(
        { name: 'cache-example', stage: -100 },
        async (ctx) => {
          const key = this.getCacheKey(ctx);
          const cached = this.cache.get(key);

          if (cached && cached.expireAt > Date.now()) {
            return cached.response.clone();
          }

          if (cached) {
            this.cache.delete(key);
          }

          return undefined;
        }
      );

      // 2. 响应处理：缓存响应
      hooks.onResponse.tapPromise(
        { name: 'cache-example' },
        async (response, ctx) => {
          if (response.status === 200 && ctx.method === 'GET') {
            const key = this.getCacheKey(ctx);
            this.cache.set(key, {
              response: response.clone(),
              expireAt: Date.now() + this.ttlMs,
            });
          }
          return response;
        }
      );
    }

    /** @internal */
    getCacheKey(ctx: { method: string; originalUrl: URL }): string {
      return `${ctx.method}:${ctx.originalUrl.pathname}${ctx.originalUrl.search}`;
    }

    async reset(): Promise<void> {}

    async onDestroy(): Promise<void> {
      this.cache.clear();
    }
  }
);

export default CacheExamplePlugin;
