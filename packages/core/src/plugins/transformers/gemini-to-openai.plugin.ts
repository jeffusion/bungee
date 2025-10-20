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

import type { Plugin, PluginContext, StreamChunkContext } from '../../plugin.types';

export class GeminiToOpenAIPlugin implements Plugin {
  name = 'gemini-to-openai';
  version = '1.0.0';

  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    // 路径转换
    if (ctx.url.pathname.match(/\/v1.*\/(generateContent|streamGenerateContent)$/)) {
      ctx.url.pathname = '/v1/chat/completions';
      ctx.url.search = '';

      // 构建 OpenAI 请求
      ctx.body = this.buildOpenAIRequest(body);
    }
  }

  private buildOpenAIRequest(geminiBody: any): any {
    const openaiBody: any = {
      model: geminiBody.model || 'gpt-3.5-turbo'
    };

    // Messages
    const messages: any[] = [];

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
              // 按文档 4.1.1 Line 156: 通过对话历史映射恢复原始 tool_call_id
              // 目前使用简化版本：call_<name>_<random>
              const toolCallId = `call_${part.functionResponse.name}_${Math.random().toString(36).substring(2, 15)}`;
              messages.push({
                role: 'tool',
                tool_call_id: toolCallId,
                content: JSON.stringify(part.functionResponse.response)
              });
            }
          }
        } else if (parts.some((p: any) => p.functionCall)) {
          // Tool calls
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: parts
              .filter((p: any) => p.functionCall)
              .map((p: any, i: number) => ({
                id: `call_${p.functionCall.name}_${i}`,
                type: 'function',
                function: {
                  name: p.functionCall.name,
                  arguments: JSON.stringify(p.functionCall.args || {})
                }
              }))
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
          // 读取阈值环境变量
          const lowThreshold = parseInt(process.env.GEMINI_TO_OPENAI_LOW_REASONING_THRESHOLD || '0');
          const highThreshold = parseInt(process.env.GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD || '0');

          // 推断 reasoning_effort
          let effort = 'medium';
          if (thinkingBudget < lowThreshold) {
            effort = 'low';
          } else if (thinkingBudget >= highThreshold) {
            effort = 'high';
          }

          openaiBody.reasoning_effort = effort;

          // max_completion_tokens - 优先 maxOutputTokens，fallback OPENAI_REASONING_MAX_TOKENS
          const maxCompletionTokens = genConfig.maxOutputTokens || process.env.OPENAI_REASONING_MAX_TOKENS;
          if (!maxCompletionTokens) {
            throw new Error('maxOutputTokens or OPENAI_REASONING_MAX_TOKENS required for reasoning mode');
          }
          openaiBody.max_completion_tokens = typeof maxCompletionTokens === 'string'
            ? parseInt(maxCompletionTokens)
            : maxCompletionTokens;
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
    if (geminiBody.stream !== undefined) {
      openaiBody.stream = geminiBody.stream;
    }

    return openaiBody;
  }

  async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!contentType.includes('application/json') || !ctx.response.ok) {
      return;
    }

    const responseClone = ctx.response.clone();
    const openaiBody = await responseClone.json();

    const geminiBody = this.convertOpenAIResponseToGemini(openaiBody);

    return new Response(JSON.stringify(geminiBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
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
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || '{}')
          }
        });
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
        }]
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

export default GeminiToOpenAIPlugin;
