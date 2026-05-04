/**
 * Anthropic to OpenAI Converter
 *
 * 将 Anthropic Messages API 格式转换为 OpenAI Chat Completions API 格式
 *
 * 转换规则：
 * - 请求：/v1/messages → /v1/chat/completions
 * - 请求：system → messages[0] (role=system)
 * - 请求：tool_result → tool role, tool_use → tool_calls
 * - 请求：thinking.effort / output_config.effort → reasoning_effort 映射
 * - 响应：OpenAI → Anthropic (tool_calls, thinking 标签)
 * - 响应：OpenAI SSE → Anthropic SSE 事件序列
 */

import type { AIConverter, MutableRequestContext, ResponseContext, StreamChunkContext } from './base';
import {
  generateAnthropicMessageId,
  mapOpenAIFinishReasonToAnthropic
} from './utils';

export class AnthropicToOpenAIConverter implements AIConverter {
  readonly from = 'anthropic';
  readonly to = 'openai';
  private configuredApiMode?: 'chat_completions' | 'responses';

  setApiMode(mode: unknown): void {
    if (typeof mode !== 'string') {
      this.configuredApiMode = undefined;
      return;
    }

    const normalized = mode.trim().toLowerCase();
    if (normalized === 'responses' || normalized === 'chat_completions') {
      this.configuredApiMode = normalized;
      return;
    }

    this.configuredApiMode = undefined;
  }

  setRuntimeOptions(options: unknown): void {
    if (!options || typeof options !== 'object') {
      this.setApiMode(undefined);
      return;
    }

    const value = options as Record<string, unknown>;
    this.setApiMode(value.anthropicToOpenAIApiMode);
  }

  private resolveTargetApiMode(): 'chat_completions' | 'responses' {
    if (this.configuredApiMode) {
      return this.configuredApiMode;
    }

    const raw = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    if (!raw) return 'chat_completions';

    const normalized = raw.trim().toLowerCase();
    if (normalized === 'responses' || normalized === 'chat_completions') {
      return normalized;
    }

    return 'chat_completions';
  }

  /**
   * 修改请求：转换为 OpenAI Chat Completions 格式
   */
  async onBeforeRequest(ctx: MutableRequestContext): Promise<void> {
    const body = ctx.body as any;
    if (!body) return;

    // 路径转换
    if (this.isAnthropicCountTokensPath(ctx.url.pathname)) {
      ctx.url.pathname = '/v1/chat/completions';
      ctx.body = this.buildOpenAICountTokensRequest(body);
      return;
    }

    if (ctx.url.pathname === '/v1/messages' || ctx.url.pathname === '/messages') {
      const targetApiMode = this.resolveTargetApiMode();

      if (targetApiMode === 'responses') {
        ctx.url.pathname = '/v1/responses';
        ctx.body = this.buildOpenAIResponsesRequest(body);
      } else {
        ctx.url.pathname = '/v1/chat/completions';
        ctx.body = this.buildOpenAIRequest(body);
      }
    }
  }

  private isAnthropicCountTokensPath(pathname: string): boolean {
    return pathname === '/v1/messages/count_tokens'
      || pathname === '/messages/count_tokens'
      || pathname.endsWith('/messages/count_tokens');
  }

  private buildOpenAICountTokensRequest(anthropicBody: any): any {
    const requestBody = {
      ...anthropicBody,
      max_tokens: 1,
      max_tokens_to_sample: 1,
      stream: false,
      thinking: undefined
    };

    const chatBody = this.buildOpenAIRequest(requestBody);
    chatBody.max_tokens = 1;
    chatBody.stream = false;

    delete chatBody.reasoning_effort;
    delete chatBody.max_completion_tokens;

    return chatBody;
  }

  /**
   * 构建 OpenAI 请求
   */
  private buildOpenAIRequest(anthropicBody: any): any {
    const openaiBody: any = {};

    if (typeof anthropicBody.model === 'string') {
      openaiBody.model = anthropicBody.model;
    }

    const messages: any[] = [];
    messages.push(...this.convertSystemMessages(anthropicBody.system));

    if (Array.isArray(anthropicBody.messages)) {
      for (const msg of anthropicBody.messages) {
        if (msg.role === 'user') {
          this.convertUserMessage(msg, messages);
        } else if (msg.role === 'assistant') {
          this.convertAssistantMessage(msg, messages);
        }
      }
    }

    this.normalizeOpenAISystemMessages(messages);
    openaiBody.messages = messages;
    if (!Array.isArray(openaiBody.messages) || openaiBody.messages.length === 0) {
      openaiBody.messages = [{ role: 'user', content: '' }];
    }

    const maxTokens = anthropicBody.max_tokens ?? anthropicBody.max_tokens_to_sample;
    if (maxTokens !== undefined) {
      if (typeof openaiBody.model === 'string' && this.isOpenAINumericOSeriesModel(openaiBody.model)) {
        openaiBody.max_completion_tokens = maxTokens;
      } else {
        openaiBody.max_tokens = maxTokens;
      }
    }

    if (anthropicBody.temperature !== undefined) {
      openaiBody.temperature = anthropicBody.temperature;
    }

    if (anthropicBody.top_p !== undefined) {
      openaiBody.top_p = anthropicBody.top_p;
    }

    if (anthropicBody.stop_sequences !== undefined) {
      openaiBody.stop = anthropicBody.stop_sequences;
    }

    if (anthropicBody.stream !== undefined) {
      openaiBody.stream = anthropicBody.stream;
    }

    if (Array.isArray(anthropicBody.tools)) {
      openaiBody.tools = anthropicBody.tools
        .filter((tool: any) => tool?.type !== 'BatchTool')
        .map((tool: any) => {
          const mappedTool: any = {
            type: 'function',
            function: {
              name: typeof tool?.name === 'string' ? tool.name : '',
              description: tool?.description,
              parameters: this.cleanOpenAIToolSchema(tool?.input_schema ?? {})
            }
          };
          if (tool.cache_control !== undefined) {
            mappedTool.cache_control = tool.cache_control;
          }
          return mappedTool;
        });

      if (openaiBody.tools.length === 0) {
        delete openaiBody.tools;
      }
    }

    if (anthropicBody.tool_choice !== undefined) {
      openaiBody.tool_choice = anthropicBody.tool_choice;
    }

    const promptCacheKey = this.resolvePromptCacheKey(anthropicBody);
    if (promptCacheKey) {
      openaiBody.prompt_cache_key = promptCacheKey;
    }

    const reasoningEffort = this.resolveAnthropicReasoningEffort(anthropicBody);
    if (reasoningEffort && this.supportsReasoningEffort(openaiBody.model)) {
      openaiBody.reasoning_effort = reasoningEffort;
    }

    return openaiBody;
  }

  private isOpenAINumericOSeriesModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    return normalized.length > 1 && normalized[0] === 'o' && /\d/.test(normalized[1]);
  }

  private buildOpenAIResponsesRequest(anthropicBody: any): any {
    const responsesBody: any = {};

    if (typeof anthropicBody.model === 'string') {
      responsesBody.model = anthropicBody.model;
    }

    const instructions = this.convertAnthropicSystemToInstructions(anthropicBody.system);
    if (instructions) {
      responsesBody.instructions = instructions;
    }

    const input = this.convertAnthropicMessagesToResponsesInput(anthropicBody.messages);
    if (input.length > 0) {
      responsesBody.input = input;
    }

    const maxTokens = anthropicBody.max_tokens ?? anthropicBody.max_tokens_to_sample;
    if (maxTokens !== undefined) {
      responsesBody.max_output_tokens = maxTokens;
    }

    if (anthropicBody.temperature !== undefined) {
      responsesBody.temperature = anthropicBody.temperature;
    }

    if (anthropicBody.top_p !== undefined) {
      responsesBody.top_p = anthropicBody.top_p;
    }

    if (anthropicBody.stream !== undefined) {
      responsesBody.stream = anthropicBody.stream;
    }

    if (Array.isArray(anthropicBody.tools)) {
      const tools = anthropicBody.tools
        .filter((tool: any) => tool?.type !== 'BatchTool')
        .map((tool: any) => ({
          type: 'function',
          name: tool.name || '',
          description: tool.description,
          parameters: this.normalizeToolParametersSchema(tool.input_schema)
        }));
      if (tools.length > 0) {
        responsesBody.tools = tools;
      }
    }

    const toolChoice = this.mapAnthropicToolChoiceToResponses(anthropicBody.tool_choice);
    if (toolChoice !== undefined) {
      responsesBody.tool_choice = toolChoice;
    }

    const reasoningEffort = this.resolveAnthropicReasoningEffort(anthropicBody);
    if (reasoningEffort && this.supportsReasoningEffort(responsesBody.model)) {
      responsesBody.reasoning = {
        effort: reasoningEffort
      };
    }

    const promptCacheKey = this.resolvePromptCacheKey(anthropicBody);
    if (promptCacheKey) {
      responsesBody.prompt_cache_key = promptCacheKey;
    }

    return responsesBody;
  }

  private convertAnthropicSystemToInstructions(system: unknown): string | undefined {
    if (typeof system === 'string') {
      const cleaned = this.sanitizeSystemText(system).trim();
      return cleaned || undefined;
    }

    if (!Array.isArray(system)) {
      return undefined;
    }

    const texts: string[] = [];
    for (const block of system) {
      if (typeof block === 'string') {
        const cleaned = this.sanitizeSystemText(block).trim();
        if (cleaned) texts.push(cleaned);
      } else if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        const cleaned = this.sanitizeSystemText(block.text).trim();
        if (cleaned) texts.push(cleaned);
      }
    }

    return texts.length > 0 ? texts.join('\n\n') : undefined;
  }

  private convertAnthropicMessagesToResponsesInput(messages: unknown): any[] {
    const input: any[] = [];

    if (!Array.isArray(messages)) {
      return input;
    }

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const content = msg.content;

      if (typeof content === 'string') {
        input.push({
          role,
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }]
        });
        continue;
      }

      if (Array.isArray(content)) {
        let contentItems: any[] = [];
        const flushContentItems = () => {
          if (contentItems.length > 0) {
            input.push({ role, content: contentItems });
            contentItems = [];
          }
        };

        for (const block of content) {
          if (!block || typeof block !== 'object') continue;

          switch (block.type) {
            case 'text':
              if (typeof block.text === 'string') {
                contentItems.push({
                  type: role === 'assistant' ? 'output_text' : 'input_text',
                  text: block.text
                });
              }
              break;

            case 'image':
              if (role !== 'assistant' && block.source) {
                const imageUrl = this.convertAnthropicImageSourceToUrl(block.source);
                if (imageUrl) {
                  contentItems.push({ type: 'input_image', image_url: imageUrl });
                }
              }
              break;

            case 'tool_use':
              flushContentItems();
              input.push({
                type: 'function_call',
                call_id: block.id || '',
                name: block.name || '',
                arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : '{}'
              });
              break;

            case 'tool_result':
              flushContentItems();
              input.push({
                type: 'function_call_output',
                call_id: block.tool_use_id || '',
                output: this.normalizeToolResultContent(block.content)
              });
              break;

            case 'thinking':
              break;
          }
        }

        flushContentItems();
        continue;
      }

      input.push({ role });
    }

    return input;
  }

  private convertAnthropicImageSourceToUrl(source: any): string | null {
    if (!source || typeof source !== 'object') return null;

    if (source.type === 'base64' && source.media_type && source.data) {
      return `data:${source.media_type};base64,${source.data}`;
    }

    return null;
  }

  private mapAnthropicToolChoiceToResponses(toolChoice: unknown): any {
    if (toolChoice === undefined || toolChoice === null) {
      return undefined;
    }

    if (typeof toolChoice === 'string') {
      return toolChoice;
    }

    if (typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
      return undefined;
    }

    const choice = toolChoice as Record<string, any>;
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';

    if (type === 'any') {
      return 'required';
    }

    if (type === 'auto') {
      return 'auto';
    }

    if (type === 'none') {
      return 'none';
    }

    if (type === 'tool') {
      return {
        type: 'function',
        name: typeof choice.name === 'string' ? choice.name : ''
      };
    }

    return toolChoice;
  }

  private resolveAnthropicReasoningEffort(anthropicBody: any): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    if (anthropicBody.output_config && typeof anthropicBody.output_config === 'object') {
      const effort = typeof anthropicBody.output_config.effort === 'string'
        ? anthropicBody.output_config.effort.trim().toLowerCase()
        : '';
      if (effort === 'low' || effort === 'medium' || effort === 'high') {
        return effort;
      }
      if (effort === 'max') {
        return 'xhigh';
      }
    }

    if (anthropicBody.thinking && typeof anthropicBody.thinking === 'object') {
      const thinkingType = typeof anthropicBody.thinking.type === 'string'
        ? anthropicBody.thinking.type.trim().toLowerCase()
        : '';

      const thinkingEffort = typeof anthropicBody.thinking.effort === 'string'
        ? anthropicBody.thinking.effort.trim().toLowerCase()
        : '';
      if (thinkingEffort === 'low' || thinkingEffort === 'medium' || thinkingEffort === 'high') {
        return thinkingEffort;
      }
      if (thinkingEffort === 'max') {
        return 'xhigh';
      }

      if (thinkingType === 'adaptive') {
        return 'xhigh';
      }

      if (thinkingType === 'enabled') {
        const budgetTokens = anthropicBody.thinking.budget_tokens;
        if (typeof budgetTokens === 'number') {
          if (budgetTokens < 4000) return 'low';
          if (budgetTokens < 16000) return 'medium';
        }
        return 'high';
      }

    }

    return undefined;
  }

  private supportsReasoningEffort(model: string | undefined): boolean {
    if (!model || typeof model !== 'string') {
      return false;
    }

    const normalized = model.trim().toLowerCase();

    if (normalized.length > 1 && normalized[0] === 'o' && /\d/.test(normalized[1])) {
      return true;
    }

    if (normalized.startsWith('gpt-')) {
      const match = normalized.match(/gpt-(\d+)/);
      if (match) {
        const version = parseInt(match[1], 10);
        return version >= 5;
      }
    }

    return false;
  }

  private convertSystemMessages(system: unknown): Array<{ role: 'system'; content: string; cache_control?: any }> {
    if (typeof system === 'string') {
      const content = this.sanitizeSystemText(system).trim();
      return content ? [{ role: 'system', content }] : [];
    }

    if (!Array.isArray(system)) {
      return [];
    }

    const results: Array<{ role: 'system'; content: string; cache_control?: any }> = [];
    for (const block of system) {
      if (typeof block === 'string') {
        const content = this.sanitizeSystemText(block).trim();
        if (content) {
          results.push({ role: 'system', content });
        }
        continue;
      }

      if (block && typeof block === 'object' && (block as any).type === 'text') {
        const content = typeof (block as any).text === 'string' ? this.sanitizeSystemText((block as any).text).trim() : '';
        if (content) {
          const message: { role: 'system'; content: string; cache_control?: any } = { role: 'system', content };
          if ((block as any).cache_control !== undefined) {
            message.cache_control = (block as any).cache_control;
          }
          results.push(message);
        }
      }
    }

    return results;
  }

  private sanitizeSystemText(text: string): string {
    return text
      .split(/(?<=\n)/)
      .filter((segment) => !segment.replace(/\n$/, '').trimStart().startsWith('x-anthropic-billing-header:'))
      .join('');
  }

  private extractTextFromOpenAIContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((part: any) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '')
      .filter((text: string) => text.length > 0)
      .join('\n');
  }

  private normalizeOpenAISystemMessages(messages: any[]): void {
    const systemMessages = messages.filter((message) => message?.role === 'system');
    if (systemMessages.length === 0) {
      return;
    }

    if (systemMessages.length === 1) {
      const index = messages.indexOf(systemMessages[0]);
      if (index > 0) {
        messages.splice(index, 1);
        messages.unshift(systemMessages[0]);
      }
      return;
    }

    const combinedContent = systemMessages
      .map((message) => this.extractTextFromOpenAIContent(message.content))
      .filter((text) => text.length > 0)
      .join('\n');
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'system') {
        messages.splice(index, 1);
      }
    }

    if (combinedContent) {
      messages.unshift({
        role: 'system',
        content: combinedContent
      });
    }
  }

  /**
   * 转换 User 消息
   */
  private normalizeToolResultContent(content: any): string {
    if (content === undefined || content === null) {
      return '';
    }

    if (typeof content === 'string') {
      return content;
    }

    if (typeof content === 'object') return JSON.stringify(content);

    return String(content);
  }

  private convertUserMessage(msg: any, messages: any[]): void {
    const content = msg.content;

    if (content === undefined) {
      messages.push({ role: 'user', content: null });
      return;
    }

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
      const hasToolResult = content.some((block: any) => block?.type === 'tool_result');

      if (hasToolResult) {
        for (const block of content) {
          const toolUseId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : '';
          if (block?.type !== 'tool_result') {
            continue;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolUseId,
            content: this.normalizeToolResultContent(block.content)
          });
        }
      }

      const userContentBlocks = content
        .filter((block: any) => block?.type !== 'tool_result')
        .map((block: any) => this.convertUserContentBlock(block))
        .filter((block: any): block is Record<string, any> => block !== null);

      if (userContentBlocks.length > 0) {
        messages.push({
          role: 'user',
          content: this.normalizeOpenAIMessageContent(userContentBlocks)
        });
      }
      return;
    }

    messages.push({ role: 'user', content });
  }

  private convertUserContentBlock(block: any): any | null {
    if (!block || typeof block !== 'object') {
      return null;
    }

    if (block.type === 'text') {
      const textBlock: any = {
        type: 'text',
        text: block.text || ''
      };
      if (block.cache_control !== undefined) {
        textBlock.cache_control = block.cache_control;
      }
      return textBlock;
    }

    if (block.type === 'image' && block.source) {
      const mediaType = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
      const data = typeof block.source.data === 'string' ? block.source.data : '';
      return {
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${data}` }
      };
    }

    return null;
  }

  /**
   * 转换 Assistant 消息
   */
  private convertAssistantMessage(msg: any, messages: any[]): void {
    const content = msg.content;

    if (content === undefined) {
      messages.push({ role: 'assistant', content: null });
      return;
    }

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
      const contentParts: any[] = [];
      const toolCalls: any[] = [];

      for (const block of content) {
        if (!block || typeof block !== 'object') continue;

        if (block.type === 'text' && typeof block.text === 'string') {
          const textBlock: any = { type: 'text', text: block.text };
          if (block.cache_control !== undefined) {
            textBlock.cache_control = block.cache_control;
          }
          contentParts.push(textBlock);
          continue;
        }

        if (block.type === 'tool_use') {
          toolCalls.push({
            id: typeof block.id === 'string' ? block.id : '',
            type: 'function',
            function: {
              name: typeof block.name === 'string' ? block.name : '',
              arguments: JSON.stringify(block.input ?? {})
            }
          });
        }
      }

      if (contentParts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: contentParts.length > 0 ? this.normalizeOpenAIMessageContent(contentParts) : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        });
      }
      return;
    }

    messages.push({ role: 'assistant', content });
  }

  private normalizeOpenAIMessageContent(contentParts: any[]): any {
    if (contentParts.length === 1) {
      const first = contentParts[0];
      if (first?.type === 'text' && first.cache_control === undefined) {
        return first.text;
      }
    }

    return contentParts;
  }

  private normalizeToolParametersSchema(schema: unknown): Record<string, any> {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return { type: 'object', properties: {} };
    }

    const normalized = this.normalizeJsonSchema(schema as Record<string, any>);
    const typeValue = typeof normalized.type === 'string' ? normalized.type.toLowerCase() : '';
    if (typeValue === 'object') {
      const hasValidProperties = normalized.properties && typeof normalized.properties === 'object' && !Array.isArray(normalized.properties);
      if (!hasValidProperties) {
        normalized.properties = {};
      }
    }

    return normalized;
  }

  private cleanOpenAIToolSchema(schema: unknown): any {
    return this.normalizeJsonSchema(schema);
  }

  private resolvePromptCacheKey(anthropicBody: any): string | undefined {
    const candidates = [
      anthropicBody?.prompt_cache_key,
      anthropicBody?.metadata?.prompt_cache_key,
      anthropicBody?.metadata?.provider_id,
      anthropicBody?.metadata?.providerId
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private normalizeJsonSchema(schema: unknown): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.normalizeJsonSchema(item));
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'format' && value === 'uri') {
        continue;
      }

      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        const normalizedProperties: Record<string, any> = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          normalizedProperties[propName] = this.normalizeJsonSchema(propSchema);
        }
        result[key] = normalizedProperties;
        continue;
      }

      result[key] = this.normalizeJsonSchema(value);
    }

    const typeValue = typeof result.type === 'string' ? result.type.toLowerCase() : '';
    if (typeValue === 'object') {
      const hasValidProperties = result.properties && typeof result.properties === 'object' && !Array.isArray(result.properties);
      if (!hasValidProperties) {
        result.properties = {};
      }
    }

    return result;
  }

  /**
   * 处理非流式响应：OpenAI → Anthropic
   */
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

    const originalPathname = typeof ctx.originalUrl?.pathname === 'string' ? ctx.originalUrl.pathname : '';
    if (this.isAnthropicCountTokensPath(originalPathname)) {
      if (!ctx.response.ok) {
        if (!this.isLikelyOpenAIErrorBody(openaiBody)) {
          return ctx.response;
        }
        const anthropicError = this.convertOpenAIErrorToAnthropic(openaiBody, ctx.response.status);
        return new Response(JSON.stringify(anthropicError), {
          status: ctx.response.status,
          statusText: ctx.response.statusText,
          headers: ctx.response.headers
        });
      }

      if (!this.isLikelyOpenAICountTokensBody(openaiBody)) {
        return ctx.response;
      }

      const inputTokens = this.extractCountTokensInput(openaiBody);
      return new Response(JSON.stringify({ input_tokens: inputTokens }), {
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        headers: ctx.response.headers
      });
    }

    if (!ctx.response.ok) {
      if (!this.isLikelyOpenAIErrorBody(openaiBody)) {
        return ctx.response;
      }
      const anthropicError = this.convertOpenAIErrorToAnthropic(openaiBody, ctx.response.status);
      return new Response(JSON.stringify(anthropicError), {
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        headers: ctx.response.headers
      });
    }

    if (this.isLikelyOpenAIErrorBody(openaiBody) && !this.isLikelyOpenAISuccessBody(openaiBody)) {
      const anthropicError = this.convertOpenAIErrorToAnthropic(openaiBody, ctx.response.status);
      return new Response(JSON.stringify(anthropicError), {
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        headers: ctx.response.headers
      });
    }

    if (!this.isLikelyOpenAISuccessBody(openaiBody)) {
      return ctx.response;
    }

    const anthropicBody = this.isResponsesApiBody(openaiBody)
      ? this.convertOpenAIResponsesToAnthropic(openaiBody)
      : this.convertOpenAIResponseToAnthropic(openaiBody);

    return new Response(JSON.stringify(anthropicBody), {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers
    });
  }

  private extractCountTokensInput(openaiBody: any): number {
    const directInputTokens = openaiBody?.input_tokens;
    if (typeof directInputTokens === 'number' && Number.isFinite(directInputTokens) && directInputTokens >= 0) {
      return directInputTokens;
    }

    const promptTokens = openaiBody?.usage?.prompt_tokens;
    if (typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens >= 0) {
      return promptTokens;
    }

    const inputTokens = openaiBody?.usage?.input_tokens;
    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0) {
      return inputTokens;
    }

    return 0;
  }

  private convertOpenAIErrorToAnthropic(openaiBody: any, status: number): any {
    void status;
    const message =
      (typeof openaiBody?.error?.message === 'string' && openaiBody.error.message)
      || (typeof openaiBody?.message === 'string' && openaiBody.message)
      || 'Upstream error';
    const type = typeof openaiBody?.error?.type === 'string' && openaiBody.error.type.length > 0
      ? openaiBody.error.type
      : 'invalid_request_error';

    return {
      type: 'error',
      error: {
        type,
        message
      }
    };
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

  private isLikelyOpenAICountTokensBody(body: any): boolean {
    if (!body || typeof body !== 'object') {
      return false;
    }

    if (typeof body.input_tokens === 'number') {
      return true;
    }

    const usage = body.usage;
    if (!usage || typeof usage !== 'object') {
      return false;
    }

    return typeof usage.prompt_tokens === 'number' || typeof usage.input_tokens === 'number';
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

  private isResponsesApiBody(openaiBody: any): boolean {
    if (!openaiBody || typeof openaiBody !== 'object') {
      return false;
    }

    if (openaiBody.object === 'response') {
      return true;
    }

    return Array.isArray(openaiBody.output) && !Array.isArray(openaiBody.choices);
  }

  private extractReasoningSummaryTexts(reasoningItem: any): string[] {
    const texts: string[] = [];

    const pushText = (value: unknown) => {
      if (typeof value !== 'string') return;
      const normalized = value.trim();
      if (!normalized) return;
      texts.push(normalized);
    };

    if (!reasoningItem || typeof reasoningItem !== 'object') {
      return texts;
    }

    if (Array.isArray(reasoningItem.summary)) {
      for (const item of reasoningItem.summary) {
        if (typeof item === 'string') {
          pushText(item);
          continue;
        }

        if (!item || typeof item !== 'object') continue;
        if (item.type === 'summary_text') {
          pushText(item.text);
          continue;
        }

        pushText(item.text);
      }
    } else {
      pushText(reasoningItem.summary);
    }

    if (texts.length === 0) {
      pushText(reasoningItem.text);
    }

    if (texts.length === 0) {
      pushText(reasoningItem.delta);
    }

    return texts;
  }

  private extractStrictResponsesReasoningText(reasoningItem: any): string {
    if (!reasoningItem || typeof reasoningItem !== 'object' || !Array.isArray(reasoningItem.summary)) {
      return '';
    }

    return reasoningItem.summary
      .filter((item: any) => item?.type === 'summary_text' && typeof item.text === 'string')
      .map((item: any) => item.text)
      .join('');
  }

  private extractReasoningTextFromDeltaContentPart(part: any): string {
    if (!part || typeof part !== 'object') {
      return '';
    }

    const partType = typeof part.type === 'string' ? part.type : '';
    const isReasoningPart = partType === 'reasoning' || partType === 'thinking' || part.thought === true;
    if (!isReasoningPart) {
      return '';
    }

    const texts = this.extractReasoningSummaryTexts(part);
    if (texts.length > 0) {
      return texts.join('');
    }

    if (typeof part.text === 'string') {
      return part.text;
    }

    return '';
  }

  private extractChatThinkingDelta(delta: any): string {
    if (!delta || typeof delta !== 'object') {
      return '';
    }

    const chunks: string[] = [];

    const pushChunk = (value: unknown) => {
      if (typeof value !== 'string' || value.length === 0) return;
      chunks.push(value);
    };

    pushChunk(delta.reasoning_content);
    if (typeof delta.reasoning === 'string') {
      pushChunk(delta.reasoning);
    } else if (delta.reasoning && typeof delta.reasoning === 'object') {
      pushChunk(this.extractReasoningSummaryTexts(delta.reasoning).join(''));
    }

    if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        pushChunk(this.extractReasoningTextFromDeltaContentPart(part));
      }
    }

    return chunks.join('');
  }

  private getChatUsedIndices(ctx: StreamChunkContext): Set<number> {
    const existing = ctx.streamState.get('chat_used_indices');
    if (existing instanceof Set) {
      return existing as Set<number>;
    }

    const created = new Set<number>();
    ctx.streamState.set('chat_used_indices', created);
    return created;
  }

  private allocateChatContentBlockIndex(ctx: StreamChunkContext, preferredIndex: number, minIndex: number): number {
    const used = this.getChatUsedIndices(ctx);

    let candidate = Number.isFinite(preferredIndex) ? Math.trunc(preferredIndex) : minIndex;
    if (candidate < minIndex) {
      candidate = minIndex;
    }

    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }

    candidate = minIndex;
    while (used.has(candidate)) {
      candidate += 1;
    }

    used.add(candidate);
    return candidate;
  }

  private ensureChatTextBlockStarted(events: any[], ctx: StreamChunkContext): number {
    const existing = ctx.streamState.get('chat_text_index');
    if (typeof existing === 'number' && Number.isFinite(existing)) {
      return existing;
    }

    const index = this.allocateChatContentBlockIndex(ctx, 0, 0);
    events.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'text',
        text: ''
      }
    });

    ctx.streamState.set('chat_text_index', index);
    ctx.streamState.set('text_block_started', true);
    return index;
  }

  private ensureChatThinkingBlockStarted(events: any[], ctx: StreamChunkContext): number {
    const existing = ctx.streamState.get('chat_thinking_index');
    if (typeof existing === 'number' && Number.isFinite(existing)) {
      return existing;
    }

    const index = this.allocateChatContentBlockIndex(ctx, 1, 1);
    events.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'thinking',
        thinking: ''
      }
    });

    ctx.streamState.set('chat_thinking_index', index);
    return index;
  }

  private closeChatNonToolBlock(events: any[], ctx: StreamChunkContext): void {
    const textIndex = ctx.streamState.get('chat_text_index');
    if (typeof textIndex === 'number' && Number.isFinite(textIndex)) {
      events.push({ type: 'content_block_stop', index: textIndex });
      ctx.streamState.delete('chat_text_index');
      ctx.streamState.delete('text_block_started');
    }

    const thinkingIndex = ctx.streamState.get('chat_thinking_index');
    if (typeof thinkingIndex === 'number' && Number.isFinite(thinkingIndex)) {
      events.push({ type: 'content_block_stop', index: thinkingIndex });
      ctx.streamState.delete('chat_thinking_index');
    }
  }

  private resolveChatToolIndex(rawIndex: number, ctx: StreamChunkContext): number {
    const normalizedRawIndex = Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : 0;
    const mapKey = `chat_tool_index_${normalizedRawIndex}`;
    const existing = ctx.streamState.get(mapKey);
    if (typeof existing === 'number' && Number.isFinite(existing)) {
      return existing;
    }

    const resolved = this.allocateChatContentBlockIndex(ctx, normalizedRawIndex, 0);
    ctx.streamState.set(mapKey, resolved);
    return resolved;
  }

  private resolveResponsesReasoningIndex(chunk: any, item: any, ctx: StreamChunkContext): number {
    const outputIndex = typeof chunk?.output_index === 'number'
      ? chunk.output_index
      : typeof item?.output_index === 'number'
        ? item.output_index
        : undefined;

    if (typeof outputIndex === 'number' && Number.isFinite(outputIndex)) {
      return outputIndex + 1;
    }

    const itemId = typeof chunk?.item_id === 'string'
      ? chunk.item_id
      : typeof item?.id === 'string'
        ? item.id
        : '';

    if (itemId) {
      const mappedIndex = ctx.streamState.get(`resp_reasoning_item_${itemId}`);
      if (typeof mappedIndex === 'number' && Number.isFinite(mappedIndex)) {
        return mappedIndex;
      }
    }

    return 1;
  }

  private nextResponsesContentIndex(ctx: StreamChunkContext): number {
    const current = ctx.streamState.get('resp_next_content_index');
    const next = typeof current === 'number' && Number.isFinite(current) ? current : 0;
    ctx.streamState.set('resp_next_content_index', next + 1);
    return next;
  }

  private resolveResponsesContentIndex(chunk: any, ctx: StreamChunkContext): number {
    const itemId = typeof chunk?.item_id === 'string' ? chunk.item_id : '';
    const contentIndex = typeof chunk?.content_index === 'number' ? chunk.content_index : undefined;
    const outputIndex = typeof chunk?.output_index === 'number' ? chunk.output_index : undefined;
    const key = itemId && contentIndex !== undefined
      ? `resp_part_${itemId}_${contentIndex}`
      : outputIndex !== undefined && contentIndex !== undefined
        ? `resp_part_out_${outputIndex}_${contentIndex}`
        : '';

    if (key) {
      const existing = ctx.streamState.get(key);
      if (typeof existing === 'number' && Number.isFinite(existing)) return existing;
      const assigned = this.nextResponsesContentIndex(ctx);
      ctx.streamState.set(key, assigned);
      return assigned;
    }

    const fallback = ctx.streamState.get('resp_fallback_text_index');
    if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
    const assigned = this.nextResponsesContentIndex(ctx);
    ctx.streamState.set('resp_fallback_text_index', assigned);
    return assigned;
  }

  private ensureResponsesTextBlockStarted(events: any[], ctx: StreamChunkContext, index: number): void {
    const key = `resp_text_block_${index}`;
    if (ctx.streamState.get(key) === true) return;
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' }
    });
    ctx.streamState.set(key, true);
  }

  private resolveResponsesToolIndex(chunk: any, ctx: StreamChunkContext): number | undefined {
    const itemId = typeof chunk?.item_id === 'string' ? chunk.item_id : '';
    if (itemId) {
      const byItem = ctx.streamState.get(`resp_tool_item_${itemId}`);
      if (typeof byItem === 'number' && Number.isFinite(byItem)) return byItem;
    }

    const outputIndex = typeof chunk?.output_index === 'number' ? chunk.output_index : undefined;
    if (outputIndex !== undefined) {
      const byOutput = ctx.streamState.get(`resp_tool_out_${outputIndex}`);
      if (typeof byOutput === 'number' && Number.isFinite(byOutput)) return byOutput;
    }

    const last = ctx.streamState.get('resp_last_tool_index');
    return typeof last === 'number' && Number.isFinite(last) ? last : undefined;
  }

  private ensureResponsesThinkingBlockStarted(events: any[], ctx: StreamChunkContext, index: number): void {
    const blockKey = `resp_reasoning_block_${index}`;
    if (ctx.streamState.get(blockKey) === true) {
      return;
    }

    events.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'thinking',
        thinking: ''
      }
    });
    ctx.streamState.set(blockKey, true);
  }

  private emitResponsesThinkingDelta(events: any[], ctx: StreamChunkContext, index: number, text: string): void {
    if (typeof text !== 'string' || text.length === 0) {
      return;
    }

    events.push({
      type: 'content_block_delta',
      index,
      delta: {
        type: 'thinking_delta',
        thinking: text
      }
    });
    ctx.streamState.set(`resp_reasoning_has_delta_${index}`, true);
  }

  private extractResponsesReasoningDeltaText(chunk: any): string {
    if (!chunk || typeof chunk !== 'object') {
      return '';
    }

    if (typeof chunk.delta === 'string') {
      return chunk.delta;
    }

    if (typeof chunk.text === 'string') {
      return chunk.text;
    }

    if (typeof chunk.summary_text === 'string') {
      return chunk.summary_text;
    }

    if (chunk.delta && typeof chunk.delta === 'object' && typeof chunk.delta.text === 'string') {
      return chunk.delta.text;
    }

    return '';
  }

  private convertOpenAIResponsesToAnthropic(openaiBody: any): any {
    const content: any[] = [];
    const output = Array.isArray(openaiBody.output) ? openaiBody.output : [];
    let hasToolUse = false;

    for (const item of output) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'reasoning') {
        const thinkingText = this.extractStrictResponsesReasoningText(item);
        if (thinkingText) {
          content.push({
            type: 'thinking',
            thinking: thinkingText
          });
        }
        continue;
      }

      if (item.type === 'function_call') {
        let parsedInput: Record<string, any> = {};
        const rawArgs = item.arguments;
        if (typeof rawArgs === 'string') {
          try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              parsedInput = parsed;
            }
          } catch {
            parsedInput = {};
          }
        }

        content.push({
          type: 'tool_use',
          id: item.call_id || item.id || '',
          name: item.name || '',
          input: parsedInput
        });
        hasToolUse = true;
        continue;
      }

      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'output_text' && typeof part.text === 'string') {
            if (part.text) content.push({ type: 'text', text: part.text });
            continue;
          }

          if (part.type === 'refusal' && typeof part.refusal === 'string') {
            if (part.refusal) content.push({ type: 'text', text: part.refusal });
          }
        }
      }
    }

    const stopReason = this.mapResponsesStopReason(openaiBody.status, hasToolUse, openaiBody.incomplete_details?.reason);
    const usage = this.buildAnthropicUsageFromResponses(openaiBody.usage);

    return {
      id: typeof openaiBody.id === 'string' ? openaiBody.id : '',
      type: 'message',
      role: 'assistant',
      content,
      model: typeof openaiBody.model === 'string' ? openaiBody.model : '',
      stop_reason: stopReason,
      stop_sequence: null,
      usage
    };
  }

  private mapResponsesStopReason(status: unknown, hasToolUse: boolean, incompleteReason: unknown): string | null {
    if (typeof status !== 'string') {
      return null;
    }

    if (status === 'completed') {
      return hasToolUse ? 'tool_use' : 'end_turn';
    }

    if (status === 'incomplete') {
      return incompleteReason === undefined || incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens'
        ? 'max_tokens'
        : 'end_turn';
    }

    return 'end_turn';
  }

  private buildAnthropicUsageFromResponses(usage: any): any {
    if (!usage || typeof usage !== 'object') {
      return { input_tokens: 0, output_tokens: 0 };
    }

    const result: any = {
      input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
    };

    const cachedFromInput = usage.input_tokens_details?.cached_tokens;
    const cachedFromPrompt = usage.prompt_tokens_details?.cached_tokens;
    if (typeof cachedFromInput === 'number') {
      result.cache_read_input_tokens = cachedFromInput;
    } else if (typeof cachedFromPrompt === 'number') {
      result.cache_read_input_tokens = cachedFromPrompt;
    }

    if (usage.cache_read_input_tokens !== undefined) {
      result.cache_read_input_tokens = usage.cache_read_input_tokens;
    }
    if (usage.cache_creation_input_tokens !== undefined) {
      result.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    }

    return result;
  }

  /**
   * 转换 OpenAI 响应为 Anthropic 格式
   */
  private convertOpenAIResponseToAnthropic(openaiBody: any): any {
    const choice = openaiBody.choices?.[0];
    if (!choice) {
      return {
        id: generateAnthropicMessageId(),
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

    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

    if (message.refusal && typeof message.refusal === 'string') {
      content.push({
        type: 'text',
        text: message.refusal
      });
    }

    if (typeof message.content === 'string' && message.content.length > 0) {
      content.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if ((part?.type === 'text' || part?.type === 'output_text') && typeof part.text === 'string') {
          if (part.text) content.push({ type: 'text', text: part.text });
          continue;
        }

        if (part?.type === 'refusal' && typeof part.refusal === 'string') {
          if (part.refusal) content.push({ type: 'text', text: part.refusal });
          continue;
        }
      }
    }

    if (hasToolCalls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id || '',
          name: tc.function?.name || '',
          input: this.parseToolArguments(tc.function?.arguments)
        });
      }
    }

    if (!hasToolCalls && message.function_call) {
      const functionCall = message.function_call;
      const hasArguments = functionCall.arguments !== undefined;
      const name = typeof functionCall.name === 'string' ? functionCall.name : '';
      if (name || hasArguments) {
        content.push({
          type: 'tool_use',
          id: typeof functionCall.id === 'string' ? functionCall.id : '',
          name,
          input: typeof functionCall.arguments === 'string'
            ? this.parseToolArguments(functionCall.arguments)
            : functionCall.arguments && typeof functionCall.arguments === 'object'
              ? functionCall.arguments
              : {}
        });
      }
    }

    let stopReason = mapOpenAIFinishReasonToAnthropic(choice.finish_reason || 'stop');
    if (!choice.finish_reason && content.some((block) => block.type === 'tool_use')) {
      stopReason = 'tool_use';
    }

    const usage: any = {
      input_tokens: openaiBody.usage?.prompt_tokens ?? openaiBody.usage?.input_tokens ?? 0,
      output_tokens: openaiBody.usage?.completion_tokens ?? openaiBody.usage?.output_tokens ?? 0
    };

    const cacheReadTokens = openaiBody.usage?.prompt_tokens_details?.cached_tokens
      ?? openaiBody.usage?.cache_read_input_tokens;
    if (typeof cacheReadTokens === 'number') {
      usage.cache_read_input_tokens = cacheReadTokens;
    }

    const cacheCreationTokens = openaiBody.usage?.cache_creation_input_tokens;
    if (typeof cacheCreationTokens === 'number') {
      usage.cache_creation_input_tokens = cacheCreationTokens;
    }

    return {
      id: typeof openaiBody.id === 'string' ? openaiBody.id : '',
      type: 'message',
      role: 'assistant',
      content,
      model: typeof openaiBody.model === 'string' ? openaiBody.model : '',
      stop_reason: stopReason,
      stop_sequence: null,
      usage
    };
  }

  private parseToolArguments(argumentsValue: unknown): Record<string, any> {
    if (typeof argumentsValue !== 'string') {
      return {};
    }

    try {
      const parsedValue = JSON.parse(argumentsValue || '{}');
      return parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
        ? parsedValue as Record<string, any>
        : {};
    } catch {
      return {};
    }
  }

  /**
   * 处理流式响应：OpenAI chunk → Anthropic SSE
   */
  async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
    if (this.isResponsesStreamChunk(chunk)) {
      return this.processResponsesStreamChunk(chunk, ctx);
    }

    const events: any[] = [];
    const streamUsage = this.extractOpenAIStreamUsage(chunk);
    if (streamUsage) {
      ctx.streamState.set('latest_usage', streamUsage);
    }

    const choice = chunk.choices?.[0];

    if (!choice) {
      const pendingStopReason = ctx.streamState.get('pending_stop_reason');
      if (pendingStopReason && streamUsage) {
        events.push({
          type: 'message_delta',
          delta: {
            stop_reason: pendingStopReason
          },
          usage: streamUsage
        });

        events.push({
          type: 'message_stop'
        });

        ctx.streamState.clear();
        return events;
      }

      return [];
    }

    const delta = choice.delta;
    const thinkingDeltaText = this.extractChatThinkingDelta(delta);
    const deltaText = this.extractDeltaText(delta?.content);
    const finishReason = choice.finish_reason;

    // 首次接收非空 delta - 发送 message_start
    if (!ctx.streamState.has('message_started')) {
      if (delta && (delta.content || delta.tool_calls || delta.function_call || delta.role || thinkingDeltaText)) {
        events.push({
          type: 'message_start',
          message: {
            id: chunk.id || generateAnthropicMessageId(),
            type: 'message',
            role: 'assistant',
            content: [],
            model: chunk.model || '',
            usage: streamUsage || { input_tokens: 0, output_tokens: 0 }
          }
        });
        ctx.streamState.set('message_started', true);
      }
    }

    if (thinkingDeltaText) {
      const textIndex = ctx.streamState.get('chat_text_index');
      if (typeof textIndex === 'number' && Number.isFinite(textIndex)) {
        events.push({ type: 'content_block_stop', index: textIndex });
        ctx.streamState.delete('chat_text_index');
        ctx.streamState.delete('text_block_started');
      }
      const thinkingIndex = this.ensureChatThinkingBlockStarted(events, ctx);

      events.push({
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: {
          type: 'thinking_delta',
          thinking: thinkingDeltaText
        }
      });
    }

    // 文本增量
    if (deltaText) {
      const thinkingIndex = ctx.streamState.get('chat_thinking_index');
      if (typeof thinkingIndex === 'number' && Number.isFinite(thinkingIndex)) {
        events.push({ type: 'content_block_stop', index: thinkingIndex });
        ctx.streamState.delete('chat_thinking_index');
      }
      const textIndex = this.ensureChatTextBlockStarted(events, ctx);

      events.push({
        type: 'content_block_delta',
        index: textIndex,
        delta: {
          type: 'text_delta',
          text: deltaText
        }
      });
    }

    // 工具调用增量
    if (delta?.tool_calls) {
      this.closeChatNonToolBlock(events, ctx);
      for (const tc of delta.tool_calls) {
        const rawIndex = typeof tc.index === 'number' ? tc.index : 0;
        const index = this.resolveChatToolIndex(rawIndex, ctx);
        const toolKey = `tool_${index}`;

        if (!ctx.streamState.has(toolKey)) {
          ctx.streamState.set(toolKey, {
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: '',
            started: false
          });
        }

        const toolState = ctx.streamState.get(toolKey) as any;
        if (typeof tc.id === 'string') toolState.id = tc.id;
        if (typeof tc.function?.name === 'string') toolState.name = tc.function.name;

        const argsDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
        if (!toolState.started && toolState.id && toolState.name) {
          toolState.started = true;
          events.push({
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: toolState.id,
              name: toolState.name,
              input: {}
            }
          });

          if (toolState.arguments) {
            events.push({
              type: 'content_block_delta',
              index,
              delta: {
                type: 'input_json_delta',
                partial_json: toolState.arguments
              }
            });
            toolState.arguments = '';
          }
        }

        if (argsDelta) {
          if (toolState.started) {
            events.push({
              type: 'content_block_delta',
              index,
              delta: {
                type: 'input_json_delta',
                partial_json: argsDelta
              }
            });
          } else {
            toolState.arguments += argsDelta;
          }
          ctx.streamState.set(toolKey, toolState);
        }
      }
    }

    if (delta?.function_call) {
      this.closeChatNonToolBlock(events, ctx);
      const functionCall = delta.function_call;
      if (typeof functionCall.name === 'string') {
        ctx.streamState.set('legacy_function_name', functionCall.name);
      }
      if (!ctx.streamState.has('legacy_function_index')) {
        const index = this.allocateChatContentBlockIndex(ctx, 0, 0);
        ctx.streamState.set('legacy_function_index', index);
        events.push({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: '',
            name: ctx.streamState.get('legacy_function_name') || '',
            input: {}
          }
        });
      }
      const index = ctx.streamState.get('legacy_function_index') as number;
      if (typeof functionCall.arguments === 'string' && functionCall.arguments.length > 0) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: functionCall.arguments
          }
        });
      }
    }

    // 完成时
    if (finishReason) {
      this.closeChatNonToolBlock(events, ctx);

      const legacyFunctionIndex = ctx.streamState.get('legacy_function_index');
      if (typeof legacyFunctionIndex === 'number' && Number.isFinite(legacyFunctionIndex)) {
        events.push({ type: 'content_block_stop', index: legacyFunctionIndex });
      }

      const toolKeys = Array.from(ctx.streamState.keys())
        .filter(k => k.startsWith('tool_'))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
      for (const toolKey of toolKeys) {
        const toolIndex = Number(toolKey.slice(5));
        const toolState = ctx.streamState.get(toolKey) as any;
        if (toolState && !toolState.started && (toolState.arguments || toolState.id || toolState.name)) {
          const fallbackId = toolState.id || `tool_call_${toolIndex}`;
          const fallbackName = toolState.name || 'unknown_tool';
          events.push({
            type: 'content_block_start',
            index: Number.isFinite(toolIndex) ? toolIndex : 0,
            content_block: {
              type: 'tool_use',
              id: fallbackId,
              name: fallbackName,
              input: {}
            }
          });
          if (toolState.arguments) {
            events.push({
              type: 'content_block_delta',
              index: Number.isFinite(toolIndex) ? toolIndex : 0,
              delta: {
                type: 'input_json_delta',
                partial_json: toolState.arguments
              }
            });
          }
        }
        events.push({
          type: 'content_block_stop',
          index: Number.isFinite(toolIndex) ? toolIndex : 0
        });
      }

      const stopReason = mapOpenAIFinishReasonToAnthropic(finishReason);

      const latestUsage = (ctx.streamState.get('latest_usage') as Record<string, number> | undefined) || streamUsage;
      if (latestUsage) {
        events.push({
          type: 'message_delta',
          delta: {
            stop_reason: stopReason
          },
          usage: latestUsage
        });

        events.push({
          type: 'message_stop'
        });

        ctx.streamState.clear();
      } else {
        ctx.streamState.set('pending_stop_reason', stopReason);
      }
    }

    return events;
  }

  /**
   * 刷新流 - 确保流结束
   */
  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    if (ctx.streamState.has('message_started') && !ctx.streamState.has('flushed')) {
      ctx.streamState.set('flushed', true);

      const pendingStopReason = ctx.streamState.get('pending_stop_reason') as string | undefined;
      if (pendingStopReason) {
        const latestUsage = ctx.streamState.get('latest_usage') as Record<string, number> | undefined;
        const out: any[] = [{
          type: 'message_delta',
          delta: {
            stop_reason: pendingStopReason
          },
          ...(latestUsage && { usage: latestUsage })
        }, {
          type: 'message_stop'
        }];
        ctx.streamState.clear();
        return out;
      }

      const latestUsage = ctx.streamState.get('latest_usage') as Record<string, number> | undefined;
      ctx.streamState.clear();
      return [{
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn'
        },
        ...(latestUsage && { usage: latestUsage })
      }, {
        type: 'message_stop'
      }];
    }
    return [];
  }

  private isResponsesStreamChunk(chunk: any): boolean {
    const eventType = typeof chunk?._event === 'string' ? chunk._event : '';
    const type = typeof chunk?.type === 'string' ? chunk.type : '';
    if (eventType.startsWith('response.')) return true;
    if (type.startsWith('response.')) return true;
    return false;
  }

  private async processResponsesStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
    const events: any[] = [];
    const eventType = typeof chunk?._event === 'string' && chunk._event.length > 0 ? chunk._event : chunk.type;
    const ensureMessageStarted = () => {
      if (!ctx.streamState.has('message_started')) {
        events.push({
          type: 'message_start',
          message: {
            id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
            type: 'message',
            role: 'assistant',
            content: [],
            model: chunk.response?.model || '',
            usage: this.buildAnthropicUsageFromResponses(chunk.response?.usage)
          }
        });
        ctx.streamState.set('message_started', true);
      }
    };
    const currentResponseId = typeof chunk?.response?.id === 'string'
      ? chunk.response.id
      : typeof chunk?.response_id === 'string'
        ? chunk.response_id
        : undefined;
    const terminalEmitted = ctx.streamState.get('resp_terminal_emitted') === true;
    const terminalResponseId = ctx.streamState.get('resp_terminal_response_id');
    const sameTerminalStream = !terminalResponseId || !currentResponseId || terminalResponseId === currentResponseId;

    if (terminalEmitted && sameTerminalStream) {
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (terminalEmitted && terminalResponseId && currentResponseId && terminalResponseId !== currentResponseId) {
      ctx.streamState.delete('resp_terminal_emitted');
      ctx.streamState.delete('resp_terminal_response_id');
    }

    if (eventType === 'response.created') {
      ensureMessageStarted();
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.content_part.added') {
      ensureMessageStarted();
      const partType = chunk.part?.type;
      if (partType === 'output_text' || partType === 'refusal') {
        const index = this.resolveResponsesContentIndex(chunk, ctx);
        this.ensureResponsesTextBlockStarted(events, ctx, index);
      }
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.content_part.done' || eventType === 'response.refusal.done' || eventType === 'response.reasoning.done') {
      const index = this.resolveResponsesContentIndex(chunk, ctx);
      if (ctx.streamState.get(`resp_text_block_${index}`) === true || ctx.streamState.get(`resp_reasoning_block_${index}`) === true) {
        events.push({ type: 'content_block_stop', index });
        ctx.streamState.delete(`resp_text_block_${index}`);
        ctx.streamState.delete(`resp_reasoning_block_${index}`);
      }
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.in_progress' || eventType === 'keepalive') {
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.output_item.added') {
      const item = chunk.item;
      if (item?.type === 'function_call') {
        const index = this.nextResponsesContentIndex(ctx);
        const metaKey = `resp_tool_meta_${index}`;
        const callId = typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string'
            ? item.id
            : `tool_${index}`;
        const name = typeof item.name === 'string' ? item.name : 'tool';
        ctx.streamState.set(metaKey, { callId, name });
        if (typeof item.id === 'string') ctx.streamState.set(`resp_tool_item_${item.id}`, index);
        if (typeof chunk.item_id === 'string') ctx.streamState.set(`resp_tool_item_${chunk.item_id}`, index);
        if (typeof chunk.output_index === 'number') ctx.streamState.set(`resp_tool_out_${chunk.output_index}`, index);
        ctx.streamState.set('resp_last_tool_index', index);

        if (!ctx.streamState.has('message_started')) {
          events.push({
            type: 'message_start',
            message: {
              id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
              type: 'message',
              role: 'assistant',
              content: [],
              model: chunk.response?.model || '',
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          });
          ctx.streamState.set('message_started', true);
        }
      } else if (item?.type === 'reasoning') {
        ensureMessageStarted();

        const index = this.resolveResponsesReasoningIndex(chunk, item, ctx);
        const itemId = typeof item.id === 'string'
          ? item.id
          : typeof chunk.item_id === 'string'
            ? chunk.item_id
            : '';
        if (itemId) {
          ctx.streamState.set(`resp_reasoning_item_${itemId}`, index);
        }

        this.ensureResponsesThinkingBlockStarted(events, ctx, index);

        const summaryTexts = this.extractReasoningSummaryTexts(item);
        for (const summaryText of summaryTexts) {
          this.emitResponsesThinkingDelta(events, ctx, index, summaryText);
        }
      } else {
        ensureMessageStarted();
        events.push({
          type: 'ping'
        });
      }

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.output_item.done') {
      const item = chunk.item;
      if (item?.type === 'function_call') {
        const index = this.resolveResponsesToolIndex({ ...chunk, item_id: chunk.item_id || item.id }, ctx) ?? this.nextResponsesContentIndex(ctx);
        const toolKey = `resp_tool_${index}`;
        const metaKey = `resp_tool_meta_${index}`;
        const meta = ctx.streamState.get(metaKey) as { callId?: string; name?: string } | undefined;
        const callId = typeof item.call_id === 'string'
          ? item.call_id
          : typeof meta?.callId === 'string'
            ? meta.callId
            : typeof item.id === 'string'
              ? item.id
              : `tool_${index}`;
        const name = typeof item.name === 'string'
          ? item.name
          : typeof meta?.name === 'string'
            ? meta.name
            : 'tool';

        if (!ctx.streamState.has('message_started')) {
          events.push({
            type: 'message_start',
            message: {
              id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
              type: 'message',
              role: 'assistant',
              content: [],
              model: chunk.response?.model || '',
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          });
          ctx.streamState.set('message_started', true);
        }

        if (!ctx.streamState.has(toolKey)) {
          ctx.streamState.set(toolKey, true);
          events.push({
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: callId,
              name,
              input: {}
            }
          });
        }

      } else if (item?.type === 'reasoning') {
        ensureMessageStarted();

        const index = this.resolveResponsesReasoningIndex(chunk, item, ctx);
        const itemId = typeof item.id === 'string'
          ? item.id
          : typeof chunk.item_id === 'string'
            ? chunk.item_id
            : '';
        if (itemId) {
          ctx.streamState.set(`resp_reasoning_item_${itemId}`, index);
        }

        this.ensureResponsesThinkingBlockStarted(events, ctx, index);

        const hasDelta = ctx.streamState.get(`resp_reasoning_has_delta_${index}`) === true;
        if (!hasDelta) {
          const summaryTexts = this.extractReasoningSummaryTexts(item);
          for (const summaryText of summaryTexts) {
            this.emitResponsesThinkingDelta(events, ctx, index, summaryText);
          }
        }
      }

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.function_call_arguments.done') {
      const index = this.resolveResponsesToolIndex(chunk, ctx);
      if (index === undefined) {
        return this.finalizeResponsesStreamEvents(events, ctx);
      }
      const toolKey = `resp_tool_${index}`;
      const metaKey = `resp_tool_meta_${index}`;
      const meta = ctx.streamState.get(metaKey) as { callId?: string; name?: string } | undefined;
      const callId = typeof chunk.call_id === 'string'
        ? chunk.call_id
        : typeof meta?.callId === 'string'
          ? meta.callId
          : typeof chunk.item_id === 'string'
            ? chunk.item_id
            : `tool_${index}`;
      const name = typeof chunk.name === 'string'
        ? chunk.name
        : typeof meta?.name === 'string'
          ? meta.name
          : 'tool';

      if (!ctx.streamState.has('message_started')) {
        events.push({
          type: 'message_start',
          message: {
            id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
            type: 'message',
            role: 'assistant',
            content: [],
            model: chunk.response?.model || '',
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        ctx.streamState.set('message_started', true);
      }

      if (!ctx.streamState.has(toolKey)) {
        ctx.streamState.set(toolKey, true);
        events.push({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: callId,
            name,
            input: {}
          }
        });
      }

      const doneArguments = typeof chunk.arguments === 'string' ? chunk.arguments : '';
      const hasDelta = ctx.streamState.get(`resp_tool_has_delta_${index}`) === true;
      if (doneArguments && !hasDelta) {
        ctx.streamState.set(`resp_tool_has_delta_${index}`, true);
        events.push({
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: doneArguments
          }
        });
      }

      events.push({ type: 'content_block_stop', index });
      ctx.streamState.set(`resp_tool_closed_${index}`, true);

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (!ctx.streamState.has('message_started') && (eventType === 'response.output_text.delta' || eventType === 'response.refusal.delta')) {
      events.push({
        type: 'message_start',
        message: {
          id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
          type: 'message',
          role: 'assistant',
          content: [],
          model: chunk.response?.model || '',
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
      ctx.streamState.set('message_started', true);
    }

    if (eventType === 'response.output_text.delta' || eventType === 'response.refusal.delta') {
      const index = this.resolveResponsesContentIndex(chunk, ctx);
      this.ensureResponsesTextBlockStarted(events, ctx, index);

      const deltaText = typeof chunk.delta === 'string'
        ? chunk.delta
        : typeof chunk.text === 'string'
          ? chunk.text
          : '';

      if (deltaText) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: {
            type: 'text_delta',
            text: deltaText
          }
        });
      }

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (
      eventType === 'response.reasoning_summary_text.delta'
      || eventType === 'response.reasoning_text.delta'
      || eventType === 'response.reasoning.delta'
    ) {
      ensureMessageStarted();

      const index = this.resolveResponsesReasoningIndex(chunk, undefined, ctx);
      if (typeof chunk?.item_id === 'string' && chunk.item_id.length > 0) {
        ctx.streamState.set(`resp_reasoning_item_${chunk.item_id}`, index);
      }

      this.ensureResponsesThinkingBlockStarted(events, ctx, index);
      const deltaText = this.extractResponsesReasoningDeltaText(chunk);
      this.emitResponsesThinkingDelta(events, ctx, index, deltaText);

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (
      eventType === 'response.reasoning_summary_text.done'
      || eventType === 'response.reasoning_text.done'
      || eventType === 'response.reasoning.done'
    ) {
      ensureMessageStarted();

      const index = this.resolveResponsesReasoningIndex(chunk, undefined, ctx);
      if (typeof chunk?.item_id === 'string' && chunk.item_id.length > 0) {
        ctx.streamState.set(`resp_reasoning_item_${chunk.item_id}`, index);
      }

      this.ensureResponsesThinkingBlockStarted(events, ctx, index);
      const hasDelta = ctx.streamState.get(`resp_reasoning_has_delta_${index}`) === true;
      if (!hasDelta) {
        const doneText = this.extractResponsesReasoningDeltaText(chunk);
        this.emitResponsesThinkingDelta(events, ctx, index, doneText);
      }

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.function_call_arguments.delta') {
      const index = this.resolveResponsesToolIndex(chunk, ctx) ?? this.nextResponsesContentIndex(ctx);
      const argsDoneSeen = ctx.streamState.get(`resp_tool_args_done_seen_${index}`) === true;
      const fullArgsSent = ctx.streamState.get(`resp_tool_full_args_sent_${index}`) === true;

      if (argsDoneSeen || fullArgsSent) {
        return this.finalizeResponsesStreamEvents(events, ctx);
      }

      if (!ctx.streamState.has('message_started')) {
        events.push({
          type: 'message_start',
          message: {
            id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
            type: 'message',
            role: 'assistant',
            content: [],
            model: chunk.response?.model || '',
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        ctx.streamState.set('message_started', true);
      }

      const toolKey = `resp_tool_${index}`;
      if (ctx.streamState.get(`resp_tool_closed_${index}`) === true) {
        return this.finalizeResponsesStreamEvents(events, ctx);
      }
      const metaKey = `resp_tool_meta_${index}`;
      const meta = ctx.streamState.get(metaKey) as { callId?: string; name?: string } | undefined;
      const callId = typeof chunk.call_id === 'string'
        ? chunk.call_id
        : typeof meta?.callId === 'string'
          ? meta.callId
          : typeof chunk.item_id === 'string'
            ? chunk.item_id
            : `tool_${index}`;
      const name = typeof chunk.name === 'string'
        ? chunk.name
        : typeof meta?.name === 'string'
          ? meta.name
          : 'tool';

      if (!ctx.streamState.has(toolKey)) {
        ctx.streamState.set(toolKey, true);
        events.push({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: callId,
            name,
            input: {}
          }
        });
      }

      const partialJson = typeof chunk.delta === 'string' ? chunk.delta : '';
      if (partialJson) {
        ctx.streamState.set(`resp_tool_has_delta_${index}`, true);
        events.push({
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: partialJson
          }
        });
      }

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.completed' || eventType === 'response.incomplete' || eventType === 'response.failed') {
      const responseId = chunk.response?.id || chunk.response_id;

      if (!ctx.streamState.has('message_started')) {
        events.push({
          type: 'message_start',
          message: {
            id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
            type: 'message',
            role: 'assistant',
            content: [],
            model: chunk.response?.model || '',
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        ctx.streamState.set('message_started', true);
      }

      const textBlockKeys = Array.from(ctx.streamState.keys())
        .filter((k) => typeof k === 'string' && /^resp_text_block_\d+$/.test(k))
        .sort((a, b) => Number(a.slice('resp_text_block_'.length)) - Number(b.slice('resp_text_block_'.length)));

      for (const blockKey of textBlockKeys) {
        const textIndex = Number(blockKey.slice('resp_text_block_'.length));
        events.push({ type: 'content_block_stop', index: Number.isFinite(textIndex) ? textIndex : 0 });
      }

      const reasoningBlockKeys = Array.from(ctx.streamState.keys())
        .filter((k) => typeof k === 'string' && /^resp_reasoning_block_\d+$/.test(k))
        .sort((a, b) => Number(a.slice('resp_reasoning_block_'.length)) - Number(b.slice('resp_reasoning_block_'.length)));

      for (const blockKey of reasoningBlockKeys) {
        const reasoningIndex = Number(blockKey.slice('resp_reasoning_block_'.length));
        events.push({
          type: 'content_block_stop',
          index: Number.isFinite(reasoningIndex) ? reasoningIndex : 1
        });
      }

      const toolKeys = Array.from(ctx.streamState.keys())
        .filter((k) => typeof k === 'string' && /^resp_tool_\d+$/.test(k))
        .sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));

      for (const toolKey of toolKeys) {
        const toolIndex = Number(toolKey.slice(10));
        if (ctx.streamState.get(`resp_tool_closed_${toolIndex}`) === true) {
          continue;
        }
        events.push({
          type: 'content_block_stop',
          index: Number.isFinite(toolIndex) ? toolIndex : 1
        });
      }

      const usage = chunk.response?.usage && typeof chunk.response.usage === 'object'
        ? chunk.response.usage
        : chunk.usage;
      const normalizedUsage = usage ? this.buildAnthropicUsageFromResponses(usage) : undefined;
      const responseStatus = typeof chunk.response?.status === 'string'
        ? chunk.response.status
        : eventType === 'response.completed'
          ? 'completed'
          : eventType === 'response.incomplete'
            ? 'incomplete'
            : 'failed';
      const hasToolUse = toolKeys.length > 0;

      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: this.mapResponsesStopReason(responseStatus, hasToolUse, chunk.response?.incomplete_details?.reason)
        },
        ...(normalizedUsage && { usage: normalizedUsage })
      });

      events.push({
        type: 'message_stop'
      });

      ctx.streamState.clear();
      ctx.streamState.set('resp_terminal_emitted', true);
      if (typeof responseId === 'string' && responseId.length > 0) {
        ctx.streamState.set('resp_terminal_response_id', responseId);
      }
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (typeof eventType === 'string' && eventType.startsWith('response.')) {
      ensureMessageStarted();
      events.push({
        type: 'ping'
      });
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    return this.finalizeResponsesStreamEvents(events, ctx);
  }

  private finalizeResponsesStreamEvents(events: any[], ctx: StreamChunkContext): any[] {
    const deduped: any[] = [];

    for (const event of events) {
      if (event?.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const index = typeof event.index === 'number' ? event.index : 0;
        const partialJson = typeof event.delta.partial_json === 'string' ? event.delta.partial_json : '';
        const lastPartialJsonKey = `resp_tool_last_input_json_${index}`;
        const previousPartialJson = ctx.streamState.get(lastPartialJsonKey);

        if (partialJson && previousPartialJson === partialJson) {
          continue;
        }

        if (partialJson) {
          ctx.streamState.set(lastPartialJsonKey, partialJson);
        }
      }

      deduped.push(event);
    }

    return deduped;
  }

  private extractOpenAIStreamUsage(chunk: any): { input_tokens: number; output_tokens: number } | undefined {
    const usage = chunk?.usage;
    if (!usage || typeof usage !== 'object') {
      return undefined;
    }

    const inputTokens = typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : typeof usage.input_tokens === 'number'
        ? usage.input_tokens
      : 0;
    const outputTokens = typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : typeof usage.output_tokens === 'number'
        ? usage.output_tokens
      : 0;

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };
  }

  private extractDeltaText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'reasoning' || part?.type === 'thinking' || part?.thought === true) return '';
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
}
