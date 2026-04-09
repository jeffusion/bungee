/**
 * Token 统计插件 - 服务端逻辑 (v2.0)
 *
 * 重构版本，采用混合统计策略：
 * 1. 多格式 usage 解析（OpenAI/Anthropic/Gemini）
 * 2. 本地 tokenizer 兜底计算
 *
 * 功能：
 * - 从 AI 请求/响应中统计 Token 使用量
 * - 按路由和上游分类统计
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
  MutableRequestContext,
  ResponseContext,
  StreamChunkContext,
} from '../../../packages/core/src/hooks';
import { countInputTokens, countOutputTokens } from './tokenizer';

/**
 * Token 使用量数据结构
 */
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Token 统计来源
 */
type TokenSource = 'api' | 'calculated' | 'hybrid';

/**
 * 扩展的 Token 使用量（带来源标记）
 */
interface ExtendedTokenUsage extends TokenUsage {
  source: TokenSource;
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
 * 按 Upstream 统计的 Token 数据
 */
interface UpstreamTokenStats {
  upstreamId: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

/**
 * 通用维度统计数据
 */
interface DimensionTokenStats {
  dimension: string;
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
  by_upstream: UpstreamTokenStats[];
}

/**
 * 聚合维度类型
 */
type GroupByDimension = 'route' | 'upstream' | 'all';

/**
 * 请求阶段状态（用于跨阶段传递）
 */
interface RequestState {
  inputTokens: number;
  model: string;
  timestamp: number;
}

/**
 * 全局请求状态存储
 * 基于 requestId 跟踪每个请求的状态
 */
const requestStateMap = new Map<string, RequestState>();

/**
 * 清理过期的请求状态（5分钟过期）
 */
const STATE_TTL_MS = 5 * 60 * 1000;
let lastCleanupTime = Date.now();

function cleanupExpiredStates(): void {
  const now = Date.now();
  if (now - lastCleanupTime < 60000) return; // 每分钟最多清理一次

  lastCleanupTime = now;
  for (const [requestId, state] of requestStateMap.entries()) {
    if (now - state.timestamp > STATE_TTL_MS) {
      requestStateMap.delete(requestId);
    }
  }
}

/**
 * 流式状态键
 */
const STATE_KEYS = {
  OUTPUT_BUFFER: 'token-stats:output_buffer',
  RECORDED: 'token-stats:recorded',
  /** Anthropic message_start 提供的 input_tokens */
  API_INPUT_TOKENS: 'token-stats:api_input_tokens',
} as const;

export const TokenStatsPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'token-stats';
    static readonly version = '1.0.0';

    /** @internal */
    storage!: PluginStorage;
    /** @internal */
    logger!: PluginLogger;
    /** AI Provider（上游实际使用的提供商） */
    private provider: 'auto' | 'openai' | 'anthropic' | 'gemini';

    /**
     * 构造函数
     */
    constructor(options?: { provider?: string }) {
      this.provider = (options?.provider as any) || 'auto';
    }

    /**
     * 插件初始化
     */
    async init(context: PluginInitContext): Promise<void> {
      this.storage = context.storage;
      this.logger = context.logger;
      this.logger.info(`TokenStatsPlugin v2.0 initialized (provider: ${this.provider})`);
    }

    /**
     * 注册 Hooks
     */
    register(hooks: PluginHooks): void {
      // 1. 请求阶段：注入 stream_options，计算输入 tokens
      hooks.onBeforeRequest.tapPromise(
        { name: 'token-stats', stage: 10 }, // 早期执行
        async (ctx) => {
          await this.handleRequest(ctx);
          return ctx;
        }
      );

      // 2. 非流式响应处理（在 ai-transformer 之前执行，确保看到上游格式）
      hooks.onResponse.tapPromise(
        { name: 'token-stats', stage: -10 },
        async (response, ctx) => {
          await this.handleResponse(response, ctx);
          return response;
        }
      );

      // 3. 流式响应处理（在 ai-transformer 之前执行，确保看到上游格式）
      hooks.onStreamChunk.tapPromise(
        { name: 'token-stats', stage: -10 },
        async (chunk, ctx) => {
          await this.handleStreamChunk(chunk, ctx);
          return null;
        }
      );
    }

    /**
     * 处理请求：计算输入 tokens
     */
    async handleRequest(ctx: MutableRequestContext): Promise<void> {
      const body = ctx.body as any;
      if (!body) return;

      try {
        // 定期清理过期状态
        cleanupExpiredStates();

        const model = body.model || 'gpt-4';
        const inputTokens = countInputTokens(body, model);

        requestStateMap.set(ctx.requestId, {
          inputTokens,
          model,
          timestamp: Date.now(),
        });

        this.logger.debug('Input tokens calculated', {
          routeId: ctx.routeId,
          requestId: ctx.requestId,
          model,
          inputTokens,
          source: 'calculated',
        });
      } catch (error) {
        this.logger.debug('Failed to process request', { error });
      }
    }

    /**
     * 处理非流式响应
     */
    async handleResponse(response: Response, ctx: ResponseContext): Promise<void> {
      try {
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) return;

        const cloned = response.clone();
        const body = await cloned.json();

        // 1. 尝试从响应中提取 usage
        const apiUsage = this.parseUsage(body);

        // 2. 获取请求阶段保存的状态
        const requestState = requestStateMap.get(ctx.requestId);
        const calculatedInput = requestState?.inputTokens || 0;
        const model = requestState?.model || 'gpt-4';

        // 3. 确定最终 usage
        let finalUsage: ExtendedTokenUsage;

        if (apiUsage) {
          // API 返回了 usage
          finalUsage = {
            input_tokens: apiUsage.input_tokens || calculatedInput,
            output_tokens: apiUsage.output_tokens,
            source: apiUsage.input_tokens ? 'api' : 'hybrid',
          };
        } else {
          // API 没有返回 usage，使用计算值
          const outputContent = this.extractOutputContent(body);
          const outputTokens = countOutputTokens(outputContent, model);

          finalUsage = {
            input_tokens: calculatedInput,
            output_tokens: outputTokens,
            source: 'calculated',
          };
        }

        // 4. 记录 usage
        await this.recordUsage(
          ctx.routeId || 'unknown',
          ctx.upstreamId || 'unknown',
          finalUsage
        );

        // 5. 清理请求状态
        requestStateMap.delete(ctx.requestId);
      } catch (error) {
        this.logger.debug('Failed to process response', { error });
      }
    }

    /**
     * 处理流式响应
     *
     * 处理策略：
     * - OpenAI: 最后一个 chunk 带完整 usage
     * - Anthropic: message_start 带 input_tokens，message_delta 带 output_tokens
     * - Gemini: 最后一个 chunk 带 usageMetadata
     */
    async handleStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<void> {
      try {
        // 已经记录过则跳过
        if (ctx.streamState.has(STATE_KEYS.RECORDED)) {
          return;
        }

        // 1. 尝试从 chunk 中提取 usage
        const apiUsage = this.parseUsage(chunk);

        if (apiUsage) {
          // Anthropic message_start: 只有 input_tokens，暂存
          if (chunk.type === 'message_start' && apiUsage.input_tokens > 0 && apiUsage.output_tokens === 0) {
            ctx.streamState.set(STATE_KEYS.API_INPUT_TOKENS, apiUsage.input_tokens);
            this.logger.debug('Anthropic message_start: stored input_tokens', {
              requestId: ctx.requestId,
              inputTokens: apiUsage.input_tokens,
            });
            return;
          }

          // Anthropic message_delta 或其他格式的完整 usage
          const storedInputTokens = ctx.streamState.get(STATE_KEYS.API_INPUT_TOKENS) as number | undefined;
          const requestState = requestStateMap.get(ctx.requestId);
          const calculatedInput = requestState?.inputTokens || 0;

          // 优先级：API 返回 > 暂存的 message_start > 本地计算
          const finalInputTokens = apiUsage.input_tokens || storedInputTokens || calculatedInput;

          const finalUsage: ExtendedTokenUsage = {
            input_tokens: finalInputTokens,
            output_tokens: apiUsage.output_tokens,
            source: (apiUsage.input_tokens || storedInputTokens) ? 'api' : 'hybrid',
          };

          await this.recordUsage(
            ctx.routeId || 'unknown',
            ctx.upstreamId || 'unknown',
            finalUsage
          );
          ctx.streamState.set(STATE_KEYS.RECORDED, true);

          // 清理请求状态
          requestStateMap.delete(ctx.requestId);

          this.logger.debug('Stream usage recorded from API', {
            requestId: ctx.requestId,
            chunkType: chunk.type,
            input: finalUsage.input_tokens,
            output: finalUsage.output_tokens,
            source: finalUsage.source,
          });
          return;
        }

        // 2. 没有 usage，累积输出内容
        const content = this.extractChunkContent(chunk);
        if (content) {
          const buffer = ctx.streamState.get(STATE_KEYS.OUTPUT_BUFFER) as string || '';
          ctx.streamState.set(STATE_KEYS.OUTPUT_BUFFER, buffer + content);
        }

        // 3. 检测流结束（没有 usage 的情况）
        if (this.isStreamEnd(chunk)) {
          // 使用本地计算或之前暂存的 API input_tokens
          const storedInputTokens = ctx.streamState.get(STATE_KEYS.API_INPUT_TOKENS) as number | undefined;
          const requestState = requestStateMap.get(ctx.requestId);
          const calculatedInput = requestState?.inputTokens || 0;
          const model = requestState?.model || 'gpt-4';
          const outputBuffer = ctx.streamState.get(STATE_KEYS.OUTPUT_BUFFER) as string || '';
          const outputTokens = countOutputTokens(outputBuffer, model);

          const finalUsage: ExtendedTokenUsage = {
            input_tokens: storedInputTokens || calculatedInput,
            output_tokens: outputTokens,
            source: storedInputTokens ? 'hybrid' : 'calculated',
          };

          await this.recordUsage(
            ctx.routeId || 'unknown',
            ctx.upstreamId || 'unknown',
            finalUsage
          );
          ctx.streamState.set(STATE_KEYS.RECORDED, true);

          // 清理请求状态
          requestStateMap.delete(ctx.requestId);

          this.logger.debug('Stream ended, calculated output tokens', {
            requestId: ctx.requestId,
            outputTokens,
            bufferLength: outputBuffer.length,
          });
        }
      } catch (error) {
        this.logger.debug('Failed to process stream chunk', { error });
      }
    }

    /**
     * 解析 usage 字段（支持多格式）
     *
     * 支持格式：
     * - OpenAI: { usage: { prompt_tokens, completion_tokens } }
     * - Anthropic 非流式: { usage: { input_tokens, output_tokens } }
     * - Anthropic 流式 message_start: { message: { usage: { input_tokens } } }
     * - Anthropic 流式 message_delta: { usage: { output_tokens } }
     * - Gemini: { usageMetadata: { promptTokenCount, candidatesTokenCount } }
     */
    parseUsage(data: any): TokenUsage | null {
      if (!data) return null;

      // 1. OpenAI 格式: { usage: { prompt_tokens, completion_tokens } }
      if (data.usage) {
        const usage = data.usage;

        // OpenAI 格式
        if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
          return {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
          };
        }

        // Anthropic 格式（非流式或 message_delta）
        if ('input_tokens' in usage || 'output_tokens' in usage) {
          return {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          };
        }
      }

      // 2. Gemini 格式: { usageMetadata: { promptTokenCount, candidatesTokenCount } }
      if (data.usageMetadata) {
        const meta = data.usageMetadata;
        return {
          input_tokens: meta.promptTokenCount || 0,
          output_tokens: meta.candidatesTokenCount || 0,
        };
      }

      // 3. Anthropic 流式 message_start 事件（包含 input_tokens）
      // { type: 'message_start', message: { usage: { input_tokens: N } } }
      if (data.type === 'message_start' && data.message?.usage) {
        return {
          input_tokens: data.message.usage.input_tokens || 0,
          output_tokens: 0, // message_start 不包含 output_tokens
        };
      }

      // 4. Anthropic 流式 message_delta 事件（包含 output_tokens）
      // { type: 'message_delta', usage: { output_tokens: N } }
      if (data.type === 'message_delta' && data.usage) {
        return {
          input_tokens: 0, // message_delta 不包含 input_tokens
          output_tokens: data.usage.output_tokens || 0,
        };
      }

      return null;
    }

    /**
     * 从非流式响应中提取输出内容
     */
    private extractOutputContent(body: any): string {
      // OpenAI 格式
      if (body.choices?.[0]?.message?.content) {
        return body.choices[0].message.content;
      }

      // Anthropic 格式
      if (body.content) {
        if (typeof body.content === 'string') {
          return body.content;
        }
        if (Array.isArray(body.content)) {
          return body.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text || '')
            .join('');
        }
      }

      // Gemini 格式
      if (body.candidates?.[0]?.content?.parts) {
        return body.candidates[0].content.parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('');
      }

      return '';
    }

    /**
     * 从流式 chunk 中提取文本内容
     */
    private extractChunkContent(chunk: any): string {
      // OpenAI 格式
      if (chunk.choices?.[0]?.delta?.content) {
        return chunk.choices[0].delta.content;
      }

      // Anthropic content_block_delta
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        return chunk.delta.text || '';
      }

      // Gemini 格式
      if (chunk.candidates?.[0]?.content?.parts) {
        return chunk.candidates[0].content.parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('');
      }

      return '';
    }

    /**
     * 检测流是否结束
     */
    private isStreamEnd(chunk: any): boolean {
      // OpenAI: finish_reason 不为 null
      if (chunk.choices?.[0]?.finish_reason) {
        return true;
      }

      // Anthropic: message_stop 事件
      if (chunk.type === 'message_stop') {
        return true;
      }

      // Gemini: finishReason 存在
      if (chunk.candidates?.[0]?.finishReason) {
        return true;
      }

      return false;
    }

    /**
     * 记录 Token 使用量
     *
     * 键格式（使用 # 分隔符避免与 URL 协议冲突）：
     * - tokens#${routeId}#${date}#${hour}
     * - tokens#upstream#${upstreamId}#${date}#${hour}
     * - tokens#detail#${routeId}#${upstreamId}#${date}#${hour}
     */
    async recordUsage(
      routeId: string,
      upstreamId: string,
      usage: ExtendedTokenUsage
    ): Promise<void> {
      const dateKey = this.getDateKey();
      const hourKey = new Date().getHours().toString().padStart(2, '0');

      // 三种存储键（使用 # 分隔符）
      const routeKey = `tokens#${routeId}#${dateKey}#${hourKey}`;
      const upstreamKey = `tokens#upstream#${upstreamId}#${dateKey}#${hourKey}`;
      const detailKey = `tokens#detail#${routeId}#${upstreamId}#${dateKey}#${hourKey}`;

      // 原子递增操作
      await Promise.all([
        // 按路由聚合
        this.storage.increment(routeKey, 'input_tokens', usage.input_tokens),
        this.storage.increment(routeKey, 'output_tokens', usage.output_tokens),
        this.storage.increment(routeKey, 'requests', 1),
        // 按 upstream 聚合
        this.storage.increment(upstreamKey, 'input_tokens', usage.input_tokens),
        this.storage.increment(upstreamKey, 'output_tokens', usage.output_tokens),
        this.storage.increment(upstreamKey, 'requests', 1),
        // 细粒度数据
        this.storage.increment(detailKey, 'input_tokens', usage.input_tokens),
        this.storage.increment(detailKey, 'output_tokens', usage.output_tokens),
        this.storage.increment(detailKey, 'requests', 1),
      ]);

      this.logger.debug('Token usage recorded', {
        routeId,
        upstreamId,
        input: usage.input_tokens,
        output: usage.output_tokens,
        source: usage.source,
      });
    }

    /**
     * 获取日期键
     */
    getDateKey(): string {
      return new Date().toISOString().split('T')[0];
    }

    // ===== API Handlers =====

    /**
     * 获取汇总统计数据
     */
    async getSummary(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const range = url.searchParams.get('range') || '24h';

        const keys = await this.storage.keys('tokens#');
        const cutoffTime = this.getCutoffTime(range);

        let totalInput = 0;
        let totalOutput = 0;
        let totalRequests = 0;
        const routeStats: Record<string, RouteTokenStats> = {};
        const upstreamStats: Record<string, UpstreamTokenStats> = {};

        for (const key of keys) {
          const parts = key.split('#');

          if (parts[1] === 'detail') continue;

          if (parts[1] === 'upstream') {
            if (parts.length !== 5) continue;
            const [, , upstreamId, date, hour] = parts;
            const keyTime = new Date(`${date}T${hour}:00:00`).getTime();
            if (keyTime < cutoffTime) continue;

            const data = await this.storage.get<{
              input_tokens: number;
              output_tokens: number;
              requests: number;
            }>(key);

            if (data) {
              if (!upstreamStats[upstreamId]) {
                upstreamStats[upstreamId] = {
                  upstreamId,
                  input_tokens: 0,
                  output_tokens: 0,
                  requests: 0,
                };
              }
              upstreamStats[upstreamId].input_tokens += data.input_tokens || 0;
              upstreamStats[upstreamId].output_tokens += data.output_tokens || 0;
              upstreamStats[upstreamId].requests += data.requests || 0;
            }
            continue;
          }

          if (parts.length !== 4) continue;
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

        const sortByTotal = (a: { input_tokens: number; output_tokens: number }, b: { input_tokens: number; output_tokens: number }) =>
          b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens);

        const summary: TokenStatsSummary = {
          total_input_tokens: totalInput,
          total_output_tokens: totalOutput,
          total_requests: totalRequests,
          by_route: Object.values(routeStats).sort(sortByTotal),
          by_upstream: Object.values(upstreamStats).sort(sortByTotal),
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
     */
    async getByRoute(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const range = url.searchParams.get('range') || '24h';

        const keys = await this.storage.keys('tokens#');
        const cutoffTime = this.getCutoffTime(range);

        const routeStats: Record<string, RouteTokenStats> = {};

        for (const key of keys) {
          const parts = key.split('#');

          if (parts[1] === 'upstream' || parts[1] === 'detail') continue;
          if (parts.length !== 4) continue;

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
     * 获取按 Upstream 分组的统计数据
     */
    async getByUpstream(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const range = url.searchParams.get('range') || '24h';

        const keys = await this.storage.keys('tokens#upstream#');
        const cutoffTime = this.getCutoffTime(range);

        const upstreamStats: Record<string, UpstreamTokenStats> = {};

        for (const key of keys) {
          const parts = key.split('#');
          if (parts.length !== 5) continue;

          const [, , upstreamId, date, hour] = parts;
          const keyTime = new Date(`${date}T${hour}:00:00`).getTime();

          if (keyTime < cutoffTime) continue;

          const data = await this.storage.get<{
            input_tokens: number;
            output_tokens: number;
            requests: number;
          }>(key);

          if (data) {
            if (!upstreamStats[upstreamId]) {
              upstreamStats[upstreamId] = {
                upstreamId,
                input_tokens: 0,
                output_tokens: 0,
                requests: 0,
              };
            }
            upstreamStats[upstreamId].input_tokens += data.input_tokens || 0;
            upstreamStats[upstreamId].output_tokens += data.output_tokens || 0;
            upstreamStats[upstreamId].requests += data.requests || 0;
          }
        }

        const result = Object.values(upstreamStats).sort(
          (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)
        );

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error: any) {
        this.logger.error('Failed to get token stats by upstream', { error });
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    /**
     * 统一统计查询接口
     */
    async getStats(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const range = url.searchParams.get('range') || '24h';
        const groupBy = (url.searchParams.get('groupBy') || 'all') as GroupByDimension;

        const cutoffTime = this.getCutoffTime(range);

        if (groupBy === 'route') {
          const keys = await this.storage.keys('tokens#');
          const routeStats: Record<string, DimensionTokenStats> = {};
          let totalInput = 0;
          let totalOutput = 0;
          let totalRequests = 0;

          for (const key of keys) {
            const parts = key.split('#');
            if (parts[1] === 'upstream' || parts[1] === 'detail') continue;
            if (parts.length !== 4) continue;

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
                  dimension: routeId,
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

          return new Response(JSON.stringify({
            groupBy: 'route',
            total_input_tokens: totalInput,
            total_output_tokens: totalOutput,
            total_requests: totalRequests,
            data: Object.values(routeStats).sort(
              (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)
            ),
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (groupBy === 'upstream') {
          const keys = await this.storage.keys('tokens#upstream#');
          const upstreamStats: Record<string, DimensionTokenStats> = {};
          let totalInput = 0;
          let totalOutput = 0;
          let totalRequests = 0;

          for (const key of keys) {
            const parts = key.split('#');
            if (parts.length !== 5) continue;

            const [, , upstreamId, date, hour] = parts;
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

              if (!upstreamStats[upstreamId]) {
                upstreamStats[upstreamId] = {
                  dimension: upstreamId,
                  input_tokens: 0,
                  output_tokens: 0,
                  requests: 0,
                };
              }
              upstreamStats[upstreamId].input_tokens += data.input_tokens || 0;
              upstreamStats[upstreamId].output_tokens += data.output_tokens || 0;
              upstreamStats[upstreamId].requests += data.requests || 0;
            }
          }

          return new Response(JSON.stringify({
            groupBy: 'upstream',
            total_input_tokens: totalInput,
            total_output_tokens: totalOutput,
            total_requests: totalRequests,
            data: Object.values(upstreamStats).sort(
              (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)
            ),
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // groupBy === 'all'
        const keys = await this.storage.keys('tokens#');
        let totalInput = 0;
        let totalOutput = 0;
        let totalRequests = 0;

        for (const key of keys) {
          const parts = key.split('#');
          if (parts[1] === 'upstream' || parts[1] === 'detail') continue;
          if (parts.length !== 4) continue;

          const [, , date, hour] = parts;
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
          }
        }

        return new Response(JSON.stringify({
          groupBy: 'all',
          total_input_tokens: totalInput,
          total_output_tokens: totalOutput,
          total_requests: totalRequests,
          data: [],
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error: any) {
        this.logger.error('Failed to get token stats', { error });
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    /**
     * 根据时间范围获取截止时间
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
