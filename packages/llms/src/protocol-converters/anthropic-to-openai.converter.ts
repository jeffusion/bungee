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
  parseThinkingTags,
  mapOpenAIFinishReasonToAnthropic
} from './utils';
import {
  AnthropicAdapter
} from '../providers/anthropic/anthropic-adapter';
import {
  LLMSRuntime
} from '../runtime/llms-runtime';
import {
  OpenAIAdapter
} from '../providers/openai/openai-adapter';
import {
  OpenAIProtocolConversion
} from '../providers/openai/protocol-conversion';

export class AnthropicToOpenAIConverter implements AIConverter {
  readonly from = 'anthropic';
  readonly to = 'openai';
  private configuredApiMode?: 'chat_completions' | 'responses';
  private readonly protocolConversion = new OpenAIProtocolConversion();
  private readonly runtime = new LLMSRuntime();

  constructor() {
    this.runtime.registerAdapter(new AnthropicAdapter(), {
      provider: 'anthropic',
      displayName: 'Anthropic'
    });
    this.runtime.registerAdapter(new OpenAIAdapter(), {
      provider: 'openai',
      displayName: 'OpenAI'
    });
  }

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

  private parseIntegerOption(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private resolveReasoningMaxCompletionTokens(maxTokens: unknown): number | undefined {
    return this.parseIntegerOption(maxTokens);
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

      if (this.canUseRuntimeRequestConversion(body, targetApiMode)) {
        ctx.url.pathname = '/v1/chat/completions';
        let runtimeRequestBody: Record<string, unknown> | undefined;

        try {
          runtimeRequestBody = this.runtime.convertRequest<Record<string, unknown>>(
            'anthropic',
            'openai',
            body as Record<string, unknown>,
            { pathname: '/v1/chat/completions' }
          );
        } catch {
          ctx.body = this.buildOpenAIRequest(body);
          return;
        }

        if (!runtimeRequestBody || typeof runtimeRequestBody !== 'object' || Array.isArray(runtimeRequestBody)) {
          ctx.body = this.buildOpenAIRequest(body);
          return;
        }

        const model = runtimeRequestBody.model;
        if (typeof model !== 'string' || model.trim().length === 0) {
          runtimeRequestBody.model = 'gpt-4';
        }

        ctx.body = runtimeRequestBody;
        return;
      }

      if (targetApiMode === 'responses') {
        ctx.url.pathname = '/v1/responses';
        ctx.body = this.buildOpenAIResponsesRequest(body);
      } else {
        ctx.url.pathname = '/v1/chat/completions';
        ctx.body = this.buildOpenAIRequest(body);
      }
    }
  }

  private canUseRuntimeRequestConversion(
    anthropicBody: unknown,
    targetApiMode: 'chat_completions' | 'responses'
  ): boolean {
    if (targetApiMode !== 'chat_completions') {
      return false;
    }

    if (!anthropicBody || typeof anthropicBody !== 'object' || Array.isArray(anthropicBody)) {
      return false;
    }

    const body = anthropicBody as Record<string, unknown>;
    if (typeof body.system !== 'string' && body.system !== undefined) {
      return false;
    }

    if (
      body.tools !== undefined
      || body.tool_choice !== undefined
      || body.thinking !== undefined
      || body.output_config !== undefined
      || body.top_k !== undefined
    ) {
      return false;
    }

    if (!Array.isArray(body.messages)) {
      return false;
    }

    if (body.messages.length === 0) {
      const hasNonEmptySystem = typeof body.system === 'string' && body.system.trim().length > 0;
      if (!hasNonEmptySystem) {
        return false;
      }
    }

    for (const message of body.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return false;
      }

      const typedMessage = message as Record<string, unknown>;
      if (typedMessage.role !== 'user' && typedMessage.role !== 'assistant') {
        return false;
      }

      if (typeof typedMessage.content !== 'string') {
        return false;
      }
    }

    return true;
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

    // Model
    openaiBody.model = anthropicBody.model || 'gpt-4';

    // Messages
    const messages: any[] = [];

    // 1. System message
    messages.push(...this.convertSystemMessages(anthropicBody.system));

    // 2. Convert Anthropic messages
    if (anthropicBody.messages) {
      for (const msg of anthropicBody.messages) {
        if (msg.role === 'user') {
          this.convertUserMessage(msg, messages);
        } else if (msg.role === 'assistant') {
          this.convertAssistantMessage(msg, messages);
        }
      }
    }

    openaiBody.messages = this.validateAndCleanToolCalls(messages);
    if (!Array.isArray(openaiBody.messages) || openaiBody.messages.length === 0) {
      openaiBody.messages = [{ role: 'user', content: '' }];
    }

    // 3. Parameters mapping
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

    // stop_sequences → stop
    if (anthropicBody.stop_sequences !== undefined) {
      openaiBody.stop = Array.isArray(anthropicBody.stop_sequences)
        ? anthropicBody.stop_sequences
        : [anthropicBody.stop_sequences];
    }

    if (anthropicBody.stream !== undefined) {
      openaiBody.stream = anthropicBody.stream;
      if (anthropicBody.stream === true) {
        openaiBody.stream_options = {
          include_usage: true
        };
      }
    }

    // 4. Tools conversion
    if (Array.isArray(anthropicBody.tools)) {
      openaiBody.tools = anthropicBody.tools
        .filter((tool: any) => typeof tool?.name === 'string' && tool.name.trim().length > 0)
        .map((tool: any) => ({
        type: 'function',
        function: {
          name: tool.name.trim(),
          description: tool.description || '',
          parameters: this.normalizeToolParametersSchema(tool.input_schema)
        }
      }));

      if (openaiBody.tools.length === 0) {
        delete openaiBody.tools;
      }
    }

    const toolChoice = this.mapAnthropicToolChoiceToOpenAI(anthropicBody.tool_choice);
    if (toolChoice !== undefined) {
      openaiBody.tool_choice = toolChoice;
    }

    const thinkingEnabled = this.isAnthropicThinkingEnabled(anthropicBody.thinking);
    const thinkingEffort = this.resolveAnthropicThinkingEffort(anthropicBody.thinking);
    const outputConfigEffort = this.resolveOutputConfigEffort(anthropicBody.output_config);
    const shouldApplyReasoningFields = thinkingEnabled || thinkingEffort !== undefined || outputConfigEffort !== undefined;

    if (shouldApplyReasoningFields) {
      const effort = this.normalizeOpenAIReasoningEffort(
        thinkingEffort || outputConfigEffort,
        openaiBody.model
      );
      if (effort) {
        openaiBody.reasoning_effort = effort;
      }

      const maxCompletionTokens = this.resolveReasoningMaxCompletionTokens(openaiBody.max_tokens);
      if (maxCompletionTokens !== undefined) {
        openaiBody.max_completion_tokens = maxCompletionTokens;
        delete openaiBody.max_tokens;
      }
    }

    return openaiBody;
  }

  private isAnthropicThinkingEnabled(thinking: any): boolean {
    if (!thinking || typeof thinking !== 'object') {
      return false;
    }

    const rawType = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : '';
    return rawType === 'enabled' || rawType === 'adaptive';
  }

  private resolveAnthropicThinkingEffort(thinking: any): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    if (!thinking || typeof thinking !== 'object') {
      return undefined;
    }

    const rawEffort = typeof thinking.effort === 'string' ? thinking.effort.trim().toLowerCase() : '';
    if (rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high') {
      return rawEffort;
    }
    if (rawEffort === 'max') {
      return 'xhigh';
    }
    if (rawEffort === 'min') {
      return 'low';
    }

    return undefined;
  }

  private resolveOutputConfigEffort(outputConfig: any): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    if (!outputConfig || typeof outputConfig !== 'object') {
      return undefined;
    }

    const rawEffort = typeof outputConfig.effort === 'string' ? outputConfig.effort.trim().toLowerCase() : '';
    if (rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high') {
      return rawEffort;
    }
    if (rawEffort === 'max') {
      return 'xhigh';
    }
    if (rawEffort === 'min') {
      return 'low';
    }

    return undefined;
  }

  private normalizeOpenAIReasoningEffort(
    effort: 'low' | 'medium' | 'high' | 'xhigh' | undefined,
    model: string
  ): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    if (!effort) {
      return undefined;
    }

    if (effort !== 'xhigh') {
      return effort;
    }

    return this.supportsXHighReasoningEffort(model) ? 'xhigh' : 'high';
  }

  private supportsXHighReasoningEffort(model: string): boolean {
    const normalized = typeof model === 'string' ? model.trim().toLowerCase() : '';
    if (!normalized) {
      return false;
    }

    if (normalized.includes('gpt-5-pro')) {
      return false;
    }

    if (normalized.includes('codex-max')) {
      return true;
    }

    const gpt5MinorMatch = normalized.match(/gpt-5\.(\d+)/);
    if (gpt5MinorMatch) {
      const minor = parseInt(gpt5MinorMatch[1], 10);
      if (Number.isFinite(minor)) {
        return minor >= 2;
      }
    }

    return false;
  }

  private buildOpenAIResponsesRequest(anthropicBody: any): any {
    const chatBody = this.buildOpenAIRequest(anthropicBody);
    const responsesInput = this.protocolConversion.convertChatMessagesToResponsesInput(chatBody.messages);
    const responsesBody: any = {
      model: chatBody.model,
      input: responsesInput.input
    };

    if (responsesInput.instructions) {
      responsesBody.instructions = responsesInput.instructions;
    }

    const maxOutputTokens = chatBody.max_tokens ?? chatBody.max_completion_tokens;
    if (maxOutputTokens !== undefined) {
      responsesBody.max_output_tokens = maxOutputTokens;
    }

    if (chatBody.temperature !== undefined) {
      responsesBody.temperature = chatBody.temperature;
    }

    if (chatBody.top_p !== undefined) {
      responsesBody.top_p = chatBody.top_p;
    }

    if (chatBody.tools !== undefined) {
      const mappedTools = this.protocolConversion.mapChatToolsToResponsesTools(chatBody.tools);
      if (mappedTools.length > 0) {
        responsesBody.tools = mappedTools;
      }
    }

    if (chatBody.stop !== undefined) {
      responsesBody.stop = chatBody.stop;
    }

    if (chatBody.reasoning_effort !== undefined) {
      responsesBody.reasoning = {
        effort: chatBody.reasoning_effort,
        summary: 'auto'
      };
    }

    if (chatBody.stream === true) {
      responsesBody.stream = true;
    }

    return responsesBody;
  }

  private convertSystemMessages(system: unknown): Array<{ role: 'system'; content: string }> {
    if (typeof system === 'string') {
      const content = system.trim();
      return content ? [{ role: 'system', content }] : [];
    }

    if (!Array.isArray(system)) {
      return [];
    }

    const results: Array<{ role: 'system'; content: string }> = [];
    for (const block of system) {
      if (typeof block === 'string') {
        const content = block.trim();
        if (content) {
          results.push({ role: 'system', content });
        }
        continue;
      }

      if (block && typeof block === 'object' && (block as any).type === 'text') {
        const content = typeof (block as any).text === 'string' ? (block as any).text.trim() : '';
        if (content) {
          results.push({ role: 'system', content });
        }
      }
    }

    return results;
  }

  private validateAndCleanToolCalls(messages: any[]): any[] {
    const toolResultIds = new Set(
      messages
        .filter((msg: any) => msg.role === 'tool' && typeof msg.tool_call_id === 'string' && msg.tool_call_id)
        .map((msg: any) => msg.tool_call_id)
    );

    const cleanedMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) {
        cleanedMessages.push(msg);
        continue;
      }

      const matchedToolCalls = msg.tool_calls.filter((tc: any) => typeof tc?.id === 'string' && toolResultIds.has(tc.id));
      const hasTextContent = typeof msg.content === 'string' && msg.content.trim().length > 0;

      if (matchedToolCalls.length > 0) {
        cleanedMessages.push({
          ...msg,
          tool_calls: matchedToolCalls,
          content: hasTextContent ? msg.content : null
        });
        continue;
      }

      if (hasTextContent) {
        const { tool_calls, ...assistantTextOnly } = msg;
        cleanedMessages.push(assistantTextOnly);
      }
    }

    return cleanedMessages;
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

    if (Array.isArray(content)) {
      const normalizedBlocks = content
        .map((part: any) => {
          if (typeof part === 'string') {
            return { type: 'text', text: part };
          }

          if (!part || typeof part !== 'object') {
            return null;
          }

          if (part.type === 'text' && typeof part.text === 'string') {
            return { type: 'text', text: part.text };
          }

          if (part.type === 'image' && part.source) {
            if (part.source.type === 'url' && typeof part.source.url === 'string') {
              return {
                type: 'image_url',
                image_url: {
                  url: part.source.url
                }
              };
            }

            if (part.source.type === 'base64' && part.source.media_type && part.source.data) {
              return {
                type: 'image_url',
                image_url: {
                  url: `data:${part.source.media_type};base64,${part.source.data}`
                }
              };
            }
          }

          return {
            type: 'text',
            text: JSON.stringify(part)
          };
        })
        .filter((block: any): block is Record<string, any> => block !== null);

      if (normalizedBlocks.length === 0) {
        return '';
      }

      const firstBlock = normalizedBlocks[0];
      if (normalizedBlocks.length === 1 && firstBlock && firstBlock.type === 'text') {
        return typeof firstBlock.text === 'string' ? firstBlock.text : '';
      }

      return JSON.stringify(normalizedBlocks);
    }

    if (typeof content === 'object') {
      if ('content' in content) {
        return this.normalizeToolResultContent(content.content);
      }

      return JSON.stringify(content);
    }

    return String(content);
  }

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
      const hasToolResult = content.some((block: any) => block?.type === 'tool_result');

      if (hasToolResult) {
        for (const block of content) {
          const toolUseId = typeof block?.tool_use_id === 'string' ? block.tool_use_id.trim() : '';
          if (block?.type !== 'tool_result' || toolUseId.length === 0) {
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
          content: userContentBlocks
        });
      }
    }
  }

  private convertUserContentBlock(block: any): any | null {
    if (!block || typeof block !== 'object') {
      return null;
    }

    if (block.type === 'text') {
      return {
        type: 'text',
        text: block.text || ''
      };
    }

    if (block.type === 'image' && block.source) {
      if (block.source.type === 'url' && block.source.url) {
        return {
          type: 'image_url',
          image_url: { url: block.source.url }
        };
      }

      if (block.source.type === 'base64' && block.source.media_type && block.source.data) {
        return {
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
        };
      }
    }

    return null;
  }

  /**
   * 转换 Assistant 消息
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
      const toolUseBlocks = content.filter((block: any) => block.type === 'tool_use');

      if (toolUseBlocks.length > 0) {
        const validToolUseBlocks = toolUseBlocks
          .filter((block: any) => typeof block?.name === 'string' && block.name.trim().length > 0);

        const toolCalls = validToolUseBlocks.map((block: any, index: number) => ({
          id: this.normalizeToolCallId(block.id, block.name, index),
          type: 'function',
          function: {
            name: String(block.name).trim(),
            arguments: JSON.stringify(block.input || {})
          }
        }));

        let textContent = '';
        for (const block of content) {
          if (block.type === 'text') {
            textContent += block.text || '';
          } else if (block.type === 'thinking') {
            textContent += `<thinking>\n${block.thinking || ''}\n</thinking>\n\n`;
          }
        }

        if (toolCalls.length > 0 || textContent.trim()) {
          messages.push({
            role: 'assistant',
            content: textContent.trim() || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          });
        }
      } else {
        // 文本/多模态内容，包含 thinking 块
        let textContent = '';

        for (const block of content) {
          if (block.type === 'text') {
            textContent += block.text || '';
          } else if (block.type === 'thinking') {
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

  private normalizeToolCallId(rawId: unknown, name: unknown, index: number): string {
    if (typeof rawId === 'string' && rawId.trim()) {
      return rawId.trim();
    }

    const normalizedName = typeof name === 'string' && name.trim() ? name.trim() : 'tool';
    return `call_${normalizedName}_${index}`;
  }

  private mapAnthropicToolChoiceToOpenAI(toolChoice: unknown): any {
    if (toolChoice === undefined || toolChoice === null) {
      return undefined;
    }

    if (typeof toolChoice === 'string') {
      const normalized = toolChoice.trim().toLowerCase();
      if (normalized === 'auto' || normalized === 'none' || normalized === 'required') {
        return normalized;
      }
      if (normalized === 'any') {
        return 'required';
      }
      return undefined;
    }

    if (typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
      return undefined;
    }

    const choice = toolChoice as Record<string, any>;
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';

    if (type === 'tool') {
      const toolName = typeof choice.name === 'string' ? choice.name.trim() : '';
      if (!toolName) {
        return undefined;
      }

      return {
        type: 'function',
        function: {
          name: toolName
        }
      };
    }

    if (type === 'any') {
      return 'required';
    }

    if (type === 'auto' || type === 'none') {
      return type;
    }

    return undefined;
  }

  private parseOpenAIImageUrlSource(url: string): any | null {
    if (!url) return null;

    if (url.startsWith('data:')) {
      const parts = url.split(';base64,');
      if (parts.length !== 2) return null;
      return {
        type: 'base64',
        media_type: parts[0].replace('data:', ''),
        data: parts[1]
      };
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      return {
        type: 'url',
        url
      };
    }

    return null;
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

  private normalizeJsonSchema(schema: unknown): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.normalizeJsonSchema(item));
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(schema)) {
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
    const message =
      (typeof openaiBody?.error?.message === 'string' && openaiBody.error.message)
      || (typeof openaiBody?.message === 'string' && openaiBody.message)
      || `OpenAI request failed with status ${status}`;

    return {
      type: 'error',
      error: {
        type: 'api_error',
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

  private appendUniqueThinkingBlocks(content: any[], texts: string[], seen: Set<string>): void {
    for (const text of texts) {
      if (typeof text !== 'string') continue;
      const normalized = text.trim();
      if (!normalized) continue;
      if (seen.has(normalized)) continue;

      content.push({
        type: 'thinking',
        thinking: normalized
      });
      seen.add(normalized);
    }
  }

  private appendParsedContent(content: any[], parsedContent: Array<{ type: string; text?: string; thinking?: string }>, seenThinking: Set<string>): void {
    for (const block of parsedContent) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'thinking') {
        const thinkingText = typeof block.thinking === 'string' ? block.thinking.trim() : '';
        if (!thinkingText || seenThinking.has(thinkingText)) {
          continue;
        }

        content.push({
          type: 'thinking',
          thinking: thinkingText
        });
        seenThinking.add(thinkingText);
        continue;
      }

      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (!text) continue;
        content.push({
          type: 'text',
          text
        });
      }
    }
  }

  private extractChatCompletionReasoningTexts(message: any): string[] {
    const texts: string[] = [];

    if (!message || typeof message !== 'object') {
      return texts;
    }

    const directReasoning = this.extractReasoningSummaryTexts({
      summary: message.reasoning,
      text: message.reasoning_content
    });
    texts.push(...directReasoning);

    if (typeof message.reasoning === 'string') {
      texts.push(message.reasoning);
    }

    if (Array.isArray(message.reasoning_details)) {
      for (const detail of message.reasoning_details) {
        texts.push(...this.extractReasoningSummaryTexts(detail));
      }
    }

    return texts;
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

    for (const item of output) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'reasoning') {
        const summaryTexts = this.extractReasoningSummaryTexts(item);
        for (const summaryText of summaryTexts) {
          content.push({
            type: 'thinking',
            thinking: summaryText
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
        continue;
      }

      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'output_text' && typeof part.text === 'string') {
            content.push(...parseThinkingTags(part.text));
            continue;
          }

          if (part.type === 'text' && typeof part.text === 'string') {
            content.push(...parseThinkingTags(part.text));
          }
        }
      }
    }

    const stopReason = content.some((block) => block.type === 'tool_use')
      ? 'tool_use'
      : openaiBody.status === 'incomplete'
        ? 'max_tokens'
        : 'end_turn';

    return {
      id: openaiBody.id || generateAnthropicMessageId(),
      type: 'message',
      role: 'assistant',
      content,
      model: openaiBody.model || 'gpt-4',
      stop_reason: stopReason,
      usage: {
        input_tokens: openaiBody.usage?.input_tokens || 0,
        output_tokens: openaiBody.usage?.output_tokens || 0
      }
    };
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
    const seenThinking = new Set<string>();

    this.appendUniqueThinkingBlocks(content, this.extractChatCompletionReasoningTexts(message), seenThinking);

    // tool_calls → tool_use
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        let parsedInput: Record<string, any> = {};
        try {
          const parsedValue = JSON.parse(tc.function?.arguments || '{}');
          if (parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)) {
            parsedInput = parsedValue as Record<string, any>;
          }
        } catch {
          parsedInput = {};
        }

        content.push({
          type: 'tool_use',
          id: tc.id || '',
          name: tc.function?.name || '',
          input: parsedInput
        });
      }
    }

    if (typeof message.content === 'string' && message.content.length > 0) {
      // 文本与 <thinking> 标签拆分
      const parsedContent = parseThinkingTags(message.content);
      this.appendParsedContent(content, parsedContent, seenThinking);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          this.appendParsedContent(content, parseThinkingTags(part.text), seenThinking);
          continue;
        }

        if (typeof part === 'string') {
          this.appendParsedContent(content, parseThinkingTags(part), seenThinking);
          continue;
        }

        if (part && typeof part === 'object') {
          const partType = typeof part.type === 'string' ? part.type : '';
          if (partType === 'reasoning' || partType === 'thinking' || part.thought === true) {
            this.appendUniqueThinkingBlocks(content, this.extractReasoningSummaryTexts(part), seenThinking);
            continue;
          }

          if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
            const source = this.parseOpenAIImageUrlSource(part.image_url.url);
            if (source) {
              content.push({
                type: 'image',
                source
              });
              continue;
            }
          }

          content.push({
            type: 'text',
            text: JSON.stringify(part)
          });
        }
      }
    }

    // finish_reason 映射
    const stopReason = mapOpenAIFinishReasonToAnthropic(choice.finish_reason || 'stop');

    return {
      id: openaiBody.id || generateAnthropicMessageId(),
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
      if (delta && (delta.content || delta.tool_calls || delta.role || thinkingDeltaText)) {
        events.push({
          type: 'message_start',
          message: {
            id: chunk.id || generateAnthropicMessageId(),
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

    if (thinkingDeltaText) {
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
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const rawIndex = typeof tc.index === 'number' ? tc.index : 0;
        const index = this.resolveChatToolIndex(rawIndex, ctx);
        const toolKey = `tool_${index}`;

        if (!ctx.streamState.has(toolKey)) {
          ctx.streamState.set(toolKey, {
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: ''
          });

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

    // 完成时
    if (finishReason) {
      const textIndex = ctx.streamState.get('chat_text_index');
      if (typeof textIndex === 'number' && Number.isFinite(textIndex)) {
        events.push({
          type: 'content_block_stop',
          index: textIndex
        });
      }

      const thinkingIndex = ctx.streamState.get('chat_thinking_index');
      if (typeof thinkingIndex === 'number' && Number.isFinite(thinkingIndex)) {
        events.push({
          type: 'content_block_stop',
          index: thinkingIndex
        });
      }

      const toolKeys = Array.from(ctx.streamState.keys())
        .filter(k => k.startsWith('tool_'))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
      for (const toolKey of toolKeys) {
        const toolIndex = Number(toolKey.slice(5));
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
            model: chunk.response?.model || 'gpt-4',
            usage: { input_tokens: 0, output_tokens: 0 }
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

    if (eventType === 'response.in_progress' || eventType === 'keepalive') {
      ensureMessageStarted();
      events.push({
        type: 'ping'
      });
      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (eventType === 'response.output_item.added') {
      const item = chunk.item;
      if (item?.type === 'function_call') {
        const rawIndex = typeof chunk.output_index === 'number'
          ? chunk.output_index + 1
          : typeof item.output_index === 'number'
            ? item.output_index + 1
            : 1;
        const index = Number.isFinite(rawIndex) ? rawIndex : 1;
        const metaKey = `resp_tool_meta_${index}`;
        const callId = typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string'
            ? item.id
            : `tool_${index}`;
        const name = typeof item.name === 'string' ? item.name : 'tool';
        ctx.streamState.set(metaKey, { callId, name });

        if (!ctx.streamState.has('message_started')) {
          events.push({
            type: 'message_start',
            message: {
              id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
              type: 'message',
              role: 'assistant',
              content: [],
              model: chunk.response?.model || 'gpt-4',
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
        const rawIndex = typeof chunk.output_index === 'number'
          ? chunk.output_index + 1
          : typeof item.output_index === 'number'
            ? item.output_index + 1
            : 1;
        const index = Number.isFinite(rawIndex) ? rawIndex : 1;
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
              model: chunk.response?.model || 'gpt-4',
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
      const rawIndex = typeof chunk.output_index === 'number' ? chunk.output_index + 1 : 1;
      const index = Number.isFinite(rawIndex) ? rawIndex : 1;
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
            model: chunk.response?.model || 'gpt-4',
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

      const hasDeltaKey = `resp_tool_has_delta_${index}`;
      const hasDelta = ctx.streamState.get(hasDeltaKey) === true;
      const fullArgsSentKey = `resp_tool_full_args_sent_${index}`;
      const fullArgsSent = ctx.streamState.get(fullArgsSentKey) === true;
      const argsDoneSeenKey = `resp_tool_args_done_seen_${index}`;
      const argsDoneSeen = ctx.streamState.get(argsDoneSeenKey) === true;
      const doneArgsKey = `resp_tool_done_arguments_${index}`;
      const previousDoneArgs = ctx.streamState.get(doneArgsKey);
      const fullArgs = typeof chunk.arguments === 'string' ? chunk.arguments : '';

      if (argsDoneSeen && (fullArgsSent || hasDelta || (fullArgs && previousDoneArgs === fullArgs))) {
        return this.finalizeResponsesStreamEvents(events, ctx);
      }

      ctx.streamState.set(argsDoneSeenKey, true);
      if (fullArgs) {
        ctx.streamState.set(doneArgsKey, fullArgs);
      }

      if (fullArgs && !hasDelta && !fullArgsSent) {
        ctx.streamState.set(fullArgsSentKey, true);
        events.push({
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: fullArgs
          }
        });
      }

      return this.finalizeResponsesStreamEvents(events, ctx);
    }

    if (!ctx.streamState.has('message_started') && eventType === 'response.output_text.delta') {
      events.push({
        type: 'message_start',
        message: {
          id: chunk.response?.id || chunk.response_id || generateAnthropicMessageId(),
          type: 'message',
          role: 'assistant',
          content: [],
          model: chunk.response?.model || 'gpt-4',
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
      ctx.streamState.set('message_started', true);
    }

    if (eventType === 'response.output_text.delta') {
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

      const deltaText = typeof chunk.delta === 'string'
        ? chunk.delta
        : typeof chunk.text === 'string'
          ? chunk.text
          : '';

      if (deltaText) {
        events.push({
          type: 'content_block_delta',
          index: 0,
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
      const rawIndex = typeof chunk.output_index === 'number' ? chunk.output_index + 1 : 1;
      const index = Number.isFinite(rawIndex) ? rawIndex : 1;
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
            model: chunk.response?.model || 'gpt-4',
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        ctx.streamState.set('message_started', true);
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
            model: chunk.response?.model || 'gpt-4',
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        ctx.streamState.set('message_started', true);
      }

      if (ctx.streamState.has('text_block_started')) {
        events.push({
          type: 'content_block_stop',
          index: 0
        });
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
        events.push({
          type: 'content_block_stop',
          index: Number.isFinite(toolIndex) ? toolIndex : 1
        });
      }

      const usage = chunk.response?.usage && typeof chunk.response.usage === 'object'
        ? chunk.response.usage
        : chunk.usage;
      const normalizedUsage = usage
        ? {
            input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
            output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
          }
        : undefined;

      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: toolKeys.length > 0
            ? 'tool_use'
            : eventType === 'response.incomplete'
              ? 'max_tokens'
              : 'end_turn'
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
