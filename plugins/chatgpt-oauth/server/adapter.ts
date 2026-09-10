import type { MutableRequestContext, RawResponseContext } from '../../../packages/core/src/hooks';
import type { RawResponseCompletion, RawResponseResult } from '../../../packages/core/src/plugin-control/contracts';
import {
  CodexProtocolError,
  CodexResponseProcessor,
  consumeCodexResponse,
  convertChatCompletionsRequestToCodex,
  normalizeCodexResponsesRequest,
  parseCodexSSE,
  responsesToChatCompletion,
  streamIncludesUsage,
  type CodexSSEEvent,
  type JsonObject,
} from './codex-protocol';
import { CodexModelsError, parseCodexModelsBody } from './codex-models';
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
const MAX_DISCARD_BYTES = 64 * 1024;
const MAX_MODELS_BODY_BYTES = 256 * 1024;
const MAX_PROFILE_HEADER_VALUE_BYTES = 8192;
const CHATGPT_ORIGIN = 'https://chatgpt.com';

type AdaptationTarget = 'chat' | 'responses' | 'models';
type AdaptedRequest = Readonly<{
  target: AdaptationTarget;
  stream: boolean;
  includeUsage: boolean;
  allowMissingContentType: boolean;
  attemptId?: string;
  adaptedResponses: WeakSet<Response>;
}>;

function record(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexProtocolError('invalid_response', 'Request must be a JSON object');
  }
  return value as JsonObject;
}

function validHeaderValue(value: unknown): value is string {
  return typeof value === 'string'
    && new TextEncoder().encode(value).byteLength <= MAX_PROFILE_HEADER_VALUE_BYTES
    && value.trim().length > 0
    && !/[\r\n\0]/.test(value);
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

function safeErrorBody(): string {
  return JSON.stringify({ error: { message: 'Upstream response could not be adapted', type: 'upstream_error', code: 'upstream_error' } });
}

function completionFromError(error: unknown): RawResponseCompletion {
  if (error instanceof CodexProtocolError) {
    if (error.kind === 'cancelled') return { status: 'cancelled' };
    if (error.kind === 'incomplete') return { status: 'incomplete', code: 'incomplete' };
    if (error.kind === 'unexpected_eof') return { status: 'failed', code: 'unexpected_eof' };
    return { status: 'failed', code: error.kind };
  }
  if (error instanceof CodexModelsError) {
    return error.kind === 'aborted' ? { status: 'cancelled' } : { status: 'failed', code: error.kind };
  }
  return { status: 'failed', code: 'body_error' };
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

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function discardBody(response: Response, signal: AbortSignal): Promise<RawResponseCompletion> {
  if (!response.body) return { status: 'completed' };
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const next = await readWithSignal(reader, signal);
      if (next.done) return { status: 'completed' };
      if (!next.value) return { status: 'failed', code: 'body_error' };
      total += next.value.byteLength;
      if (total > MAX_DISCARD_BYTES) {
        try { void reader.cancel('body_limit').catch(() => undefined); } catch { /* already closed */ }
        return { status: 'failed', code: 'body_limit' };
      }
    }
  } catch {
    try { void reader.cancel('body_error').catch(() => undefined); } catch { /* already closed */ }
    return signal.aborted ? { status: 'cancelled' } : { status: 'failed', code: 'body_error' };
  } finally {
    try { reader.releaseLock(); } catch { /* a pending read owns the lock */ }
  }
}

function isJsonContentType(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  return contentType === 'application/json' || contentType?.endsWith('+json') === true;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const next = await readWithSignal(reader, signal);
      if (next.done) return body + decoder.decode();
      if (!next.value) throw new CodexModelsError('invalid_structure');
      bytes += next.value.byteLength;
      if (bytes > MAX_MODELS_BODY_BYTES) throw new CodexModelsError('body_limit');
      body += decoder.decode(next.value, { stream: true });
    }
  } catch (error) {
    try { void reader.cancel('body_error').catch(() => undefined); } catch { /* already closed */ }
    if (signal.aborted) throw new CodexModelsError('aborted');
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* a pending read owns the lock */ }
  }
}

function serialize(event: CodexSSEEvent): string {
  if (event.type === 'done') return 'data: [DONE]\n\n';
  return `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event.data)}\n\n`;
}

function protocolStreamBody(
  source: ReadableStream<Uint8Array>,
  target: Exclude<AdaptationTarget, 'models'>,
  includeUsage: boolean,
  signal: AbortSignal,
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
  const processor = new CodexResponseProcessor({ target, includeUsage });
  const events = parseCodexSSE(source, { signal: protocolController.signal });
  const iterator = (async function* (): AsyncGenerator<string> {
    try {
      for await (const event of events) {
        const output = processor.process(event);
        if (target === 'responses') yield serialize(event);
        else for (const chunk of output) yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      const final = processor.finish();
      const outcome = final.terminal === 'completed' ? { status: 'completed' as const } : { status: 'incomplete' as const, code: 'incomplete' };
      if (target === 'chat') yield 'data: [DONE]\n\n';
      settle(outcome);
    } catch (error) {
      settle(completionFromError(error));
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
      protocolController.abort(reason ?? 'cancelled');
      void Promise.resolve(iterator.return?.(reason)).catch(() => undefined);
      settle({ status: 'cancelled' });
    },
  });
  return { body, completion };
}

export class ChatgptOauthAdapter {
  private readonly requests = new Map<string, AdaptedRequest>();

  constructor() {}

  beforeRequest(context: MutableRequestContext): MutableRequestContext {
    const target = context.url.pathname === MODELS_PATH
      ? 'models'
      : context.url.pathname === CHAT_COMPLETIONS_PATH
      ? 'chat'
      : context.url.pathname === RESPONSES_PATH ? 'responses' : undefined;
    if (target === undefined || context.url.pathname === CODEX_RESPONSES_PATH) return context;
    if (target === 'models') {
      context.body = undefined;
      context.url.pathname = CODEX_MODELS_PATH;
      context.url.search = `?client_version=${encodeURIComponent(CODEX_COMPATIBILITY_VERSION)}`;
      setHeader(context.headers, 'Accept', 'application/json');
      setHeader(context.headers, 'User-Agent', CODEX_MODELS_USER_AGENT);
      setHeader(context.headers, 'Originator', CODEX_MODELS_ORIGINATOR);
      this.requests.set(context.requestId, Object.freeze({
        target, stream: false, includeUsage: false, allowMissingContentType: false,
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
    setHeader(context.headers, 'Accept', 'text/event-stream');
    setHeader(context.headers, 'Content-Type', 'application/json');
    setHeader(context.headers, 'User-Agent', CODEX_RESPONSES_USER_AGENT);
    setHeader(context.headers, 'Originator', CODEX_RESPONSES_ORIGINATOR);
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
    const errorResponse = (status: number, completion: Promise<RawResponseCompletion>): RawResponseResult => {
      const response = mark(new Response(safeErrorBody(), {
        status,
        statusText: result.response.statusText,
        headers: responseHeaders(result.response, 'application/json; charset=utf-8'),
      }));
      void completion.then(cleanup, cleanup);
      return { response, completion };
    };

    if (!result.response.ok) {
      const bodyCompletion: Promise<RawResponseCompletion> = discardBody(result.response, context.signal).then((outcome): RawResponseCompletion =>
        outcome.status === 'completed' ? { status: 'failed', code: 'upstream_http_error' } : outcome);
      return errorResponse(result.response.status, joinCompletion(result.completion, bodyCompletion, context.signal));
    }

    if (state.target === 'models') {
      if (!isJsonContentType(result.response)) {
        const bodyCompletion = discardBody(result.response, context.signal).then((outcome): RawResponseCompletion =>
          outcome.status === 'completed' ? { status: 'failed', code: 'invalid_content_type' } : outcome);
        return errorResponse(502, joinCompletion(result.completion, bodyCompletion, context.signal));
      }
      if (!result.response.body) {
        return errorResponse(502, joinCompletion(result.completion, Promise.resolve({ status: 'failed', code: 'invalid_response' }), context.signal));
      }
      try {
        const models = parseCodexModelsBody(await readBoundedBody(result.response, context.signal), MAX_MODELS_BODY_BYTES);
        const body = {
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
        return errorResponse(502, joinCompletion(result.completion, Promise.resolve(completionFromError(error)), context.signal));
      }
    }

    const contentType = result.response.headers.get('content-type');
    const hasEventStream = contentType?.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
    const allowMissingContentType = state.allowMissingContentType && contentType === null;
    if ((!hasEventStream && !allowMissingContentType) || !result.response.body) {
      const bodyCompletion = !hasEventStream && !allowMissingContentType
        ? discardBody(result.response, context.signal).then((outcome): RawResponseCompletion =>
          outcome.status === 'completed' ? { status: 'failed', code: 'invalid_content_type' } : outcome)
        : Promise.resolve({ status: 'failed' as const, code: 'invalid_response' });
      return errorResponse(502, joinCompletion(result.completion, bodyCompletion, context.signal));
    }
    if (state.stream) {
      const converted = protocolStreamBody(result.response.body, state.target, state.includeUsage, context.signal);
      const streamCompletion = joinCompletion(result.completion, converted.completion, context.signal);
      void streamCompletion.then(cleanup, cleanup);
      return {
        response: mark(new Response(converted.body, { status: result.response.status, statusText: result.response.statusText, headers: responseHeaders(result.response, 'text/event-stream') })),
        completion: streamCompletion,
      };
    }
    try {
      const stateResult = await consumeCodexResponse(result.response.body, {
        signal: context.signal,
        request: { stream_options: { include_usage: state.includeUsage } },
        target: state.target,
      });
      const body = state.target === 'chat' ? responsesToChatCompletion(stateResult.response) : stateResult.response;
      const protocolCompletion: Promise<RawResponseCompletion> = Promise.resolve(
        stateResult.terminal === 'completed' ? { status: 'completed' } : { status: 'incomplete', code: 'incomplete' },
      );
      const nonStreamCompletion = joinCompletion(result.completion, protocolCompletion, context.signal);
      void nonStreamCompletion.then(cleanup, cleanup);
      return { response: mark(new Response(JSON.stringify(body), { status: result.response.status, statusText: result.response.statusText, headers: responseHeaders(result.response, 'application/json; charset=utf-8') })), completion: nonStreamCompletion };
    } catch (error) {
      const failure = completionFromError(error);
      const failedCompletion = joinCompletion(result.completion, Promise.resolve(failure), context.signal);
      return errorResponse(502, failedCompletion);
    }
  }

}
