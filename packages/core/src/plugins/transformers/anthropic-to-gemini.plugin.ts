/**
 * Anthropic to Gemini Plugin
 *
 * 将 Anthropic Messages API 格式转换为 Google Gemini API 格式
 *
 * 主要转换：
 * - 请求：/v1/messages → /v1beta/models/{model}:generateContent
 * - 请求：messages → contents (role: assistant → model)
 * - 请求：system → systemInstruction
 * - 请求：tools → functionDeclarations
 * - 响应：Gemini 累积文本 → Anthropic 增量文本（SSE）
 */

import type { Plugin, PluginContext, StreamChunkContext } from '../../plugin.types';

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

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: any;
}

interface GeminiPart {
  text?: string;
  thought?: string | boolean;
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

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
    role?: string;
  };
  finishReason?: string;
}

export class AnthropicToGeminiPlugin implements Plugin {
  name = 'anthropic-to-gemini';
  version = '1.0.0';

  // 工具调用 ID 与函数名的映射 - 按文档 Line 113
  private toolIdToNameMap = new Map<string, string>();

  /**
   * 修改请求 URL 和 body，转换为 Gemini 格式
   */
  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    // 重置映射表
    this.toolIdToNameMap.clear();
    const body = ctx.body as any;
    if (!body) return;

    // 1. 处理路径重写
    if (ctx.url.pathname === '/v1/messages/count_tokens') {
      // count_tokens 端点
      const model = body.model || 'gemini-pro';
      ctx.url.pathname = `/v1beta/models/${model}:countTokens`;
      ctx.url.search = ''; // 清除 Anthropic 特有的查询参数

      // 转换 body
      // Gemini countTokens API 要求 generateContentRequest 内部必须包含 model 字段
      const generateContentRequest = this.buildGenerateContentRequest(body);
      ctx.body = {
        generateContentRequest: {
          model: `models/${model}`,
          ...generateContentRequest
        }
      };
    } else if (ctx.url.pathname === '/v1/messages') {
      // 主要的 messages 端点
      const model = body.model || 'gemini-pro';
      const isStreaming = body.stream === true;

      if (isStreaming) {
        ctx.url.pathname = `/v1beta/models/${model}:streamGenerateContent`;
        ctx.url.search = '?alt=sse';
      } else {
        ctx.url.pathname = `/v1beta/models/${model}:generateContent`;
        ctx.url.search = ''; // 清除 Anthropic 特有的查询参数
      }

      // 转换 body
      ctx.body = this.buildGenerateContentRequest(body);
    }
  }

  /**
   * 构建 Gemini generateContent 请求
   */
  private buildGenerateContentRequest(anthropicBody: any): any {
    const geminiBody: any = {};

    // 转换 messages
    if (anthropicBody.messages) {
      geminiBody.contents = this.convertMessages(anthropicBody.messages);
    }

    // 转换 system instruction
    // 按 Gemini API 规范：system_instruction.parts 是数组
    // 支持 system 为字符串或内容块数组（Claude Code 使用数组格式）
    if (anthropicBody.system) {
      let systemText = '';

      if (typeof anthropicBody.system === 'string') {
        // 简单字符串格式
        systemText = anthropicBody.system;
      } else if (Array.isArray(anthropicBody.system)) {
        // 内容块数组格式（如 Claude Code）
        // 提取所有 text 类型块的文本并合并，忽略 cache_control 等字段
        systemText = anthropicBody.system
          .filter((block: any) => block.type === 'text' && block.text)
          .map((block: any) => block.text)
          .join('\n');
      }

      if (systemText) {
        geminiBody.system_instruction = {
          parts: [{ text: systemText }]
        };
      }
    }

    // generationConfig
    const generationConfig: any = {};

    if (anthropicBody.temperature !== undefined) {
      generationConfig.temperature = anthropicBody.temperature;
    }

    const maxTokens = anthropicBody.max_tokens_to_sample || anthropicBody.max_tokens;
    if (maxTokens) {
      generationConfig.maxOutputTokens = maxTokens;
    }

    if (anthropicBody.top_p !== undefined) {
      generationConfig.topP = anthropicBody.top_p;
    }

    if (anthropicBody.top_k !== undefined) {
      generationConfig.topK = anthropicBody.top_k;
    }

    if (anthropicBody.stop_sequences) {
      generationConfig.stopSequences = anthropicBody.stop_sequences;
    }

    // Thinking config
    if (anthropicBody.thinking && anthropicBody.thinking.type === 'enabled') {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: anthropicBody.thinking.budget_tokens || -1
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      geminiBody.generationConfig = generationConfig;
    }

    // 转换 tools
    if (anthropicBody.tools && anthropicBody.tools.length > 0) {
      geminiBody.tools = [{
        functionDeclarations: anthropicBody.tools.map((tool: AnthropicTool) => ({
          name: tool.name,
          description: tool.description || '',
          parameters: this.cleanSchema(tool.input_schema)
        }))
      }];

      // toolConfig
      if (anthropicBody.tool_choice) {
        geminiBody.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [anthropicBody.tool_choice.name]
          }
        };
      } else {
        geminiBody.toolConfig = {
          functionCallingConfig: {
            mode: 'AUTO'
          }
        };
      }
    }

    return geminiBody;
  }

  /**
   * 转换 Anthropic messages 为 Gemini contents
   */
  private convertMessages(messages: AnthropicMessage[]): any[] {
    return messages.map(msg => {
      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        return {
          role,
          parts: [{ text: msg.content }]
        };
      }

      // 处理数组内容
      const parts: GeminiPart[] = [];

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          // Thinking 块转换为 thought: true 的文本 part
          parts.push({ text: block.thinking, thought: true });
        } else if (block.type === 'image' && block.source) {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data
            }
          });
        } else if (block.type === 'tool_use') {
          const toolName = block.name || '';
          const toolId = block.id || '';

          // 记录 ID → 函数名映射 - 按文档 Line 113
          if (toolId && toolName) {
            this.toolIdToNameMap.set(toolId, toolName);
          }

          parts.push({
            functionCall: {
              name: toolName,
              args: block.input || {}
            }
          });
        } else if (block.type === 'tool_result') {
          // 按文档 Line 224-229
          // 从 tool_use_id 恢复函数名
          const toolUseId = block.tool_use_id || '';
          const functionName = this.toolIdToNameMap.get(toolUseId) || '';

          const resultContent = block.content || '';
          parts.push({
            functionResponse: {
              name: functionName,
              response: {
                content: resultContent
              }
            }
          });
        }
      }

      return { role, parts };
    });
  }

  /**
   * 清理 JSON Schema（移除 Gemini 不支持的字段）
   * 按文档 3.4 Line 144: 深度清洗，去除不被 Gemini 接受的关键词
   * 参考 llms 项目的 cleanupParameters 和 processJsonSchema 实现
   */
  private cleanSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    if (Array.isArray(schema)) {
      return schema.map(item => this.cleanSchema(item));
    }

    const cleaned: any = {};

    // Gemini 支持的字段白名单（参考 llms/src/utils/gemini.util.ts Line 16-39）
    const validFields = new Set([
      'type',
      'format',
      'description',
      'nullable',
      'enum',
      'maxItems',
      'minItems',
      'properties',
      'required',
      'minProperties',
      'maxProperties',
      'minLength',
      'maxLength',
      'pattern',
      'example',
      'anyOf',
      'default',
      'items',
      'minimum',
      'maximum'
    ]);

    // 只保留有效字段
    for (const key in schema) {
      if (validFields.has(key)) {
        cleaned[key] = schema[key];
      }
    }

    // 特殊处理：enum 只在 string 类型时有效
    if (cleaned.enum && cleaned.type !== 'string') {
      delete cleaned.enum;
    }

    // 特殊处理：format 只在 string 类型且为特定值时有效
    if (
      cleaned.type === 'string' &&
      cleaned.format &&
      !['enum', 'date-time'].includes(cleaned.format)
    ) {
      delete cleaned.format;
    }

    // 验证 required 数组：移除 properties 中不存在的字段
    if (cleaned.required && Array.isArray(cleaned.required) && cleaned.properties) {
      cleaned.required = cleaned.required.filter((field: string) =>
        field in cleaned.properties
      );
      // 如果过滤后为空，删除 required 字段
      if (cleaned.required.length === 0) {
        delete cleaned.required;
      }
    } else if (cleaned.required && !cleaned.properties) {
      // 如果有 required 但没有 properties，删除 required
      delete cleaned.required;
    }

    // 递归清理嵌套对象
    if (cleaned.properties && typeof cleaned.properties === 'object') {
      const cleanedProps: any = {};
      for (const key in cleaned.properties) {
        cleanedProps[key] = this.cleanSchema(cleaned.properties[key]);
      }
      cleaned.properties = cleanedProps;
    }

    // 递归清理 items
    if (cleaned.items && typeof cleaned.items === 'object') {
      cleaned.items = this.cleanSchema(cleaned.items);
    }

    // 递归清理 anyOf
    if (cleaned.anyOf && Array.isArray(cleaned.anyOf)) {
      cleaned.anyOf = cleaned.anyOf.map((item: any) => this.cleanSchema(item));
    }

    return cleaned;
  }

  /**
   * 处理非流式响应
   * 将 Gemini 响应转换为 Anthropic 格式
   */
  async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
    const contentType = ctx.response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return;
    }

    const responseClone = ctx.response.clone();
    const geminiBody = await responseClone.json();

    // Handle error responses
    if (!ctx.response.ok) {
      const anthropicError = {
        type: 'error',
        error: {
          type: 'api_error',
          message: geminiBody.error?.message || 'Unknown error'
        }
      };

      return new Response(JSON.stringify(anthropicError), {
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        headers: ctx.response.headers
      });
    }

    // Convert success response
    const anthropicBody = this.convertGeminiResponseToAnthropic(geminiBody);

    return new Response(JSON.stringify(anthropicBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  /**
   * 转换 Gemini 响应为 Anthropic 格式
   */
  private convertGeminiResponseToAnthropic(geminiBody: any): any {
    const candidate = geminiBody.candidates?.[0];
    if (!candidate) {
      return {
        id: `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'gemini-pro',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      };
    }

    const parts = candidate.content?.parts || [];
    const content: any[] = [];

    for (const part of parts) {
      if (part.text) {
        if (part.thought) {
          content.push({
            type: 'thinking',
            thinking: part.text
          });
        } else {
          content.push({
            type: 'text',
            text: part.text
          });
        }
      } else if (part.functionCall) {
        content.push({
          type: 'tool_use',
          id: `toolu_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {}
        });
      }
    }

    // Convert finish reason
    const finishReason = candidate.finishReason;
    let stopReason = 'end_turn';

    // 按文档 3.2.2: 若包含函数调用则 stop_reason 设为 tool_use
    if (content.some((c: any) => c.type === 'tool_use')) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    } else if (finishReason === 'STOP') {
      stopReason = 'end_turn';
    } else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      stopReason = 'end_turn';
    }

    return {
      id: `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
      type: 'message',
      role: 'assistant',
      content,
      model: geminiBody.modelVersion || 'gemini-pro',
      stop_reason: stopReason,
      usage: {
        input_tokens: geminiBody.usageMetadata?.promptTokenCount || 0,
        output_tokens: geminiBody.usageMetadata?.candidatesTokenCount || 0
      }
    };
  }

  /**
   * 处理流式响应 chunk
   * Gemini 返回累积文本，需要转换为 Anthropic 的增量文本
   */
  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    const events: any[] = [];

    // 检查是否有 candidates
    if (!chunk.candidates || chunk.candidates.length === 0) {
      return [];
    }

    const candidate: GeminiCandidate = chunk.candidates[0];
    const parts = candidate.content?.parts || [];
    const hasFinish = !!candidate.finishReason;

    // 第一个 chunk 时，发送 message_start - 按文档 3.3.2
    if (ctx.isFirstChunk && !ctx.streamState.has('message_started')) {
      events.push({
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: chunk.modelVersion || 'gemini-pro',
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
      ctx.streamState.set('message_started', true);
    }

    // 为每个 part 生成事件
    for (let partIdx = 0; partIdx < parts.length; partIdx++) {
      const part = parts[partIdx];

      // 第一个 chunk 时，发送 content_block_start
      if (ctx.isFirstChunk) {
        let contentBlock: any;

        if (part.functionCall) {
          contentBlock = {
            type: 'tool_use',
            id: `toolu_${Date.now()}_${partIdx}`,
            name: part.functionCall.name,
            input: {}
          };
        } else if (part.thought !== undefined) {
          contentBlock = {
            type: 'thinking',
            thinking: ''
          };
        } else {
          contentBlock = {
            type: 'text',
            text: ''
          };
        }

        events.push({
          type: 'content_block_start',
          index: partIdx,
          content_block: contentBlock
        });
      }

      // 发送 delta 事件
      if (part.functionCall) {
        // Tool use delta
        const argsKey = `part_${partIdx}_args_length`;
        const argsStr = JSON.stringify(part.functionCall.args || {});
        const lastArgsLength = ctx.streamState.get(argsKey) || 0;
        const currentArgsLength = argsStr.length;

        if (currentArgsLength > lastArgsLength) {
          const argsDelta = argsStr.substring(lastArgsLength);
          events.push({
            type: 'content_block_delta',
            index: partIdx,
            delta: {
              type: 'input_json_delta',
              partial_json: argsDelta
            }
          });
          ctx.streamState.set(argsKey, currentArgsLength);
        }
      } else if (part.thought !== undefined && typeof part.thought === 'string') {
        // Thinking delta
        const thinkingKey = `part_${partIdx}_thinking_length`;
        const lastLength = ctx.streamState.get(thinkingKey) || 0;
        const currentLength = part.thought.length;

        if (currentLength > lastLength) {
          const delta = part.thought.substring(lastLength);
          events.push({
            type: 'content_block_delta',
            index: partIdx,
            delta: {
              type: 'thinking_delta',
              thinking: delta
            }
          });
          ctx.streamState.set(thinkingKey, currentLength);
        }
      } else if (part.text !== undefined) {
        // Text delta
        const textKey = `part_${partIdx}_text_length`;
        const lastLength = ctx.streamState.get(textKey) || 0;
        const currentLength = part.text.length;

        if (currentLength > lastLength) {
          const delta = part.text.substring(lastLength);
          events.push({
            type: 'content_block_delta',
            index: partIdx,
            delta: {
              type: 'text_delta',
              text: delta
            }
          });
          ctx.streamState.set(textKey, currentLength);
        }
      }

      // 如果是最后一个 chunk，发送 content_block_stop
      if (hasFinish) {
        events.push({
          type: 'content_block_stop',
          index: partIdx
        });
      }
    }

    return events;
  }

  /**
   * 流结束时发送最终事件
   */
  async flushStream(_ctx: StreamChunkContext): Promise<any[]> {
    return [{
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn'
      }
    }, {
      type: 'message_stop'
    }];
  }
}

export default AnthropicToGeminiPlugin;
