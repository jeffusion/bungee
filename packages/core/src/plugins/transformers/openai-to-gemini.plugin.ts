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

import type { Plugin, PluginContext, StreamChunkContext } from '../../plugin.types';

export class OpenAIToGeminiPlugin implements Plugin {
  name = 'openai-to-gemini';
  version = '1.0.0';

  /**
   * Model-specific max output tokens mapping (based on official Gemini API documentation)
   * Source: https://ai.google.dev/gemini-api/docs/models
   */
  private readonly modelMaxTokens: Record<string, number> = {
    // Gemini 2.5 series
    'gemini-2.5-pro': 65536,
    'gemini-2.5-flash': 65536,
    'gemini-2.5-flash-preview': 65536,
    'gemini-2.5-flash-lite': 65536,
    'gemini-2.5-flash-lite-preview': 65536,
    'gemini-2.5-flash-image': 32768,
    'gemini-2.5-flash-live': 8192,
    'gemini-2.5-flash-tts': 16384,

    // Gemini 2.0 series
    'gemini-2.0-flash': 8192,
    'gemini-2.0-flash-exp': 8192,
    'gemini-2.0-flash-image': 8192,
    'gemini-2.0-flash-live': 8192,
    'gemini-2.0-flash-lite': 8192,

    // Gemini 1.5 series
    'gemini-1.5-pro': 8192,
    'gemini-1.5-pro-latest': 8192,
    'gemini-1.5-flash': 8192,
    'gemini-1.5-flash-latest': 8192,
    'gemini-1.5-flash-8b': 8192,

    // Legacy
    'gemini-pro': 8192,
    'gemini-flash': 8192,
  };

  /**
   * Get default max output tokens for a given model
   */
  private getDefaultMaxTokens(model: string): number {
    // Direct match
    if (this.modelMaxTokens[model]) {
      return this.modelMaxTokens[model];
    }

    // Partial match for model with version suffix (e.g., "gemini-2.5-pro-001")
    for (const [key, value] of Object.entries(this.modelMaxTokens)) {
      if (model.startsWith(key)) {
        return value;
      }
    }

    // Default fallback for unknown models
    return 8192;
  }

  async onBeforeRequest(ctx: PluginContext): Promise<void> {
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

    // System instruction
    const systemMessages = openaiBody.messages?.filter((m: any) => m.role === 'system') || [];
    if (systemMessages.length > 0) {
      geminiBody.systemInstruction = {
        parts: [{ text: systemMessages.map((m: any) => m.content).join('\n') }]
      };
    }

    // Contents (convert messages)
    const nonSystemMessages = openaiBody.messages?.filter((m: any) => m.role !== 'system') || [];
    geminiBody.contents = nonSystemMessages.map((m: any) => {
      // Handle tool calls
      if (m.tool_calls) {
        return {
          role: 'model',
          parts: m.tool_calls.map((tc: any) => ({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}')
            }
          }))
        };
      }

      // Handle tool responses
      if (m.role === 'tool') {
        const fnName = m.tool_call_id.startsWith('call_')
          ? m.tool_call_id.split('_').slice(1, -1).join('_')
          : m.tool_call_id;

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

    // max_tokens - 可选，根据模型使用动态默认值
    if (openaiBody.max_tokens) {
      generationConfig.maxOutputTokens = openaiBody.max_tokens;
    } else if (process.env.ANTHROPIC_MAX_TOKENS) {
      generationConfig.maxOutputTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS);
    } else {
      // 根据模型使用对应的最大 token 数
      const model = openaiBody.model || 'gemini-pro';
      generationConfig.maxOutputTokens = this.getDefaultMaxTokens(model);
    }

    if (openaiBody.stop) {
      generationConfig.stopSequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
    }

    // Thinking config for reasoning models
    if (openaiBody.max_completion_tokens) {
      const effort = openaiBody.reasoning_effort || 'medium';
      const envKey = `OPENAI_${effort.toUpperCase()}_TO_GEMINI_TOKENS`;
      const tokens = process.env[envKey];

      if (!tokens) {
        throw new Error(`Environment variable ${envKey} not configured`);
      }

      generationConfig.thinkingConfig = {
        thinkingBudget: parseInt(tokens)
      };
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
    keysToRemove.forEach(key => delete cleaned[key]);

    for (const key in cleaned) {
      if (cleaned[key] && typeof cleaned[key] === 'object') {
        cleaned[key] = this.cleanSchema(cleaned[key]);
      }
    }

    return cleaned;
  }

  async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!contentType.includes('application/json') || !ctx.response.ok) {
      return;
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

    for (const part of parts) {
      if (part.text) {
        textContent += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${part.functionCall.name}_${Math.random().toString(36).substring(2, 15)}`,
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

    // First chunk
    if (ctx.isFirstChunk) {
      return [{
        id: `chatcmpl-${streamId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: chunk.modelVersion || chunk.candidates?.[0]?.model || 'gemini-pro',
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null
        }]
      }];
    }

    // Final chunk
    if (finishReason) {
      let openaiFinishReason = 'stop';
      if (finishReason === 'MAX_TOKENS') openaiFinishReason = 'length';
      else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') openaiFinishReason = 'content_filter';

      return [{
        id: `chatcmpl-${streamId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: chunk.modelVersion || 'gemini-pro',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: openaiFinishReason
        }]
      }];
    }

    // Regular chunk - handle both text and tool calls
    const textParts = parts.filter((p: any) => p.text);
    const toolCallParts = parts.filter((p: any) => p.functionCall);

    // Build delta object
    const delta: any = {};

    // Add text content
    if (textParts.length > 0) {
      delta.content = textParts.map((p: any) => p.text).join('');
    }

    // Add tool calls
    if (toolCallParts.length > 0) {
      delta.tool_calls = toolCallParts.map((p: any) => ({
        id: `call_${p.functionCall.name}_${Math.random().toString(36).substring(2, 15)}`,
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args || {})
        }
      }));
    }

    // Skip empty chunks
    if (Object.keys(delta).length === 0) return [];

    return [{
      id: `chatcmpl-${streamId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: chunk.modelVersion || 'gemini-pro',
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

export default OpenAIToGeminiPlugin;
