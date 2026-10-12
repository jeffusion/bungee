import { fail } from '../responses-codec/common';
import type { LLMProtocol } from './types';

/** Read the actual generation model. Gemini's URL is authoritative, including base prefixes. */
export function protocolRequestModel(protocol: LLMProtocol, body: unknown, url?: string | URL): string {
  if (protocol === 'gemini_generate_content') {
    let path: string;
    try { path = new URL(url!).pathname; }
    catch { return fail('invalid_payload', 'A valid Gemini target URL is required', 'url'); }
    const match = path.match(/\/models\/([^/]+):(?:streamGenerateContent|generateContent)$/);
    if (!match) return fail('invalid_payload', 'Gemini target URL has no terminal model', 'url');
    try {
      const model = decodeURIComponent(match[1]!);
      if (model) return model;
    } catch { return fail('invalid_payload', 'Gemini target model encoding is invalid', 'url'); }
    return fail('invalid_payload', 'Gemini target model is required', 'url');
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (typeof model !== 'string' || !model) return fail('invalid_payload', 'Target model is required', 'model');
  return model;
}

/** Generation endpoint; Responses keeps the host/provider's /responses entry contract. */
export function protocolRequestPath(protocol: LLMProtocol, model: string, streaming: boolean): string {
  switch (protocol) {
    case 'responses': return '/responses';
    case 'chat_completions': return '/v1/chat/completions';
    case 'anthropic_messages': return '/v1/messages';
    case 'gemini_generate_content':
      if (typeof model !== 'string' || !model) fail('invalid_payload', 'Target model is required', 'model');
      return `/v1beta/models/${encodeURIComponent(model)}:${streaming ? 'streamGenerateContent' : 'generateContent'}`;
    default: return fail('unsupported_protocol', 'Unknown protocol');
  }
}
