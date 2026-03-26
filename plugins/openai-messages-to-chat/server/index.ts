import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type {
  MutableRequestContext,
  PluginHooks,
  ResponseContext
} from '../../../packages/core/src/hooks';
import { AnthropicToOpenAIConverter } from '../../ai-transformer/server/converters/anthropic-to-openai.converter';

interface OpenAIMessagesToChatOptions {
  strictValidation?: boolean;
  allowShortPathAlias?: boolean;
}

type JsonObject = Record<string, unknown>;
type NormalizedMessageResult =
  | { ok: true; messages: JsonObject[] }
  | { ok: false; message: string };
type NormalizedPartResult =
  | { ok: true; part: unknown }
  | { ok: false; message: string };
type BodyValidationResult =
  | { ok: true; body: JsonObject }
  | { ok: false; message: string };
type NormalizedToolResult =
  | { ok: true; tool: JsonObject }
  | { ok: false; message: string };
type NormalizedToolsResult =
  | { ok: true; tools?: JsonObject[] }
  | { ok: false; message: string };
type NormalizedToolChoiceResult =
  | { ok: true; toolChoice?: JsonObject | 'auto' | 'none' | 'required' }
  | { ok: false; message: string };

const RESPONSES_STYLE_FIELDS = [
  'input',
  'instructions',
  'max_output_tokens',
  'previous_response_id',
  'conversation',
  'response_id'
] as const;

const THREAD_RESOURCE_FIELDS = [
  'thread_id',
  'assistant_id',
  'run_id',
  'attachments'
] as const;

const SUPPORTED_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function extractImageUrl(part: JsonObject): string | undefined {
  const fromImageUrl = part.image_url;
  if (typeof fromImageUrl === 'string' && fromImageUrl.trim().length > 0) {
    return fromImageUrl;
  }

  if (isRecord(fromImageUrl)) {
    const nestedUrl = fromImageUrl.url;
    if (typeof nestedUrl === 'string' && nestedUrl.trim().length > 0) {
      return nestedUrl;
    }
  }

  const fallbackUrl = part.url;
  if (typeof fallbackUrl === 'string' && fallbackUrl.trim().length > 0) {
    return fallbackUrl;
  }

  return undefined;
}

function normalizeJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeJsonSchema(item));
  }

  const source = schema as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'properties' && isRecord(value)) {
      const normalizedProperties: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        normalizedProperties[propertyName] = normalizeJsonSchema(propertySchema);
      }
      normalized[key] = normalizedProperties;
      continue;
    }

    normalized[key] = normalizeJsonSchema(value);
  }

  const typeValue = typeof normalized.type === 'string' ? normalized.type.toLowerCase() : '';
  if (typeValue === 'object') {
    const hasProperties = isRecord(normalized.properties);
    if (!hasProperties) {
      normalized.properties = {};
    }
  }

  return normalized;
}

function normalizeToolParametersSchema(schema: unknown): JsonObject {
  if (!isRecord(schema)) {
    return { type: 'object', properties: {} };
  }

  const normalized = normalizeJsonSchema(schema);
  if (!isRecord(normalized)) {
    return { type: 'object', properties: {} };
  }

  const typeValue = typeof normalized.type === 'string' ? normalized.type.toLowerCase() : '';
  if (typeValue === 'object' && !isRecord(normalized.properties)) {
    normalized.properties = {};
  }

  return normalized;
}

export const OpenAIMessagesToChatPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'openai-messages-to-chat';
    static readonly version = '1.0.0';

    private readonly strictValidation: boolean;
    private readonly allowShortPathAlias: boolean;
    private readonly validationErrors = new Map<string, string>();
    private readonly adaptedRequestIds = new Set<string>();
    private readonly streamConversionRequestIds = new Set<string>();
    private readonly responseConverter = new AnthropicToOpenAIConverter();

    constructor(options?: OpenAIMessagesToChatOptions) {
      this.strictValidation = options?.strictValidation !== false;
      this.allowShortPathAlias = options?.allowShortPathAlias !== false;
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'openai-messages-to-chat', stage: -10 },
        (ctx) => {
          this.adaptedRequestIds.delete(ctx.requestId);
          this.streamConversionRequestIds.delete(ctx.requestId);
          this.validationErrors.delete(ctx.requestId);

          if (!this.shouldHandleRequest(ctx)) {
            return ctx;
          }

          const validation = this.validateAndNormalizeBody(ctx.body);
          if (!validation.ok) {
            this.validationErrors.set(ctx.requestId, validation.message);
            return ctx;
          }

          ctx.url.pathname = '/v1/chat/completions';
          ctx.body = validation.body;
          this.adaptedRequestIds.add(ctx.requestId);
          return ctx;
        }
      );

      hooks.onInterceptRequest.tap(
        { name: 'openai-messages-to-chat', stage: -10 },
        (ctx) => {
          const error = this.validationErrors.get(ctx.requestId);
          if (!error) {
            return undefined;
          }

          this.validationErrors.delete(ctx.requestId);
          return this.buildBadRequest(error);
        }
      );

      hooks.onResponse.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (response, ctx) => {
          if (!this.adaptedRequestIds.has(ctx.requestId)) {
            return response;
          }

          const parsedBody = await this.tryParseJsonBody(response);
          if (!parsedBody || !this.isOpenAIResponsePayload(parsedBody)) {
            return response;
          }

          const responseContext: ResponseContext = {
            ...ctx,
            response
          };
          const converted = await this.responseConverter.onResponse?.(responseContext);
          const finalized = converted ?? response;
          return this.ensureAssistantToolUseReasoningContent(finalized);
        }
      );

      hooks.onStreamChunk.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (chunk, ctx) => {
          if (!this.adaptedRequestIds.has(ctx.requestId)) {
            return null;
          }

          if (!this.isOpenAIStreamChunk(chunk)) {
            return null;
          }

          this.streamConversionRequestIds.add(ctx.requestId);
          const converted = await this.responseConverter.processStreamChunk?.(chunk, ctx);
          if (!Array.isArray(converted)) {
            return converted ?? null;
          }

          return this.ensureStreamCompatibility(converted, ctx);
        }
      );

      hooks.onFlushStream.tapPromise(
        { name: 'openai-messages-to-chat', stage: 10 },
        async (chunks, ctx) => {
          if (!this.streamConversionRequestIds.has(ctx.requestId)) {
            return chunks;
          }

          const flushed = await this.responseConverter.flushStream?.(ctx);
          this.streamConversionRequestIds.delete(ctx.requestId);
          const merged = [...chunks, ...(flushed ?? [])];
          return this.ensureStreamCompatibility(merged, ctx);
        }
      );

      hooks.onFinally.tap(
        { name: 'openai-messages-to-chat' },
        (ctx) => {
          this.adaptedRequestIds.delete(ctx.requestId);
          this.streamConversionRequestIds.delete(ctx.requestId);
          this.validationErrors.delete(ctx.requestId);
        }
      );
    }

    async reset(): Promise<void> {
      this.adaptedRequestIds.clear();
      this.streamConversionRequestIds.clear();
      this.validationErrors.clear();
    }

    private async tryParseJsonBody(response: Response): Promise<unknown | null> {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return null;
      }

      try {
        return await response.clone().json();
      } catch {
        return null;
      }
    }

    private isOpenAIResponsePayload(payload: unknown): boolean {
      if (!isRecord(payload)) {
        return false;
      }

      if (Array.isArray(payload.choices) || Array.isArray(payload.output)) {
        return true;
      }

      const objectType = payload.object;
      if (typeof objectType === 'string') {
        return objectType === 'chat.completion' || objectType === 'response';
      }

      if (isRecord(payload.error) && typeof payload.error.message === 'string') {
        return true;
      }

      return false;
    }

    private isOpenAIStreamChunk(chunk: unknown): boolean {
      if (!isRecord(chunk)) {
        return false;
      }

      if (Array.isArray(chunk.choices)) {
        return true;
      }

      const objectType = chunk.object;
      if (typeof objectType === 'string' && objectType.startsWith('chat.completion')) {
        return true;
      }

      const eventType = chunk.type;
      return typeof eventType === 'string' && eventType.startsWith('response.');
    }

    private normalizeAnthropicUsage(usage: unknown): { input_tokens: number; output_tokens: number } {
      if (!isRecord(usage)) {
        return {
          input_tokens: 0,
          output_tokens: 0
        };
      }

      return {
        input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      };
    }

    private extractThinkingTextFromAnthropicContent(content: unknown[]): string {
      const segments: string[] = [];

      for (const block of content) {
        if (!isRecord(block) || block.type !== 'thinking') {
          continue;
        }

        if (typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
          segments.push(block.thinking.trim());
        }
      }

      return segments.join('\n\n');
    }

    private hasToolUseInAnthropicContent(content: unknown[]): boolean {
      return content.some((block) => isRecord(block) && block.type === 'tool_use');
    }

    private async ensureAssistantToolUseReasoningContent(response: Response): Promise<Response> {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return response;
      }

      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        return response;
      }

      if (!isRecord(body) || body.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content)) {
        return response;
      }

      if (!this.hasToolUseInAnthropicContent(body.content)) {
        return response;
      }

      const existingReasoningContent = typeof body.reasoning_content === 'string'
        ? body.reasoning_content
        : undefined;
      if (existingReasoningContent !== undefined) {
        return response;
      }

      const extractedReasoning = this.extractThinkingTextFromAnthropicContent(body.content);
      const patchedBody: JsonObject = {
        ...body,
        reasoning_content: extractedReasoning
      };

      return new Response(JSON.stringify(patchedBody), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    private ensureMessageStartReasoningContent(events: unknown[]): unknown[] {
      return events.map((event) => {
        if (!isRecord(event) || event.type !== 'message_start' || !isRecord(event.message)) {
          return event;
        }

        const existingReasoningContent = event.message.reasoning_content;
        if (typeof existingReasoningContent === 'string') {
          return event;
        }

        return {
          ...event,
          message: {
            ...event.message,
            reasoning_content: ''
          }
        };
      });
    }

    private ensureStreamCompatibility(events: unknown[], ctx: { streamState: Map<string, unknown> }): unknown[] {
      const withUsage = this.ensureMessageDeltaUsage(events, ctx);
      return this.ensureMessageStartReasoningContent(withUsage);
    }

    private ensureMessageDeltaUsage(events: unknown[], ctx: { streamState: Map<string, unknown> }): unknown[] {
      const lastUsageKey = 'messages_compat_last_usage';
      const cachedUsage = this.normalizeAnthropicUsage(ctx.streamState.get(lastUsageKey));

      return events.map((event) => {
        if (!isRecord(event) || event.type !== 'message_delta') {
          return event;
        }

        const normalizedUsage = this.normalizeAnthropicUsage(event.usage ?? cachedUsage);
        ctx.streamState.set(lastUsageKey, normalizedUsage);

        return {
          ...event,
          usage: normalizedUsage
        };
      });
    }

    private shouldHandleRequest(ctx: MutableRequestContext): boolean {
      if (ctx.method.toUpperCase() !== 'POST') {
        return false;
      }

      const normalizedPath = this.normalizePathname(ctx.url.pathname);
      if (normalizedPath === '/v1/messages') {
        return true;
      }

      return this.allowShortPathAlias && normalizedPath === '/messages';
    }

    private normalizePathname(pathname: string): string {
      if (pathname.length > 1 && pathname.endsWith('/')) {
        return pathname.slice(0, -1);
      }

      return pathname;
    }

    private collectConflictingFields(body: JsonObject): string[] {
      const conflictingFields: string[] = [];

      for (const field of RESPONSES_STYLE_FIELDS) {
        if (hasOwn(body, field)) {
          conflictingFields.push(field);
        }
      }

      for (const field of THREAD_RESOURCE_FIELDS) {
        if (hasOwn(body, field)) {
          conflictingFields.push(field);
        }
      }

      return conflictingFields;
    }

    private parseToolsInput(rawTools: unknown):
      | { ok: true; tools: unknown[] }
      | { ok: false; message: string } {
      if (rawTools === undefined || rawTools === null) {
        return { ok: true, tools: [] };
      }

      if (Array.isArray(rawTools)) {
        return { ok: true, tools: rawTools };
      }

      if (typeof rawTools === 'string') {
        const trimmed = rawTools.trim();
        if (!trimmed) {
          return { ok: true, tools: [] };
        }

        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return { ok: true, tools: parsed };
          }

          if (isRecord(parsed)) {
            return { ok: true, tools: [parsed] };
          }

          return {
            ok: false,
            message: '"tools" must be an array/object or a JSON-encoded array/object.'
          };
        } catch {
          return {
            ok: false,
            message: '"tools" string is not valid JSON. Provide tools as array/object instead.'
          };
        }
      }

      if (isRecord(rawTools)) {
        const looksLikeSingleTool = typeof rawTools.name === 'string'
          || isRecord(rawTools.function)
          || rawTools.type === 'function';

        if (looksLikeSingleTool) {
          return { ok: true, tools: [rawTools] };
        }

        const entries = Object.values(rawTools);
        if (entries.every((entry) => isRecord(entry) || typeof entry === 'string')) {
          return { ok: true, tools: entries };
        }
      }

      return {
        ok: false,
        message: '"tools" must be an array/object or a JSON-encoded array/object.'
      };
    }

    private normalizeSingleTool(rawTool: unknown, index: number): NormalizedToolResult {
      let candidate: unknown = rawTool;
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (!trimmed) {
          return {
            ok: false,
            message: `tools[${index}] is empty. Expected a tool object.`
          };
        }

        try {
          candidate = JSON.parse(trimmed);
        } catch {
          return {
            ok: false,
            message: `tools[${index}] is not a valid JSON object.`
          };
        }
      }

      if (!isRecord(candidate)) {
        return {
          ok: false,
          message: `tools[${index}] must be an object.`
        };
      }

      const rawType = typeof candidate.type === 'string' ? candidate.type.trim().toLowerCase() : '';

      if (rawType && rawType !== 'function') {
        return {
          ok: false,
          message: `tools[${index}].type="${rawType}" is not supported by chat completions. Use "function".`
        };
      }

      if (isRecord(candidate.function)) {
        const functionName = typeof candidate.function.name === 'string'
          ? candidate.function.name.trim()
          : '';
        if (!functionName) {
          return {
            ok: false,
            message: `tools[${index}].function.name must be a non-empty string.`
          };
        }

        const functionDescription = typeof candidate.function.description === 'string'
          ? candidate.function.description
          : typeof candidate.description === 'string'
            ? candidate.description
            : '';
        const rawParameters = candidate.function.parameters
          ?? candidate.function.input_schema
          ?? candidate.parameters
          ?? candidate.input_schema;

        return {
          ok: true,
          tool: {
            type: 'function',
            function: {
              name: functionName,
              description: functionDescription,
              parameters: normalizeToolParametersSchema(rawParameters)
            }
          }
        };
      }

      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      if (!name) {
        return {
          ok: false,
          message: `tools[${index}] must include either function.name or name.`
        };
      }

      const description = typeof candidate.description === 'string' ? candidate.description : '';
      const parameters = normalizeToolParametersSchema(candidate.input_schema ?? candidate.parameters);

      return {
        ok: true,
        tool: {
          type: 'function',
          function: {
            name,
            description,
            parameters
          }
        }
      };
    }

    private normalizeTools(rawTools: unknown): NormalizedToolsResult {
      const parsed = this.parseToolsInput(rawTools);
      if (!parsed.ok) {
        if (this.strictValidation) {
          return parsed;
        }

        return { ok: true, tools: undefined };
      }

      if (parsed.tools.length === 0) {
        return { ok: true, tools: undefined };
      }

      const normalizedTools: JsonObject[] = [];
      for (let i = 0; i < parsed.tools.length; i += 1) {
        const normalizedTool = this.normalizeSingleTool(parsed.tools[i], i);
        if (!normalizedTool.ok) {
          if (this.strictValidation) {
            return normalizedTool;
          }

          continue;
        }

        normalizedTools.push(normalizedTool.tool);
      }

      if (normalizedTools.length === 0) {
        return { ok: true, tools: undefined };
      }

      return { ok: true, tools: normalizedTools };
    }

    private normalizeToolChoice(rawToolChoice: unknown): NormalizedToolChoiceResult {
      if (rawToolChoice === undefined || rawToolChoice === null) {
        return { ok: true, toolChoice: undefined };
      }

      if (typeof rawToolChoice === 'string') {
        const normalized = rawToolChoice.trim().toLowerCase();
        if (!normalized) {
          return { ok: true, toolChoice: undefined };
        }

        if (normalized === 'auto' || normalized === 'none' || normalized === 'required') {
          return { ok: true, toolChoice: normalized };
        }

        if (normalized === 'any') {
          return { ok: true, toolChoice: 'required' };
        }

        return {
          ok: false,
          message: `tool_choice="${normalized}" is not supported.`
        };
      }

      if (!isRecord(rawToolChoice)) {
        return {
          ok: false,
          message: '"tool_choice" must be a string or object.'
        };
      }

      const typeValue = typeof rawToolChoice.type === 'string' ? rawToolChoice.type.trim().toLowerCase() : '';
      if (!typeValue) {
        return {
          ok: false,
          message: '"tool_choice.type" is required when tool_choice is an object.'
        };
      }

      if (typeValue === 'auto' || typeValue === 'none') {
        return { ok: true, toolChoice: typeValue };
      }

      if (typeValue === 'any' || typeValue === 'required') {
        return { ok: true, toolChoice: 'required' };
      }

      if (typeValue === 'tool') {
        const toolName = typeof rawToolChoice.name === 'string' ? rawToolChoice.name.trim() : '';
        if (!toolName) {
          return {
            ok: false,
            message: 'tool_choice with type "tool" requires a non-empty name.'
          };
        }

        return {
          ok: true,
          toolChoice: {
            type: 'function',
            function: {
              name: toolName
            }
          }
        };
      }

      if (typeValue === 'function') {
        const functionSpec = rawToolChoice.function;
        if (!isRecord(functionSpec)) {
          return {
            ok: false,
            message: 'tool_choice.type="function" requires a function object.'
          };
        }

        const functionName = typeof functionSpec.name === 'string' ? functionSpec.name.trim() : '';
        if (!functionName) {
          return {
            ok: false,
            message: 'tool_choice.function.name must be a non-empty string.'
          };
        }

        return {
          ok: true,
          toolChoice: {
            type: 'function',
            function: {
              name: functionName
            }
          }
        };
      }

      return {
        ok: false,
        message: `tool_choice.type="${typeValue}" is not supported.`
      };
    }

    private validateAndNormalizeBody(rawBody: unknown): BodyValidationResult {
      if (!isRecord(rawBody)) {
        return {
          ok: false,
          message: 'messages compatibility route requires a JSON object body.'
        };
      }

      const conflictingFields = this.collectConflictingFields(rawBody);
      if (this.strictValidation && conflictingFields.length > 0) {
        return {
          ok: false,
          message: `messages compatibility route does not accept these fields: ${conflictingFields.join(', ')}.`
        };
      }

      const model = rawBody.model;
      if (typeof model !== 'string' || model.trim().length === 0) {
        return {
          ok: false,
          message: 'messages compatibility route requires a non-empty "model" field.'
        };
      }

      const messages = rawBody.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return {
          ok: false,
          message: 'messages compatibility route requires a non-empty "messages" array.'
        };
      }

      const normalizedMessages: JsonObject[] = [];
      for (let i = 0; i < messages.length; i += 1) {
        const normalizedMessage = this.normalizeMessage(messages[i], i + 1);
        if (!normalizedMessage.ok) {
          return {
            ok: false,
            message: normalizedMessage.message
          };
        }

        normalizedMessages.push(...normalizedMessage.messages);
      }

      const normalizedBody: JsonObject = {
        ...rawBody,
        model: model.trim(),
        messages: normalizedMessages
      };

      const normalizedTools = this.normalizeTools(rawBody.tools);
      if (!normalizedTools.ok) {
        return {
          ok: false,
          message: normalizedTools.message
        };
      }

      if (normalizedTools.tools && normalizedTools.tools.length > 0) {
        normalizedBody.tools = normalizedTools.tools;
      } else {
        delete normalizedBody.tools;
      }

      const normalizedToolChoice = this.normalizeToolChoice(rawBody.tool_choice);
      if (!normalizedToolChoice.ok) {
        return {
          ok: false,
          message: normalizedToolChoice.message
        };
      }

      if (normalizedToolChoice.toolChoice !== undefined) {
        normalizedBody.tool_choice = normalizedToolChoice.toolChoice;
      } else {
        delete normalizedBody.tool_choice;
      }

      if (!this.strictValidation) {
        for (const field of conflictingFields) {
          delete normalizedBody[field];
        }
      }

      return {
        ok: true,
        body: normalizedBody
      };
    }

    private normalizeMessage(rawMessage: unknown, messageIndex: number): NormalizedMessageResult {
      if (!isRecord(rawMessage)) {
        return {
          ok: false,
          message: `messages[${messageIndex}] must be an object.`
        };
      }

      const role = rawMessage.role;
      if (typeof role !== 'string' || !SUPPORTED_ROLES.has(role)) {
        return {
          ok: false,
          message: `messages[${messageIndex}].role must be one of: system, developer, user, assistant, tool.`
        };
      }

      if (role === 'tool') {
        const toolCallId = rawMessage.tool_call_id;
        if (typeof toolCallId !== 'string' || toolCallId.trim().length === 0) {
          return {
            ok: false,
            message: `messages[${messageIndex}] with role "tool" requires non-empty "tool_call_id".`
          };
        }
      }

      const normalizedMessage: JsonObject = { ...rawMessage, role };
      const content = rawMessage.content;

      if (content === null) {
        if (role !== 'assistant') {
          return {
            ok: false,
            message: `messages[${messageIndex}].content can only be null when role is "assistant".`
          };
        }

        normalizedMessage.content = null;
        return {
          ok: true,
          messages: [normalizedMessage]
        };
      }

      if (typeof content === 'string') {
        normalizedMessage.content = content;
        return {
          ok: true,
          messages: [normalizedMessage]
        };
      }

      if (Array.isArray(content)) {
        if (role === 'user') {
          return this.normalizeUserMessageWithToolResults(rawMessage, messageIndex, content);
        }

        if (role === 'assistant') {
          return this.normalizeAssistantMessageWithToolUse(rawMessage, messageIndex, content);
        }

        const normalizedParts: unknown[] = [];

        for (let i = 0; i < content.length; i += 1) {
          const normalizedPart = this.normalizeContentPart(content[i], messageIndex, i + 1);
          if (!normalizedPart.ok) {
            if (this.strictValidation) {
              return {
                ok: false,
                message: normalizedPart.message
              };
            }

            normalizedParts.push(content[i]);
            continue;
          }

          normalizedParts.push(normalizedPart.part);
        }

        normalizedMessage.content = normalizedParts;
        return {
          ok: true,
          messages: [normalizedMessage]
        };
      }

      if (content === undefined) {
        const hasToolCalls = Array.isArray(rawMessage.tool_calls) && rawMessage.tool_calls.length > 0;
        if (role === 'assistant' && hasToolCalls) {
          return {
            ok: true,
            messages: [normalizedMessage]
          };
        }

        if (this.strictValidation) {
          return {
            ok: false,
            message: `messages[${messageIndex}].content is required unless assistant tool_calls are present.`
          };
        }
      }

      return {
        ok: true,
        messages: [normalizedMessage]
      };
    }

    private normalizeToolCallId(rawId: unknown, name: string, index: number): string {
      if (typeof rawId === 'string' && rawId.trim().length > 0) {
        return rawId.trim();
      }

      return `call_${name}_${index}`;
    }

    private normalizeToolResultContent(content: unknown): string {
      if (content === undefined || content === null) {
        return '';
      }

      if (typeof content === 'string') {
        return content;
      }

      if (Array.isArray(content)) {
        const normalizedBlocks = content
          .map((part) => {
            if (typeof part === 'string') {
              return { type: 'text', text: part };
            }

            if (!isRecord(part)) {
              return null;
            }

            if (part.type === 'text' && typeof part.text === 'string') {
              return { type: 'text', text: part.text };
            }

            if (part.type === 'image' && isRecord(part.source)) {
              if (part.source.type === 'url' && typeof part.source.url === 'string') {
                return {
                  type: 'image_url',
                  image_url: {
                    url: part.source.url
                  }
                };
              }

              if (
                part.source.type === 'base64'
                && typeof part.source.media_type === 'string'
                && typeof part.source.data === 'string'
              ) {
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
          .filter((part) => part !== null);

        if (normalizedBlocks.length === 0) {
          return '';
        }

        const first = normalizedBlocks[0];
        if (
          normalizedBlocks.length === 1
          && isRecord(first)
          && first.type === 'text'
          && typeof first.text === 'string'
        ) {
          return first.text;
        }

        return JSON.stringify(normalizedBlocks);
      }

      if (isRecord(content)) {
        if (hasOwn(content, 'content')) {
          return this.normalizeToolResultContent(content.content);
        }

        return JSON.stringify(content);
      }

      return String(content);
    }

    private extractThinkingText(part: unknown): string | undefined {
      if (!isRecord(part)) {
        return undefined;
      }

      if (part.type === 'thinking') {
        if (typeof part.thinking === 'string' && part.thinking.trim().length > 0) {
          return part.thinking;
        }

        if (typeof part.text === 'string' && part.text.trim().length > 0) {
          return part.text;
        }
      }

      if (part.type === 'reasoning') {
        if (typeof part.reasoning === 'string' && part.reasoning.trim().length > 0) {
          return part.reasoning;
        }

        if (typeof part.text === 'string' && part.text.trim().length > 0) {
          return part.text;
        }
      }

      if (part.type === 'reasoning_content' && typeof part.text === 'string' && part.text.trim().length > 0) {
        return part.text;
      }

      return undefined;
    }

    private normalizeUserMessageWithToolResults(
      rawMessage: JsonObject,
      messageIndex: number,
      content: unknown[]
    ): NormalizedMessageResult {
      const toolMessages: JsonObject[] = [];
      const userParts: unknown[] = [];

      for (let i = 0; i < content.length; i += 1) {
        const rawPart = content[i];
        if (isRecord(rawPart) && rawPart.type === 'tool_result') {
          const toolUseId = typeof rawPart.tool_use_id === 'string' ? rawPart.tool_use_id.trim() : '';
          if (!toolUseId) {
            if (this.strictValidation) {
              return {
                ok: false,
                message: `messages[${messageIndex}].content[${i + 1}] with type tool_result requires non-empty tool_use_id.`
              };
            }

            continue;
          }

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolUseId,
            content: this.normalizeToolResultContent(rawPart.content)
          });
          continue;
        }

        const normalizedPart = this.normalizeContentPart(rawPart, messageIndex, i + 1);
        if (!normalizedPart.ok) {
          if (this.strictValidation) {
            return {
              ok: false,
              message: normalizedPart.message
            };
          }

          userParts.push(rawPart);
          continue;
        }

        userParts.push(normalizedPart.part);
      }

      const outputMessages: JsonObject[] = [...toolMessages];
      if (userParts.length > 0 || toolMessages.length === 0) {
        outputMessages.push({
          ...rawMessage,
          role: 'user',
          content: userParts
        });
      }

      return {
        ok: true,
        messages: outputMessages
      };
    }

    private normalizeAssistantMessageWithToolUse(
      rawMessage: JsonObject,
      messageIndex: number,
      content: unknown[]
    ): NormalizedMessageResult {
      const toolCalls: JsonObject[] = [];
      const normalizedParts: unknown[] = [];
      const thinkingSegments: string[] = [];

      for (let i = 0; i < content.length; i += 1) {
        const rawPart = content[i];

        const thinkingText = this.extractThinkingText(rawPart);
        if (typeof thinkingText === 'string') {
          thinkingSegments.push(thinkingText);
          continue;
        }

        if (isRecord(rawPart) && rawPart.type === 'tool_use') {
          const functionName = typeof rawPart.name === 'string' ? rawPart.name.trim() : '';
          if (!functionName) {
            if (this.strictValidation) {
              return {
                ok: false,
                message: `messages[${messageIndex}].content[${i + 1}] with type tool_use requires non-empty name.`
              };
            }

            continue;
          }

          const argumentsValue = isRecord(rawPart.input) || Array.isArray(rawPart.input)
            ? rawPart.input
            : rawPart.input ?? {};

          toolCalls.push({
            id: this.normalizeToolCallId(rawPart.id, functionName, i),
            type: 'function',
            function: {
              name: functionName,
              arguments: JSON.stringify(argumentsValue)
            }
          });
          continue;
        }

        const normalizedPart = this.normalizeContentPart(rawPart, messageIndex, i + 1);
        if (!normalizedPart.ok) {
          if (this.strictValidation) {
            return {
              ok: false,
              message: normalizedPart.message
            };
          }

          normalizedParts.push(rawPart);
          continue;
        }

        normalizedParts.push(normalizedPart.part);
      }

      const normalizedMessage: JsonObject = {
        ...rawMessage,
        role: 'assistant'
      };

      const reasoningFromMessage = typeof rawMessage.reasoning_content === 'string'
        ? rawMessage.reasoning_content.trim()
        : '';
      if (thinkingSegments.length > 0) {
        normalizedMessage.reasoning_content = thinkingSegments.join('\n\n');
      } else if (reasoningFromMessage.length > 0) {
        normalizedMessage.reasoning_content = reasoningFromMessage;
      }

      if (toolCalls.length > 0) {
        normalizedMessage.tool_calls = toolCalls;

        const textSegments: string[] = [];
        for (let i = 0; i < normalizedParts.length; i += 1) {
          const part = normalizedParts[i];
          if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
            textSegments.push(part.text);
            continue;
          }

          if (this.strictValidation) {
            return {
              ok: false,
              message: `messages[${messageIndex}].content contains non-text blocks alongside tool_use, which is not supported.`
            };
          }

          textSegments.push(JSON.stringify(part));
        }

        const mergedText = textSegments.join('').trim();
        normalizedMessage.content = mergedText.length > 0 ? mergedText : null;

        return {
          ok: true,
          messages: [normalizedMessage]
        };
      }

      normalizedMessage.content = normalizedParts.length > 0 ? normalizedParts : '';
      return {
        ok: true,
        messages: [normalizedMessage]
      };
    }

    private normalizeContentPart(rawPart: unknown, messageIndex: number, partIndex: number): NormalizedPartResult {
      if (typeof rawPart === 'string') {
        return {
          ok: true,
          part: {
            type: 'text',
            text: rawPart
          }
        };
      }

      if (!isRecord(rawPart)) {
        return {
          ok: false,
          message: `messages[${messageIndex}].content[${partIndex}] must be a string or object part.`
        };
      }

      const partType = rawPart.type;

      if (partType === 'input_text' || partType === 'output_text') {
        if (typeof rawPart.text !== 'string') {
          return {
            ok: false,
            message: `messages[${messageIndex}].content[${partIndex}] with type ${String(partType)} requires string "text".`
          };
        }

        return {
          ok: true,
          part: {
            type: 'text',
            text: rawPart.text
          }
        };
      }

      if (partType === 'thinking' || partType === 'reasoning' || partType === 'reasoning_content') {
        const thinkingText = this.extractThinkingText(rawPart);
        if (typeof thinkingText !== 'string') {
          return {
            ok: false,
            message: `messages[${messageIndex}].content[${partIndex}] with type ${String(partType)} requires textual thinking content.`
          };
        }

        return {
          ok: true,
          part: {
            type: 'text',
            text: thinkingText
          }
        };
      }

      if (partType === 'input_image') {
        const imageUrl = extractImageUrl(rawPart);
        if (!imageUrl) {
          return {
            ok: false,
            message: `messages[${messageIndex}].content[${partIndex}] with type input_image requires image_url.`
          };
        }

        return {
          ok: true,
          part: {
            type: 'image_url',
            image_url: {
              url: imageUrl
            }
          }
        };
      }

      if (partType === 'image' && isRecord(rawPart.source)) {
        if (rawPart.source.type === 'url' && typeof rawPart.source.url === 'string') {
          return {
            ok: true,
            part: {
              type: 'image_url',
              image_url: {
                url: rawPart.source.url
              }
            }
          };
        }

        if (
          rawPart.source.type === 'base64'
          && typeof rawPart.source.media_type === 'string'
          && typeof rawPart.source.data === 'string'
        ) {
          return {
            ok: true,
            part: {
              type: 'image_url',
              image_url: {
                url: `data:${rawPart.source.media_type};base64,${rawPart.source.data}`
              }
            }
          };
        }
      }

      if (partType === 'tool_result') {
        return {
          ok: false,
          message: `messages[${messageIndex}].content[${partIndex}] with type tool_result must be represented as role=tool with tool_call_id.`
        };
      }

      if (partType === 'tool_use') {
        return {
          ok: false,
          message: `messages[${messageIndex}].content[${partIndex}] with type tool_use must be represented as assistant.tool_calls.`
        };
      }

      return {
        ok: true,
        part: rawPart
      };
    }

    private buildBadRequest(message: string): Response {
      return new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message
          }
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }
  }
);

export default OpenAIMessagesToChatPlugin;
