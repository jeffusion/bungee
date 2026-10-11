import { fail } from '../responses-codec/common';
import type { LLMProtocol } from './types';

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
