/**
 * OpenAI to Gemini Plugin
 *
 * 将 OpenAI Chat Completions API 格式转换为 Google Gemini API 格式
 *
 * 主要转换：
 * - 请求：/v1/chat/completions → /v1beta/models/{model}:generateContent
 * - 请求：messages → contents
 * - 响应：Gemini → OpenAI chat.completion
 */

import type { AIConverter, MutableRequestContext, ResponseContext, StreamChunkContext } from './base';

export class OpenAIToGeminiConverter implements AIConverter {
  readonly from = 'openai';
  readonly to = 'gemini';

  private extractInstructionText(content: any): string {
    if (typeof content === 'string') {
      return content.trim();
    }

    if (Array.isArray(content)) {
      return content
        .map((item: any) => {
          if (typeof item === 'string') return item;
          if (item?.type === 'text') return item.text || '';
          if (typeof item?.text === 'string') return item.text;
          return '';
        })
        .join('')
        .trim();
    }

    return '';
  }

  private parseToolArgumentsToObject(rawArguments: any): Record<string, any> {
    if (typeof rawArguments !== 'string') {
      return {};
    }

    try {
      const parsed = JSON.parse(rawArguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private buildToolCallIdToNameMap(messages: any[]): Map<string, string> {
    const toolCallIdToName = new Map<string, string>();

    for (const message of messages) {
      if (!Array.isArray(message?.tool_calls)) continue;
      for (const toolCall of message.tool_calls) {
        const id = typeof toolCall?.id === 'string' ? toolCall.id : '';
        const name = typeof toolCall?.function?.name === 'string' ? toolCall.function.name : '';
        if (id && name) {
          toolCallIdToName.set(id, name);
        }
      }
    }

    return toolCallIdToName;
  }

  async onBeforeRequest(ctx: MutableRequestContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    // 路径转换
    if (ctx.url.pathname === '/v1/chat/completions') {
      const model = body.model || 'gemini-pro';
      const isStreaming = body.stream === true;

      if (isStreaming) {
        ctx.url.pathname = `/v1beta/models/${model}:streamGenerateContent`;
        ctx.url.search = '?alt=sse';
      } else {
        ctx.url.pathname = `/v1beta/models/${model}:generateContent`;
      }

      // 构建 Gemini 请求
      ctx.body = this.buildGeminiRequest(body);
    }
  }

  private buildGeminiRequest(openaiBody: any): any {
    const geminiBody: any = {};
    const messages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];

    // System instruction
    const instructionParts: string[] = [];
    if (typeof openaiBody.system === 'string' && openaiBody.system.trim()) {
      instructionParts.push(openaiBody.system.trim());
    }

    const instructionMessages = messages
      .filter((m: any) => m.role === 'system' || m.role === 'developer')
      .map((m: any) => this.extractInstructionText(m.content))
      .filter((text: string) => text.length > 0);

    instructionParts.push(...instructionMessages);

    if (instructionParts.length > 0) {
      geminiBody.systemInstruction = {
        parts: [{ text: instructionParts.join('\n') }]
      };
    }

    const toolCallIdToName = this.buildToolCallIdToNameMap(messages);

    // Contents (convert messages)
    const nonSystemMessages = messages.filter((m: any) => m.role !== 'system' && m.role !== 'developer');
    geminiBody.contents = nonSystemMessages.map((m: any) => {
      // Handle tool calls
      if (m.tool_calls) {
        const textParts: any[] = [];
        if (typeof m.content === 'string' && m.content.trim()) {
          textParts.push({ text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (typeof part === 'string' && part.trim()) {
              textParts.push({ text: part });
            } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              textParts.push({ text: part.text });
            }
          }
        }

        return {
          role: 'model',
          parts: [
            ...textParts,
            ...m.tool_calls.map((tc: any) => ({
              functionCall: {
                name: tc.function.name,
                args: this.parseToolArgumentsToObject(tc.function.arguments)
              }
            }))
          ]
        };
      }

      // Handle tool responses
      if (m.role === 'tool') {
        const toolCallId = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
        const mappedFnName = toolCallId ? toolCallIdToName.get(toolCallId) : undefined;
        const fallbackFnName = toolCallId.startsWith('call_')
          ? toolCallId.split('_').slice(1, -1).join('_')
          : toolCallId;
        const fnName = mappedFnName || fallbackFnName || 'tool';

        // Parse JSON content if it's a string
        let resp = m.content;
        if (typeof m.content === 'string') {
          try {
            resp = JSON.parse(m.content);
          } catch (e) {
            // If parsing fails, wrap in object
            resp = { content: m.content };
          }
        }

        return {
          role: 'tool',
          parts: [{
            functionResponse: {
              name: fnName,
              response: resp
            }
          }]
        };
      }

      // Handle regular messages
      const role = m.role === 'assistant' ? 'model' : 'user';

      if (typeof m.content === 'string') {
        return { role, parts: [{ text: m.content }] };
      } else if (Array.isArray(m.content)) {
        const parts = m.content.map((c: any) => {
          if (c.type === 'text') return { text: c.text };
          if (c.type === 'image_url') {
            const url = c.image_url.url;
            const [mimeType, data] = url.replace('data:', '').split(';base64,');
            return { inlineData: { mimeType, data } };
          }
          return { text: '' };
        });
        return { role, parts };
      }

      return { role, parts: [{ text: '' }] };
    });

    // Generation config
    const generationConfig: any = {};

    if (openaiBody.temperature !== undefined) {
      generationConfig.temperature = openaiBody.temperature;
    }

    if (openaiBody.top_p !== undefined) {
      generationConfig.topP = openaiBody.top_p;
    }

    if (openaiBody.max_tokens !== undefined) {
      generationConfig.maxOutputTokens = openaiBody.max_tokens;
    }

    if (openaiBody.stop) {
      generationConfig.stopSequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
    }

    // Response format
    if (openaiBody.response_format?.type === 'json_schema') {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = openaiBody.response_format.json_schema?.schema;
    }

    if (Object.keys(generationConfig).length > 0) {
      geminiBody.generationConfig = generationConfig;
    }

    // Tools
    if (openaiBody.tools) {
      geminiBody.tools = [{
        functionDeclarations: openaiBody.tools.map((t: any) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: this.cleanSchema(t.function.parameters)
        }))
      }];
    }

    return geminiBody;
  }

  private cleanSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(s => this.cleanSchema(s));

    const cleaned = { ...schema };
    const keysToRemove = ['$schema', 'additionalProperties', 'title', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'format'];
    keysToRemove.forEach((key) => {
      delete cleaned[key];
    });

    for (const key in cleaned) {
      if (cleaned[key] && typeof cleaned[key] === 'object') {
        cleaned[key] = this.cleanSchema(cleaned[key]);
      }
    }

    return cleaned;
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
        if (!this.isLikelyGeminiErrorBody(errorBody)) {
          return ctx.response;
        }
        return this.transformErrorResponse(ctx, errorBody);
      } catch {
        return ctx.response;
      }
    }

    const responseClone = ctx.response.clone();
    const geminiBody = await responseClone.json();

    const openaiBody = this.convertGeminiResponseToOpenAI(geminiBody);

    return new Response(JSON.stringify(openaiBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  private mapGeminiErrorToOpenAIType(statusText: unknown, status: number): string {
    if (typeof statusText === 'string') {
      const normalized = statusText.toUpperCase();
      if (normalized === 'INVALID_ARGUMENT') return 'invalid_request_error';
      if (normalized === 'UNAUTHENTICATED') return 'authentication_error';
      if (normalized === 'PERMISSION_DENIED') return 'permission_error';
      if (normalized === 'NOT_FOUND') return 'not_found_error';
      if (normalized === 'RESOURCE_EXHAUSTED') return 'rate_limit_error';
      if (normalized === 'UNAVAILABLE' || normalized === 'INTERNAL') return 'server_error';
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
    const geminiError = errorBody?.error || {};
    const mappedType = this.mapGeminiErrorToOpenAIType(geminiError.status, ctx.response.status);

    const openaiError = {
      error: {
        message: typeof geminiError.message === 'string' && geminiError.message.trim()
          ? geminiError.message
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

  private isLikelyGeminiErrorBody(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    const error = body.error;
    if (!error || typeof error !== 'object') {
      return false;
    }

    return typeof error.message === 'string'
      || typeof error.status === 'string'
      || typeof error.code === 'number';
  }

  private convertGeminiResponseToOpenAI(geminiBody: any): any {
    const candidate = geminiBody.candidates?.[0];
    if (!candidate) {
      return {
        id: 'chatcmpl-error',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gemini-pro',
        choices: [],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
    }

    const parts = candidate.content?.parts || [];
    let textContent = '';
    const toolCalls: any[] = [];

    for (const [index, part] of parts.entries()) {
      if (part.text) {
        textContent += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${part.functionCall.name}_${index}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }

    // Build message
    const message: any = { role: 'assistant' };
    if (toolCalls.length > 0) {
      message.content = textContent || null;
      message.tool_calls = toolCalls;
    } else {
      message.content = textContent;
    }

    // Convert finish reason
    const finishReason = candidate.finishReason;
    let openaiFinishReason = 'stop';
    if (finishReason === 'MAX_TOKENS') openaiFinishReason = 'length';
    else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') openaiFinishReason = 'content_filter';
    else if (toolCalls.length > 0) openaiFinishReason = 'tool_calls';

    return {
      id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').substring(0, 29)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: geminiBody.modelVersion || 'gemini-pro',
      choices: [{
        index: 0,
        message,
        finish_reason: openaiFinishReason
      }],
      usage: {
        prompt_tokens: geminiBody.usageMetadata?.promptTokenCount || 0,
        completion_tokens: geminiBody.usageMetadata?.candidatesTokenCount || 0,
        cached_content_token_count: geminiBody.usageMetadata?.cachedContentTokenCount || null,
        total_tokens: geminiBody.usageMetadata?.totalTokenCount || 0
      }
    };
  }

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    if (!ctx.streamState.has('streamId')) {
      ctx.streamState.set('streamId', crypto.randomUUID().replace(/-/g, '').substring(0, 29));
    }
    const streamId = ctx.streamState.get('streamId') as string;

    const parts = chunk.candidates?.[0]?.content?.parts || [];
    const finishReason = chunk.candidates?.[0]?.finishReason;
    const model = chunk.modelVersion || chunk.candidates?.[0]?.model || 'gemini-pro';

    let streamToolCalls = ctx.streamState.get('stream_tool_calls') as Map<string, { id: string; index: number }> | undefined;
    if (!streamToolCalls) {
      streamToolCalls = new Map<string, { id: string; index: number }>();
      ctx.streamState.set('stream_tool_calls', streamToolCalls);
    }
    let nextToolCallIndex = (ctx.streamState.get('stream_tool_call_next_index') as number | undefined) ?? 0;

    const textParts = parts.filter((p: any) => p.text);
    const toolCallParts = parts.filter((p: any) => p.functionCall);

    if (toolCallParts.length > 0) {
      ctx.streamState.set('has_tool_calls', true);
    }

    const delta: any = {};
    if (ctx.isFirstChunk) {
      delta.role = 'assistant';
    }

    if (textParts.length > 0) {
      delta.content = textParts.map((p: any) => p.text).join('');
    }

    if (toolCallParts.length > 0) {
      delta.tool_calls = parts
        .map((part: any, partIndex: number) => ({ part, partIndex }))
        .filter((entry: { part: any; partIndex: number }) => entry.part?.functionCall)
        .map((entry: { part: any; partIndex: number }) => {
          const { part, partIndex } = entry;
          const functionName = part.functionCall.name;
          const callKey = `${partIndex}:${functionName}`;
          let callMeta = streamToolCalls!.get(callKey);

          if (!callMeta) {
            callMeta = {
              id: `call_${functionName}_${nextToolCallIndex}`,
              index: nextToolCallIndex,
            };
            streamToolCalls!.set(callKey, callMeta);
            nextToolCallIndex++;
          }

          return {
            index: callMeta.index,
            id: callMeta.id,
            type: 'function',
            function: {
              name: functionName,
              arguments: JSON.stringify(part.functionCall.args || {})
            }
          };
        });
      ctx.streamState.set('stream_tool_call_next_index', nextToolCallIndex);
    }

    // Final chunk
    if (finishReason) {
      let openaiFinishReason = 'stop';
      if (finishReason === 'MAX_TOKENS') openaiFinishReason = 'length';
      else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') openaiFinishReason = 'content_filter';
      else if (ctx.streamState.get('has_tool_calls') === true) openaiFinishReason = 'tool_calls';

      return [{
        id: `chatcmpl-${streamId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: Object.keys(delta).length > 0 ? delta : {},
          finish_reason: openaiFinishReason
        }],
        usage: {
          prompt_tokens: chunk.usageMetadata?.promptTokenCount || 0,
          completion_tokens: chunk.usageMetadata?.candidatesTokenCount || 0,
          cached_content_token_count: chunk.usageMetadata?.cachedContentTokenCount || null,
          total_tokens: chunk.usageMetadata?.totalTokenCount || 0
        }
      }];
    }

    // Skip empty chunks
    if (Object.keys(delta).length === 0) return [];

    return [{
      id: `chatcmpl-${streamId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta,
        finish_reason: null
      }],
      usage: {
        prompt_tokens: chunk.usageMetadata?.promptTokenCount || 0,
        completion_tokens: chunk.usageMetadata?.candidatesTokenCount || 0,
        cached_content_token_count: chunk.usageMetadata?.cachedContentTokenCount || null,
        total_tokens: chunk.usageMetadata?.totalTokenCount || 0
      }
    }];
  }

  /**
   * flushStream - 此 transformer 不需要缓冲，返回空数组
   */
  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    return [];
  }
}
