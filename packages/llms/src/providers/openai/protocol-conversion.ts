export type JsonRecord = Record<string, unknown>;

export interface OpenAIProtocolConversionOptions {
  trimWhitespace?: boolean;
}

const THINKING_TAG_PATTERN = /<thinking>([\s\S]*?)<\/thinking>/gi;
const TOOL_CALL_CONTENT_TYPES = new Set([
  'tool_use',
  'tool_call',
  'function_call',
  'output_tool_call'
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, trimWhitespace: boolean): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return trimWhitespace ? value.trim() : value;
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function isEnabledLike(value: unknown): boolean {
  if (value === true) {
    return true;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'enabled'
      || normalized === 'enable'
      || normalized === 'true'
      || normalized === 'on'
      || normalized === '1';
  }

  if (!isRecord(value)) {
    return false;
  }

  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (type === 'disabled' || type === 'disable' || type === 'off') {
    return false;
  }

  if (value.enabled === false) {
    return false;
  }

  if (value.enabled === true) {
    return true;
  }

  if (type === 'enabled' || type === 'enable') {
    return true;
  }

  return Object.keys(value).length > 0;
}

function isToolCallContentBlock(item: JsonRecord): boolean {
  const itemType = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
  if (TOOL_CALL_CONTENT_TYPES.has(itemType) || itemType.endsWith('_call')) {
    return true;
  }

  const hasCallIdentifier = typeof item.id === 'string'
    || typeof item.call_id === 'string'
    || typeof item.name === 'string';
  const hasCallPayload = item.input !== undefined
    || item.arguments !== undefined
    || item.function !== undefined;

  return hasCallIdentifier && hasCallPayload;
}

function hasToolCalls(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.length > 0;
    }

    return isRecord(parsed);
  } catch {
    return true;
  }
}

function hasToolCallLikeContent(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    if (isToolCallContentBlock(item)) {
      return true;
    }
  }

  return false;
}

function isAssistantToolCallMessage(message: JsonRecord): boolean {
  if (message.role !== 'assistant') {
    return false;
  }

  return hasToolCalls(message.tool_calls) || hasToolCallLikeContent(message.content);
}

function extractThinkingTagContent(content: string, trimWhitespace: boolean): string {
  THINKING_TAG_PATTERN.lastIndex = 0;
  const extracted: string[] = [];
  let matched: RegExpExecArray | null = THINKING_TAG_PATTERN.exec(content);
  while (matched !== null) {
    const block = asString(matched[1], trimWhitespace);
    if (block) {
      extracted.push(block);
    }
    matched = THINKING_TAG_PATTERN.exec(content);
  }

  if (extracted.length === 0) {
    return '';
  }

  return extracted.join('\n\n');
}

function extractReasoningFromArrayContent(content: unknown[], trimWhitespace: boolean): string {
  const reasoningTexts: string[] = [];

  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    const type = typeof item.type === 'string' ? item.type : '';
    if (type !== 'reasoning' && type !== 'thinking' && type !== 'reasoning_content') {
      continue;
    }

    const candidates: unknown[] = [
      item.text,
      item.content,
      item.reasoning,
      item.thinking
    ];

    for (const candidate of candidates) {
      const text = asString(candidate, trimWhitespace);
      if (text && text.length > 0) {
        reasoningTexts.push(text);
        break;
      }
    }
  }

  if (reasoningTexts.length === 0) {
    return '';
  }

  return reasoningTexts.join('\n\n');
}

function extractReasoningContent(content: unknown, trimWhitespace: boolean): string {
  if (typeof content === 'string') {
    return extractThinkingTagContent(content, trimWhitespace);
  }

  if (Array.isArray(content)) {
    return extractReasoningFromArrayContent(content, trimWhitespace);
  }

  return '';
}

function normalizeAnthropicUsage(usage: unknown): { input_tokens: number; output_tokens: number } {
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

function normalizeAssistantToolCallMessage(message: JsonRecord, trimWhitespace: boolean): JsonRecord {
  if (typeof message.reasoning_content === 'string') {
    const normalized = trimWhitespace ? message.reasoning_content.trim() : message.reasoning_content;
    if (normalized === message.reasoning_content) {
      return message;
    }

    return {
      ...message,
      reasoning_content: normalized
    };
  }

  return {
    ...message,
    reasoning_content: extractReasoningContent(message.content, trimWhitespace)
  };
}

function convertChatUserContentToResponsesContent(content: unknown): JsonRecord[] {
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ type: 'input_text', text }] : [{ type: 'input_text', text: '' }];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: '' }];
  }

  const converted: JsonRecord[] = [];

  for (const part of content) {
    if (typeof part === 'string') {
      const text = part.trim();
      if (text) {
        converted.push({ type: 'input_text', text });
      }
      continue;
    }

    if (!isRecord(part)) {
      continue;
    }

    if (part.type === 'text' && typeof part.text === 'string') {
      converted.push({ type: 'input_text', text: part.text });
      continue;
    }

    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      converted.push({ type: 'input_image', image_url: part.image_url.url });
    }
  }

  return converted.length > 0 ? converted : [{ type: 'input_text', text: '' }];
}

export class OpenAIProtocolConversion {
  private readonly trimWhitespace: boolean;

  constructor(options?: OpenAIProtocolConversionOptions) {
    this.trimWhitespace = options?.trimWhitespace !== false;
  }

  isResponsesPath(pathname: string): boolean {
    const normalizedPath = normalizePath(pathname);
    return normalizedPath === '/v1/responses' || normalizedPath === '/responses';
  }

  isReasoningContext(body: JsonRecord): boolean {
    if (body.reasoning !== undefined && body.reasoning !== null) {
      return true;
    }

    if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim().length > 0) {
      return true;
    }

    if (isEnabledLike(body.enable_thinking)) {
      return true;
    }

    return isEnabledLike(body.thinking);
  }

  normalizeResponsesReasoningBody(body: JsonRecord): JsonRecord {
    let changed = false;
    let normalizedBody = body;

    for (const key of ['input', 'messages'] as const) {
      const normalizedCollection = this.normalizeMessageCollection(normalizedBody, key);
      if (normalizedCollection.changed) {
        normalizedBody = normalizedCollection.body;
        changed = true;
      }
    }

    if (!changed) {
      return body;
    }

    return normalizedBody;
  }

  async ensureAssistantToolUseReasoningContent(response: Response): Promise<Response> {
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

    if (!body.content.some((block) => isRecord(block) && block.type === 'tool_use')) {
      return response;
    }

    const existingReasoningContent = typeof body.reasoning_content === 'string'
      ? body.reasoning_content
      : undefined;
    if (existingReasoningContent !== undefined) {
      return response;
    }

    const extractedReasoning = this.extractThinkingTextFromAnthropicContent(body.content);
    const patchedBody: JsonRecord = {
      ...body,
      reasoning_content: extractedReasoning
    };

    return new Response(JSON.stringify(patchedBody), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  ensureMessagesStreamCompatibility(
    events: unknown[],
    ctx: { streamState: Map<string, unknown> }
  ): unknown[] {
    const withUsage = this.ensureMessageDeltaUsage(events, ctx);
    return this.ensureMessageStartReasoningContent(withUsage);
  }

  convertChatMessagesToResponsesInput(messages: unknown): { input: JsonRecord[]; instructions?: string } {
    if (!Array.isArray(messages)) {
      return { input: [] };
    }

    const input: JsonRecord[] = [];
    const instructionParts: string[] = [];

    for (const msg of messages) {
      if (!isRecord(msg)) {
        continue;
      }

      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text) instructionParts.push(text);
        continue;
      }

      if (msg.role === 'user') {
        input.push({
          role: 'user',
          content: convertChatUserContentToResponsesContent(msg.content)
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const assistantText = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (assistantText) {
          input.push({
            role: 'assistant',
            content: [{ type: 'output_text', text: assistantText }]
          });
        }

        if (Array.isArray(msg.tool_calls)) {
          for (const toolCall of msg.tool_calls) {
            if (!isRecord(toolCall)) {
              continue;
            }

            const callId = typeof toolCall.id === 'string' ? toolCall.id : '';
            const functionObject = isRecord(toolCall.function) ? toolCall.function : undefined;
            if (!functionObject) {
              continue;
            }
            const functionName = typeof functionObject?.name === 'string' ? functionObject.name : '';
            if (!callId || !functionName) {
              continue;
            }

            input.push({
              type: 'function_call',
              call_id: callId,
              name: functionName,
              arguments: functionObject.arguments || '{}'
            });
          }
        }

        continue;
      }

      if (msg.role === 'tool') {
        const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
        if (!callId) {
          continue;
        }

        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: msg.content ?? ''
        });
      }
    }

    const instructions = instructionParts.length > 0 ? instructionParts.join('\n') : undefined;
    return { input, instructions };
  }

  mapChatToolsToResponsesTools(chatTools: unknown): JsonRecord[] {
    if (!Array.isArray(chatTools)) {
      return [];
    }

    const mapped: JsonRecord[] = [];
    for (const tool of chatTools) {
      if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
        continue;
      }

      const name = typeof tool.function.name === 'string' ? tool.function.name : '';
      if (!name) {
        continue;
      }

      const parameters = isRecord(tool.function.parameters)
        ? tool.function.parameters
        : { type: 'object', properties: {} };

      mapped.push({
        type: 'function',
        name,
        description: typeof tool.function.description === 'string' ? tool.function.description : '',
        parameters
      });
    }

    return mapped;
  }

  convertResponsesInputToMessages(input: unknown): JsonRecord[] {
    if (typeof input === 'string') {
      const text = input.trim();
      return text ? [{ role: 'user', content: text }] : [];
    }

    if (!Array.isArray(input)) {
      return [];
    }

    const messages: JsonRecord[] = [];
    const pendingTopLevelInputParts: unknown[] = [];

    const flushPendingTopLevelInputParts = (): void => {
      if (pendingTopLevelInputParts.length === 0) {
        return;
      }

      messages.push({
        role: 'user',
        content: this.normalizeResponsesMessageContent([...pendingTopLevelInputParts])
      });

      pendingTopLevelInputParts.length = 0;
    };

    for (const item of input) {
      if (typeof item === 'string') {
        if (item.trim()) {
          pendingTopLevelInputParts.push({ type: 'input_text', text: item });
        }
        continue;
      }

      if (!isRecord(item)) {
        continue;
      }

      const itemType = item.type;

      if (
        itemType === 'input_text'
        || itemType === 'output_text'
        || itemType === 'input_image'
        || itemType === 'text'
        || itemType === 'image_url'
      ) {
        pendingTopLevelInputParts.push(item);
        continue;
      }

      if (itemType === 'function_call') {
        flushPendingTopLevelInputParts();

        const rawArgs = item.arguments;
        const argumentsString = typeof rawArgs === 'string'
          ? rawArgs
          : JSON.stringify(rawArgs || {});

        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id || item.id || '',
            type: 'function',
            function: {
              name: item.name || '',
              arguments: argumentsString
            }
          }]
        });
        continue;
      }

      if (itemType === 'function_call_output') {
        flushPendingTopLevelInputParts();

        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || '',
          content: item.output ?? '',
          is_error: item.is_error === true || item.status === 'error' || item.status === 'failed'
        });
        continue;
      }

      if (itemType === 'message') {
        flushPendingTopLevelInputParts();

        const role = item.role || 'user';
        if (typeof role === 'string') {
          messages.push({
            role,
            content: this.normalizeResponsesMessageContent(item.content)
          });
        }
        continue;
      }

      if (typeof item.role === 'string') {
        flushPendingTopLevelInputParts();

        messages.push({
          role: item.role,
          content: this.normalizeResponsesMessageContent(item.content)
        });
      }
    }

    flushPendingTopLevelInputParts();

    return messages;
  }

  normalizeResponsesMessageContent(content: unknown): unknown {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return content;
    }

    const converted = content
      .map((part) => {
        if (typeof part === 'string') {
          return { type: 'text', text: part };
        }

        if (!isRecord(part)) {
          return null;
        }

        if (part.type === 'input_text' || part.type === 'output_text') {
          return { type: 'text', text: part.text || '' };
        }

        if (part.type === 'input_image') {
          const imageUrl = typeof part.image_url === 'string'
            ? part.image_url
            : isRecord(part.image_url)
              ? part.image_url.url
              : undefined;

          if (typeof imageUrl === 'string' && imageUrl) {
            return {
              type: 'image_url',
              image_url: { url: imageUrl }
            };
          }
        }

        return part;
      })
      .filter((part) => part !== null);

    return converted;
  }

  private normalizeMessageCollection(
    body: JsonRecord,
    key: 'input' | 'messages'
  ): { body: JsonRecord; changed: boolean } {
    const collection = body[key];
    if (!Array.isArray(collection)) {
      return { body, changed: false };
    }

    let changed = false;
    const normalizedCollection = collection.map((item) => {
      const normalizedItem = this.normalizeAssistantToolCallCandidate(item);
      if (normalizedItem.changed) {
        changed = true;
      }

      return normalizedItem.normalized;
    });

    if (!changed) {
      return { body, changed: false };
    }

    return {
      body: {
        ...body,
        [key]: normalizedCollection
      },
      changed: true
    };
  }

  private normalizeAssistantToolCallCandidate(
    value: unknown
  ): { normalized: unknown; changed: boolean } {
    if (!isRecord(value)) {
      return { normalized: value, changed: false };
    }

    let changed = false;
    let current: JsonRecord = value;

    if (isRecord(current.message)) {
      const nested = this.normalizeAssistantToolCallCandidate(current.message);
      if (nested.changed) {
        current = {
          ...current,
          message: nested.normalized
        };
        changed = true;
      }
    }

    if (!isAssistantToolCallMessage(current)) {
      return { normalized: current, changed };
    }

    const normalizedMessage = normalizeAssistantToolCallMessage(current, this.trimWhitespace);
    if (normalizedMessage !== current) {
      current = normalizedMessage;
      changed = true;
    }

    return { normalized: current, changed };
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

  private ensureMessageDeltaUsage(
    events: unknown[],
    ctx: { streamState: Map<string, unknown> }
  ): unknown[] {
    const lastUsageKey = 'messages_compat_last_usage';
    const cachedUsage = normalizeAnthropicUsage(ctx.streamState.get(lastUsageKey));

    return events.map((event) => {
      if (!isRecord(event) || event.type !== 'message_delta') {
        return event;
      }

      const normalizedUsage = normalizeAnthropicUsage(event.usage ?? cachedUsage);
      ctx.streamState.set(lastUsageKey, normalizedUsage);

      return {
        ...event,
        usage: normalizedUsage
      };
    });
  }
}
