import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks } from '../../../packages/core/src/hooks';
import { logger } from '../../../packages/core/src/logger';

interface SignatureRepairOptions {
  enabled?: boolean;
  statusCodes?: string;
  errorPattern?: string;
  stripThinking?: boolean;
  dummySignature?: string;
}

/**
 * Repair rule — extensible for different providers.
 * Each rule defines: which status codes to match, what error message pattern,
 * and how to sanitize the request body before retry.
 */
interface RepairRule {
  provider: string;
  statusCodes: Set<number>;
  errorPattern: RegExp;
  stripThinking: boolean;
  dummySignature: string;
}

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

/**
 * Sanitize request body: strip thinking parts, replace thoughtSignature with dummy value.
 * Handles both Gemini-native format (contents) and OpenAI-format (messages).
 */
function sanitizeBody(body: unknown, rule: RepairRule): { body: unknown; stripped: boolean } {
  const out = deepClone(body);
  let stripped = false;

  if (!isRecord(out)) return { body: out, stripped };

  // Handle Gemini-native format: { contents: [...] }
  if (Array.isArray(out.contents)) {
    for (const content of out.contents) {
      if (!isRecord(content) || !Array.isArray(content.parts)) continue;
      stripped = sanitizeGeminiParts(content.parts as unknown[], rule) || stripped;
    }
    return { body: out, stripped };
  }

  // Handle OpenAI-format: { messages: [...] } — strip thinking-related content from messages
  if (Array.isArray(out.messages)) {
    for (const msg of out.messages) {
      if (!isRecord(msg)) continue;

      // Handle assistant messages with tool_calls that may have thought_signature
      if (Array.isArray(msg.tool_calls) && rule.stripThinking) {
        for (const tc of msg.tool_calls) {
          if (isRecord(tc) && tc.extra_content) {
            delete tc.extra_content;
            stripped = true;
          }
          if (isRecord(tc) && typeof tc.thought_signature === 'string') {
            tc.thought_signature = rule.dummySignature;
            stripped = true;
          }
        }
      }

      // Handle content arrays that may include thinking blocks
      if (Array.isArray(msg.content)) {
        const newContent: unknown[] = [];
        for (const block of msg.content) {
          if (isRecord(block) && (block.type === 'thinking' || block.type === 'reasoning')) {
            stripped = true;
            if (!rule.stripThinking) {
              newContent.push(block);
            }
            continue;
          }
          if (isRecord(block) && block.type === 'tool_use' && typeof block.thought_signature === 'string') {
            block.thought_signature = rule.dummySignature;
            stripped = true;
          }
          newContent.push(block);
        }
        msg.content = newContent;
      }
    }
    return { body: out, stripped };
  }

  return { body: out, stripped };
}

function sanitizeGeminiParts(parts: unknown[], rule: RepairRule): boolean {
  let stripped = false;
  const newParts: unknown[] = [];

  for (const part of parts) {
    if (!isRecord(part)) {
      newParts.push(part);
      continue;
    }

    // Strip thinking parts
    if (rule.stripThinking && (part.thought === true || part.thought === 'true')) {
      stripped = true;
      continue;
    }

    // Replace thoughtSignature on functionCall parts
    if (isRecord(part.functionCall) && typeof part.thoughtSignature === 'string') {
      part.thoughtSignature = rule.dummySignature;
      stripped = true;
    }

    // Replace thoughtSignature on text parts (Gemini 3 image models)
    if (typeof part.text === 'string' && typeof part.thoughtSignature === 'string') {
      part.thoughtSignature = rule.dummySignature;
      stripped = true;
    }

    newParts.push(part);
  }

  // Mutate the original array in-place (it's a clone, safe to modify)
  parts.length = 0;
  parts.push(...newParts);
  return stripped;
}

function parseStatusCodes(raw: string | undefined): Set<number> {
  if (!raw) return new Set([400]);
  const codes = new Set<number>();
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (trimmed) {
      const n = Number(trimmed);
      if (!isNaN(n)) codes.add(n);
    }
  }
  return codes.size > 0 ? codes : new Set([400]);
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const clone = response.clone();
    const body = await clone.json();
    if (isRecord(body)) {
      if (typeof body.error?.message === 'string') return body.error.message;
      if (typeof body.message === 'string') return body.message;
    }
  } catch {
    // Non-JSON body — can't extract
  }
  return '';
}

export const SignatureRepairPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'signature-repair';
    static readonly version = '1.0.0';

    private readonly enabled: boolean;
    private readonly rules: RepairRule[];
    private lastRequestState?: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: unknown;
    };
    private retryDone = false;

    constructor(options?: SignatureRepairOptions) {
      this.enabled = options?.enabled !== false;
      const statusCodes = parseStatusCodes(options?.statusCodes);
      const errorPattern = new RegExp(
        options?.errorPattern || 'thought.*signature|corrupted.*thought|missing.*thought.*signature',
        'i'
      );
      const stripThinking = options?.stripThinking !== false;
      const dummySignature = options?.dummySignature || 'skip_thought_signature_validator';

      this.rules = [
        {
          provider: 'gemini',
          statusCodes,
          errorPattern,
          stripThinking,
          dummySignature,
        },
      ];
    }

    register(hooks: PluginHooks): void {
      // Stage 10: run after ai-transformer (stage 0) so the body is already in upstream format
      hooks.onBeforeRequest.tap(
        { name: 'signature-repair', stage: 10 },
        ctx => {
          if (!this.enabled) return ctx;
          this.retryDone = false;
          this.lastRequestState = {
            url: ctx.url.toString(),
            method: ctx.method,
            headers: { ...ctx.headers },
            body: deepClone(ctx.body),
          };
          return ctx;
        }
      );

      hooks.onResponse.tapPromise(
        { name: 'signature-repair' },
        async (response, ctx) => {
          if (!this.enabled || this.retryDone || !this.lastRequestState) return response;
          if (response.ok) return response;

          // Match against configured rules
          const matchingRule = this.rules.find(rule => rule.statusCodes.has(response.status));
          if (!matchingRule) return response;

          const errorMessage = await extractErrorMessage(response);
          if (!errorMessage || !matchingRule.errorPattern.test(errorMessage)) return response;

          // Sanitize body and retry
          const { body: sanitizedBody, stripped } = sanitizeBody(this.lastRequestState.body, matchingRule);

          logger.warn(
            {
              requestId: ctx.requestId,
              status: response.status,
              errorMessage,
              provider: matchingRule.provider,
              stripped,
              upstreamUrl: this.lastRequestState.url,
            },
            'Signature-repair: detected signature error, stripping signatures and retrying'
          );

          this.retryDone = true;

          try {
            const retryResponse = await fetch(this.lastRequestState.url, {
              method: this.lastRequestState.method,
              headers: this.lastRequestState.headers,
              body: JSON.stringify(sanitizedBody),
            });

            logger.warn(
              {
                requestId: ctx.requestId,
                retryStatus: retryResponse.status,
                retryOk: retryResponse.ok,
                provider: matchingRule.provider,
              },
              'Signature-repair: retry completed'
            );

            return retryResponse;
          } catch (fetchError) {
            logger.error(
              {
                requestId: ctx.requestId,
                error: fetchError,
                provider: matchingRule.provider,
              },
              'Signature-repair: retry fetch failed, returning original error'
            );
            return response;
          }
        }
      );
    }

    async reset(): Promise<void> {
      this.retryDone = false;
      this.lastRequestState = undefined;
    }
  }
);

export default SignatureRepairPlugin;
