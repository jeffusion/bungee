/**
 * OpenAI to Anthropic Plugin
 *
 * 将 OpenAI Chat Completions API 格式转换为 Anthropic Messages API 格式
 *
 * 主要转换：
 * - 请求：/v1/chat/completions → /v1/messages
 * - 请求：messages、tools、reasoning_effort
 * - 响应：Anthropic message → OpenAI chat.completion
 * - 响应：Anthropic SSE → OpenAI SSE
 */

import type { Plugin, PluginContext, StreamChunkContext } from '../../plugin.types';

export class OpenAIToAnthropicPlugin implements Plugin {
  name = 'openai-to-anthropic';
  version = '1.0.0';

  /**
   * 修改请求 URL 和 body，转换为 Anthropic 格式
   */
  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    // 1. 路径转换
    if (ctx.url.pathname === '/v1/chat/completions') {
      ctx.url.pathname = '/v1/messages';
    }

    // 2. 转换 body
    const anthropicBody: any = {};

    // Model
    anthropicBody.model = body.model;

    // Extract system messages (check both body.system and messages array for backward compatibility)
    if (body.system) {
      // System already extracted by transformer rules
      anthropicBody.system = body.system;
    } else if (body.messages) {
      // Extract from messages array
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

      // Validate tool calls - 按文档 3.1.1 Line 101
      // 移除没有收到 Tool 回复的 tool_call，避免 OpenAI API 拒绝
      this.validateAndCleanToolCalls(anthropicBody.messages);
    }

    // Max tokens - 按文档 2.1 Line 39: 若皆缺失则报错
    // Note: Skip this check if using reasoning mode (max_completion_tokens)
    if (body.max_tokens) {
      anthropicBody.max_tokens = body.max_tokens;
    } else if (process.env.ANTHROPIC_MAX_TOKENS) {
      anthropicBody.max_tokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS);
    } else if (!body.max_completion_tokens) {
      // Only throw if not in reasoning mode
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

  /**
   * 验证并清理 tool calls - 按文档 3.1.1 Line 101
   * 移除没有收到 Tool 回复的 tool_call
   */
  private validateAndCleanToolCalls(messages: any[]): void {
    // 收集所有 tool_result 的 tool_use_id
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

    // 清理 assistant 消息中没有匹配的 tool_use
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content = msg.content.filter((block: any) => {
          if (block.type === 'tool_use') {
            // 只保留有对应 tool_result 的 tool_use
            return toolResultIds.has(block.id);
          }
          return true;
        });
      }
    }
  }

  /**
   * 转换 OpenAI messages 为 Anthropic messages
   * 支持合并连续的 tool 消息为单个 user 消息
   */
  private convertMessages(messages: any[]): any[] {
    const anthropicMessages: any[] = [];
    const filtered = messages.filter((m: any) => m.role !== 'system');

    let i = 0;
    while (i < filtered.length) {
      const msg = filtered[i];
      const role = msg.role;

      // 检查是否是连续的 tool 消息，需要合并
      if (role === 'tool') {
        const toolResults: any[] = [];

        // 收集所有连续的 tool 消息
        while (i < filtered.length && filtered[i].role === 'tool') {
          const toolMsg = filtered[i];
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMsg.tool_call_id || '',
            content: String(toolMsg.content || '')
          });
          i++;
        }

        // 合并为单个 user 消息
        if (toolResults.length > 0) {
          anthropicMessages.push({
            role: 'user',
            content: toolResults
          });
        }
        continue; // i 已经在内部循环中递增了
      }

      // 处理其他角色的消息
      i++;

      if (role === 'user') {
        const content = msg.content;

        if (typeof content === 'string') {
          const textContent = content.trim();
          if (!textContent) continue;

          // Extract <thinking> tags
          const thinkingMatch = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/g;
          let match;
          let lastIdx = 0;
          const blocks: any[] = [];

          while ((match = thinkingMatch.exec(content)) !== null) {
            const beforeText = content.substring(lastIdx, match.index).trim();
            if (beforeText) {
              blocks.push({ type: 'text', text: beforeText });
            }

            const thinkingText = match[1].trim();
            if (thinkingText) {
              blocks.push({ type: 'thinking', thinking: thinkingText });
            }

            lastIdx = match.index + match[0].length;
          }

          const afterText = content.substring(lastIdx).trim();
          if (afterText) {
            blocks.push({ type: 'text', text: afterText });
          }

          // Construct message
          if (blocks.length === 0) {
            anthropicMessages.push({ role: 'user', content: textContent });
          } else if (blocks.length === 1 && blocks[0].type === 'text') {
            anthropicMessages.push({ role: 'user', content: blocks[0].text });
          } else {
            anthropicMessages.push({ role: 'user', content: blocks });
          }
        } else if (Array.isArray(content)) {
          // Multimodal content
          // 按文档 2.1 Line 35: 多模态内容需保证图片在文本之前
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

          // 1. Process images first (图片在前)
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

          // 2. Then process texts (文本在后)
          for (const txt of texts) {
            const textContent = txt.text || '';
            if (textContent.trim()) {
              anthropicContent.push({ type: 'text', text: textContent });
            }
          }

          // 3. Other content types at the end
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
          // Convert tool calls
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
      // Note: tool role 消息已在循环开始时统一处理（支持合并）
    }

    return anthropicMessages;
  }

  /**
   * 处理非流式响应
   */
  async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
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

  /**
   * 转换 Anthropic 响应为 OpenAI 格式
   */
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

    // Wrap thinking content
    if (thinkingContent.trim()) {
      textContent = `<thinking>\n${thinkingContent.trim()}\n</thinking>\n\n${textContent}`;
    }

    // Build message
    const message: any = { role: 'assistant' };
    if (toolCalls.length > 0) {
      message.content = textContent || null;
      message.tool_calls = toolCalls;
    } else {
      message.content = textContent;
    }

    // Convert stop_reason
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

  /**
   * 处理流式响应
   * Anthropic SSE → OpenAI SSE
   */
  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    const eventType = chunk.type;

    // 初始化 streamId
    if (!ctx.streamState.has('streamId')) {
      ctx.streamState.set('streamId', crypto.randomUUID());
    }
    const streamId = ctx.streamState.get('streamId') as string;

    // message_start: 发送第一个 chunk
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

    // content_block_start: 处理 tool_use 开始
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

    // content_block_delta: 处理增量内容
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

    // message_delta: 发送结束事件
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

    // Skip other events
    return [];
  }

  /**
   * flushStream - 此 transformer 不需要缓冲，返回空数组
   */
  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    return [];
  }
}

export default OpenAIToAnthropicPlugin;
