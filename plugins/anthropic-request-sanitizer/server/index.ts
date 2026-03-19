import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';

type SanitizeMode = 'none' | 'normal' | 'aggressive';
type BetaMode = 'none' | 'passthrough' | 'allowlist' | 'strip';

interface AnthropicRequestSanitizerOptions {
  sanitizeMode?: SanitizeMode;
  stripCacheControl?: boolean;
  betaMode?: BetaMode;
  betaAllowlist?: string;
  removeBetaQuery?: boolean;
  filterOrphanToolResults?: boolean;
}

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => deepClone(item)) as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepClone(v);
    }
    return out as T;
  }
  return value;
}

function stripKeysDeep(value: unknown, keySet: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map(item => stripKeysDeep(item, keySet));
  }
  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (keySet.has(k)) continue;
    out[k] = stripKeysDeep(v, keySet);
  }
  return out;
}

function normalizeTool(tool: unknown, aggressive: boolean): unknown {
  if (!isRecord(tool)) return tool;

  const out: Record<string, unknown> = { ...tool };
  const typeValue = out.type;

  if (typeValue === 'deferred' && isRecord(out.tool)) {
    Object.assign(out, out.tool);
    delete out.tool;
  }

  if ('type' in out) {
    if (aggressive || typeValue === 'deferred') {
      delete out.type;
    }
  }

  delete out.deferred;
  return out;
}

function sanitizeBody(
  inputBody: unknown,
  aggressive: boolean,
  stripCacheControl: boolean
): unknown {
  let out = deepClone(inputBody);

  if (stripCacheControl) {
    out = stripKeysDeep(out, new Set(['cache_control']));
  }

  if (isRecord(out)) {
    const tools = out.tools;
    if (Array.isArray(tools)) {
      const normalizedTools = tools
        .map(tool => normalizeTool(tool, aggressive))
        .filter(tool => isRecord(tool));

      if (normalizedTools.length === 0) {
        delete out.tools;
      } else {
        out.tools = normalizedTools;
      }
    }
  }

  if (aggressive && isRecord(out)) {
    delete out.context_management;
    delete out.container;
    delete out.metadata;
    delete out.effort;
    delete out.service_tier;
  }

  return out;
}

/**
 * Filter orphan tool_results from messages.
 * For each user message containing tool_result blocks, only keep those
 * whose tool_use_id matches a tool_use in the immediately preceding assistant message.
 * Remove messages that become empty after filtering.
 */
function filterOrphanToolResults(body: unknown): void {
  if (!isRecord(body)) return;
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  for (let i = 0; i < messages.length; i++) {
    const assistantMsg = messages[i];
    if (!isRecord(assistantMsg) || assistantMsg.role !== 'assistant' || !Array.isArray(assistantMsg.content)) {
      continue;
    }

    const assistantContent = assistantMsg.content as unknown[];
    const assistantToolUseBlocks = assistantContent
      .filter(block => isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string');

    if (assistantToolUseBlocks.length > 0) {
      const assistantNonToolUseBlocks = assistantContent
        .filter(block => !(isRecord(block) && block.type === 'tool_use'));
      assistantMsg.content = [...assistantNonToolUseBlocks, ...assistantToolUseBlocks];
    }

    const assistantToolUseIds = assistantToolUseBlocks
      .map(block => (block as Record<string, unknown>).id as string);

    if (assistantToolUseIds.length === 0) {
      continue;
    }

    const nextMessage = messages[i + 1];
    const matchedToolResultIds = new Set<string>();

    if (isRecord(nextMessage) && nextMessage.role === 'user' && Array.isArray(nextMessage.content)) {
      const validToolResults: Record<string, unknown>[] = [];
      const otherBlocks: unknown[] = [];

      for (const block of nextMessage.content as unknown[]) {
        if (isRecord(block) && block.type === 'tool_result') {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          if (toolUseId && assistantToolUseIds.includes(toolUseId)) {
            validToolResults.push(block);
            matchedToolResultIds.add(toolUseId);
          }
          continue;
        }
        otherBlocks.push(block);
      }

      nextMessage.content = [...validToolResults, ...otherBlocks];
    }

    assistantMsg.content = (assistantMsg.content as unknown[]).filter(block => {
      if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
        return matchedToolResultIds.has(block.id);
      }
      return true;
    });
  }

  const filteredMessages: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) {
      filteredMessages.push(msg);
      continue;
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      let validToolResultIds: string[] = [];
      if (i > 0) {
        const prev = messages[i - 1];
        if (isRecord(prev) && prev.role === 'assistant' && Array.isArray(prev.content)) {
          validToolResultIds = (prev.content as unknown[])
            .filter(block => isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string')
            .map(block => (block as Record<string, unknown>).id as string);
        }
      }

      msg.content = (msg.content as unknown[]).filter(block => {
        if (isRecord(block) && block.type === 'tool_result') {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          return toolUseId !== '' && validToolResultIds.includes(toolUseId);
        }
        return true;
      });
    }

    const content = msg.content;
    if (content === undefined || content === null) {
      filteredMessages.push(msg);
      continue;
    }
    if (typeof content === 'string' && content.length > 0) {
      filteredMessages.push(msg);
      continue;
    }
    if (Array.isArray(content) && content.length > 0) {
      filteredMessages.push(msg);
      continue;
    }
    if (!Array.isArray(content) && typeof content !== 'string') {
      filteredMessages.push(msg);
      continue;
    }
  }

  body.messages = filteredMessages;
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();

  const items = raw
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);

  return new Set(items);
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      delete headers[key];
    }
  }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  deleteHeader(headers, name);
  headers[name] = value;
}

function sanitizeBetaHeader(
  raw: string | undefined,
  mode: BetaMode,
  allowlist: Set<string>
): string {
  if (!raw) return '';
  if (mode === 'strip') return '';
  if (mode === 'passthrough') return raw;

  const values = raw
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  if (allowlist.size === 0) {
    return '';
  }

  return values.filter(v => allowlist.has(v)).join(',');
}

export const AnthropicRequestSanitizerPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'anthropic-request-sanitizer';
    static readonly version = '1.0.0';

    private readonly sanitizeMode: SanitizeMode;
    private readonly stripCacheControl: boolean;
    private readonly betaMode: BetaMode;
    private readonly betaAllowlist: Set<string>;
    private readonly removeBetaQuery: boolean;
    private readonly shouldFilterOrphanToolResults: boolean;

    constructor(options?: AnthropicRequestSanitizerOptions) {
      this.sanitizeMode = options?.sanitizeMode || 'none';
      this.stripCacheControl = options?.stripCacheControl === true;
      this.betaMode = options?.betaMode || 'none';
      this.betaAllowlist = parseAllowlist(options?.betaAllowlist);
      this.removeBetaQuery = options?.removeBetaQuery === true;
      this.shouldFilterOrphanToolResults = options?.filterOrphanToolResults === true;
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'anthropic-request-sanitizer', stage: -20 },
        ctx => {
          const aggressive = this.sanitizeMode === 'aggressive';

          if (this.sanitizeMode !== 'none') {
            ctx.body = sanitizeBody(ctx.body as JsonLike, aggressive, this.stripCacheControl);
          } else if (this.stripCacheControl) {
            ctx.body = stripKeysDeep(deepClone(ctx.body), new Set(['cache_control']));
          }

          if (this.shouldFilterOrphanToolResults) {
            filterOrphanToolResults(ctx.body);
          }

          if (this.removeBetaQuery) {
            const betaFlag = ctx.url.searchParams.get('beta');
            if (betaFlag === 'true') {
              ctx.url.searchParams.delete('beta');
            }
          }

          if (this.betaMode !== 'none') {
            const rawBeta = getHeader(ctx.headers, 'anthropic-beta');
            const sanitizedBeta = sanitizeBetaHeader(rawBeta, this.betaMode, this.betaAllowlist);
            if (sanitizedBeta) {
              setHeader(ctx.headers, 'anthropic-beta', sanitizedBeta);
            } else {
              deleteHeader(ctx.headers, 'anthropic-beta');
            }
          }

          return ctx;
        }
      );
    }

    async reset(): Promise<void> {}
  }
);

export default AnthropicRequestSanitizerPlugin;
