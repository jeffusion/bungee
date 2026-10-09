import type { BodyHandle, MutableRequestContext, RawResponseContext } from '@jeffusion/bungee-core/plugin';
import type { RawResponseCompletion, RawResponseError, RawResponseResult } from '@jeffusion/bungee-core/plugin';
import { errorDiagnostic } from './error-diagnostics';
import {
  CodexProtocolError,
  CodexResponseProcessor,
  consumeCodexResponse,
  convertChatCompletionsRequestToCodex,
  isCodexResponsesLite,
  normalizeCodexResponsesRequest,
  parseCodexSSE,
  responsesToChatCompletion,
  streamIncludesUsage,
  type CodexSSEEvent,
  type JsonObject,
} from './codex-protocol';
import { CodexModelsError, parseCodexModelsPayload } from './codex-models';
import {
  CODEX_COMPATIBILITY_VERSION,
  CODEX_MODELS_ORIGINATOR,
  CODEX_MODELS_USER_AGENT,
  CODEX_RESPONSES_ORIGINATOR,
  CODEX_RESPONSES_USER_AGENT,
} from './constants';

export {
  CODEX_COMPATIBILITY_VERSION,
  CODEX_MODELS_USER_AGENT,
  CODEX_RESPONSES_USER_AGENT,
} from './constants';

export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
export const RESPONSES_PATH = '/v1/responses';
export const MODELS_PATH = '/v1/models';
export const CODEX_RESPONSES_PATH = '/backend-api/codex/responses';
export const CODEX_MODELS_PATH = '/backend-api/codex/models';
const MAX_PROFILE_HEADER_VALUE_BYTES = 8192;
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const SIWC_ORIGIN = 'https://api.openai.com';
const CODEX_ROUTING_HINT_HEADER = 'X-Codex-Routing-Hint';
const SIWC_FORBIDDEN_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_completion_tokens', 'max_tool_calls',
  'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier',
  'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
  'client_metadata', 'context_management', 'prompt_cache_options',
];

type AdaptationTarget = 'chat' | 'responses' | 'models';
type AdaptedRequest = Readonly<{
  target: AdaptationTarget;
  stream: boolean;
  includeUsage: boolean;
  allowMissingContentType: boolean;
  siwc?: boolean;
  attemptId?: string;
  adaptedResponses: WeakSet<Response>;
  preserveModels?: boolean;
}>;

function record(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexProtocolError('invalid_response', 'Request must be a JSON object');
  }
  return value as JsonObject;
}

function siwcTool(tool: unknown): JsonObject {
  const value = record(tool);
  if (value.type !== 'function' && value.type !== 'custom') {
    throw new CodexProtocolError('invalid_response', 'SIWC supports only function and custom tools');
  }
  const nested = value.type === 'function' ? value.function : value.custom;
  const definition = nested === undefined ? value : record(nested);
  if (typeof definition.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(definition.name)) {
    throw new CodexProtocolError('invalid_response', 'SIWC tool names must be 1-64 ASCII letters, digits, underscores or hyphens');
  }
  const normalized: JsonObject = { ...definition, type: value.type };
  if (value.type === 'custom' && normalized.format?.type === 'grammar' && normalized.format.grammar !== undefined) {
    const grammar = record(normalized.format.grammar);
    if (!['lark', 'regex'].includes(grammar.syntax) || typeof grammar.definition !== 'string') {
      throw new CodexProtocolError('invalid_response', 'SIWC custom tool grammar is invalid');
    }
    normalized.format = { type: 'grammar', syntax: grammar.syntax, definition: grammar.definition };
  }
  return normalized;
}

function normalizeSiwcRequest(input: JsonObject, target: 'chat' | 'responses'): JsonObject {
  if (input.previous_response_id !== undefined) {
    throw new CodexProtocolError('invalid_response', 'SIWC requires the full conversation in input; previous_response_id is unsupported');
  }
  if (input.tools !== undefined && !Array.isArray(input.tools)) {
    throw new CodexProtocolError('invalid_response', 'SIWC tools must be an array');
  }
  // Validate before conversion, which can otherwise preserve hosted tools.
  input.tools?.forEach(siwcTool);
  if (target === 'chat' && !Array.isArray(input.messages)) {
    throw new CodexProtocolError('invalid_response', 'Chat messages must be an array');
  }
  const out = target === 'chat' ? convertChatCompletionsRequestToCodex(input) : JSON.parse(JSON.stringify(input));
  out.store = false;
  out.stream = true;
  if (out.instructions === undefined || out.instructions === null) out.instructions = '';
  if (typeof out.instructions !== 'string') throw new CodexProtocolError('invalid_response', 'SIWC instructions must be text');
  if (typeof out.input === 'string') out.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: out.input }] }];
  if (out.input === undefined) out.input = [];
  if (!Array.isArray(out.input)) throw new CodexProtocolError('invalid_response', 'SIWC input must contain the full conversation as an array');
  const inputTypes = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'reasoning', 'compaction']);
  for (const item of out.input) {
    const value = record(item);
    if (value.type === undefined && typeof value.role === 'string') value.type = 'message';
    if (!inputTypes.has(value.type)) throw new CodexProtocolError('invalid_response', 'SIWC input contains an unsupported item');
    if (value.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(value.role)) throw new CodexProtocolError('invalid_response', 'SIWC input contains an unsupported role');
      if (value.role === 'system') value.role = 'developer';
    }
  }
  if (Array.isArray(out.tools)) out.tools = out.tools.map(siwcTool);
  if (out.tool_choice !== undefined) {
    if (typeof out.tool_choice === 'string') {
      if (!['auto', 'none', 'required'].includes(out.tool_choice)) throw new CodexProtocolError('invalid_response', 'SIWC tool choice is unsupported');
    } else out.tool_choice = siwcTool(out.tool_choice);
  }
  for (const field of SIWC_FORBIDDEN_FIELDS) delete out[field];
  return out;
}

function setSiwcHeaders(context: MutableRequestContext, target: AdaptationTarget): void {
  for (const name of Object.keys(context.headers)) {
    if (/^(chatgpt-account-id|session-id|thread-id|version|x-codex-.*|x-openai-internal-codex-.*)$/i.test(name)) delete context.headers[name];
  }
  setHeader(context.headers, 'User-Agent', 'Bungee/5.11.0');
  setHeader(context.headers, 'Originator', 'Bungee');
  setHeader(context.headers, 'Accept', target === 'models' ? 'application/json' : 'text/event-stream');
  if (target !== 'models') setHeader(context.headers, 'Content-Type', 'application/json');
}

function parseSiwcModelsBody(payload: unknown): readonly { id: string }[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new CodexModelsError('invalid_structure');
  const models = (payload as JsonObject).models;
  if (!Array.isArray(models) || models.length > 512) throw new CodexModelsError('invalid_structure');
  const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\r\n\0]/.test(value);
  const listed: { id: string }[] = [];
  for (const model of models) {
    if (!model || typeof model !== 'object' || Array.isArray(model) || !text(model.slug)
      || typeof model.visibility !== 'string' || (model.display_name !== undefined && !text(model.display_name))) throw new CodexModelsError('invalid_structure');
    if (model.visibility === 'list') listed.push({ id: model.slug });
  }
  return listed;
}

function validHeaderValue(value: unknown): value is string {
  return typeof value === 'string'
    && new TextEncoder().encode(value).byteLength <= MAX_PROFILE_HEADER_VALUE_BYTES
    && value.trim().length > 0
    && !/[\r\n\0]/.test(value);
}

function validRoutingHintPart(value: unknown): value is string {
  return validHeaderValue(value) && !/[\x00-\x1F\x7F;]/.test(value);
}

function setCodexRoutingHint(headers: Record<string, string>, body: unknown): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === CODEX_ROUTING_HINT_HEADER.toLowerCase()) delete headers[key];
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  const requestBody = body as Record<string, unknown>;
  if (!validRoutingHintPart(requestBody.model)) return;
  const hint = requestBody.service_tier === 'priority'
    ? `model=${requestBody.model};tier=priority`
    : `model=${requestBody.model}`;
  if (validHeaderValue(hint)) setHeader(headers, CODEX_ROUTING_HINT_HEADER, hint);
}

function enforceCodexResponsesLite(context: MutableRequestContext): void {
  if (context.url.pathname !== CODEX_RESPONSES_PATH || !isCodexResponsesLite(context.body, context.headers)) return;
  if (typeof context.body === 'object' && context.body !== null && !Array.isArray(context.body)) {
    context.body = { ...context.body, parallel_tool_calls: false };
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry && validHeaderValue(entry[1]) ? entry[1] : undefined;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) delete headers[key];
  }
  headers[lowerName] = value;
}

function responseHeaders(response: Response, contentType: string): Headers {
  const headers = new Headers();
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) headers.set('retry-after', retryAfter);
  headers.set('content-type', contentType);
  return headers;
}

function errorBody(error?: RawResponseError, fallbackCode = 'upstream_error') {
  return { message: error?.message ?? 'Upstream response could not be adapted', type: error?.type ?? 'upstream_error', code: error?.code ?? fallbackCode };
}

function completionFromError(error: unknown, redact?: RawResponseContext['redactDiagnostic']): RawResponseCompletion {
  if (error instanceof CodexProtocolError) {
    if (error.kind === 'cancelled') return { status: 'cancelled' };
    if (error.kind === 'incomplete') return { status: 'incomplete', code: 'incomplete' };
    if (error.kind === 'unexpected_eof') return { status: 'failed', code: 'unexpected_eof' };
    return { status: 'failed', code: error.kind, ...(error.diagnostic ? {
      error: errorDiagnostic(error.diagnostic, error.diagnostic.source, error.message, redact),
    } : {}) };
  }
  if (error instanceof CodexModelsError) {
    return error.kind === 'aborted' ? { status: 'cancelled' } : { status: 'failed', code: error.kind };
  }
  const hostCode = (error as { code?: string })?.code;
  if (hostCode === 'body_consumer_cancelled') return { status: 'cancelled' };
  if (hostCode?.includes('too_large')) return { status: 'failed', code: 'body_limit' };
  if (hostCode === 'invalid_json_body' || hostCode?.startsWith('body_sse_')) return { status: 'failed', code: 'invalid_response' };
  return { status: 'failed', code: 'body_error', error: errorDiagnostic(error, 'transport', 'Upstream response body could not be read', redact) };
}

function bodyConsumer(signal: AbortSignal) {
  return { id: 'chatgpt-oauth', mandatory: true, signal } as const;
}

async function readHttpError(context: RawResponseContext): Promise<RawResponseCompletion> {
  try {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(1000)]);
    const body = await context.bodyHandle!.json(bodyConsumer(signal));
    const error = body && typeof body === 'object' ? (body as JsonObject).error : undefined;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      return { status: 'failed', code: 'upstream_http_error', error: errorDiagnostic(error, 'upstream', 'Upstream returned an HTTP error', context.redactDiagnostic) };
    }
  } catch {
    if (context.signal.aborted) return { status: 'cancelled' };
    // Malformed JSON and body limits must never expose the upstream body.
  }
  return { status: 'failed', code: 'upstream_http_error' };
}

function joinCompletion(
  upstream: Promise<RawResponseCompletion>,
  body: Promise<RawResponseCompletion>,
  signal?: AbortSignal,
): Promise<RawResponseCompletion> {
  const safe = (promise: Promise<RawResponseCompletion>): Promise<RawResponseCompletion> =>
    promise.catch(() => ({ status: 'failed', code: 'upstream_completion' }));
  const wait = (promise: Promise<RawResponseCompletion>): Promise<RawResponseCompletion> => {
    const pending = safe(promise);
    if (signal === undefined) return pending;
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RawResponseCompletion) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => finish({ status: 'cancelled' });
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(finish, () => finish({ status: 'failed', code: 'upstream_completion' }));
    });
  };
  return wait(body).then((bodyResult) => bodyResult.status === 'completed' ? wait(upstream) : bodyResult);
}

async function discardBody(handle: BodyHandle, signal: AbortSignal): Promise<RawResponseCompletion> {
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(1000)]);
    await handle.decoded(bodyConsumer(deadline));
    return { status: 'completed' };
  } catch (error) {
    if (signal.aborted) return { status: 'cancelled' };
    const code = (error as { code?: string })?.code;
    return { status: 'failed', code: code?.includes('too_large') ? 'body_limit' : 'body_error' };
  }
}

function isJsonContentType(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  return contentType === 'application/json' || contentType?.endsWith('+json') === true;
}


function serialize(event: CodexSSEEvent): string {
  const envelope = event.envelope;
  if (envelope?.raw) return envelope.raw;
  const lines = (envelope?.comments ?? []).map(comment => `:${comment}`);
  if (envelope?.event !== undefined) lines.push(`event: ${envelope.event}`);
  if (envelope?.id !== undefined) lines.push(`id: ${envelope.id}`);
  if (envelope?.retry !== undefined) lines.push(`retry: ${envelope.retry}`);
  const data = event.type === 'done' ? '[DONE]' : envelope?.data ?? JSON.stringify(event.data);
  lines.push(...data.split('\n').map(line => `data: ${line}`));
  return `${lines.join('\n')}\n\n`;
}

function protocolStreamBody(
  handle: BodyHandle,
  target: Exclude<AdaptationTarget, 'models'>,
  includeUsage: boolean,
  signal: AbortSignal,
  redact?: RawResponseContext['redactDiagnostic'],
  preserveCustomTools = false,
): { body: ReadableStream<Uint8Array>; completion: Promise<RawResponseCompletion> } {
  const protocolController = new AbortController();
  const onAbort = () => protocolController.abort(signal.reason ?? 'cancelled');
  if (signal.aborted) protocolController.abort(signal.reason ?? 'cancelled');
  else signal.addEventListener('abort', onAbort, { once: true });
  let resolveCompletion!: (result: RawResponseCompletion) => void;
  let settled = false;
  const settle = (result: RawResponseCompletion) => {
    if (settled) return;
    settled = true;
    resolveCompletion(result);
  };
  const completion = new Promise<RawResponseCompletion>((resolve) => { resolveCompletion = resolve; });
  const processor = new CodexResponseProcessor({ target, includeUsage, redactDiagnostic: redact, preserveCustomTools });
  let terminalOutcome: RawResponseCompletion | undefined;
  const events = parseCodexSSE(handle.events(bodyConsumer(protocolController.signal)), { signal: protocolController.signal });
  const iterator = (async function* (): AsyncGenerator<string> {
    try {
      for await (const event of events) {
        const output = processor.process(event);
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          const final = processor.finish();
          terminalOutcome = final.terminal === 'completed'
            ? { status: 'completed' }
            : { status: 'incomplete', code: 'incomplete' };
          // A complete, validated protocol terminal is proof even if the client
          // closes the transport immediately after receiving this event.
          settle(terminalOutcome);
        }
        if (target === 'responses') yield serialize(event);
        else for (const chunk of output) yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      const final = processor.finish();
      const outcome = final.terminal === 'completed' ? { status: 'completed' as const } : { status: 'incomplete' as const, code: 'incomplete' };
      if (target === 'chat') yield 'data: [DONE]\n\n';
      settle(outcome);
    } catch (error) {
      const outcome = completionFromError(error, redact);
      settle(outcome.status === 'cancelled' ? terminalOutcome ?? outcome : outcome);
      if (outcome.status === 'failed' && outcome.error) {
        // A terminal error frame makes the reason observable to clients and the
        // response capture. Completion stays failed, even though HTTP is 200.
        const safe = errorBody(outcome.error, outcome.code);
        yield target === 'responses'
          ? `event: error\ndata: ${JSON.stringify({ type: 'error', code: safe.code, message: safe.message, param: null, error: safe })}\n\n`
          : `data: ${JSON.stringify({ error: safe })}\n\n`;
        return;
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  })()[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else if (next.value !== undefined) controller.enqueue(new TextEncoder().encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      settle(terminalOutcome ?? { status: 'cancelled' });
      protocolController.abort(reason ?? 'cancelled');
      void Promise.resolve(iterator.return?.(reason)).catch(() => undefined);
    },
  });
  return { body, completion };
}

export class ChatgptOauthAdapter {
  private readonly requests = new Map<string, AdaptedRequest>();

  constructor() {}

  beforeRequest(context: MutableRequestContext): MutableRequestContext {
    const target = (context.url.pathname === MODELS_PATH || (context.originalUrl.searchParams.has('client_version') && context.url.pathname === '/models'))
      ? 'models'
      : context.url.pathname === CHAT_COMPLETIONS_PATH
      ? 'chat'
      : context.url.pathname === RESPONSES_PATH ? 'responses' : undefined;
    if (context.url.origin === SIWC_ORIGIN) {
      if (target === undefined) return context;
      const input = target === 'models' ? undefined : record(context.body);
      const stream = input?.stream === true;
      const includeUsage = input ? streamIncludesUsage(input) : false;
      context.body = input ? normalizeSiwcRequest(input, target as 'chat' | 'responses') : undefined;
      if (target !== 'models') context.url.pathname = RESPONSES_PATH;
      setSiwcHeaders(context, target);
      this.requests.set(context.requestId, Object.freeze({
        // SIWC Responses can return a valid SSE body without Content-Type.
        // The protocol parser still requires valid events and a terminal response.
        target, stream, includeUsage, siwc: true, allowMissingContentType: target !== 'models',
        adaptedResponses: new WeakSet<Response>(),
      }));
      return context;
    }
    if (context.url.pathname === CODEX_RESPONSES_PATH) {
      setCodexRoutingHint(context.headers, context.body);
      enforceCodexResponsesLite(context);
      return context;
    }
    if (target === undefined) return context;
    if (target === 'models') {
      context.body = undefined;
      context.url.pathname = CODEX_MODELS_PATH;
      context.url.search = `?client_version=${encodeURIComponent(CODEX_COMPATIBILITY_VERSION)}`;
      setHeader(context.headers, 'Accept', 'application/json');
      setHeader(context.headers, 'User-Agent', CODEX_MODELS_USER_AGENT);
      setHeader(context.headers, 'Originator', CODEX_MODELS_ORIGINATOR);
      this.requests.set(context.requestId, Object.freeze({
        target, stream: false, includeUsage: false, allowMissingContentType: false,
        preserveModels: context.originalUrl.searchParams.has('client_version'),
        adaptedResponses: new WeakSet<Response>(),
      }));
      return context;
    }
    const input = record(context.body);
    const stream = input.stream === true;
    const includeUsage = streamIncludesUsage(input);
    const promptCacheKey = validHeaderValue(input.prompt_cache_key) ? input.prompt_cache_key : undefined;
    const inboundSessionId = headerValue(context.headers, 'Session-Id');
    const sessionId = inboundSessionId ?? promptCacheKey;
    context.body = target === 'chat'
      ? convertChatCompletionsRequestToCodex(input)
      : normalizeCodexResponsesRequest(input);
    if (target === 'chat' && promptCacheKey !== undefined) context.body.prompt_cache_key = promptCacheKey;
    context.url.pathname = CODEX_RESPONSES_PATH;
    enforceCodexResponsesLite(context);
    setHeader(context.headers, 'Accept', 'text/event-stream');
    setHeader(context.headers, 'Content-Type', 'application/json');
    setHeader(context.headers, 'User-Agent', CODEX_RESPONSES_USER_AGENT);
    setHeader(context.headers, 'Originator', CODEX_RESPONSES_ORIGINATOR);
    setCodexRoutingHint(context.headers, context.body);
    for (const key of Object.keys(context.headers)) {
      if (key.toLowerCase() === 'session-id') delete context.headers[key];
    }
    if (sessionId !== undefined) setHeader(context.headers, 'Session-Id', sessionId);
    this.requests.set(context.requestId, Object.freeze({
      target,
      stream,
      includeUsage,
      allowMissingContentType: context.url.origin === CHATGPT_ORIGIN
        && context.url.pathname === CODEX_RESPONSES_PATH,
      adaptedResponses: new WeakSet<Response>(),
    }));
    return context;
  }

  reconcileOutboundRequest(context: MutableRequestContext): MutableRequestContext {
    if (context.url.origin === SIWC_ORIGIN) {
      if (context.url.pathname === RESPONSES_PATH) {
        context.body = normalizeSiwcRequest(record(context.body), 'responses');
        setSiwcHeaders(context, 'responses');
      } else if (context.url.pathname === MODELS_PATH) setSiwcHeaders(context, 'models');
      return context;
    }
    if (context.url.pathname === CODEX_RESPONSES_PATH) {
      setCodexRoutingHint(context.headers, context.body);
      enforceCodexResponsesLite(context);
    }
    return context;
  }

  async rawResponse(result: RawResponseResult, context: RawResponseContext): Promise<RawResponseResult> {
    const current = this.requests.get(context.requestId);
    if (current === undefined || current.adaptedResponses.has(result.response)) return result;
    current.adaptedResponses.add(result.response);
    const state = current.attemptId === undefined
      ? Object.freeze({ ...current, attemptId: context.attemptId })
      : current;
    if (state !== current && this.requests.get(context.requestId) === current) this.requests.set(context.requestId, state);
    const cleanup = () => { if (this.requests.get(context.requestId) === state) this.requests.delete(context.requestId); };
    const mark = (response: Response): Response => { current.adaptedResponses.add(response); return response; };
    const errorResponse = (status: number, completion: Promise<RawResponseCompletion>, error?: RawResponseError): RawResponseResult => {
      const response = mark(new Response(JSON.stringify({ error: errorBody(error) }), {
        status,
        statusText: result.response.statusText,
        headers: responseHeaders(result.response, 'application/json; charset=utf-8'),
      }));
      void completion.then(cleanup, cleanup);
      return { response, completion };
    };

    // The host owns wire reading, decompression, framing and JSON caching.
    // Adaptation requires that explicit shared view; there is no private reader fallback.
    if (!context.bodyHandle) {
      return errorResponse(502, Promise.resolve({ status: 'failed', code: 'body_view_missing' }));
    }

    if (!result.response.ok) {
      const failure = await readHttpError(context);
      return errorResponse(result.response.status, joinCompletion(result.completion, Promise.resolve(failure), context.signal), 'error' in failure ? failure.error : undefined);
    }

    if (state.target === 'models') {
      if (!isJsonContentType(result.response)) {
        const bodyCompletion = discardBody(context.bodyHandle, context.signal).then((outcome): RawResponseCompletion =>
          outcome.status === 'completed' ? { status: 'failed', code: 'invalid_content_type' } : outcome);
        return errorResponse(502, joinCompletion(result.completion, bodyCompletion, context.signal));
      }
      if (!result.response.body) {
        return errorResponse(502, joinCompletion(result.completion, Promise.resolve({ status: 'failed', code: 'invalid_response' }), context.signal));
      }
      try {
        const payload = await context.bodyHandle.json(bodyConsumer(context.signal));
        const models = state.preserveModels ? [] : state.siwc ? parseSiwcModelsBody(payload) : parseCodexModelsPayload(payload);
        if (state.preserveModels && (!payload || typeof payload !== 'object' || !Array.isArray((payload as JsonObject).models))) throw new CodexModelsError('invalid_structure');
        const body = state.preserveModels ? payload : {
          object: 'list',
          data: models.map(({ id }) => ({ id, object: 'model', owned_by: 'openai' })),
        };
        const completion = joinCompletion(result.completion, Promise.resolve({ status: 'completed' as const }), context.signal);
        const response = mark(new Response(JSON.stringify(body), {
          status: result.response.status,
          statusText: result.response.statusText,
          headers: responseHeaders(result.response, 'application/json; charset=utf-8'),
        }));
        void completion.then(cleanup, cleanup);
        return { response, completion };
      } catch (error) {
        const failure = completionFromError(error, context.redactDiagnostic);
        return errorResponse(502, joinCompletion(result.completion, Promise.resolve(failure), context.signal), 'error' in failure ? failure.error : undefined);
      }
    }

    const contentType = result.response.headers.get('content-type');
    const hasEventStream = contentType?.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
    const allowMissingContentType = state.allowMissingContentType && contentType === null;
    if ((!hasEventStream && !allowMissingContentType) || !result.response.body) {
      const bodyCompletion = !hasEventStream && !allowMissingContentType
        ? discardBody(context.bodyHandle, context.signal).then((outcome): RawResponseCompletion =>
          outcome.status === 'completed' ? { status: 'failed', code: 'invalid_content_type' } : outcome)
        : Promise.resolve({ status: 'failed' as const, code: 'invalid_response' });
      return errorResponse(502, joinCompletion(result.completion, bodyCompletion, context.signal));
    }
    if (state.stream) {
      const converted = protocolStreamBody(context.bodyHandle, state.target, state.includeUsage, context.signal, context.redactDiagnostic, state.siwc);
      // A validated terminal is proof before transport EOF. An already failed
      // upstream must still settle even if its body never reaches a terminal.
      const streamCompletion = Promise.race([
        converted.completion,
        result.completion.then(upstream => upstream.status === 'failed' ? upstream : converted.completion,
          () => ({ status: 'failed' as const, code: 'upstream_completion' })),
      ]);
      void streamCompletion.then(cleanup, cleanup);
      return {
        response: mark(new Response(converted.body, { status: result.response.status, statusText: result.response.statusText, headers: responseHeaders(result.response, 'text/event-stream') })),
        completion: streamCompletion,
      };
    }
    try {
      const stateResult = await consumeCodexResponse(context.bodyHandle.events(bodyConsumer(context.signal)), {
        signal: context.signal,
        request: { stream_options: { include_usage: state.includeUsage } },
        target: state.target,
        redactDiagnostic: context.redactDiagnostic,
      });
      const body = state.target === 'chat' ? responsesToChatCompletion(stateResult.response, state.siwc) : stateResult.response;
      const protocolCompletion: Promise<RawResponseCompletion> = Promise.resolve(
        stateResult.terminal === 'completed' ? { status: 'completed' } : { status: 'incomplete', code: 'incomplete' },
      );
      const nonStreamCompletion = joinCompletion(result.completion, protocolCompletion, context.signal);
      void nonStreamCompletion.then(cleanup, cleanup);
      return { response: mark(new Response(JSON.stringify(body), { status: result.response.status, statusText: result.response.statusText, headers: responseHeaders(result.response, 'application/json; charset=utf-8') })), completion: nonStreamCompletion };
    } catch (error) {
      const failure = completionFromError(error, context.redactDiagnostic);
      const failedCompletion = joinCompletion(result.completion, Promise.resolve(failure), context.signal);
      return errorResponse(502, failedCompletion, 'error' in failure ? failure.error : undefined);
    }
  }

}
