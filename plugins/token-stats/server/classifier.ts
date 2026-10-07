type JsonRecord = Record<string, unknown>;
export type SupportedProvider = 'openai' | 'anthropic' | 'gemini';

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messages(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((message) =>
    record(message) && typeof message.role === 'string'
    && ['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message.role)
    && (typeof message.content === 'string' || Array.isArray(message.content)
      || (message.role === 'assistant' && (message.content === null || Array.isArray(message.tool_calls)))));
}

function input(value: unknown): boolean {
  return typeof value === 'string' || (Array.isArray(value) && value.every((item) =>
    typeof item === 'string' || (record(item) && (typeof item.type === 'string'
      || (typeof item.role === 'string' && (typeof item.content === 'string' || Array.isArray(item.content)))))));
}

function contents(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every((content) => record(content) && Array.isArray(content.parts));
}

/** Endpoint names alone are insufficient: ordinary APIs can also expose /messages or /responses. */
export function classifyRequest(url: URL, body: JsonRecord): { llm: boolean; provider?: SupportedProvider } {
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  const hasModel = typeof body.model === 'string' && body.model.trim().length > 0;
  const hasMessages = messages(body.messages);
  const hasInput = input(body.input);
  const hasPrompt = typeof body.prompt === 'string'
    || (Array.isArray(body.prompt) && body.prompt.length > 0 && body.prompt.every((item) => typeof item === 'string'));
  const hasContents = contents(body.contents);
  if (hasContents && (/\/models\/[^/]+:(?:stream)?generatecontent$/.test(path) || hasModel || record(body.generationConfig))) {
    return { llm: true, provider: 'gemini' };
  }
  if (hasModel && hasMessages && (path.endsWith('/messages') || typeof body.anthropic_version === 'string')) {
    return { llm: true, provider: 'anthropic' };
  }
  if ((hasModel && (hasInput || hasPrompt || hasMessages))
    || (hasMessages && /\/(?:responses|completions)$/.test(path))) {
    if (hasInput || hasPrompt || /\/(?:responses|completions)$/.test(path)) {
      return { llm: true, provider: 'openai' };
    }
    // Chat messages on a custom endpoint identify an LLM attempt, but not its wire protocol.
    return { llm: true };
  }
  return { llm: false };
}

/** Recognize generation envelopes, including custom relay paths and streaming responses. */
export function classifyResponse(body: JsonRecord, knownLlmRequest: boolean, event?: string): SupportedProvider | undefined {
  const eventType = event ?? (typeof body.type === 'string' ? body.type : '');
  if (Array.isArray(body.candidates) && body.candidates.some((candidate) =>
    record(candidate) && record(candidate.content) && Array.isArray(candidate.content.parts))) return 'gemini';
  if (eventType === 'message' && body.role === 'assistant' && Array.isArray(body.content)) return 'anthropic';
  if (eventType === 'message_start' && record(body.message)
    && body.message.type === 'message' && Array.isArray(body.message.content)) return 'anthropic';
  if (eventType === 'content_block_delta' && record(body.delta)
    && ['text_delta', 'input_json_delta', 'thinking_delta', 'signature_delta'].includes(String(body.delta.type))) return 'anthropic';
  if (Array.isArray(body.choices) && (body.object === 'chat.completion' || body.object === 'chat.completion.chunk'
    || body.object === 'text_completion' || body.choices.some((choice) => record(choice)
      && ((record(choice.message) && choice.message.role === 'assistant'
        && (typeof choice.message.content === 'string' || Array.isArray(choice.message.content) || Array.isArray(choice.message.tool_calls)))
        || (record(choice.delta) && (choice.delta.role === 'assistant' || typeof choice.delta.content === 'string'
          || typeof choice.delta.reasoning_content === 'string' || Array.isArray(choice.delta.tool_calls) || record(choice.delta.function_call)))
        || (typeof choice.text === 'string' && typeof choice.index === 'number'))))) return 'openai';
  if (body.object === 'response' && Array.isArray(body.output)) return 'openai';
  if (eventType.startsWith('response.') && (record(body.response) || record(body.item)
    || typeof body.delta === 'string' || typeof body.output_index === 'number')) return 'openai';

  // Usage-only chunks are valid after an LLM request has been identified, not proof on an ordinary API.
  if (!knownLlmRequest) return undefined;
  if (record(body.usageMetadata)) return 'gemini';
  const usage = record(body.usage) ? body.usage : undefined;
  if (eventType.startsWith('message_') || eventType.startsWith('content_block_')
    || (usage && ('cache_creation_input_tokens' in usage || 'cache_read_input_tokens' in usage))) return 'anthropic';
  if (usage && ('prompt_tokens' in usage || 'completion_tokens' in usage)) return 'openai';
  return undefined;
}
