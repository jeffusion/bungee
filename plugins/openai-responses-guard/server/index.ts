import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';

interface OpenAIResponsesGuardOptions {
  trimWhitespace?: boolean;
}

type JsonRecord = Record<string, unknown>;

const THINKING_TAG_PATTERN = /<thinking>([\s\S]*?)<\/thinking>/gi;
const TOOL_CALL_CONTENT_TYPES = new Set([
  'tool_use',
  'tool_call',
  'function_call',
  'output_tool_call'
]);

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

function isResponsesPath(pathname: string): boolean {
  const normalizedPath = normalizePath(pathname);
  return normalizedPath === '/v1/responses' || normalizedPath === '/responses';
}

function isReasoningContext(body: JsonRecord): boolean {
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

function normalizeAssistantToolCallCandidate(
  value: unknown,
  trimWhitespace: boolean
): { normalized: unknown; changed: boolean } {
  if (!isRecord(value)) {
    return { normalized: value, changed: false };
  }

  let changed = false;
  let current: JsonRecord = value;

  if (isRecord(current.message)) {
    const nested = normalizeAssistantToolCallCandidate(current.message, trimWhitespace);
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

  const normalizedMessage = normalizeAssistantToolCallMessage(current, trimWhitespace);
  if (normalizedMessage !== current) {
    current = normalizedMessage;
    changed = true;
  }

  return { normalized: current, changed };
}

function normalizeMessageCollection(
  body: JsonRecord,
  key: 'input' | 'messages',
  trimWhitespace: boolean
): { body: JsonRecord; changed: boolean } {
  const collection = body[key];
  if (!Array.isArray(collection)) {
    return { body, changed: false };
  }

  let changed = false;
  const normalizedCollection = collection.map((item) => {
    const normalizedItem = normalizeAssistantToolCallCandidate(item, trimWhitespace);
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

function normalizeAssistantToolCallMessage(
  message: JsonRecord,
  trimWhitespace: boolean
): JsonRecord {
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

function normalizeResponsesInput(
  body: JsonRecord,
  trimWhitespace: boolean
): JsonRecord {
  let changed = false;
  let normalizedBody = body;

  for (const key of ['input', 'messages'] as const) {
    const normalizedCollection = normalizeMessageCollection(normalizedBody, key, trimWhitespace);
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

export const OpenAIResponsesGuardPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'openai-responses-guard';
    static readonly version = '1.0.0';

    private readonly trimWhitespace: boolean;

    constructor(options?: OpenAIResponsesGuardOptions) {
      this.trimWhitespace = options?.trimWhitespace !== false;
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'openai-responses-guard', stage: 5 },
        ctx => {
          if (!isResponsesPath(ctx.url.pathname)) {
            return ctx;
          }

          if (!isRecord(ctx.body)) {
            return ctx;
          }

          if (!isReasoningContext(ctx.body)) {
            return ctx;
          }

          ctx.body = normalizeResponsesInput(ctx.body, this.trimWhitespace);
          return ctx;
        }
      );
    }

    async reset(): Promise<void> {}
  }
);

export default OpenAIResponsesGuardPlugin;
