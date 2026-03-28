/**
 * OpenAI to Anthropic Converter
 *
 * 将 OpenAI Chat Completions API 格式转换为 Anthropic Messages API 格式
 *
 * 转换规则：
 * - 请求：/v1/chat/completions → /v1/messages
 * - 请求：messages、tools、reasoning_effort
 * - 响应：Anthropic message → OpenAI chat.completion
 * - 响应：Anthropic SSE → OpenAI SSE
 */

import type { AIConverter, MutableRequestContext, ResponseContext, StreamChunkContext } from './base';
import { AnthropicAdapter } from '../providers/anthropic/anthropic-adapter';
import { LLMSRuntime } from '../runtime/llms-runtime';
import { OpenAIAdapter } from '../providers/openai/openai-adapter';

export class OpenAIToAnthropicConverter implements AIConverter {
  readonly from = 'openai';
  readonly to = 'anthropic';
  private readonly runtime = new LLMSRuntime();

  constructor() {
    this.runtime.registerAdapter(new OpenAIAdapter(), {
      provider: 'openai',
      displayName: 'OpenAI'
    });
    this.runtime.registerAdapter(new AnthropicAdapter(), {
      provider: 'anthropic',
      displayName: 'Anthropic'
    });
  }

  async onBeforeRequest(ctx: MutableRequestContext): Promise<void> {
    const isChatEndpoint = ctx.url.pathname === '/v1/chat/completions';
    const isResponsesEndpoint = ctx.url.pathname === '/v1/responses';
    if (!isChatEndpoint && !isResponsesEndpoint) {
      return;
    }

    const anthropicBody = this.runtime.convertRequest<Record<string, unknown>>(
      'openai',
      'anthropic',
      ctx.body as Record<string, unknown>,
      { pathname: ctx.url.pathname }
    );

    ctx.url.pathname = '/v1/messages';
    ctx.body = anthropicBody;
  }

  async onResponse(ctx: ResponseContext): Promise<Response | void> {
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!this.isJsonLikeContentType(contentType)) {
      return;
    }

    if (!ctx.response.ok) {
      try {
        const responseClone = ctx.response.clone();
        const errorBody = await responseClone.json();
        if (!this.isLikelyAnthropicErrorBody(errorBody)) {
          return ctx.response;
        }
        return this.transformErrorResponse(ctx, errorBody);
      } catch {
        return ctx.response;
      }
    }

    const responseClone = ctx.response.clone();
    const anthropicBody = await responseClone.json();

    const openaiBody = this.convertAnthropicResponseToOpenAI(anthropicBody);

    return new Response(JSON.stringify(openaiBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  private mapAnthropicErrorToOpenAIType(type: unknown, status: number): string {
    if (typeof type === 'string') {
      const normalized = type.toLowerCase();
      if (normalized.includes('invalid_request')) return 'invalid_request_error';
      if (normalized.includes('authentication')) return 'authentication_error';
      if (normalized.includes('permission')) return 'permission_error';
      if (normalized.includes('rate_limit')) return 'rate_limit_error';
      if (normalized.includes('not_found')) return 'not_found_error';
      if (normalized.includes('overloaded') || normalized.includes('unavailable')) return 'server_error';
    }

    if (status === 400) return 'invalid_request_error';
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    if (status === 429) return 'rate_limit_error';
    if (status >= 500) return 'server_error';
    return 'api_error';
  }

  private transformErrorResponse(ctx: ResponseContext, errorBody: any): Response {
    const anthropicError = errorBody?.error || {};
    const mappedType = this.mapAnthropicErrorToOpenAIType(anthropicError.type, ctx.response.status);

    const openaiError = {
      error: {
        message: typeof anthropicError.message === 'string' && anthropicError.message.trim()
          ? anthropicError.message
          : 'Unknown upstream error',
        type: mappedType,
        code: mappedType
      }
    };

    return new Response(JSON.stringify(openaiError), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  private isJsonLikeContentType(contentType: string): boolean {
    const normalized = contentType.toLowerCase();
    return normalized.includes('application/json') || normalized.includes('+json');
  }

  private isLikelyAnthropicErrorBody(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    if (body.type !== 'error') {
      return false;
    }

    const error = body.error;
    return !!error
      && typeof error === 'object'
      && (typeof error.message === 'string' || typeof error.type === 'string');
  }

  private convertAnthropicResponseToOpenAI(anthropicBody: any): any {
    const content = anthropicBody.content || [];
    let textContent = '';
    const toolCalls: any[] = [];
    let thinkingContent = '';

    for (const item of content) {
      if (item.type === 'text') {
        textContent += item.text || '';
      } else if (item.type === 'thinking') {
        thinkingContent += item.thinking || '';
      } else if (item.type === 'tool_use') {
        toolCalls.push({
          id: item.id || '',
          type: 'function',
          function: {
            name: item.name || '',
            arguments: JSON.stringify(item.input || {})
          }
        });
      }
    }

    if (thinkingContent.trim()) {
      textContent = `<thinking>\n${thinkingContent.trim()}\n</thinking>\n\n${textContent}`;
    }

    const message: any = { role: 'assistant' };
    if (toolCalls.length > 0) {
      message.content = textContent || null;
      message.tool_calls = toolCalls;
    } else {
      message.content = textContent;
    }

    const stopReason = anthropicBody.stop_reason;
    let finishReason = 'stop';
    if (stopReason === 'tool_use') finishReason = 'tool_calls';
    else if (stopReason === 'end_turn') finishReason = 'stop';
    else if (stopReason === 'max_tokens') finishReason = 'length';
    else if (stopReason === 'stop_sequence') finishReason = 'stop';

    return {
      id: `chatcmpl-${anthropicBody.id.replace('msg_', '')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: anthropicBody.model,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason
      }],
      usage: {
        prompt_tokens: anthropicBody.usage?.input_tokens || 0,
        completion_tokens: anthropicBody.usage?.output_tokens || 0,
        total_tokens: (anthropicBody.usage?.input_tokens || 0) + (anthropicBody.usage?.output_tokens || 0)
      }
    };
  }

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    const eventType = chunk.type;

    if (!ctx.streamState.has('streamId')) {
      ctx.streamState.set('streamId', crypto.randomUUID());
    }
    const streamId = ctx.streamState.get('streamId') as string;

    if (eventType === 'message_start') {
      const startInputTokens = chunk.message?.usage?.input_tokens;
      const startOutputTokens = chunk.message?.usage?.output_tokens;
      const promptTokens = typeof startInputTokens === 'number' ? startInputTokens : 0;
      const completionTokens = typeof startOutputTokens === 'number' ? startOutputTokens : 0;

      if (promptTokens > 0) {
        ctx.streamState.set('anthropic_input_tokens', promptTokens);
      }

      if (completionTokens > 0) {
        ctx.streamState.set('anthropic_output_tokens', completionTokens);
      }

      return [{
        id: `chatcmpl-${streamId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: chunk.message?.model || 'claude',
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        }
      }];
    }

    if (eventType === 'content_block_start') {
      const contentBlock = chunk.content_block || {};

      if (contentBlock.type === 'tool_use') {
        return [{
          id: `chatcmpl-${streamId}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: chunk.message?.model || 'claude',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: chunk.index || 0,
                id: contentBlock.id || '',
                type: 'function',
                function: { name: contentBlock.name || '' }
              }]
            },
            finish_reason: null
          }]
        }];
      }

      return [];
    }

    if (eventType === 'content_block_delta') {
      const delta = chunk.delta || {};
      const openaiDelta: any = {};

      if (delta.type === 'text_delta') {
        openaiDelta.content = delta.text || '';
      } else if (delta.type === 'thinking_delta') {
        openaiDelta.content = `<thinking>${delta.thinking || ''}</thinking>`;
      } else if (delta.type === 'input_json_delta') {
        openaiDelta.tool_calls = [{
          index: chunk.index || 0,
          function: {
            arguments: delta.partial_json || ''
          }
        }];
      }

      if (Object.keys(openaiDelta).length === 0) {
        return [];
      }

      return [{
        id: `chatcmpl-${streamId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: chunk.message?.model || 'claude',
        choices: [{
          index: 0,
          delta: openaiDelta,
          finish_reason: null
        }]
      }];
    }

    if (eventType === 'message_delta') {
      const stopReason = chunk.delta?.stop_reason;
      let finishReason = 'stop';
      if (stopReason === 'tool_use') finishReason = 'tool_calls';
      else if (stopReason === 'max_tokens') finishReason = 'length';
      else if (stopReason === 'stop_sequence') finishReason = 'stop';

      const topLevelUsage = chunk.usage && typeof chunk.usage === 'object'
        ? chunk.usage
        : undefined;
      const deltaUsage = chunk.delta?.usage && typeof chunk.delta.usage === 'object'
        ? chunk.delta.usage
        : undefined;

      const latestInputFromEvent = typeof topLevelUsage?.input_tokens === 'number'
        ? topLevelUsage.input_tokens
        : undefined;
      const latestOutputFromEvent = typeof topLevelUsage?.output_tokens === 'number'
        ? topLevelUsage.output_tokens
        : typeof deltaUsage?.output_tokens === 'number'
          ? deltaUsage.output_tokens
          : undefined;

      const promptTokens = latestInputFromEvent ?? (ctx.streamState.get('anthropic_input_tokens') as number | undefined) ?? 0;
      const completionTokens = latestOutputFromEvent ?? (ctx.streamState.get('anthropic_output_tokens') as number | undefined) ?? 0;

      if (promptTokens > 0) {
        ctx.streamState.set('anthropic_input_tokens', promptTokens);
      }
      if (completionTokens > 0) {
        ctx.streamState.set('anthropic_output_tokens', completionTokens);
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      };

      return [{
        id: `chatcmpl-${streamId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: chunk.message?.model || 'claude',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: finishReason
        }],
        usage
      }];
    }

    return [];
  }

  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    return [];
  }
}
