/**
 * Token 统计插件 - 服务端逻辑
 *
 * 功能：
 * - 从 AI 响应中提取 Token 使用量（支持 OpenAI/Anthropic 格式）
 * - 按路由分类统计输入/输出 Token
 * - 提供 API 端点查询统计数据
 */

import type {
  PluginStorage,
  Plugin,
} from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type {
  PluginHooks,
  PluginInitContext,
  PluginLogger,
  ResponseContext,
  StreamChunkContext,
} from '../../../packages/core/src/hooks';

/**
 * Token 使用量数据结构
 */
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * 按路由统计的 Token 数据
 */
interface RouteTokenStats {
  routeId: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

/**
 * 汇总统计数据
 */
interface TokenStatsSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_requests: number;
  by_route: RouteTokenStats[];
}

export const TokenStatsPlugin = definePlugin(
  class implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'token-stats';
    static readonly version = '1.0.0';

    /** @internal */
    storage!: PluginStorage;
    /** @internal */
    logger!: PluginLogger;

    /**
     * 插件初始化
     */
    async init(context: PluginInitContext): Promise<void> {
      this.storage = context.storage;
      this.logger = context.logger;
      this.logger.info('TokenStatsPlugin initialized');
    }

    /**
     * 注册 Hooks
     */
    register(hooks: PluginHooks): void {
      // 1. 非流式响应处理：从完整响应中提取 usage
      hooks.onResponse.tapPromise(
        { name: 'token-stats', stage: 100 }, // 后置执行，不影响响应
        async (response, ctx) => {
          await this.extractTokensFromResponse(response, ctx);
          return response;
        }
      );

      // 2. 流式响应处理：从每个 chunk 中检测 usage
      //    OpenAI: 最后一个 chunk 可能包含 usage
      //    Anthropic: message_stop 事件包含 usage
      hooks.onStreamChunk.tapPromise(
        { name: 'token-stats', stage: 100 },
        async (chunk, ctx) => {
          await this.extractTokensFromChunk(chunk, ctx);
          return null; // 不修改 chunk
        }
      );
    }

    /**
     * 从非流式响应中提取 Token 使用量
     * @internal
     */
    async extractTokensFromResponse(
      response: Response,
      ctx: ResponseContext
    ): Promise<void> {
      try {
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) return;

        // 克隆响应以避免消费原始流
        const cloned = response.clone();
        const body = await cloned.json();

        const usage = this.parseUsage(body);
        if (usage) {
          await this.recordUsage(ctx.routeId || 'unknown', usage);
        }
      } catch (error) {
        this.logger.debug('Failed to extract tokens from response', { error });
      }
    }

    /**
     * 从流式 chunk 中提取 Token 使用量
     * @internal
     */
    async extractTokensFromChunk(
      chunk: any,
      ctx: StreamChunkContext
    ): Promise<void> {
      try {
        // 检查 chunk 是否包含 usage 信息
        const usage = this.parseUsage(chunk);
        if (usage) {
          // 使用 streamState 避免重复记录
          const stateKey = 'token-stats:recorded';
          if (!ctx.streamState.has(stateKey)) {
            await this.recordUsage(ctx.routeId || 'unknown', usage);
            ctx.streamState.set(stateKey, true);
          }
        }
      } catch (error) {
        this.logger.debug('Failed to extract tokens from chunk', { error });
      }
    }

    /**
     * 解析 usage 字段（兼容 OpenAI 和 Anthropic 格式）
     * @internal
     */
    parseUsage(data: any): TokenUsage | null {
      if (!data?.usage) return null;

      const usage = data.usage;

      // OpenAI 格式
      if ('prompt_tokens' in usage) {
        return {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
        };
      }

      // Anthropic 格式
      if ('input_tokens' in usage) {
        return {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
        };
      }

      return null;
    }

    /**
     * 记录 Token 使用量（原子操作）
     * @internal
     */
    async recordUsage(routeId: string, usage: TokenUsage): Promise<void> {
      const dateKey = this.getDateKey();
      const hourKey = new Date().getHours().toString().padStart(2, '0');
      const storageKey = `tokens:${routeId}:${dateKey}:${hourKey}`;

      // 原子递增操作
      await Promise.all([
        this.storage.increment(storageKey, 'input_tokens', usage.input_tokens),
        this.storage.increment(storageKey, 'output_tokens', usage.output_tokens),
        this.storage.increment(storageKey, 'requests', 1),
      ]);

      this.logger.debug('Token usage recorded', {
        routeId,
        input: usage.input_tokens,
        output: usage.output_tokens,
      });
    }

    /**
     * 获取日期键（按天聚合）
     * @internal
     */
    getDateKey(): string {
      return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    }

    // ===== API Handlers =====

    /**
     * 获取汇总统计数据
     * GET /api/plugins/token-stats/summary?range=1h|12h|24h
     */
    async getSummary(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const range = url.searchParams.get('range') || '24h';

        const keys = await this.storage.keys('tokens:');
        const cutoffTime = this.getCutoffTime(range);

        let totalInput = 0;
        let totalOutput = 0;
        let totalRequests = 0;
        const routeStats: Record<string, RouteTokenStats> = {};

        for (const key of keys) {
          // 解析 key: tokens:{routeId}:{date}:{hour}
          const parts = key.split(':');
          if (parts.length < 4) continue;

          const [, routeId, date, hour] = parts;
          const keyTime = new Date(`${date}T${hour}:00:00`).getTime();

          if (keyTime < cutoffTime) continue;

          const data = await this.storage.get<{
            input_tokens: number;
            output_tokens: number;
            requests: number;
          }>(key);

          if (data) {
            totalInput += data.input_tokens || 0;
            totalOutput += data.output_tokens || 0;
            totalRequests += data.requests || 0;

            if (!routeStats[routeId]) {
              routeStats[routeId] = {
                routeId,
                input_tokens: 0,
                output_tokens: 0,
                requests: 0,
              };
            }
            routeStats[routeId].input_tokens += data.input_tokens || 0;
            routeStats[routeId].output_tokens += data.output_tokens || 0;
            routeStats[routeId].requests += data.requests || 0;
          }
        }

        const summary: TokenStatsSummary = {
          total_input_tokens: totalInput,
          total_output_tokens: totalOutput,
          total_requests: totalRequests,
          by_route: Object.values(routeStats).sort(
            (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)
          ),
        };

        return new Response(JSON.stringify(summary), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error: any) {
        this.logger.error('Failed to get token stats summary', { error });
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    /**
     * 获取按路由分组的统计数据
     * GET /api/plugins/token-stats/by-route?range=1h|12h|24h
     */
    async getByRoute(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const range = url.searchParams.get('range') || '24h';

        const keys = await this.storage.keys('tokens:');
        const cutoffTime = this.getCutoffTime(range);

        const routeStats: Record<string, RouteTokenStats> = {};

        for (const key of keys) {
          const parts = key.split(':');
          if (parts.length < 4) continue;

          const [, routeId, date, hour] = parts;
          const keyTime = new Date(`${date}T${hour}:00:00`).getTime();

          if (keyTime < cutoffTime) continue;

          const data = await this.storage.get<{
            input_tokens: number;
            output_tokens: number;
            requests: number;
          }>(key);

          if (data) {
            if (!routeStats[routeId]) {
              routeStats[routeId] = {
                routeId,
                input_tokens: 0,
                output_tokens: 0,
                requests: 0,
              };
            }
            routeStats[routeId].input_tokens += data.input_tokens || 0;
            routeStats[routeId].output_tokens += data.output_tokens || 0;
            routeStats[routeId].requests += data.requests || 0;
          }
        }

        const result = Object.values(routeStats).sort(
          (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)
        );

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error: any) {
        this.logger.error('Failed to get token stats by route', { error });
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    /**
     * 根据时间范围获取截止时间
     * @internal
     */
    getCutoffTime(range: string): number {
      const now = Date.now();
      switch (range) {
        case '1h':
          return now - 60 * 60 * 1000;
        case '12h':
          return now - 12 * 60 * 60 * 1000;
        case '24h':
        default:
          return now - 24 * 60 * 60 * 1000;
      }
    }

    /**
     * 插件销毁
     */
    async onDestroy(): Promise<void> {
      this.logger.info('TokenStatsPlugin destroyed');
    }
  }
);

export default TokenStatsPlugin;
