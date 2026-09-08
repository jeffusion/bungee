import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createPluginHooks, type MutableRequestContext, type RawResponseContext } from '../../../packages/core/src/hooks';
import { validatePluginOptions } from '../../../packages/core/src/config-storage/plugin-schema';
import { ValidationContext } from '../../../packages/core/src/config-storage/validation';
import { parsePluginManifestText } from '../../../packages/core/src/plugin-manifest-catalog';
import { CHAT_COMPLETIONS_PATH, CODEX_COMPATIBILITY_VERSION, CODEX_MODELS_PATH, CODEX_RESPONSES_PATH, MODELS_PATH, RESPONSES_PATH, ChatgptOauthAdapter } from '../server/adapter';
import ChatgptOauthPlugin from '../server/index';

const responseStream = (body: string, status = 200, contentType = 'text/event-stream'): Response =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const completionSse = [
  'data: {"type":"response.created","response":{"id":"r1","created_at":1,"model":"codex"}}\n\n',
  'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\n\n',
  'data: [DONE]\n\n',
].join('');

const toolUsageSse = [
  'data: {"type":"response.created","response":{"id":"r3","created_at":1,"model":"codex"}}\n\n',
  'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":1}"}}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":1}"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
  'data: [DONE]\n\n',
].join('');

const nativeWebSearch = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"r2","model":"codex"}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"search_1"}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"web_search_call","id":"search_1"}]}}\n\n',
  'data: [DONE]\n\n',
].join('');

function request(path: string, stream: boolean, body: Record<string, unknown> = {}): MutableRequestContext {
  const defaults = path === RESPONSES_PATH || path === CODEX_RESPONSES_PATH
    ? { model: 'codex', stream }
    : { model: 'codex', messages: [{ role: 'user', content: 'hi' }], stream };
  return {
    method: 'POST', originalUrl: new URL(`http://localhost${path}`),
    url: new URL(`https://chatgpt.com${path}`), headers: {},
    body: { ...defaults, ...body },
    clientIP: '127.0.0.1', requestId: crypto.randomUUID(),
  };
}

function modelsRequest(): MutableRequestContext {
  return {
    method: 'GET', originalUrl: new URL(`http://localhost${MODELS_PATH}`),
    url: new URL(`https://chatgpt.com${MODELS_PATH}`), headers: {}, body: undefined,
    clientIP: '127.0.0.1', requestId: crypto.randomUUID(),
  };
}

function rawContext(context: MutableRequestContext, attemptId = 'attempt'): RawResponseContext {
  return {
    method: context.method, originalUrl: context.originalUrl, clientIP: context.clientIP,
    requestId: context.requestId, signal: new AbortController().signal, attemptId,
  };
}

function completion(status: 'completed' | 'failed' | 'incomplete' | 'cancelled' = 'completed') {
  return Promise.resolve(status === 'completed' ? { status } : { status, code: `upstream_${status}` });
}

describe('ChatGPT OAuth adapter', () => {
  test('manifest persists the required accountRef and compiler validation matches the control boundary', () => {
    const manifest = parsePluginManifestText(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const schema = new Map([[manifest.name, manifest.configSchema]]);
    const validate = (options: Record<string, any>) => {
      const context = new ValidationContext();
      validatePluginOptions(manifest.name, options as any, 'plugins[0]', schema, context);
      return context.errors;
    };
    expect(validate({ accountRef: 'account-1' })).toEqual([]);
    expect(validate({})).toHaveLength(1);
    expect(validate({ accountRef: 1 })).toHaveLength(1);
    expect(validate({ accountRef: `x${'a'.repeat(128)}` })).toHaveLength(1);
    expect(() => new ChatgptOauthPlugin({ accountRef: ' account-1' })).toThrow();
    expect(() => new ChatgptOauthPlugin({ accountRef: 'account-1 ' })).toThrow();
    expect(manifest.engines.bungee).toBe('^4.3.0');
    expect(manifest.configSchema.some((field) => field.name === 'clientVersion')).toBe(false);
    for (const asset of ['index.html', 'accounts.css', 'accounts.js', 'account-model.js']) {
      expect(Bun.file(new URL(`../ui/${asset}`, import.meta.url)).size).toBeGreaterThan(0);
    }
    expect(manifest.uiExtensionMode).toBe('sandbox-iframe');
    expect(manifest.capabilities).toContain('sandboxUiExtension');
    expect(manifest.contributes?.settings).toBe('/accounts');
  });

  test('adapts Chat Completions and native Responses requests independently', () => {
    const adapter = new ChatgptOauthAdapter();
    const chat = request(CHAT_COMPLETIONS_PATH, true, { stream_options: { include_usage: true } });
    adapter.beforeRequest(chat);
    expect(chat.url.pathname).toBe(CODEX_RESPONSES_PATH);
    expect(chat.body).toMatchObject({ stream: true, store: false, input: [{ role: 'user' }] });
    expect(chat.headers.originator).toBe('codex_cli_rs');

    const native = request(RESPONSES_PATH, false, { input: 'hi', tools: [{ type: 'web_search_preview' }] });
    adapter.beforeRequest(native);
    expect(native.url.pathname).toBe(CODEX_RESPONSES_PATH);
    expect(native.body).toMatchObject({ stream: true, store: false, input: [{ content: [{ type: 'input_text', text: 'hi' }] }] });
    expect(native.body).toMatchObject({ tools: [{ type: 'web_search' }] });
    expect(native.body).not.toMatchObject({ messages: expect.anything() });

    const codexNative = request(CODEX_RESPONSES_PATH, true, { input: 'hi' });
    adapter.beforeRequest(codexNative);
    expect(codexNative.body).toMatchObject({ input: 'hi' });
  });

  test('Chat stream and native non-stream keep their client protocol', async () => {
    const adapter = new ChatgptOauthAdapter();
    const chat = request(CHAT_COMPLETIONS_PATH, true);
    adapter.beforeRequest(chat);
    const chatResult = await adapter.rawResponse({ response: responseStream(completionSse), completion: completion() }, rawContext(chat));
    expect(await chatResult.response.text()).toContain('"content":"ok"');

    const native = request(RESPONSES_PATH, false);
    adapter.beforeRequest(native);
    const nativeResult = await adapter.rawResponse({ response: responseStream(nativeWebSearch), completion: completion() }, rawContext(native));
    expect(await nativeResult.response.json()).toMatchObject({ status: 'completed', output: [{ type: 'web_search_call' }] });

    const nativeStream = request(RESPONSES_PATH, true, { input: 'search' });
    adapter.beforeRequest(nativeStream);
    const nativeStreamResult = await adapter.rawResponse({ response: responseStream(nativeWebSearch), completion: completion() }, rawContext(nativeStream));
    const nativeStreamText = await nativeStreamResult.response.text();
    expect(nativeStreamText).toContain('response.output_item.added');
    expect(nativeStreamText).not.toContain('chat.completion');
  });

  test('Chat non-stream preserves tool calls and usage', async () => {
    const adapter = new ChatgptOauthAdapter();
    const chat = request(CHAT_COMPLETIONS_PATH, false);
    adapter.beforeRequest(chat);
    const result = await adapter.rawResponse({ response: responseStream(toolUsageSse), completion: completion() }, rawContext(chat));
    expect(await result.response.json()).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: 'lookup' } }] } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });

  test('joins upstream and protocol completion, including incomplete and EOF', async () => {
    const adapter = new ChatgptOauthAdapter();
    const incomplete = request(CHAT_COMPLETIONS_PATH, false);
    adapter.beforeRequest(incomplete);
    const incompleteBody = 'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}\n\n';
    const incompleteResult = await adapter.rawResponse({ response: responseStream(incompleteBody), completion: completion() }, rawContext(incomplete));
    await incompleteResult.response.text();
    await expect(incompleteResult.completion).resolves.toMatchObject({ status: 'incomplete' });

    const failed = request(CHAT_COMPLETIONS_PATH, true);
    adapter.beforeRequest(failed);
    const failedResult = await adapter.rawResponse({ response: responseStream('data: {"type":"response.output_text.delta","delta":"x"}\n\n'), completion: completion() }, rawContext(failed));
    await expect(failedResult.response.text()).rejects.toBeDefined();
    await expect(failedResult.completion).resolves.toMatchObject({ status: 'failed' });

    const upstreamFailed = request(CHAT_COMPLETIONS_PATH, false);
    adapter.beforeRequest(upstreamFailed);
    const upstreamFailedResult = await adapter.rawResponse({ response: responseStream(completionSse), completion: completion('failed') }, rawContext(upstreamFailed));
    await upstreamFailedResult.response.text();
    await expect(upstreamFailedResult.completion).resolves.toMatchObject({ status: 'failed' });
  });

  test('non-2xx errors are sanitized, bounded, and retain retry-after/status', async () => {
    const adapter = new ChatgptOauthAdapter();
    let consumed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { consumed++; controller.enqueue(new TextEncoder().encode('secret-429-marker')); controller.close(); },
    });
    const context = request(CHAT_COMPLETIONS_PATH, false);
    adapter.beforeRequest(context);
    const provider = new Response(body, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } });
    const result = await adapter.rawResponse({ response: provider, completion: completion() }, rawContext(context));
    const text = await result.response.text();
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get('retry-after')).toBe('7');
    expect(text).not.toContain('secret-429-marker');
    expect(text).not.toContain('429');
    expect(consumed).toBe(1);
    await expect(result.completion).resolves.toMatchObject({ status: 'failed' });
  });

  test('models use the managed upstream response and expose only real listed models', async () => {
    const adapter = new ChatgptOauthAdapter();
    const context = modelsRequest();
    adapter.beforeRequest(context);
    expect(context.url.toString()).toBe(`https://chatgpt.com${CODEX_MODELS_PATH}?client_version=${encodeURIComponent(CODEX_COMPATIBILITY_VERSION)}`);
    expect(context.method).toBe('GET');
    expect(context.body).toBeUndefined();
    expect(context.headers).toMatchObject({ accept: 'application/json', originator: 'codex_cli_rs' });

    const provider = new Response(JSON.stringify({ models: [
      { slug: 'visible', visibility: 'list', supported_in_api: true },
      { slug: 'hidden', visibility: 'hide', supported_in_api: true },
      { slug: 'not-api', visibility: 'list', supported_in_api: false },
    ] }), { headers: { 'content-type': 'application/json' } });
    const result = await adapter.rawResponse({ response: provider, completion: completion() }, rawContext(context));
    expect(await result.response.json()).toEqual({
      object: 'list', data: [{ id: 'visible', object: 'model', owned_by: 'openai' }],
    });
  });

  test('models preserve an official empty result and sanitize malformed responses', async () => {
    const empty = new ChatgptOauthAdapter();
    const emptyContext = modelsRequest();
    empty.beforeRequest(emptyContext);
    const emptyResult = await empty.rawResponse({
      response: new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } }),
      completion: completion(),
    }, rawContext(emptyContext));
    expect(await emptyResult.response.json()).toEqual({ object: 'list', data: [] });
    await expect(emptyResult.completion).resolves.toMatchObject({ status: 'completed' });

    for (const response of [
      new Response('{bad', { headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'text/plain' } }),
    ]) {
      const adapter = new ChatgptOauthAdapter();
      const context = modelsRequest();
      adapter.beforeRequest(context);
      const result = await adapter.rawResponse({ response, completion: completion() }, rawContext(context));
      expect(result.response.status).toBe(502);
      expect(await result.response.text()).not.toContain('bad');
      await expect(result.completion).resolves.toMatchObject({ status: 'failed' });
    }
  });

  test('models use the plugin compatibility version without a UI version field', () => {
    const context = modelsRequest();
    new ChatgptOauthAdapter().beforeRequest(context);
    expect(context.url.searchParams.get('client_version')).toBe(CODEX_COMPATIBILITY_VERSION);
  });

  test('cancelled body completion wins without waiting for an upstream completion', async () => {
    const adapter = new ChatgptOauthAdapter();
    const context = request(CHAT_COMPLETIONS_PATH, true);
    adapter.beforeRequest(context);
    const upstreamCompletion = new Promise<{ status: 'completed' }>(() => {});
    const source = new ReadableStream<Uint8Array>({});
    const result = await adapter.rawResponse({
      response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
      completion: upstreamCompletion,
    }, rawContext(context));
    const reader = result.response.body!.getReader();
    const pendingRead = reader.read();
    await reader.cancel('client_cancelled');
    await pendingRead.catch(() => undefined);
    const completionResult = await Promise.race([
      result.completion,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('completion timeout')), 20)),
    ]);
    expect(completionResult).toEqual({ status: 'cancelled' });
  });

  test('content-type failure drains the original body and returns no sensitive error cause', async () => {
    const adapter = new ChatgptOauthAdapter();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode('secret')); },
      cancel() { cancelled++; },
    });
    const context = request(CHAT_COMPLETIONS_PATH, false);
    adapter.beforeRequest(context);
    const result = await adapter.rawResponse({ response: new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }), completion: completion() }, rawContext(context));
    expect(await result.response.text()).not.toContain('secret');
    await expect(result.completion).resolves.toMatchObject({ status: 'failed' });
    expect(cancelled).toBe(1);
  });

  test('downstream cancellation aborts a pending reader exactly once', async () => {
    const adapter = new ChatgptOauthAdapter();
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const context = request(CHAT_COMPLETIONS_PATH, true);
    adapter.beforeRequest(context);
    const result = await adapter.rawResponse({ response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }), completion: completion() }, rawContext(context));
    const reader = result.response.body!.getReader();
    const pending = reader.read();
    await reader.cancel('client_cancelled');
    await pending.catch(() => undefined);
    expect(cancelled).toBe(1);
    await expect(result.completion).resolves.toMatchObject({ status: 'cancelled' });
  });

  test('old attempt completion cannot clear a replacement state or adapt twice', async () => {
    const adapter = new ChatgptOauthAdapter();
    const first = request(CHAT_COMPLETIONS_PATH, false);
    const second = { ...request(CHAT_COMPLETIONS_PATH, false), requestId: first.requestId };
    adapter.beforeRequest(first);
    let releaseFirst!: () => void;
    const firstCompletion = new Promise<{ status: 'completed' }>((resolve) => { releaseFirst = () => resolve({ status: 'completed' }); });
    const firstResult = await adapter.rawResponse({ response: responseStream(completionSse), completion: firstCompletion }, rawContext(first, 'old'));
    adapter.beforeRequest(second);
    const secondProvider = responseStream(completionSse);
    const secondResult = await adapter.rawResponse({ response: secondProvider, completion: completion() }, rawContext(second, 'new'));
    expect(await firstResult.response.json()).toMatchObject({ choices: expect.any(Array) });
    expect(await secondResult.response.json()).toMatchObject({ choices: expect.any(Array) });
    expect((await adapter.rawResponse({ response: secondProvider, completion: completion() }, rawContext(second, 'new'))).response).toBe(secondProvider);
    releaseFirst();
  });

  test('real default plugin registration uses raw response contract only', async () => {
    const hooks = createPluginHooks();
    const plugin = new ChatgptOauthPlugin();
    plugin.register(hooks);
    const context = request(CHAT_COMPLETIONS_PATH, true);
    const transformed = await hooks.onBeforeRequest.promise(context);
    expect(transformed.url.pathname).toBe(CODEX_RESPONSES_PATH);
    expect(hooks.onRawResponse.hasCallbacks()).toBe(true);
    expect(hooks.onStreamChunk.hasCallbacks()).toBe(false);
  });
});
