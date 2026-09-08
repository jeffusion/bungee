export type JsonObject = Record<string, any>;

export type ProtocolErrorKind = 'cancelled' | 'body_limit' | 'invalid_sse' | 'failed' | 'incomplete' | 'unexpected_eof' | 'invalid_response';

export class CodexProtocolError extends Error {
  readonly kind: ProtocolErrorKind;
  readonly reason?: string;
  constructor(kind: ProtocolErrorKind, message: string, reason?: string) {
    super(message);
    this.name = 'CodexProtocolError';
    this.kind = kind;
    this.reason = reason;
  }
}

const UNSUPPORTED_RESPONSES_FIELDS = [
  'max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p',
  'truncation', 'prompt_cache_options', 'prompt_cache_retention', 'user', 'context_management'
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function responseContentPart(part: any, role: string): any | undefined {
  if (!part || typeof part !== 'object') return undefined;
  if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: String(part.text ?? '') };
  }
  if ((part.type === 'image_url' || part.type === 'input_image') && role === 'user') {
    const image = part.type === 'input_image'
      ? { url: part.image_url, file_id: part.file_id, detail: part.detail }
      : (typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url ?? {});
    if (image.url || image.file_id) return { type: 'input_image', ...(image.url ? { image_url: image.url } : {}), ...(image.file_id ? { file_id: image.file_id } : {}), ...(image.detail ? { detail: image.detail } : {}) };
  }
  if ((part.type === 'file' || part.type === 'input_file') && role === 'user') {
    const file = part.type === 'input_file' ? part : part.file;
    if (file.file_id || file.file_data || file.file_url) return { type: 'input_file', ...file };
  }
  if (part.type === 'input_audio' && role === 'user' && part.input_audio?.data) {
    return { type: 'input_audio', data: part.input_audio.data, ...(part.input_audio.format ? { format: part.input_audio.format } : {}) };
  }
  return { type: 'input_text', text: typeof part === 'string' ? part : JSON.stringify(part) };
}

function messageToResponseItems(message: any, customToolNames: Set<string>): any[] {
  const role = message.role === 'system' ? 'developer' : message.role;
  const content = message.content;
  const parts: any[] = [];
  if (typeof content === 'string' && content.length > 0) parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: content });
  else if (Array.isArray(content)) {
    for (const part of content) {
      const converted = responseContentPart(part, role);
      if (converted) parts.push(converted);
    }
  }
  const items: any[] = [];
  if (role !== 'assistant' || parts.length > 0) items.push({ type: 'message', role, content: parts });
  if (role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (let i = 0; i < message.tool_calls.length; i++) {
      const call = message.tool_calls[i];
      if (!call || typeof call !== 'object') continue;
      const fn = call.type === 'custom' ? call.custom ?? {} : call.function ?? {};
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (!name) continue;
      validateCodexToolName(name);
      const callId = typeof call.id === 'string' && call.id ? call.id : undefined;
      if (call.type === 'custom' || customToolNames.has(name)) items.push({ type: 'custom_tool_call', ...(callId ? { call_id: callId } : {}), name, input: String(fn.input ?? fn.arguments ?? '') });
      else items.push({ type: 'function_call', ...(callId ? { call_id: callId } : {}), name, arguments: String(fn.arguments ?? '') });
    }
  }
  return items;
}

function toolOutputContent(content: any): string | any[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const supported = new Set(['text', 'input_text', 'output_text', 'image_url', 'input_image', 'file', 'input_file', 'input_audio']);
    const converted = content.map((part) => supported.has(part?.type) ? responseContentPart(part, 'user') : undefined);
    if (converted.some((part) => part === undefined || part === null)) {
      throw new CodexProtocolError('invalid_response', 'Chat tool output contains an unsupported content part');
    }
    return converted as any[];
  }
  return content;
}

function validateCodexToolName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 64 || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new CodexProtocolError('invalid_response', 'Codex tool names must be 1-64 ASCII letters, digits, underscores or hyphens');
  }
  return name;
}

export function convertChatCompletionsRequestToCodex(input: JsonObject, model = String(input.model ?? '')): JsonObject {
  const out: JsonObject = {
    instructions: '', stream: true, store: false, parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'], model, input: []
  };
  const pending = new Map<string, any>();
  const explicitCallIds = new Set<string>();
  const usedCallIds = new Set<string>();
  let missingCallNumber = 0;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  for (const message of messages) {
    for (const call of message?.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.id !== 'string' || !call.id) continue;
      if (explicitCallIds.has(call.id)) throw new CodexProtocolError('invalid_response', 'Chat request contains a duplicate tool call id');
      explicitCallIds.add(call.id);
    }
  }
  const customToolNames = new Set<string>((input.tools ?? []).filter((tool: any) => tool?.type === 'custom').map((tool: any) => validateCodexToolName(tool.name ?? tool.custom?.name)));
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'tool') {
      const requestedCallId = String(message.tool_call_id ?? '');
      let pendingKey = requestedCallId;
      let pendingCall = pending.get(requestedCallId);
      if (!pendingCall && !requestedCallId && pending.size === 1) {
        pendingKey = pending.keys().next().value as string;
        pendingCall = pending.get(pendingKey);
      }
      if (!pendingCall) throw new CodexProtocolError('invalid_response', 'Chat tool result has no matching tool call');
      out.input.push({ type: pendingCall.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output', call_id: pendingCall.call_id, output: toolOutputContent(message.content) });
      pending.delete(pendingKey);
      continue;
    }
    if (pending.size > 0) throw new CodexProtocolError('invalid_response', 'Chat request contains an unresolved pending tool call before a new message');
    const items = messageToResponseItems(message, customToolNames);
    out.input.push(...items);
    for (const item of items) {
      if (item.type !== 'function_call' && item.type !== 'custom_tool_call') continue;
      if (!item.call_id) {
        do item.call_id = `call_missing_${missingCallNumber++}`;
        while (explicitCallIds.has(item.call_id) || usedCallIds.has(item.call_id));
      } else if (usedCallIds.has(item.call_id)) {
        throw new CodexProtocolError('invalid_response', 'Chat request contains a duplicate tool call id');
      }
      usedCallIds.add(item.call_id);
      pending.set(item.call_id, item);
    }
  }
  if (input.reasoning_effort !== undefined) out.reasoning = { effort: input.reasoning_effort };
  else out.reasoning = { effort: 'medium' };
  if (Array.isArray(input.tools)) {
    out.tools = input.tools.map((tool: any) => {
      if (tool?.type === 'function') return { type: 'function', name: validateCodexToolName(tool.function?.name), description: tool.function?.description ?? '', parameters: tool.function?.parameters ?? { type: 'object', properties: {} }, strict: tool.function?.strict ?? false };
      return clone(tool);
    }).filter((tool: any) => tool && (tool.type !== 'function' || tool.name));
  }
  if (input.tool_choice !== undefined) {
    if (typeof input.tool_choice === 'string' && ['auto', 'none', 'required'].includes(input.tool_choice)) out.tool_choice = input.tool_choice;
    else if (input.tool_choice?.type === 'function') out.tool_choice = { type: 'function', name: validateCodexToolName(input.tool_choice.function?.name ?? input.tool_choice.name) };
    else if (input.tool_choice?.type === 'custom') out.tool_choice = { type: 'custom', name: validateCodexToolName(input.tool_choice.custom?.name ?? input.tool_choice.name) };
    else throw new CodexProtocolError('invalid_response', 'Chat tool_choice is not representable by Codex');
  }
  if (input.text) out.text = clone(input.text);
  if (input.response_format?.type === 'json_object') throw new CodexProtocolError('invalid_response', 'Codex Responses does not support response_format json_object');
  if (input.response_format?.type === 'text') {
    out.text ??= {};
    out.text.format = { type: 'text' };
  } else if (input.response_format?.type === 'json_schema') {
    out.text ??= {};
    out.text.format = { type: 'json_schema', ...clone(input.response_format.json_schema) };
  }
  return normalizeCodexResponsesRequest(out);
}

/** Convert an OpenAI Responses request into the Chat Completions request shape.
 * This is intentionally a data conversion only; it does not claim a model catalog.
 */
export function convertResponsesRequestToChatCompletions(input: JsonObject): JsonObject {
  const messages: any[] = [];
  if (typeof input.instructions === 'string' && input.instructions) messages.push({ role: 'system', content: input.instructions });
  const inputItems = typeof input.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input.input }] }] : (Array.isArray(input.input) ? input.input : []);
  for (const item of inputItems) {
    if (!item || typeof item !== 'object') throw new CodexProtocolError('invalid_response', 'Responses input item is not representable by Chat Completions');
    if (item.type === 'message' || (!item.type && typeof item.role === 'string')) {
      const role = item.role === 'developer' ? 'system' : item.role;
      const content = Array.isArray(item.content) ? item.content.map((part: any) => {
        if (part?.type === 'input_text' || part?.type === 'output_text') return { type: 'text', text: String(part.text ?? '') };
        if (part?.type === 'input_image') return { type: 'image_url', image_url: { ...(part.image_url ? { url: part.image_url } : {}), ...(part.file_id ? { file_id: part.file_id } : {}), ...(part.detail ? { detail: part.detail } : {}) } };
        if (part?.type === 'input_file') {
          const { type: _type, ...file } = part;
          return { type: 'file', file };
        }
        if (part?.type === 'input_audio') return { type: 'input_audio', input_audio: { data: part.data, format: part.format } };
        throw new CodexProtocolError('invalid_response', 'Responses input message contains an unsupported content part');
      }) : item.content === undefined || item.content === null || typeof item.content === 'string' ? item.content : (() => { throw new CodexProtocolError('invalid_response', 'Responses input message has an unsupported content structure'); })();
      messages.push({ role, content });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const call = { id: item.call_id, type: 'function', function: { name: validateCodexToolName(item.name), arguments: String(item.arguments ?? item.input ?? '') } };
      const previous = messages.at(-1);
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
    } else throw new CodexProtocolError('invalid_response', 'Responses input item is not representable by Chat Completions');
  }
  const output: JsonObject = { model: input.model, messages };
  if (input.reasoning?.effort) output.reasoning_effort = input.reasoning.effort;
  if (Array.isArray(input.tools)) {
    if (input.tools.some((tool: any) => tool?.type !== 'function')) throw new CodexProtocolError('invalid_response', 'Responses built-in tools are not representable in Chat Completions');
    output.tools = input.tools.map((tool: any) => ({ type: 'function', function: { name: validateCodexToolName(tool.name), description: tool.description, parameters: tool.parameters, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } }));
  }
  if (input.tool_choice !== undefined) {
    if (typeof input.tool_choice === 'string' && ['auto', 'none', 'required'].includes(input.tool_choice)) output.tool_choice = input.tool_choice;
    else if (input.tool_choice?.type === 'function') output.tool_choice = { type: 'function', function: { name: validateCodexToolName(input.tool_choice.name ?? input.tool_choice.function?.name) } };
    else throw new CodexProtocolError('invalid_response', 'Responses tool_choice is not representable by Chat Completions');
  }
  const format = input.text?.format ?? input.response_format;
  if (format !== undefined) {
    if (format.type === 'text' || format.type === 'json_object') output.response_format = { type: format.type };
    else if (format.type === 'json_schema') {
      const { type: _type, json_schema: nested, ...rest } = format;
      const json_schema = nested ?? rest;
      output.response_format = { type: 'json_schema', json_schema };
    } else throw new CodexProtocolError('invalid_response', 'Responses text format is not representable by Chat Completions');
  }
  if (input.stream !== undefined) output.stream = input.stream;
  return output;
}

export function normalizeCodexResponsesRequest(input: JsonObject): JsonObject {
  const out = clone(input);
  if (out.response_format?.type === 'json_object') throw new CodexProtocolError('invalid_response', 'Codex Responses does not support response_format json_object');
  out.stream = true;
  out.store = false;
  out.parallel_tool_calls = true;
  out.include = ['reasoning.encrypted_content'];
  if (typeof out.input === 'string') out.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: out.input }] }];
  if (Array.isArray(out.input)) {
    for (const item of out.input) {
      if ((!item?.type || item.type === 'message') && item.role === 'system') item.role = 'developer';
      if (Array.isArray(item?.content)) item.content = item.content.map((part: any) => {
        if (part?.prompt_cache_breakpoint !== undefined) {
          const cleaned = { ...part };
          delete cleaned.prompt_cache_breakpoint;
          return cleaned;
        }
        return part;
      });
    }
  }
  for (const field of UNSUPPORTED_RESPONSES_FIELDS) delete out[field];
  if (out.service_tier !== 'priority') delete out.service_tier;
  const normalizeTool = (tool: any): any => {
    if (tool?.type === 'web_search_preview' || tool?.type === 'web_search_preview_2025_03_11') return { ...tool, type: 'web_search' };
    if (tool?.type === 'function' || tool?.type === 'custom') validateCodexToolName(tool.name ?? tool.function?.name ?? tool.custom?.name);
    return tool;
  };
  if (Array.isArray(out.tools)) out.tools = out.tools.map(normalizeTool);
  if (out.tool_choice?.type === 'web_search_preview' || out.tool_choice?.type === 'web_search_preview_2025_03_11') out.tool_choice.type = 'web_search';
  if (out.tool_choice?.type === 'function' || out.tool_choice?.type === 'custom') validateCodexToolName(out.tool_choice.name ?? out.tool_choice.function?.name ?? out.tool_choice.custom?.name);
  if (Array.isArray(out.tool_choice?.tools)) out.tool_choice.tools = out.tool_choice.tools.map(normalizeTool);
  return out;
}

export interface CodexSSEEvent {
  type?: string;
  data: JsonObject;
  id?: string;
}

export type SSESource = string | AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>;

function protocolAbort(signal?: AbortSignal): CodexProtocolError {
  return new CodexProtocolError('cancelled', 'Codex response processing was cancelled');
}

async function* sourceChunks(source: SSESource, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  if (typeof source === 'string') {
    if (signal?.aborted) throw protocolAbort(signal);
    yield encoder.encode(source);
    return;
  }
  const isReadable = typeof (source as ReadableStream<Uint8Array>).getReader === 'function';
  if (!isReadable && Symbol.asyncIterator in source) {
    const iterator = (source as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
    let finished = false;
    let abortListener: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
      if (!signal) return;
      abortListener = () => reject(protocolAbort(signal));
      signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      while (true) {
        if (signal?.aborted) throw protocolAbort(signal);
        const next = await (signal ? Promise.race([iterator.next(), abort]) : iterator.next());
        if (next.done) break;
        if (signal?.aborted) throw protocolAbort(signal);
        yield typeof next.value === 'string' ? encoder.encode(next.value) : next.value;
      }
      finished = true;
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (!finished) void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  let aborted = false;
  let finished = false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel('cancelled').catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (aborted || signal?.aborted) {
        throw protocolAbort(signal);
      }
      const result = await reader.read();
      if (aborted || signal?.aborted) throw protocolAbort(signal);
      if (result.done) { finished = true; break; }
      yield result.value;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) void reader.cancel('cancelled').catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* parseCodexSSE(source: SSESource, options: { signal?: AbortSignal; maxEventBytes?: number; maxTotalBytes?: number } = {}): AsyncGenerator<CodexSSEEvent> {
  const maxEventBytes = options.maxEventBytes ?? 512 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 16 * 1024 * 1024;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let total = 0;
  let event = '';
  let eventId: string | undefined;
  let data: string[] = [];
  let eventBytes = 0;
  let pendingLineBytes = 0;
  const dispatch = async function* (): AsyncGenerator<CodexSSEEvent> {
    const currentData = data;
    const currentId = eventId;
    event = '';
    eventId = undefined;
    data = [];
    eventBytes = 0;
    if (currentData.length === 0) return;
    const raw = currentData.join('\n');
    const payload = raw.trim();
    if (payload === '[DONE]') {
      yield { type: 'done', data: {}, ...(currentId ? { id: currentId } : {}) };
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(payload); } catch { throw new CodexProtocolError('invalid_sse', 'Codex response contained invalid SSE JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CodexProtocolError('invalid_sse', 'Codex SSE event was not an object');
      const object = parsed as JsonObject;
      if (typeof object.type !== 'string' || !object.type) throw new CodexProtocolError('invalid_sse', 'Codex SSE event has no type');
      yield { type: object.type, data: object, ...(currentId ? { id: currentId } : {}) };
    }
  };
  const consumeLine = async function* (line: string): AsyncGenerator<CodexSSEEvent> {
    if (line.startsWith(':')) return;
    if (!line) { yield* dispatch(); return; }
    eventBytes += encoder.encode(line).byteLength;
    if (eventBytes > maxEventBytes) throw new CodexProtocolError('body_limit', 'Codex SSE event exceeded the body limit');
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = (colon < 0 ? '' : line.slice(colon + 1)).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') eventId = value;
    else if (field === 'data') {
      // Count encoded bytes, not UTF-16 code units; this is O(1) per line.
      data.push(value);
    }
  };
  for await (const chunk of sourceChunks(source, options.signal)) {
    total += chunk.byteLength;
    if (total > maxTotalBytes) throw new CodexProtocolError('body_limit', 'Codex response exceeded the body limit');
    pendingLineBytes += chunk.byteLength;
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = buffer.match(/\r\n|\n|\r/);
      if (!match || match.index === undefined) break;
      // A CR at the end of a chunk may be the first half of CRLF. Keep it
      // pending until the next chunk instead of dispatching an empty event.
      if (match[0] === '\r' && match.index + 1 === buffer.length) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      pendingLineBytes -= encoder.encode(line).byteLength + match[0].length;
      yield* consumeLine(line);
    }
    if (pendingLineBytes + eventBytes > maxEventBytes) throw new CodexProtocolError('body_limit', 'Codex SSE event exceeded the body limit');
  }
  buffer += decoder.decode();
  if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
  if (buffer) {
    pendingLineBytes = 0;
    yield* consumeLine(buffer);
  }
  yield* dispatch();
}

interface ToolState {
  index: number;
  id: string;
  name: string;
  kind: 'function_call' | 'custom_tool_call';
  arguments: string;
  emittedArguments: boolean;
  done: boolean;
}

interface OutputRecord {
  item: JsonObject;
  index?: number;
  order: number;
  id?: string;
  callId?: string;
  contentIndex?: number;
}

export interface CodexResponseState {
  response: JsonObject;
  terminal: 'completed' | 'incomplete';
  output: any[];
  chunks: JsonObject[];
}

export interface CodexConversionOptions {
  signal?: AbortSignal;
  maxEventBytes?: number;
  maxTotalBytes?: number;
  includeUsage?: boolean;
  request?: JsonObject;
  target?: 'chat' | 'responses';
}

export function streamIncludesUsage(request: JsonObject): boolean {
  return request?.stream_options?.include_usage === true;
}

function eventObject(event: CodexSSEEvent): JsonObject {
  return event.data;
}

function usageFrom(response: any): any | undefined {
  return response?.usage ? clone(response.usage) : undefined;
}

function responsesUsageToChat(usage: any): any {
  if (!usage) return undefined;
  const mapped: any = {};
  if (usage.input_tokens !== undefined) mapped.prompt_tokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) mapped.completion_tokens = usage.output_tokens;
  if (usage.total_tokens !== undefined) mapped.total_tokens = usage.total_tokens;
  if (usage.input_tokens_details) {
    mapped.prompt_tokens_details = {};
    if (usage.input_tokens_details.cached_tokens !== undefined) mapped.prompt_tokens_details.cached_tokens = usage.input_tokens_details.cached_tokens;
    if (usage.input_tokens_details.cache_write_tokens !== undefined) {
      mapped.prompt_tokens_details.cache_write_tokens = usage.input_tokens_details.cache_write_tokens;
      mapped.prompt_tokens_details.cached_creation_tokens = usage.input_tokens_details.cache_write_tokens;
    }
  }
  if (usage.output_tokens_details?.reasoning_tokens !== undefined) {
    mapped.completion_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens };
  }
  return mapped;
}

function chatUsageToResponses(usage: any): any {
  if (!usage) return undefined;
  const mapped: any = {};
  if (usage.prompt_tokens !== undefined) mapped.input_tokens = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) mapped.output_tokens = usage.completion_tokens;
  if (usage.total_tokens !== undefined) mapped.total_tokens = usage.total_tokens;
  if (usage.prompt_tokens_details) {
    mapped.input_tokens_details = {};
    if (usage.prompt_tokens_details.cached_tokens !== undefined) mapped.input_tokens_details.cached_tokens = usage.prompt_tokens_details.cached_tokens;
    if (usage.prompt_tokens_details.cache_write_tokens !== undefined) mapped.input_tokens_details.cache_write_tokens = usage.prompt_tokens_details.cache_write_tokens;
    else if (usage.prompt_tokens_details.cached_creation_tokens !== undefined) mapped.input_tokens_details.cache_write_tokens = usage.prompt_tokens_details.cached_creation_tokens;
  }
  if (usage.completion_tokens_details?.reasoning_tokens !== undefined) mapped.output_tokens_details = { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens };
  return mapped;
}

function textFromItem(item: any): string {
  if (!Array.isArray(item?.content)) return '';
  return item.content.filter((part: any) => part?.type === 'output_text' || part?.type === 'text').map((part: any) => String(part.text ?? '')).join('');
}

function imageMime(format: unknown): string {
  const value = String(format ?? '').toLowerCase();
  if (value === 'jpeg' || value === 'jpg' || value === 'image/jpeg') return 'image/jpeg';
  if (value === 'webp' || value === 'image/webp') return 'image/webp';
  if (value === 'gif' || value === 'image/gif') return 'image/gif';
  return 'image/png';
}

const CHAT_OUTPUT_ITEM_TYPES = new Set(['message', 'reasoning', 'function_call', 'custom_tool_call', 'image_generation_call']);

function validateChatOutputItem(item: any): void {
  if (!item || typeof item.type !== 'string' || !CHAT_OUTPUT_ITEM_TYPES.has(item.type)) {
    throw new CodexProtocolError('invalid_response', 'Codex response contains an output item that Chat Completions cannot represent');
  }
  if (item.type === 'function_call' || item.type === 'custom_tool_call') validateCodexToolName(item.name);
  if (item.type === 'message' && item.content !== undefined && !Array.isArray(item.content)) {
    throw new CodexProtocolError('invalid_response', 'Codex message output has an unsupported content structure');
  }
  if (item.type === 'message' && Array.isArray(item.content) && item.content.some((part: any) => !part || !['output_text', 'text'].includes(part.type))) {
    throw new CodexProtocolError('invalid_response', 'Codex message output contains an unsupported content part');
  }
  const reasoningParts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])];
  if (item.type === 'reasoning' && (item.summary !== undefined && !Array.isArray(item.summary) || item.content !== undefined && !Array.isArray(item.content) || reasoningParts.some((part: any) => !part || !['summary_text', 'reasoning_text'].includes(part.type)))) {
    throw new CodexProtocolError('invalid_response', 'Codex reasoning output contains an unsupported content part');
  }
}

function validateResponsesOutputItem(item: any): void {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string' || !item.type) {
    throw new CodexProtocolError('invalid_response', 'Codex response contains an invalid Responses output item');
  }
}

function incompleteFinishReason(reason: string): 'length' | 'content_filter' {
  if (reason === 'content_filter') return 'content_filter';
  if (reason === 'max_tokens' || reason === 'max_output_tokens') return 'length';
  throw new CodexProtocolError('incomplete', `Codex response has an unsupported incomplete reason: ${reason || 'missing'}`, reason);
}

export class CodexResponseProcessor {
  private readonly tools = new Map<string, ToolState>();
  private readonly output: OutputRecord[] = [];
  private readonly includeUsage: boolean;
  private readonly target: 'chat' | 'responses';
  private text = '';
  private reasoning = '';
  private readonly messageText = new Map<string, Map<string, string>>();
  private readonly messageOwners = new Map<string, string>();
  private readonly completedText = new Map<string, string>();
  private readonly imageParts = new Map<string, string>();
  private model = '';
  private responseId = '';
  private created = 0;
  private serviceTier?: string;
  private terminal?: 'completed' | 'incomplete';
  private terminalResponse: JsonObject = {};
  private toolIndex = 0;
  private outputOrder = 0;
  private sawDone = false;

  constructor(options: Pick<CodexConversionOptions, 'includeUsage' | 'request' | 'target'> = {}) {
    this.includeUsage = options.includeUsage ?? (options.request ? streamIncludesUsage(options.request) : false);
    this.target = options.target ?? 'chat';
  }

  private validateOutputItem(item: any): void {
    if (this.target === 'responses') validateResponsesOutputItem(item);
    else validateChatOutputItem(item);
  }

  private upsertOutput(item: JsonObject, index?: number, terminal = false, contentIndex?: number, itemId?: string): OutputRecord {
    const identity = {
      id: typeof item.id === 'string' && item.id ? item.id : itemId,
      callId: typeof item.call_id === 'string' && item.call_id ? item.call_id : undefined,
      outputIndex: index,
      contentIndex: contentIndex ?? (typeof item.content_index === 'number' ? item.content_index : undefined)
    };
    const hasIdentity = Object.values(identity).some((value) => value !== undefined);
    const sameIdentity = (record: OutputRecord): boolean => {
      const primaryPairs: [keyof typeof identity, keyof OutputRecord][] = [['id', 'id'], ['callId', 'callId'], ['outputIndex', 'index']];
      const shared = primaryPairs.filter(([incomingKey, recordKey]) => identity[incomingKey] !== undefined && record[recordKey] !== undefined);
      if (shared.length > 0) return shared.every(([incomingKey, recordKey]) => identity[incomingKey] === record[recordKey]);
      const contentPair: [keyof typeof identity, keyof OutputRecord] = ['contentIndex', 'contentIndex'];
      if (identity.contentIndex !== undefined && record.contentIndex !== undefined) return identity[contentPair[0]] === record[contentPair[1]];
      return false;
    };
    const matches = this.output.filter((record) => hasIdentity ? sameIdentity(record) : !record.id && !record.callId && record.index === undefined && record.contentIndex === undefined);
    if (!hasIdentity && matches.length > 1) throw new CodexProtocolError('invalid_response', 'Codex output item has ambiguous identity');
    const found = matches[0];
    if (found) {
      if (index !== undefined) found.index = index;
      if (identity.id !== undefined) found.id = identity.id;
      if (identity.callId !== undefined) found.callId = identity.callId;
      if (identity.contentIndex !== undefined) found.contentIndex = identity.contentIndex;
      if (terminal) found.item = clone(item);
      return found;
    }
    const record = { item: clone(item), index, order: this.outputOrder++, id: identity.id, callId: identity.callId, contentIndex: identity.contentIndex };
    this.output.push(record);
    return record;
  }

  private orderedOutput(): JsonObject[] {
    return this.output.slice().sort((a, b) => {
      if (a.index !== undefined && b.index !== undefined) return a.index - b.index;
      if (a.index !== undefined) return -1;
      if (b.index !== undefined) return 1;
      return a.order - b.order;
    }).map((record) => clone(record.item));
  }

  private messageKeys(data: any, item?: any): string[] {
    const keys: string[] = [];
    const id = data.item_id ?? item?.id;
    if (id !== undefined && id !== null && id !== '') keys.push(`message:id:${String(id)}`);
    if (data.output_index !== undefined && data.output_index !== null) keys.push(`message:output:${String(data.output_index)}`);
    return keys.length > 0 ? keys : ['message:unkeyed'];
  }

  private messageOwner(data: any, item?: any): string {
    const keys = this.messageKeys(data, item);
    const owners = new Set(keys.map((key) => this.messageOwners.get(key)).filter((owner): owner is string => owner !== undefined));
    if (owners.size > 1) throw new CodexProtocolError('invalid_response', 'Codex message event identifiers point to different messages');
    const owner = owners.values().next().value as string | undefined ?? keys[0];
    for (const key of keys) this.messageOwners.set(key, owner);
    return owner;
  }

  private messageContentIndex(data: any, item?: any): string {
    const contentIndex = data.content_index ?? item?.content_index;
    return contentIndex === undefined || contentIndex === null ? 'default' : String(contentIndex);
  }

  private messageTextValue(data: any, item?: any): string {
    const owner = this.messageOwner(data, item);
    const blocks = this.messageText.get(owner);
    if (!blocks) return '';
    const contentIndex = this.messageContentIndex(data, item);
    if (contentIndex !== 'default') return blocks.get(contentIndex) ?? '';
    return [...blocks.values()].join('');
  }

  private setMessageText(data: any, item: any, value: string): void {
    const owner = this.messageOwner(data, item);
    const blocks = this.messageText.get(owner) ?? new Map<string, string>();
    blocks.set(this.messageContentIndex(data, item), value);
    this.messageText.set(owner, blocks);
  }

  process(event: CodexSSEEvent): JsonObject[] {
    const data = eventObject(event);
    const type = event.type;
    if (type === 'done') { this.sawDone = true; return []; }
    if (type === 'response.failed' || data.response?.status === 'failed') throw new CodexProtocolError('failed', 'Codex response failed');
    if (this.sawDone && !this.terminal) throw new CodexProtocolError('incomplete', 'Codex emitted an event after [DONE] without a terminal response');
    if (this.terminal) {
      if (type === 'error' || type === 'response.failed') throw new CodexProtocolError('failed', 'Codex response failed after terminal event');
      if (type === 'response.completed' || type === 'response.incomplete') return [];
      return [];
    }
    if (type === 'error') throw new CodexProtocolError('failed', 'Codex response contained an error event');
    if (type === 'response.created' || type === 'response.in_progress') {
      const response = data.response ?? {};
      this.responseId ||= String(response.id ?? '');
      this.model ||= String(response.model ?? '');
      this.created ||= Number(response.created_at ?? 0);
      if (response.service_tier) this.serviceTier = String(response.service_tier);
      return [];
    }
    const output: JsonObject[] = [];
    const base = (): any => ({ id: this.responseId, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: {}, finish_reason: null }], ...(this.serviceTier ? { service_tier: this.serviceTier } : {}) });
    if (type === 'response.output_text.delta' || type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
      const value = String(data.delta ?? '');
      if (type === 'response.output_text.delta') {
        const previous = this.messageTextValue(data);
        this.setMessageText(data, undefined, previous + value);
        this.text += value;
      }
      else this.reasoning += value;
      const chunk = base();
      chunk.choices[0].delta.role = 'assistant';
      chunk.choices[0].delta[type.includes('reasoning') ? 'reasoning_content' : 'content'] = value;
      output.push(chunk);
    } else if (type === 'response.image_generation_call.partial_image') {
      const itemKey = String(data.item_id ?? data.output_index ?? 'image:unkeyed');
      const image = String(data.partial_image_b64 ?? '');
      if (!image || this.imageParts.get(itemKey) === image) return output;
      this.imageParts.set(itemKey, image);
      const chunk = base();
      chunk.choices[0].delta.role = 'assistant';
      chunk.choices[0].delta.images = [{ type: 'image_url', image_url: { url: `data:${imageMime(data.output_format)};base64,${image}` } }];
      output.push(chunk);
    } else if (type === 'response.output_item.added') {
      const item = data.item;
      this.validateOutputItem(item);
      if (!['function_call', 'custom_tool_call'].includes(item.type)) {
        if (this.target === 'responses') this.upsertOutput(item, data.output_index === undefined ? undefined : Number(data.output_index), false, data.content_index === undefined ? undefined : Number(data.content_index), typeof data.item_id === 'string' ? data.item_id : undefined);
        return output;
      }
      const existing = this.findTool({ item_id: item.id, output_index: data.output_index }, true);
      if (existing) return [];
      const key = String(item.id ?? data.item_id ?? data.output_index ?? this.toolIndex);
      const state: ToolState = { index: this.toolIndex++, id: String(item.call_id ?? ''), name: String(item.name ?? ''), kind: item.type, arguments: String(item.arguments ?? item.input ?? ''), emittedArguments: false, done: false };
      this.tools.set(`item:${key}`, state);
      if (item.id !== undefined) this.tools.set(`item:${String(item.id)}`, state);
      if (data.output_index !== undefined) this.tools.set(`output:${String(data.output_index)}`, state);
      const chunk = base();
      chunk.choices[0].delta.role = 'assistant';
      chunk.choices[0].delta.tool_calls = [{ index: state.index, id: state.id, type: 'function', function: { name: state.name, arguments: '' } }];
      output.push(chunk);
    } else if (type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta') {
      const state = this.findTool(data);
      const delta = String(data.delta ?? '');
      if (state && delta && !state.done) {
        state.arguments += delta;
        state.emittedArguments = true;
        const chunk = base();
        chunk.choices[0].delta.tool_calls = [{ index: state.index, function: { arguments: delta } }];
        output.push(chunk);
      }
    } else if (type === 'response.function_call_arguments.done' || type === 'response.custom_tool_call_input.done') {
      const state = this.findTool(data);
      const full = String(data.arguments ?? data.input ?? '');
      if (state && full) state.arguments = full;
      if (state && !state.emittedArguments && state.arguments) {
        state.emittedArguments = true;
        const chunk = base();
        chunk.choices[0].delta.tool_calls = [{ index: state.index, function: { arguments: state.arguments } }];
        output.push(chunk);
      }
    } else if (type === 'response.output_item.done') {
      const item = data.item;
      this.validateOutputItem(item);
      if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
        const state = this.findTool({ ...data, item_id: data.item_id ?? item.id }, true);
        if (state) {
          state.done = true;
          state.arguments = String(item.arguments ?? item.input ?? state.arguments);
          if (!state.emittedArguments && state.arguments) {
            state.emittedArguments = true;
            const chunk = base();
            chunk.choices[0].delta.tool_calls = [{ index: state.index, function: { arguments: state.arguments } }];
            output.push(chunk);
          }
        } else {
          const state2: ToolState = { index: this.toolIndex++, id: String(item.call_id ?? ''), name: String(item.name ?? ''), kind: item.type, arguments: String(item.arguments ?? item.input ?? ''), emittedArguments: true, done: true };
          if (item.id !== undefined) this.tools.set(`item:${String(item.id)}`, state2);
          if (data.output_index !== undefined) this.tools.set(`output:${String(data.output_index)}`, state2);
          const chunk = base();
          chunk.choices[0].delta.tool_calls = [{ index: state2.index, id: state2.id, type: 'function', function: { name: state2.name, arguments: state2.arguments } }];
          output.push(chunk);
        }
        this.upsertOutput(item, data.output_index === undefined ? undefined : Number(data.output_index), this.target === 'responses', data.content_index === undefined ? undefined : Number(data.content_index), typeof data.item_id === 'string' ? data.item_id : undefined);
      } else if (item) {
        this.upsertOutput(item, data.output_index === undefined ? undefined : Number(data.output_index), this.target === 'responses', data.content_index === undefined ? undefined : Number(data.content_index), typeof data.item_id === 'string' ? data.item_id : undefined);
        if (item.type === 'image_generation_call' && item.result) {
          const itemKey = String(item.id ?? data.output_index ?? 'image:unkeyed');
          if (this.imageParts.get(itemKey) !== item.result) {
            this.imageParts.set(itemKey, item.result);
            const chunk = base();
            chunk.choices[0].delta.role = 'assistant';
            chunk.choices[0].delta.images = [{ type: 'image_url', image_url: { url: `data:${imageMime(item.output_format)};base64,${item.result}` } }];
            output.push(chunk);
          }
        }
        if (item.type === 'message' && textFromItem(item)) {
          const fullText = textFromItem(item);
          const owner = this.messageOwner(data, item);
          const contentIndex = this.messageContentIndex(data, item);
          if (contentIndex === 'default') {
            const completed = this.completedText.get(owner);
            if (completed !== undefined) {
              if (completed !== fullText) throw new CodexProtocolError('invalid_response', 'Codex repeated message completion changed its text');
              return output;
            }
            const previous = this.messageTextValue(data, item);
            const delta = fullText === previous ? '' : fullText.startsWith(previous) ? fullText.slice(previous.length) : fullText;
            this.completedText.set(owner, fullText);
            if (!delta) return output;
            const chunk = base();
            chunk.choices[0].delta.role = 'assistant';
            chunk.choices[0].delta.content = delta;
            output.push(chunk);
            return output;
          }
          const previous = this.messageTextValue(data, item);
          const delta = fullText === previous ? '' : fullText.startsWith(previous) ? fullText.slice(previous.length) : fullText;
          this.setMessageText(data, item, fullText);
          if (!delta) return output;
          const chunk = base();
          chunk.choices[0].delta.role = 'assistant';
          chunk.choices[0].delta.content = delta;
          output.push(chunk);
        }
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = data.response ?? {};
      const incomplete = type === 'response.incomplete' || response.status === 'incomplete';
      if (response.status && !['completed', 'incomplete'].includes(response.status)) throw new CodexProtocolError('invalid_response', 'Codex response has an unsupported terminal status');
      const incompleteReason = incomplete ? String(response.incomplete_details?.reason ?? '') : '';
      const incompleteFinish = incomplete ? incompleteFinishReason(incompleteReason) : undefined;
      this.terminal = incomplete ? 'incomplete' : 'completed';
      this.terminalResponse = clone(response);
      this.model ||= String(response.model ?? '');
      this.responseId ||= String(response.id ?? '');
      this.created ||= Number(response.created_at ?? 0);
      if (response.service_tier) this.serviceTier = String(response.service_tier);
      if (response.output !== undefined && !Array.isArray(response.output)) throw new CodexProtocolError('invalid_response', 'Codex response output is not an array');
      if (Array.isArray(response.output)) response.output.forEach((item: JsonObject, index: number) => {
        this.validateOutputItem(item);
        this.upsertOutput(item, index, true, typeof item.content_index === 'number' ? item.content_index : undefined);
      });
      const chunk = base();
      chunk.choices[0].finish_reason = this.terminal === 'incomplete' ? incompleteFinish : (this.output.some((record) => record.item.type === 'function_call' || record.item.type === 'custom_tool_call') ? 'tool_calls' : 'stop');
      chunk.choices[0].native_finish_reason = this.terminal === 'incomplete' ? incompleteReason : chunk.choices[0].finish_reason;
      output.push(chunk);
      const usage = this.includeUsage ? usageFrom(response) : undefined;
      if (usage) {
        const usageChunk = base();
        usageChunk.choices = [];
        usageChunk.usage = responsesUsageToChat(usage);
        output.push(usageChunk);
      }
    }
    return output;
  }

  private findTool(data: any, allowUnknown = false): ToolState | undefined {
    const keys = [data.item_id ? `item:${String(data.item_id)}` : '', data.output_index !== undefined ? `output:${String(data.output_index)}` : '', data.item?.id ? `item:${String(data.item.id)}` : ''].filter(Boolean);
    const matches = [...new Set(keys.map((key) => this.tools.get(key)).filter((state): state is ToolState => Boolean(state)))];
    if (matches.length > 1) throw new CodexProtocolError('invalid_response', 'Codex tool event identifiers point to different tool calls');
    if (matches.length === 1) return matches[0];
    if (keys.length > 0) {
      if (allowUnknown) return undefined;
      throw new CodexProtocolError('invalid_response', 'Codex tool event referenced an unknown item or output index');
    }
    const active = [...new Set(this.tools.values())].filter((state) => !state.done);
    if (active.length === 1) return active[0];
    if (active.length > 1) throw new CodexProtocolError('invalid_response', 'Codex tool event without an id is ambiguous');
    return undefined;
  }

  finish(): CodexResponseState {
    if (!this.terminal) throw new CodexProtocolError(this.sawDone ? 'incomplete' : 'unexpected_eof', this.sawDone ? 'Codex stream sent [DONE] before a terminal response event' : 'Codex response ended before a terminal event');
    const response = clone(this.terminalResponse);
    response.id ||= this.responseId;
    response.model ||= this.model;
    response.created_at ||= this.created;
    response.status ||= this.terminal;
    response.output = this.orderedOutput();
    if (!response.output.some((item: any) => item.type === 'message') && this.text) response.output.unshift({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.text }] });
    if (!response.output.some((item: any) => item.type === 'reasoning') && this.reasoning) response.output.unshift({ type: 'reasoning', summary: [{ type: 'summary_text', text: this.reasoning }] });
    return { response, terminal: this.terminal, output: clone(response.output), chunks: [] };
  }
}

/**
 * The caller owns HTTP preconditions: it must reject non-2xx responses and
 * validate the upstream content type before handing the body to this module.
 * This module intentionally provides no transport or response-status policy.
 */
export async function consumeCodexResponse(source: SSESource, options: CodexConversionOptions = {}): Promise<CodexResponseState> {
  const processor = new CodexResponseProcessor(options);
  for await (const event of parseCodexSSE(source, options)) processor.process(event);
  return processor.finish();
}

export async function* convertCodexSSEToChatCompletions(source: SSESource, options: CodexConversionOptions = {}): AsyncGenerator<string> {
  const processor = new CodexResponseProcessor(options);
  for await (const event of parseCodexSSE(source, options)) {
    for (const chunk of processor.process(event)) yield `data: ${JSON.stringify(chunk)}\n\n`;
  }
  processor.finish();
  yield 'data: [DONE]\n\n';
}

export async function convertCodexSSEToChatCompletion(source: SSESource, options: CodexConversionOptions = {}): Promise<JsonObject> {
  const state = await consumeCodexResponse(source, options);
  return responsesToChatCompletion(state.response);
}

export async function convertCodexSSEToResponses(source: SSESource, options: CodexConversionOptions = {}): Promise<JsonObject> {
  return (await consumeCodexResponse(source, { ...options, target: 'responses' })).response;
}

export function responsesToChatCompletion(response: JsonObject): JsonObject {
  let content = '';
  let reasoning = '';
  const tool_calls: any[] = [];
  const images: any[] = [];
  if (response.output !== undefined && !Array.isArray(response.output)) throw new CodexProtocolError('invalid_response', 'Codex response output is not an array');
  for (const item of Array.isArray(response.output) ? response.output : []) {
    validateChatOutputItem(item);
    if (item.type === 'message') content += textFromItem(item);
    if (item.type === 'reasoning') reasoning += (item.summary ?? []).filter((part: any) => part.type === 'summary_text').map((part: any) => String(part.text ?? '')).join('') + (item.content ?? []).filter((part: any) => part.type === 'reasoning_text').map((part: any) => String(part.text ?? '')).join('');
    if (item.type === 'function_call' || item.type === 'custom_tool_call') tool_calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: String(item.arguments ?? item.input ?? '') } });
    if (item.type === 'image_generation_call' && item.result) images.push({ type: 'image_url', image_url: { url: `data:${imageMime(item.output_format)};base64,${item.result}` } });
  }
  const incompleteReason = String(response.incomplete_details?.reason ?? 'incomplete');
  if (response.status && !['completed', 'incomplete'].includes(response.status)) throw new CodexProtocolError('invalid_response', 'Codex response has an unsupported terminal status');
  const finishReason = response.status === 'incomplete' ? incompleteFinishReason(incompleteReason) : tool_calls.length ? 'tool_calls' : 'stop';
  const message: any = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (tool_calls.length) message.tool_calls = tool_calls;
  if (images.length) message.images = images;
  return { id: response.id ?? '', object: 'chat.completion', created: response.created_at ?? Math.floor(Date.now() / 1000), model: response.model ?? '', choices: [{ index: 0, message, finish_reason: finishReason, native_finish_reason: response.status === 'incomplete' ? incompleteReason : finishReason }], ...(response.usage ? { usage: responsesUsageToChat(response.usage) } : {}) };
}

export const convertResponsesResponseToChatCompletions = responsesToChatCompletion;

export function chatCompletionToResponses(response: JsonObject): JsonObject {
  const message = response.choices?.[0]?.message ?? {};
  const finishReason = response.choices?.[0]?.finish_reason;
  let status: 'completed' | 'incomplete';
  let incomplete_details: JsonObject | undefined;
  if (finishReason === 'stop' || finishReason === 'tool_calls') status = 'completed';
  else if (finishReason === 'length') {
    status = 'incomplete';
    incomplete_details = { reason: 'max_output_tokens' };
  } else if (finishReason === 'content_filter') {
    status = 'incomplete';
    incomplete_details = { reason: 'content_filter' };
  } else throw new CodexProtocolError('invalid_response', `Chat Completion has an unsupported finish_reason: ${String(finishReason)}`);
  const output: any[] = [];
  if (message.reasoning_content) output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: String(message.reasoning_content) }] });
  if (message.content) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: String(message.content) }] });
  for (const call of message.tool_calls ?? []) {
    if (call?.type === 'custom') output.push({ type: 'custom_tool_call', call_id: call.id, name: validateCodexToolName(call.custom?.name), input: String(call.custom?.input ?? call.custom?.arguments ?? '') });
    else output.push({ type: 'function_call', call_id: call.id, name: validateCodexToolName(call.function?.name), arguments: String(call.function?.arguments ?? '') });
  }
  return { id: response.id, object: 'response', created_at: response.created, model: response.model, status, output, ...(incomplete_details ? { incomplete_details } : {}), ...(response.usage ? { usage: chatUsageToResponses(response.usage) } : {}) };
}

export const convertChatCompletionsResponseToResponses = chatCompletionToResponses;
