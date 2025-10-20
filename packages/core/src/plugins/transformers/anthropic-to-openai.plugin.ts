/**
 * Anthropic to OpenAI Plugin
 *
 * 将 Anthropic Messages API 格式转换为 OpenAI Chat Completions API 格式
 *
 * 按文档 3.1.1 → OpenAI 规范实现：
 * - 请求：/v1/messages → /v1/chat/completions
 * - 请求：system → messages[0] (role=system)
 * - 请求：tool_result → tool role, tool_use → tool_calls
 * - 请求：thinking.budget_tokens → reasoning_effort 推断
 * - 响应：OpenAI → Anthropic (tool_calls, thinking 标签)
 * - 响应：OpenAI SSE → Anthropic SSE 事件序列
 */

import type { Plugin, PluginContext, StreamChunkContext } from '../../plugin.types';

export class AnthropicToOpenAIPlugin implements Plugin {
  name = 'anthropic-to-openai';
  version = '1.0.0';

  /**
   * 修改请求：转换为 OpenAI Chat Completions 格式
   */
  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    // 路径转换
    if (ctx.url.pathname === '/v1/messages/count_tokens') {
      // count_tokens 保持不变（Anthropic 特有端点）
      return;
    }

    if (ctx.url.pathname === '/v1/messages') {
      ctx.url.pathname = '/v1/chat/completions';

      // 构建 OpenAI 请求
      ctx.body = this.buildOpenAIRequest(body);
    }
  }

  /**
   * 构建 OpenAI 请求 - 按文档 3.1.1 实现
   */
  private buildOpenAIRequest(anthropicBody: any): any {
    const openaiBody: any = {};

    // Model
    openaiBody.model = anthropicBody.model || 'gpt-4';

    // Messages
    const messages: any[] = [];

    // 1. System message - 按文档 Line 97
    if (anthropicBody.system) {
      messages.push({
        role: 'system',
        content: anthropicBody.system
      });
    }

    // 2. Convert Anthropic messages - 按文档 Line 98-101
    if (anthropicBody.messages) {
      for (const msg of anthropicBody.messages) {
        if (msg.role === 'user') {
          this.convertUserMessage(msg, messages);
        } else if (msg.role === 'assistant') {
          this.convertAssistantMessage(msg, messages);
        }
      }
    }

    openaiBody.messages = messages;

    // 3. Parameters mapping - 按文档 Line 102
    // 支持旧格式 max_tokens_to_sample
    const maxTokens = anthropicBody.max_tokens || anthropicBody.max_tokens_to_sample;
    if (maxTokens !== undefined) {
      openaiBody.max_tokens = maxTokens;
    }

    if (anthropicBody.temperature !== undefined) {
      openaiBody.temperature = anthropicBody.temperature;
    }

    if (anthropicBody.top_p !== undefined) {
      openaiBody.top_p = anthropicBody.top_p;
    }

    // stop_sequences → stop (数组)
    if (anthropicBody.stop_sequences) {
      openaiBody.stop = anthropicBody.stop_sequences;
    }

    if (anthropicBody.stream !== undefined) {
      openaiBody.stream = anthropicBody.stream;
    }

    // 4. Tools conversion - 按文档 Line 102
    if (anthropicBody.tools) {
      openaiBody.tools = anthropicBody.tools.map((tool: any) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.input_schema || {}
        }
      }));
    }

    // 5. Thinking mode - 按文档 Line 103-105
    if (anthropicBody.thinking && anthropicBody.thinking.type === 'enabled') {
      const budgetTokens = anthropicBody.thinking.budget_tokens;

      if (budgetTokens !== undefined) {
        // 读取阈值环境变量
        const lowThreshold = parseInt(process.env.ANTHROPIC_TO_OPENAI_LOW_REASONING_THRESHOLD || '0');
        const highThreshold = parseInt(process.env.ANTHROPIC_TO_OPENAI_HIGH_REASONING_THRESHOLD || '0');

        // 推断 reasoning_effort
        let effort = 'medium';
        if (budgetTokens < lowThreshold) {
          effort = 'low';
        } else if (budgetTokens >= highThreshold) {
          effort = 'high';
        }

        openaiBody.reasoning_effort = effort;
      }

      // max_completion_tokens - 按文档 Line 105
      const maxCompletionTokens = anthropicBody.max_tokens || process.env.OPENAI_REASONING_MAX_TOKENS;
      if (!maxCompletionTokens) {
        throw new Error('max_tokens or OPENAI_REASONING_MAX_TOKENS required for reasoning mode');
      }
      openaiBody.max_completion_tokens = typeof maxCompletionTokens === 'string'
        ? parseInt(maxCompletionTokens)
        : maxCompletionTokens;
    }

    return openaiBody;
  }

  /**
   * 转换 User 消息 - 按文档 Line 99
   */
  private convertUserMessage(msg: any, messages: any[]): void {
    const content = msg.content;

    // 字符串内容
    if (typeof content === 'string') {
      messages.push({
        role: 'user',
        content
      });
      return;
    }

    // 数组内容
    if (Array.isArray(content)) {
      // 检查是否包含 tool_result - 按文档 Line 99
      const hasToolResult = content.some((block: any) => block.type === 'tool_result');

      if (hasToolResult) {
        // 拆成 tool role 消息
        for (const block of content) {
          if (block.type === 'tool_result') {
            messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id || '',
              content: block.content || ''
            });
          }
        }
      } else {
        // 普通多模态内容
        const openaiContent: any[] = [];

        for (const block of content) {
          if (block.type === 'text') {
            openaiContent.push({
              type: 'text',
              text: block.text || ''
            });
          } else if (block.type === 'image' && block.source) {
            // base64 图片 → data URL
            const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
            openaiContent.push({
              type: 'image_url',
              image_url: { url: dataUrl }
            });
          }
        }

        if (openaiContent.length > 0) {
          messages.push({
            role: 'user',
            content: openaiContent
          });
        }
      }
    }
  }

  /**
   * 转换 Assistant 消息 - 按文档 Line 100
   */
  private convertAssistantMessage(msg: any, messages: any[]): void {
    const content = msg.content;

    // 字符串内容
    if (typeof content === 'string') {
      messages.push({
        role: 'assistant',
        content
      });
      return;
    }

    // 数组内容
    if (Array.isArray(content)) {
      // 检查是否首个块是 tool_use - 按文档 Line 100
      const firstBlock = content[0];
      if (firstBlock && firstBlock.type === 'tool_use') {
        // 转写为 tool_calls
        const toolCalls = content
          .filter((block: any) => block.type === 'tool_use')
          .map((block: any) => ({
            id: block.id || '',
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {})
            }
          }));

        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: toolCalls
        });
      } else {
        // 文本/多模态内容
        let textContent = '';

        for (const block of content) {
          if (block.type === 'text') {
            textContent += block.text || '';
          } else if (block.type === 'thinking') {
            // thinking 块转换为 <thinking> 标签
            textContent += `<thinking>\n${block.thinking || ''}\n</thinking>\n\n`;
          }
        }

        messages.push({
          role: 'assistant',
          content: textContent.trim()
        });
      }
    }
  }

  /**
   * 处理非流式响应 - 按文档 3.2.1 (OpenAI → Anthropic)
   */
  async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!contentType.includes('application/json') || !ctx.response.ok) {
      return;
    }

    const responseClone = ctx.response.clone();
    const openaiBody = await responseClone.json();

    const anthropicBody = this.convertOpenAIResponseToAnthropic(openaiBody);

    return new Response(JSON.stringify(anthropicBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  /**
   * 转换 OpenAI 响应为 Anthropic 格式 - 按文档 Line 118-122
   */
  private convertOpenAIResponseToAnthropic(openaiBody: any): any {
    const choice = openaiBody.choices?.[0];
    if (!choice) {
      return {
        id: `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: openaiBody.model || 'gpt-4',
        stop_reason: 'error',
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      };
    }

    const message = choice.message;
    const content: any[] = [];

    // tool_calls → tool_use - 按文档 Line 119
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id || '',
          name: tc.function?.name || '',
          input: JSON.parse(tc.function?.arguments || '{}')
        });
      }
    } else if (message.content) {
      // 文本与 <thinking> 标签拆分 - 按文档 Line 120
      const textContent = message.content;
      const thinkingRegex = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/g;
      let lastIdx = 0;
      let match;

      while ((match = thinkingRegex.exec(textContent)) !== null) {
        // 前面的文本
        const beforeText = textContent.substring(lastIdx, match.index).trim();
        if (beforeText) {
          content.push({ type: 'text', text: beforeText });
        }

        // thinking 块
        const thinkingText = match[1].trim();
        if (thinkingText) {
          content.push({ type: 'thinking', thinking: thinkingText });
        }

        lastIdx = match.index + match[0].length;
      }

      // 后面的文本
      const afterText = textContent.substring(lastIdx).trim();
      if (afterText) {
        content.push({ type: 'text', text: afterText });
      }

      // 如果没有匹配到任何 thinking，直接添加文本
      if (content.length === 0 && textContent.trim()) {
        content.push({ type: 'text', text: textContent });
      }
    }

    // finish_reason 映射 - 按文档 Line 121
    const finishReason = choice.finish_reason;
    let stopReason = 'end_turn';
    if (finishReason === 'stop') stopReason = 'end_turn';
    else if (finishReason === 'length') stopReason = 'max_tokens';
    else if (finishReason === 'content_filter') stopReason = 'stop_sequence';
    else if (finishReason === 'tool_calls') stopReason = 'tool_use';

    return {
      id: openaiBody.id || `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
      type: 'message',
      role: 'assistant',
      content,
      model: openaiBody.model || 'gpt-4',
      stop_reason: stopReason,
      usage: {
        input_tokens: openaiBody.usage?.prompt_tokens || 0,
        output_tokens: openaiBody.usage?.completion_tokens || 0
      }
    };
  }

  /**
   * 处理流式响应 - 按文档 3.3.1 (OpenAI chunk → Anthropic SSE)
   */
  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    const events: any[] = [];
    const choice = chunk.choices?.[0];

    if (!choice) return [];

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    // 首次接收非空 delta - 发送 message_start - 按文档 Line 131
    if (!ctx.streamState.has('message_started')) {
      if (delta && (delta.content || delta.tool_calls || delta.role)) {
        events.push({
          type: 'message_start',
          message: {
            id: chunk.id || `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: chunk.model || 'gpt-4',
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        ctx.streamState.set('message_started', true);
      }
    }

    // 文本增量 - 按文档 Line 132
    if (delta.content) {
      // 检查是否已发送 content_block_start
      if (!ctx.streamState.has('text_block_started')) {
        events.push({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'text',
            text: ''
          }
        });
        ctx.streamState.set('text_block_started', true);
      }

      events.push({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: delta.content
        }
      });
    }

    // 工具调用增量 - 按文档 Line 133
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index || 0;
        const toolKey = `tool_${index}`;

        // 初始化工具调用缓存
        if (!ctx.streamState.has(toolKey)) {
          ctx.streamState.set(toolKey, {
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: ''
          });

          // 发送 content_block_start
          events.push({
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: tc.id || '',
              name: tc.function?.name || '',
              input: {}
            }
          });
        }

        const toolState = ctx.streamState.get(toolKey) as any;

        // 累积参数
        if (tc.function?.arguments) {
          toolState.arguments += tc.function.arguments;
          ctx.streamState.set(toolKey, toolState);

          events.push({
            type: 'content_block_delta',
            index,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments
            }
          });
        }
      }
    }

    // 完成时 - 按文档 Line 134
    if (finishReason) {
      // 发送 content_block_stop
      if (ctx.streamState.has('text_block_started')) {
        events.push({
          type: 'content_block_stop',
          index: 0
        });
      }

      // 工具调用的 content_block_stop
      const toolKeys = Array.from(ctx.streamState.keys()).filter(k => k.startsWith('tool_'));
      for (let i = 0; i < toolKeys.length; i++) {
        events.push({
          type: 'content_block_stop',
          index: i
        });
      }

      // 转换 finish_reason
      let stopReason = 'end_turn';
      if (finishReason === 'stop') stopReason = 'end_turn';
      else if (finishReason === 'length') stopReason = 'max_tokens';
      else if (finishReason === 'content_filter') stopReason = 'stop_sequence';
      else if (finishReason === 'tool_calls') stopReason = 'tool_use';

      // 发送 message_delta
      const usage = chunk.usage ? {
        output_tokens: chunk.usage.completion_tokens || 0
      } : undefined;

      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          ...(usage && { usage })
        },
        ...(chunk.usage && {
          usage: {
            input_tokens: chunk.usage.prompt_tokens || 0,
            output_tokens: chunk.usage.completion_tokens || 0
          }
        })
      });

      // 发送 message_stop
      events.push({
        type: 'message_stop'
      });

      // 重置状态
      ctx.streamState.clear();
    }

    return events;
  }

  /**
   * flushStream - 确保流结束
   */
  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    // 如果还没有发送 message_stop，发送它
    if (ctx.streamState.has('message_started') && !ctx.streamState.has('flushed')) {
      ctx.streamState.set('flushed', true);
      return [{
        type: 'message_stop'
      }];
    }
    return [];
  }
}

export default AnthropicToOpenAIPlugin;
