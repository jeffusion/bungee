/**
 * Gemini to Anthropic Plugin
 *
 * 将 Google Gemini API 格式转换为 Anthropic Messages API 格式
 *
 * 主要转换：
 * - 请求：/v1beta/models/{model}:generateContent → /v1/messages
 * - 请求：contents → messages (role: model → assistant, tool → user)
 * - 请求：systemInstruction → system
 * - 请求：functionDeclarations → tools
 * - 响应：Anthropic 格式 → Gemini candidates 格式
 * - 响应：Anthropic 增量 SSE → Gemini 累积 SSE
 */

import type { AIConverter, MutableRequestContext, ResponseContext, StreamChunkContext } from './base';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args: any;
  };
  functionResponse?: {
    name: string;
    response: any;
  };
}

interface GeminiContent {
  role: 'user' | 'model' | 'tool';
  parts: GeminiPart[];
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{
    type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking';
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: any;
    tool_use_id?: string;
    content?: string;
    source?: {
      type: 'base64';
      media_type: string;
      data: string;
    };
  }>;
}

export class GeminiToAnthropicConverter implements AIConverter {
  readonly from = 'gemini';
  readonly to = 'anthropic';

  private parseGeminiEndpoint(pathname: string): { model?: string; isStreaming: boolean } | null {
    const withModelMatch = pathname.match(/^\/v1(?:beta)?\/models\/([^/]+?)(?::|\/)(generateContent|streamGenerateContent)$/);
    if (withModelMatch) {
      const rawModel = withModelMatch[1];
      const endpoint = withModelMatch[2];
      const model = (() => {
        try {
          return decodeURIComponent(rawModel);
        } catch {
          return rawModel;
        }
      })();

      return {
        model,
        isStreaming: endpoint === 'streamGenerateContent'
      };
    }

    const genericMatch = pathname.match(/\/v1.*\/(generateContent|streamGenerateContent)$/);
    if (genericMatch) {
      return {
        isStreaming: genericMatch[1] === 'streamGenerateContent'
      };
    }

    return null;
  }

  /**
   * 修改请求 URL 和 body，转换为 Anthropic 格式
   */
  async onBeforeRequest(ctx: MutableRequestContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    const endpoint = this.parseGeminiEndpoint(ctx.url.pathname);

    // 1. 路径转换：Gemini generateContent → Anthropic messages
    if (endpoint) {
      ctx.url.pathname = '/v1/messages';
      // 移除 Gemini 的查询参数（如 ?alt=sse）
      ctx.url.search = '';
    }

    // 2. 转换 body
    const anthropicBody: any = {};

    // Model
    anthropicBody.model = endpoint?.model || body.model;

    // System instruction
    const sysInst = body.systemInstruction || body.system_instruction;
    if (sysInst && sysInst.parts) {
      anthropicBody.system = sysInst.parts
        .map((p: any) => p.text || '')
        .join('');
    }

    // Messages
    if (body.contents) {
      anthropicBody.messages = this.convertContentsToMessages(body.contents);
    }

    // Generation config
    if (body.generationConfig) {
      const genConfig = body.generationConfig;

      if (genConfig.temperature !== undefined) {
        anthropicBody.temperature = genConfig.temperature;
      }

      if (genConfig.topP !== undefined) {
        anthropicBody.top_p = genConfig.topP;
      }

      if (genConfig.topK !== undefined) {
        anthropicBody.top_k = genConfig.topK;
      }

      if (genConfig.maxOutputTokens !== undefined) {
        anthropicBody.max_tokens = genConfig.maxOutputTokens;
      }

      if (genConfig.stopSequences) {
        anthropicBody.stop_sequences = genConfig.stopSequences;
      }

      // Thinking config
      if (genConfig.thinkingConfig) {
        const tc = genConfig.thinkingConfig;
        const budget = tc.thinkingBudget;

        if (budget && budget !== 0) {
          if (budget === -1) {
            anthropicBody.thinking = { type: 'enabled' };
          } else {
            anthropicBody.thinking = {
              type: 'enabled',
              budget_tokens: budget
            };
          }
        }
      }
    }

    // Tools
    if (body.tools) {
      anthropicBody.tools = this.convertTools(body.tools);
    }

    // Stream
    if (endpoint?.isStreaming || body.stream === true) {
      anthropicBody.stream = true;
    } else if (body.stream !== undefined) {
      anthropicBody.stream = body.stream;
    }

    ctx.body = anthropicBody;
  }

  /**
   * 转换 Gemini contents 为 Anthropic messages
   */
  private convertContentsToMessages(contents: GeminiContent[]): AnthropicMessage[] {
    const messages: AnthropicMessage[] = [];
    const pendingToolUseIdsByName = new Map<string, string[]>();
    let toolUseCounter = 0;

    for (const content of contents) {
      const parts = content.parts || [];
      const role = content.role;

      // 转换 role
      let anthropicRole: 'user' | 'assistant';
      if (role === 'model') {
        anthropicRole = 'assistant';
      } else {
        anthropicRole = 'user'; // user 或 tool 都映射为 user
      }

      // 转换 parts
      const anthropicContent: any[] = [];

      for (const part of parts) {
        if (part.text) {
          const text = part.text.trim();
          if (text) {
            if (part.thought) {
              // Thinking content
              anthropicContent.push({
                type: 'thinking',
                thinking: text
              });
            } else {
              // Normal text
              anthropicContent.push({
                type: 'text',
                text
              });
            }
          }
        } else if (part.inlineData) {
          // Image
          anthropicContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.inlineData.mimeType || 'image/jpeg',
              data: part.inlineData.data || ''
            }
          });
        } else if (part.functionCall) {
          // Tool use
          const fc = part.functionCall;
          const toolUseId = `toolu_${fc.name}_${toolUseCounter++}`;
          const queue = pendingToolUseIdsByName.get(fc.name) || [];
          queue.push(toolUseId);
          pendingToolUseIdsByName.set(fc.name, queue);

          anthropicContent.push({
            type: 'tool_use',
            id: toolUseId,
            name: fc.name,
            input: fc.args || {}
          });
        } else if (part.functionResponse) {
          // Tool result
          const fr = part.functionResponse;
          const respContent = typeof fr.response === 'object'
            ? (fr.response.content || JSON.stringify(fr.response))
            : String(fr.response);

          const functionName = fr.name || 'tool';
          const pendingIds = pendingToolUseIdsByName.get(functionName);
          const matchedToolUseId = pendingIds && pendingIds.length > 0 ? pendingIds.shift() : undefined;
          if (pendingIds && pendingIds.length === 0) {
            pendingToolUseIdsByName.delete(functionName);
          }

          anthropicContent.push({
            type: 'tool_result',
            tool_use_id: matchedToolUseId || `toolu_${functionName}_${toolUseCounter++}`,
            content: respContent
          });
        }
      }

      // Skip empty messages
      if (anthropicContent.length === 0) {
        continue;
      }

      // Simplify single text message
      if (anthropicContent.length === 1 && anthropicContent[0].type === 'text') {
        messages.push({
          role: anthropicRole,
          content: anthropicContent[0].text
        });
      } else {
        messages.push({
          role: anthropicRole,
          content: anthropicContent
        });
      }
    }

    return messages;
  }

  /**
   * 转换 Gemini tools 为 Anthropic tools
   */
  private convertTools(tools: any[]): any[] {
    return tools.flatMap(tool => {
      const funcDeclarations = tool.function_declarations || tool.functionDeclarations;
      if (!funcDeclarations) return [];

      return funcDeclarations.map((f: any) => {
        const schema = f.parameters || {};

        return {
          name: f.name,
          description: f.description || '',
          input_schema: this.convertSchema(schema)
        };
      });
    });
  }

  /**
   * 转换 Gemini schema 类型为 JSON Schema
   */
  private convertSchema(schema: any): any {
    if (typeof schema !== 'object' || schema === null) {
      return schema;
    }

    if (Array.isArray(schema)) {
      return schema.map(item => this.convertSchema(item));
    }

    const result: any = {};

    for (const [key, value] of Object.entries(schema)) {
      if (key === 'type' && typeof value === 'string') {
        // Convert Gemini type constants to JSON Schema types
        const typeMap: Record<string, string> = {
          'STRING': 'string',
          'NUMBER': 'number',
          'INTEGER': 'integer',
          'BOOLEAN': 'boolean',
          'ARRAY': 'array',
          'OBJECT': 'object'
        };
        result[key] = typeMap[value.toUpperCase()] || value.toLowerCase();
      } else {
        result[key] = this.convertSchema(value);
      }
    }

    return result;
  }

  /**
   * 处理非流式响应
   * 将 Anthropic 响应转换为 Gemini 格式
   */
  async onResponse(ctx: ResponseContext): Promise<Response | void> {
    // 只处理成功的 JSON 响应
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!this.isJsonLikeContentType(contentType)) {
      return;
    }

    let anthropicBody: any;
    try {
      const responseClone = ctx.response.clone();
      anthropicBody = await responseClone.json();
    } catch {
      return ctx.response;
    }

    if (!ctx.response.ok) {
      // 错误响应转换
      if (!this.isLikelyAnthropicErrorBody(anthropicBody)) {
        return ctx.response;
      }
      return this.transformErrorResponse(ctx, anthropicBody);
    }

    if (!this.isLikelyAnthropicSuccessBody(anthropicBody)) {
      return ctx.response;
    }

    // 转换为 Gemini 格式
    const geminiBody = this.convertAnthropicResponseToGemini(anthropicBody);

    // 返回新的响应
    return new Response(JSON.stringify(geminiBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  /**
   * 转换 Anthropic 错误响应为 Gemini 格式
   */
  private mapAnthropicErrorToGeminiStatus(type: unknown, status: number): string {
    if (typeof type === 'string') {
      const normalized = type.toLowerCase();
      if (normalized.includes('invalid_request')) return 'INVALID_ARGUMENT';
      if (normalized.includes('authentication')) return 'UNAUTHENTICATED';
      if (normalized.includes('permission')) return 'PERMISSION_DENIED';
      if (normalized.includes('rate_limit')) return 'RESOURCE_EXHAUSTED';
      if (normalized.includes('not_found')) return 'NOT_FOUND';
      if (normalized.includes('overloaded') || normalized.includes('unavailable')) return 'UNAVAILABLE';
    }

    if (status === 400) return 'INVALID_ARGUMENT';
    if (status === 401) return 'UNAUTHENTICATED';
    if (status === 403) return 'PERMISSION_DENIED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RESOURCE_EXHAUSTED';
    if (status === 503) return 'UNAVAILABLE';
    return 'INTERNAL';
  }

  private transformErrorResponse(ctx: ResponseContext, errorBody: any): Response {
    const anthropicError = errorBody?.error || {};
    const geminiError = {
      error: {
        code: ctx.response.status,
        message: typeof anthropicError.message === 'string' && anthropicError.message.trim()
          ? anthropicError.message
          : 'Unknown upstream error',
        status: this.mapAnthropicErrorToGeminiStatus(anthropicError.type, ctx.response.status)
      }
    };

    return new Response(JSON.stringify(geminiError), {
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

  private isLikelyAnthropicSuccessBody(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    if (body.type === 'message') {
      return true;
    }

    if (Array.isArray(body.content)) {
      return true;
    }

    if (typeof body.content === 'string') {
      return true;
    }

    return typeof body.input_tokens === 'number';
  }

  /**
   * 转换 Anthropic 响应为 Gemini candidates 格式
   */
  private convertAnthropicResponseToGemini(anthropicBody: any): any {
    const content = anthropicBody.content;
    const parts: GeminiPart[] = [];

    if (typeof content === 'string') {
      if (content.trim()) {
        parts.push({ text: content });
      }
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'text') {
          const text = item.text || '';
          if (text.trim()) {
            parts.push({ text });
          }
        } else if (item.type === 'thinking') {
          const thinking = item.thinking || '';
          if (thinking.trim()) {
            parts.push({ text: thinking, thought: true });
          }
        } else if (item.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: item.name || '',
              args: item.input || {}
            }
          });
        }
      }
    }

    if (parts.length === 0) {
      parts.push({ text: '' });
    }

    // Convert stop_reason
    const stopReason = anthropicBody.stop_reason;
    let finishReason = 'STOP';
    if (stopReason === 'end_turn') finishReason = 'STOP';
    else if (stopReason === 'max_tokens') finishReason = 'MAX_TOKENS';
    else if (stopReason === 'stop_sequence') finishReason = 'STOP';
    else if (stopReason === 'tool_use') finishReason = 'STOP';

    return {
      candidates: [{
        content: {
          parts,
          role: 'model'
        },
        finishReason,
        index: 0
      }],
      usageMetadata: {
        promptTokenCount: anthropicBody.usage?.input_tokens || 0,
        candidatesTokenCount: anthropicBody.usage?.output_tokens || 0,
        totalTokenCount: (anthropicBody.usage?.input_tokens || 0) + (anthropicBody.usage?.output_tokens || 0)
      }
    };
  }

  /**
   * 处理流式响应 chunk
   * Anthropic 返回增量文本，需要累积为 Gemini 的累积格式
   */
  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    const eventType = chunk.type;

    // Skip certain events
    if (eventType === 'message_start' || eventType === 'content_block_start' ||
        eventType === 'content_block_stop' || eventType === 'message_stop' || eventType === 'ping') {
      return [];
    }

    // Process content_block_delta
    if (eventType === 'content_block_delta') {
      const delta = chunk.delta;
      if (!delta) return [];

      // 初始化累积状态
      if (!ctx.streamState.has('accumulated_text')) {
        ctx.streamState.set('accumulated_text', '');
      }
      if (!ctx.streamState.has('accumulated_thinking')) {
        ctx.streamState.set('accumulated_thinking', '');
      }

      let accumulatedText = ctx.streamState.get('accumulated_text') as string;
      let accumulatedThinking = ctx.streamState.get('accumulated_thinking') as string;

      const parts: GeminiPart[] = [];

      if (delta.type === 'text_delta') {
        // 累积文本
        accumulatedText += delta.text || '';
        ctx.streamState.set('accumulated_text', accumulatedText);

        if (accumulatedText) {
          parts.push({ text: accumulatedText });
        }
      } else if (delta.type === 'thinking_delta') {
        // 累积 thinking
        accumulatedThinking += delta.thinking || '';
        ctx.streamState.set('accumulated_thinking', accumulatedThinking);

        if (accumulatedThinking) {
          parts.push({ text: accumulatedThinking, thought: true });
        }
      } else if (delta.type === 'input_json_delta') {
        // Tool call - 暂不处理部分 JSON
        return [];
      }

      if (parts.length === 0) return [];

      return [{
        candidates: [{
          content: {
            parts,
            role: 'model'
          },
          index: 0
        }]
      }];
    }

    // Process message_delta (final event)
    if (eventType === 'message_delta') {
      const delta = chunk.delta;
      const stopReason = delta?.stop_reason;
      let finishReason = 'STOP';
      if (stopReason === 'end_turn') finishReason = 'STOP';
      else if (stopReason === 'max_tokens') finishReason = 'MAX_TOKENS';
      else if (stopReason === 'stop_sequence') finishReason = 'STOP';
      else if (stopReason === 'tool_use') finishReason = 'STOP';

      return [{
        candidates: [{
          content: {
            parts: [{ text: '' }],
            role: 'model'
          },
          finishReason,
          index: 0
        }],
        usageMetadata: {
          promptTokenCount: chunk.usage?.input_tokens || 0,
          candidatesTokenCount: delta?.usage?.output_tokens || 0,
          totalTokenCount: (chunk.usage?.input_tokens || 0) + (delta?.usage?.output_tokens || 0)
        }
      }];
    }

    return [];
  }
}
