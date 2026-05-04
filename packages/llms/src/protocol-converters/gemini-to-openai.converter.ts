/**
 * Gemini to OpenAI Plugin
 *
 * 将 Google Gemini API 格式转换为 OpenAI Chat Completions API 格式
 *
 * 主要转换：
 * - 请求：/v1beta/models/{model}:generateContent → /v1/chat/completions
 * - 请求：contents → messages
 * - 响应：OpenAI chat.completion → Gemini candidates 格式
 */

import type { AIConverter, MutableRequestContext, ResponseContext, StreamChunkContext } from './base';

export class GeminiToOpenAIConverter implements AIConverter {
  readonly from = 'gemini';
  readonly to = 'openai';

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

  async onBeforeRequest(ctx: MutableRequestContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    const endpoint = this.parseGeminiEndpoint(ctx.url.pathname);

    // 路径转换
    if (endpoint) {
      ctx.url.pathname = '/v1/chat/completions';
      ctx.url.search = '';

      // 构建 OpenAI 请求
      ctx.body = this.buildOpenAIRequest(body, endpoint.model, endpoint.isStreaming);
    }
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

  private buildOpenAIRequest(geminiBody: any, modelFromPath?: string, isStreamingEndpoint: boolean = false): any {
    const openaiBody: any = {
      model: modelFromPath || geminiBody.model || 'gpt-3.5-turbo'
    };

    // Messages
    const messages: any[] = [];
    const pendingToolCallIdsByName = new Map<string, string[]>();
    let toolCallCounter = 0;

    // System instruction
    if (geminiBody.systemInstruction || geminiBody.system_instruction) {
      const sysInst = geminiBody.systemInstruction || geminiBody.system_instruction;
      const text = sysInst.parts?.map((p: any) => p.text || '').join('') || '';
      if (text) {
        messages.push({ role: 'system', content: text });
      }
    }

    // Convert contents
    if (geminiBody.contents) {
      for (const content of geminiBody.contents) {
        const role = content.role === 'model' ? 'assistant' : content.role === 'tool' ? 'tool' : 'user';
        const parts = content.parts || [];

        if (role === 'tool') {
          // Tool response
          for (const part of parts) {
            if (part.functionResponse) {
              const functionName = part.functionResponse.name || 'tool';
              const pendingIds = pendingToolCallIdsByName.get(functionName);
              const matchedId = pendingIds && pendingIds.length > 0 ? pendingIds.shift() : undefined;
              if (pendingIds && pendingIds.length === 0) {
                pendingToolCallIdsByName.delete(functionName);
              }

              const toolCallId = matchedId || `call_${functionName}_${toolCallCounter++}`;
              messages.push({
                role: 'tool',
                tool_call_id: toolCallId,
                content: JSON.stringify(part.functionResponse.response)
              });
            }
          }
        } else if (parts.some((p: any) => p.functionCall)) {
          // Tool calls
          const functionCallParts = parts.filter((p: any) => p.functionCall);
          const textContent = parts
            .filter((p: any) => p.text)
            .map((p: any) => p.text)
            .join('');
          messages.push({
            role: 'assistant',
            content: textContent || null,
            tool_calls: functionCallParts
              .map((p: any) => {
                const functionName = p.functionCall.name || 'tool';
                const toolCallId = `call_${functionName}_${toolCallCounter++}`;
                const queue = pendingToolCallIdsByName.get(functionName) || [];
                queue.push(toolCallId);
                pendingToolCallIdsByName.set(functionName, queue);

                const tc: any = {
                  id: toolCallId,
                  type: 'function',
                  function: {
                    name: functionName,
                    arguments: JSON.stringify(p.functionCall.args || {})
                  }
                };
                if (p.thoughtSignature) {
                  tc.extra_content = { google: { thought_signature: p.thoughtSignature } };
                }
                return tc;
              })
          });
        } else {
          // Regular message - handle both text and multi-modal content
          const hasImage = parts.some((p: any) => p.inlineData);

          if (hasImage) {
            // Multi-modal content
            const contentArray: any[] = [];

            for (const part of parts) {
              if (part.text) {
                contentArray.push({ type: 'text', text: part.text });
              } else if (part.inlineData) {
                // inlineData → image_url
                const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                contentArray.push({
                  type: 'image_url',
                  image_url: { url: dataUrl }
                });
              }
            }

            if (contentArray.length > 0) {
              messages.push({ role, content: contentArray });
            }
          } else {
            // Text only
            const textParts = parts.filter((p: any) => p.text);
            const content = textParts.map((p: any) => p.text).join('');
            if (content) {
              messages.push({ role, content });
            }
          }
        }
      }
    }

    openaiBody.messages = messages;

    // Generation config
    if (geminiBody.generationConfig) {
      const genConfig = geminiBody.generationConfig;

      if (genConfig.temperature !== undefined) {
        openaiBody.temperature = genConfig.temperature;
      }

      if (genConfig.topP !== undefined) {
        openaiBody.top_p = genConfig.topP;
      }

      if (genConfig.maxOutputTokens !== undefined) {
        openaiBody.max_tokens = genConfig.maxOutputTokens;
      }

      if (genConfig.stopSequences) {
        openaiBody.stop = genConfig.stopSequences;
      }

      // Thinking config - 按文档 4.1.1 Line 159
      if (genConfig.thinkingConfig && genConfig.thinkingConfig.thinkingBudget !== undefined) {
        const thinkingBudget = genConfig.thinkingConfig.thinkingBudget;

        if (thinkingBudget > 0) {
          if (genConfig.maxOutputTokens !== undefined) {
            openaiBody.max_completion_tokens = typeof genConfig.maxOutputTokens === 'string'
              ? parseInt(genConfig.maxOutputTokens)
              : genConfig.maxOutputTokens;
            delete openaiBody.max_tokens;
          }
        }
      }
    }

    // Tools
    if (geminiBody.tools) {
      const functionDeclarations = geminiBody.tools.flatMap((t: any) =>
        (t.functionDeclarations || t.function_declarations || [])
      );

      if (functionDeclarations.length > 0) {
        openaiBody.tools = functionDeclarations.map((f: any) => ({
          type: 'function',
          function: {
            name: f.name,
            description: f.description || '',
            parameters: f.parameters || {}
          }
        }));
      }
    }

    // Stream
    if (isStreamingEndpoint || geminiBody.stream === true) {
      openaiBody.stream = true;
    } else if (geminiBody.stream !== undefined) {
      openaiBody.stream = geminiBody.stream;
    }

    return openaiBody;
  }

  async onResponse(ctx: ResponseContext): Promise<Response | void> {
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!this.isJsonLikeContentType(contentType)) {
      return;
    }

    let openaiBody: any;
    try {
      const responseClone = ctx.response.clone();
      openaiBody = await responseClone.json();
    } catch {
      return ctx.response;
    }

    if (!ctx.response.ok) {
      if (!this.isLikelyOpenAIErrorBody(openaiBody)) {
        return ctx.response;
      }
      return this.transformErrorResponse(ctx, openaiBody);
    }

    if (!this.isLikelyOpenAISuccessBody(openaiBody)) {
      return ctx.response;
    }

    const geminiBody = this.convertOpenAIResponseToGemini(openaiBody);

    return new Response(JSON.stringify(geminiBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  private mapOpenAIErrorToGeminiStatus(type: unknown, status: number): string {
    if (typeof type === 'string') {
      const normalized = type.toLowerCase();
      if (normalized.includes('invalid_request')) return 'INVALID_ARGUMENT';
      if (normalized.includes('auth')) return 'UNAUTHENTICATED';
      if (normalized.includes('permission')) return 'PERMISSION_DENIED';
      if (normalized.includes('rate_limit')) return 'RESOURCE_EXHAUSTED';
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
    const openaiError = errorBody?.error || {};
    const mappedStatus = this.mapOpenAIErrorToGeminiStatus(openaiError.type, ctx.response.status);

    const geminiError = {
      error: {
        code: typeof openaiError.code === 'number' ? openaiError.code : ctx.response.status,
        message: typeof openaiError.message === 'string' && openaiError.message.trim()
          ? openaiError.message
          : 'Unknown upstream error',
        status: mappedStatus
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

  private isLikelyOpenAIErrorBody(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    const error = body.error;
    if (!error || typeof error !== 'object') {
      return false;
    }

    return typeof error.message === 'string'
      || typeof error.type === 'string'
      || typeof error.code === 'string'
      || typeof error.code === 'number';
  }

  private isLikelyOpenAISuccessBody(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    if (Array.isArray(body.choices)) {
      return true;
    }

    if (body.object === 'chat.completion' || body.object === 'response') {
      return true;
    }

    return Array.isArray(body.output);
  }

  private convertOpenAIResponseToGemini(openaiBody: any): any {
    const choice = openaiBody.choices?.[0];
    if (!choice) {
      return {
        candidates: [],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0
        }
      };
    }

    const message = choice.message;
    const parts: any[] = [];

    // Handle tool calls
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        const fcPart: any = {
          functionCall: {
            name: tc.function.name,
            args: this.parseToolArgumentsToObject(tc.function.arguments)
          }
        };
        const sig = tc.extra_content?.google?.thought_signature || tc.thought_signature;
        if (sig) {
          fcPart.thoughtSignature = sig;
        }
        parts.push(fcPart);
      }
    } else if (message.content) {
      // Regular text
      parts.push({ text: message.content });
    }

    // Finish reason
    let finishReason = 'STOP';
    if (choice.finish_reason === 'length') finishReason = 'MAX_TOKENS';
    else if (choice.finish_reason === 'content_filter') finishReason = 'SAFETY';
    else if (choice.finish_reason === 'tool_calls') finishReason = 'TOOL_USE';

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
        promptTokenCount: openaiBody.usage?.prompt_tokens || 0,
        candidatesTokenCount: openaiBody.usage?.completion_tokens || 0,
        totalTokenCount: openaiBody.usage?.total_tokens || 0
      }
    };
  }

  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    const choice = chunk.choices?.[0];
    if (!choice) return [];

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    // Final chunk
    if (finishReason) {
      let geminiFinishReason = 'STOP';
      if (finishReason === 'length') geminiFinishReason = 'MAX_TOKENS';
      else if (finishReason === 'content_filter') geminiFinishReason = 'SAFETY';

      return [{
        candidates: [{
          content: {
            parts: [{ text: '' }],
            role: 'model'
          },
          finishReason: geminiFinishReason,
          index: 0
        }],
        // 转换 OpenAI usage → Gemini usageMetadata
        usageMetadata: chunk.usage ? {
          promptTokenCount: chunk.usage.prompt_tokens || 0,
          candidatesTokenCount: chunk.usage.completion_tokens || 0,
          totalTokenCount: chunk.usage.total_tokens || 0
        } : undefined
      }];
    }

    // Regular chunk
    if (!delta.content) return [];

    return [{
      candidates: [{
        content: {
          parts: [{ text: delta.content }],
          role: 'model'
        },
        index: 0
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
