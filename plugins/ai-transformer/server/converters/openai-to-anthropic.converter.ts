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

import type { AIConverter } from './base';
import type { MutableRequestContext, ResponseContext, StreamChunkContext } from '../../../../packages/core/src/hooks';
import { generateOpenAIChatCompletionId, parseThinkingTags } from './utils';

export class OpenAIToAnthropicConverter implements AIConverter {
  readonly from = 'openai';
  readonly to = 'anthropic';

  async onBeforeRequest(ctx: MutableRequestContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    // 路径转换
    if (ctx.url.pathname === '/v1/chat/completions') {
      ctx.url.pathname = '/v1/messages';
    }

    // 转换 body
    const anthropicBody: any = {};

    // Model
    anthropicBody.model = body.model;

    // Extract system messages
    if (body.system) {
      anthropicBody.system = body.system;
    } else if (body.messages) {
      const systemMessages = body.messages
        .filter((m: any) => m.role === 'system')
        .map((m: any) => m.content);

      if (systemMessages.length > 0) {
        anthropicBody.system = systemMessages.join('\n');
      }
    }

    // Convert non-system messages
    if (body.messages) {
      anthropicBody.messages = this.convertMessages(body.messages);
      this.validateAndCleanToolCalls(anthropicBody.messages);
    }

    // Max tokens
    if (body.max_tokens) {
      anthropicBody.max_tokens = body.max_tokens;
    } else if (process.env.ANTHROPIC_MAX_TOKENS) {
      anthropicBody.max_tokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS);
    } else if (!body.max_completion_tokens) {
      throw new Error('max_tokens is required. Provide it in request or set ANTHROPIC_MAX_TOKENS environment variable');
    }

    // Other parameters
    if (body.temperature !== undefined) {
      anthropicBody.temperature = body.temperature;
    }

    if (body.top_p !== undefined) {
      anthropicBody.top_p = body.top_p;
    }

    // Stop sequences
    if (body.stop) {
      anthropicBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    }

    // Stream
    if (body.stream !== undefined) {
      anthropicBody.stream = body.stream;
    }

    // Tools conversion
    if (body.tools) {
      anthropicBody.tools = body.tools
        .filter((t: any) => t.type === 'function' && t.function)
        .map((t: any) => ({
          name: t.function.name || '',
          description: t.function.description || '',
          input_schema: t.function.parameters || {}
        }));
    }

    // Thinking budget conversion for reasoning models
    if (body.max_completion_tokens) {
      const effort = body.reasoning_effort || 'medium';
      const envKey = `OPENAI_${effort.toUpperCase()}_TO_ANTHROPIC_TOKENS`;
      const tokens = process.env[envKey];

      if (!tokens) {
        throw new Error(`Environment variable ${envKey} not configured for reasoning_effort conversion`);
      }

      const thinkingBudget = parseInt(tokens);
      if (isNaN(thinkingBudget)) {
        throw new Error(`Invalid ${envKey} value: must be integer`);
      }

      anthropicBody.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget
      };
    }

    ctx.body = anthropicBody;
  }

  private validateAndCleanToolCalls(messages: any[]): void {
    const toolResultIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }
    }

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content = msg.content.filter((block: any) => {
          if (block.type === 'tool_use') {
            return toolResultIds.has(block.id);
          }
          return true;
        });
      }
    }
  }

  private convertMessages(messages: any[]): any[] {
    const anthropicMessages: any[] = [];
    const filtered = messages.filter((m: any) => m.role !== 'system');

    let i = 0;
    while (i < filtered.length) {
      const msg = filtered[i];
      const role = msg.role;

      // Merge consecutive tool messages
      if (role === 'tool') {
        const toolResults: any[] = [];

        while (i < filtered.length && filtered[i].role === 'tool') {
          const toolMsg = filtered[i];
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMsg.tool_call_id || '',
            content: String(toolMsg.content || '')
          });
          i++;
        }

        if (toolResults.length > 0) {
          anthropicMessages.push({
            role: 'user',
            content: toolResults
          });
        }
        continue;
      }

      i++;

      if (role === 'user') {
        const content = msg.content;

        if (typeof content === 'string') {
          const textContent = content.trim();
          if (!textContent) continue;

          const blocks = parseThinkingTags(content);

          if (blocks.length === 0) {
            anthropicMessages.push({ role: 'user', content: textContent });
          } else if (blocks.length === 1 && blocks[0].type === 'text') {
            anthropicMessages.push({ role: 'user', content: blocks[0].text });
          } else {
            anthropicMessages.push({ role: 'user', content: blocks });
          }
        } else if (Array.isArray(content)) {
          const images: any[] = [];
          const texts: any[] = [];
          const others: any[] = [];

          for (const item of content) {
            if (item.type === 'image_url') {
              images.push(item);
            } else if (item.type === 'text') {
              texts.push(item);
            } else {
              others.push(item);
            }
          }

          const anthropicContent: any[] = [];

          for (const img of images) {
            const url = img.image_url?.url || '';
            if (url.startsWith('data:')) {
              const parts = url.split(';base64,');
              if (parts.length === 2) {
                const mediaType = parts[0].replace('data:', '');
                anthropicContent.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: parts[1]
                  }
                });
              }
            }
          }

          for (const txt of texts) {
            const textContent = txt.text || '';
            if (textContent.trim()) {
              anthropicContent.push({ type: 'text', text: textContent });
            }
          }

          anthropicContent.push(...others);

          if (anthropicContent.length > 0) {
            if (anthropicContent.length === 1 && anthropicContent[0].type === 'text') {
              anthropicMessages.push({ role: 'user', content: anthropicContent[0].text });
            } else {
              anthropicMessages.push({ role: 'user', content: anthropicContent });
            }
          }
        }
      } else if (role === 'assistant') {
        if (msg.tool_calls) {
          const content: any[] = [];

          for (const tc of msg.tool_calls) {
            if (tc.type === 'function' && tc.function) {
              const argsStr = tc.function.arguments || '{}';
              let argsObj = {};

              try {
                argsObj = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
              } catch (e) {
                // Ignore parse error
              }

              content.push({
                type: 'tool_use',
                id: tc.id || '',
                name: tc.function.name || '',
                input: argsObj
              });
            }
          }

          if (content.length > 0) {
            anthropicMessages.push({ role: 'assistant', content });
          }
        } else {
          const content = msg.content || '';
          if (content.trim()) {
            anthropicMessages.push({ role: 'assistant', content });
          }
        }
      }
    }

    return anthropicMessages;
  }

  async onResponse(ctx: ResponseContext): Promise<Response | void> {
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!contentType.includes('application/json') || !ctx.response.ok) {
      return;
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
      return [{
        id: `chatcmpl-${streamId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: chunk.message?.model || 'claude',
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null
        }]
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

      const usage = chunk.usage ? {
        prompt_tokens: chunk.usage.input_tokens || 0,
        completion_tokens: chunk.delta?.usage?.output_tokens || 0,
        total_tokens: (chunk.usage.input_tokens || 0) + (chunk.delta?.usage?.output_tokens || 0)
      } : undefined;

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
        ...(usage && { usage })
      }];
    }

    return [];
  }

  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    return [];
  }
}
