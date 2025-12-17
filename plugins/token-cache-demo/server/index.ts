import type { Plugin, PluginStorage } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks, PluginInitContext, PluginLogger, MutableRequestContext, ResponseContext } from '../../../packages/core/src/hooks';

const TokenCachePlugin = definePlugin(
  class implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'token-cache-demo';
    static readonly version = '1.0.0';

    storage!: PluginStorage;
    logger!: PluginLogger;

    /**
     * 插件初始化
     */
    async init(ctx: PluginInitContext): Promise<void> {
      this.storage = ctx.storage;
      this.logger = ctx.logger;
      this.logger.info('TokenCachePlugin initialized');
    }

    /**
     * 注册插件 hooks
     */
    register(hooks: PluginHooks): void {
      // 1. 拦截请求：检查缓存
      hooks.onInterceptRequest.tapPromise(
        { name: 'token-cache-demo', stage: -100 }, // 高优先级，最早执行
        async (ctx) => {
          if (!this.storage) return undefined;

          if (ctx.method !== 'POST') return undefined;

          // 简单生成 cache key (实际应更复杂)
          const key = await this.generateCacheKey(ctx);

          const cached = await this.storage.get(key);
          if (cached) {
            this.logger.info('Cache hit', { key });

            // 更新统计
            await this.incrementStats('hits');

            // 缓存命中，返回 Response 短路后续处理
            return new Response(cached.body, {
              headers: {
                ...cached.headers,
                'X-Cache': 'HIT',
                'X-Cache-Plugin': TokenCachePlugin.name
              },
              status: cached.status
            });
          }

          this.logger.info('Cache miss', { key });
          await this.incrementStats('misses');
          return undefined; // 缓存未命中，继续执行
        }
      );

      // 2. 响应处理：缓存响应
      hooks.onResponse.tapPromise(
        { name: 'token-cache-demo' },
        async (response, ctx) => {
          if (!this.storage || !response.ok) return response;

          // 只有 POST 请求才缓存 (简化逻辑)
          if (ctx.method !== 'POST') return response;

          const key = await this.generateCacheKey(ctx);

          // 克隆响应以读取内容
          const cloned = response.clone();
          const body = await cloned.text();

          // 异步缓存 (不阻塞响应)
          this.cacheResponse(key, response, body).catch(err => {
            this.logger.error('Failed to cache response', { error: err });
          });

          return response; // Waterfall hook 必须返回 response
        }
      );
    }

    async generateCacheKey(ctx: MutableRequestContext | ResponseContext): Promise<string> {
      // 简单使用 URL 和 body hash
      const bodyStr = JSON.stringify((ctx as any).body || {});
      const url = ctx.originalUrl.href;
      const input = `${url}|${bodyStr}`;

      // 使用简单的 hash (实际生产应使用 crypto)
      let hash = 0;
      for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return `req_${hash}`;
    }

    async cacheResponse(key: string, response: Response, body: string) {
      if (!this.storage) return;

      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => headers[k] = v);

      await this.storage.set(key, {
        status: response.status,
        headers,
        body
      }, 60); // 缓存 60 秒
    }

    async incrementStats(type: 'hits' | 'misses') {
      if (!this.storage) return;

      const statsKey = 'stats';
      // 使用原子递增操作，避免并发竞争
      await this.storage.increment(statsKey, type, 1);
    }

    /**
     * 重置插件状态（对象池复用时调用）
     */
    async reset(): Promise<void> {
      // 缓存是跨请求共享的，不需要重置
    }
  }
);

export default TokenCachePlugin;
