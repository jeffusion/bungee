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
      geminiBody.system_instruction = {
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

    // max_tokens - 按文档 2.1 Line 57: 若皆缺失则报错
    if (openaiBody.max_tokens) {
      generationConfig.maxOutputTokens = openaiBody.max_tokens;
    } else if (process.env.ANTHROPIC_MAX_TOKENS) {
      generationConfig.maxOutputTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS);
    } else {
      throw new Error('max_tokens is required. Provide it in request or set ANTHROPIC_MAX_TOKENS environment variable');
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
      generationConfig.response_mime_type = 'application/json';
      generationConfig.response_schema = openaiBody.response_format.json_schema?.schema;
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

    // Regular chunk
    const textParts = parts.filter((p: any) => p.text);
    if (textParts.length === 0) return [];

    const content = textParts.map((p: any) => p.text).join('');

    return [{
      id: `chatcmpl-${streamId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: chunk.modelVersion || 'gemini-pro',
      choices: [{
        index: 0,
        delta: { content },
        finish_reason: null
      }]
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
