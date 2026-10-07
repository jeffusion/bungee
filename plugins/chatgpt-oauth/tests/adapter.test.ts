import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { ensureDataPlaneSchema } from '../../../packages/core/tests/helpers/data-plane-runtime';
import { createPluginHooks, type MutableRequestContext, type RawResponseContext } from '../../../packages/core/src/hooks';
import { ScopedPluginRegistry, setScopedPluginRegistry } from '../../../packages/core/src/scoped-plugin-registry';
import { validatePluginOptions } from '../../../packages/core/src/config-storage/plugin-schema';
import { ValidationContext } from '../../../packages/core/src/config-storage/validation';
import { parsePluginManifestText } from '../../../packages/core/src/plugin-manifest-catalog';
import { setBoundControlClientProvider } from '../../../packages/core/src/config-worker/runtime-dependencies';
import { applyOutboundHeaderProfile } from '../../../packages/core/src/worker/request/credential';
import { setPluginRegistry } from '../../../packages/core/src/worker/state/plugin-manager';
import { CHAT_COMPLETIONS_PATH, CODEX_COMPATIBILITY_VERSION, CODEX_MODELS_PATH, CODEX_MODELS_USER_AGENT, CODEX_RESPONSES_PATH, CODEX_RESPONSES_USER_AGENT, MODELS_PATH, RESPONSES_PATH, ChatgptOauthAdapter } from '../server/adapter';
import { CODEX_MAX_SSE_LINE_BYTES } from '../server/codex-protocol';
import ChatgptOauthPlugin from '../server/index';
import { ModelMappingPlugin } from '../../model-mapping/server';

const responseStream = (body: string, status = 200, contentType = 'text/event-stream'): Response =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const responseWithoutContentType = (body: string, status = 200): Response => new Response(body, { status });
const originalFetch = global.fetch;

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
    decodeResponseBody: response => response.body,
    requestId: context.requestId, signal: new AbortController().signal, attemptId,
  };
}

function completion(status: 'completed' | 'failed' | 'incomplete' | 'cancelled' = 'completed') {
  return Promise.resolve(status === 'completed' ? { status } : { status, code: `upstream_${status}` });
}

describe('ChatGPT OAuth adapter', () => {
  test('streams a 20MiB Responses event beyond the old event and cumulative limits', async () => {
    const adapter = new ChatgptOauthAdapter();
    const context = request(RESPONSES_PATH, true);
    adapter.beforeRequest(context);
    const payload = 'data: ' + JSON.stringify({ type: 'response.created', response: { id: 'large', metadata: { context: 'x'.repeat(20 * 1024 * 1024) } } }) + '\n\n' + completionSse;
    const bytes = new TextEncoder().encode(payload);
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
      offset = Math.min(bytes.length, offset + 64 * 1024);
    } }, { highWaterMark: 0 });
    const result = await adapter.rawResponse({ response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }), completion: completion() }, rawContext(context));
    const reader = result.response.body!.getReader();
    let sawLargeEvent = false;
    let sawCompleted = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      sawLargeEvent ||= text.length > 20 * 1024 * 1024;
      sawCompleted ||= text.includes('response.completed');
    }
    expect(sawLargeEvent).toBe(true);
    expect(sawCompleted).toBe(true);
    await expect(result.completion).resolves.toEqual({ status: 'completed' });
  }, 30_000);

  test('does not cap cumulative SSE bytes for streaming or nonstream conversion', async () => {
    const event = new TextEncoder().encode('data: ' + JSON.stringify({ type: 'response.created', response: { metadata: { context: 'x'.repeat(8 * 1024 * 1024) } } }) + '\n\n');
    for (const streaming of [true, false]) {
      const adapter = new ChatgptOauthAdapter();
      const context = request(RESPONSES_PATH, streaming);
      adapter.beforeRequest(context);
      let emitted = 0;
      const source = new ReadableStream<Uint8Array>({ pull(controller) {
        if (emitted++ < 9) controller.enqueue(event);
        else { controller.enqueue(new TextEncoder().encode(completionSse)); controller.close(); }
      } }, { highWaterMark: 0 });
      const result = await adapter.rawResponse({ response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }), completion: completion() }, rawContext(context));
      expect(result.response.status).toBe(200);
      const reader = result.response.body!.getReader();
      let receivedBytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
      }
      expect(event.byteLength * 9).toBeGreaterThan(64 * 1024 * 1024);
      if (streaming) expect(receivedBytes).toBeGreaterThan(64 * 1024 * 1024);
      await expect(result.completion).resolves.toEqual({ status: 'completed' });
    }
  }, 30_000);

  test('rejects a single SSE line over 50MiB and reports the HTTP-200 stream failure', async () => {
    const adapter = new ChatgptOauthAdapter();
    const context = request(RESPONSES_PATH, true);
    adapter.beforeRequest(context);
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(':'.repeat(CODEX_MAX_SSE_LINE_BYTES + 1)));
      controller.close();
    } });
    const result = await adapter.rawResponse({ response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }), completion: completion() }, rawContext(context));
    expect(result.response.status).toBe(200);
    await expect(result.response.text()).rejects.toMatchObject({ kind: 'body_limit', message: 'Codex SSE line exceeded the size limit' });
    await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'body_limit' });
  }, 30_000);

  test('manifest persists the required accountRef and compiler validation matches the control boundary', async () => {
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
    expect(manifest.engines.bungee).toBe('^4.3.0 || ^5.0.0');
    expect(manifest.configSchema.map((field) => field.name)).toEqual(['accountRef']);
    for (const asset of ['AccountsPage.svelte', 'account-model.js']) {
      expect(Bun.file(new URL(`../ui/${asset}`, import.meta.url)).size).toBeGreaterThan(0);
    }
    for (const asset of ['index.html', 'accounts.css', 'accounts.js']) expect(await Bun.file(new URL(`../ui/${asset}`, import.meta.url)).exists()).toBe(false);
    expect(manifest.builtin).toBe(true);
    expect(manifest.uiExtensionMode).toBe('native-static');
    expect(manifest.capabilities).toContain('nativeWidgetsStatic');
    expect(manifest.capabilities).not.toContain('sandboxUiExtension');
    expect(manifest.contributes?.nativeSettingsComponent).toBe('ChatgptAccountsPage');
    expect(manifest.ui?.components).toContainEqual({ name: 'ChatgptAccountsPage', entry: 'ui/AccountsPage.svelte' });
    expect(manifest.contributes?.settings).toBe('/accounts');
    expect(manifest.contributes?.upstreamSources?.[0]?.credentialPolicy.allowedHeaderNames)
      .toEqual(['Authorization', 'Chatgpt-Account-Id']);
  });

  test('adapts Chat Completions and native Responses requests independently', () => {
    const adapter = new ChatgptOauthAdapter();
    const chat = request(CHAT_COMPLETIONS_PATH, true, { stream_options: { include_usage: true } });
    adapter.beforeRequest(chat);
    expect(chat.url.pathname).toBe(CODEX_RESPONSES_PATH);
    expect(chat.body).toMatchObject({ stream: true, store: false, input: [{ role: 'user' }] });
    expect(chat.headers).toMatchObject({
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'user-agent': CODEX_RESPONSES_USER_AGENT,
      originator: 'codex-tui',
    });

    const native = request(RESPONSES_PATH, false, { input: 'hi', tools: [{ type: 'web_search_preview' }] });
    adapter.beforeRequest(native);
    expect(native.url.pathname).toBe(CODEX_RESPONSES_PATH);
    expect(native.headers).toMatchObject({
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'user-agent': CODEX_RESPONSES_USER_AGENT,
      originator: 'codex-tui',
    });
    expect(native.body).toMatchObject({ stream: true, store: false, input: [{ content: [{ type: 'input_text', text: 'hi' }] }] });
    expect(native.body.instructions).toBe('');
    expect(native.body).toMatchObject({ tools: [{ type: 'web_search' }] });
    expect(native.body).not.toMatchObject({ messages: expect.anything() });

    const codexNative = request(CODEX_RESPONSES_PATH, true, { input: 'hi' });
    adapter.beforeRequest(codexNative);
    expect(codexNative.body).toMatchObject({ input: 'hi' });
  });

  test('Lite header and metadata force serial tool calls across all request entry points', () => {
    const adapter = new ChatgptOauthAdapter();
    const paths = [CHAT_COMPLETIONS_PATH, RESPONSES_PATH, CODEX_RESPONSES_PATH];
    for (const path of paths) {
      for (const [headerName, headerValue] of [
        ['X-OpenAI-Internal-Codex-Responses-Lite', 'TRUE'],
        ['x-openai-internal-codex-responses-lite', ' true '],
      ]) {
        const context = request(path, true, { parallel_tool_calls: true });
        context.headers = { [headerName]: headerValue };
        const originalBody = context.body;
        adapter.beforeRequest(context);
        expect(context.body.parallel_tool_calls).toBe(false);
        expect(context.headers[headerName]).toBe(headerValue);
        if (path === CODEX_RESPONSES_PATH) {
          expect(originalBody.parallel_tool_calls).toBe(true);
        }
      }
    }

    for (const path of paths) {
      const context = request(path, true, {
        parallel_tool_calls: true,
        client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: ' True ' },
      });
      adapter.beforeRequest(context);
      expect(context.body.parallel_tool_calls).toBe(false);
      expect(context.body.client_metadata.ws_request_header_x_openai_internal_codex_responses_lite).toBe(' True ');
    }

    const metadataFalse = request(RESPONSES_PATH, true, {
      parallel_tool_calls: false,
      client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: false },
    });
    adapter.beforeRequest(metadataFalse);
    expect(metadataFalse.body.parallel_tool_calls).toBe(true);

    const nonLiteNative = request(CODEX_RESPONSES_PATH, true, { parallel_tool_calls: true });
    const originalNativeBody = nonLiteNative.body;
    adapter.beforeRequest(nonLiteNative);
    expect(nonLiteNative.body).toBe(originalNativeBody);
    expect(nonLiteNative.body.parallel_tool_calls).toBe(true);
    expect(nonLiteNative.headers['x-openai-internal-codex-responses-lite']).toBeUndefined();
  });

  test('Lite reconciliation follows the current later stage-200 hook and retains its header in the profile', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const profile = manifest.contributes.upstreamSources[0].credentialPolicy.allowedRequests
      .find((item: any) => item.pathname === CODEX_RESPONSES_PATH).outboundHeaders;
    for (const path of [CHAT_COMPLETIONS_PATH, RESPONSES_PATH, CODEX_RESPONSES_PATH]) {
      const hooks = createPluginHooks();
      new ChatgptOauthPlugin({ accountRef: 'test-account' }).register(hooks);
      hooks.onBeforeRequest.tap({ name: 'later-body-rewriter', stage: 200 }, (context) => {
        if (context.url.pathname === CODEX_RESPONSES_PATH) context.body.parallel_tool_calls = true;
        return context;
      });
      const context = request(path, true, { parallel_tool_calls: true, input: 'lite request' });
      context.headers = { 'X-OpenAI-Internal-Codex-Responses-Lite': ' true ' };

      const outbound = await hooks.onBeforeRequest.promise(context);
      const outboundHeaders = applyOutboundHeaderProfile(new Headers(outbound.headers), profile);
      expect(outbound.body.parallel_tool_calls).toBe(false);
      expect(outboundHeaders.get('x-openai-internal-codex-responses-lite')).toBe('true');
    }
  });

  test('sets a fresh routing hint from the final Responses body for both entry points', () => {
    const adapter = new ChatgptOauthAdapter();
    const chat = request(CHAT_COMPLETIONS_PATH, true, { model: 'chat-model', service_tier: 'priority' });
    chat.headers = { 'X-Codex-Routing-Hint': 'stale=untrusted', 'x-codex-routing-hint': 'also-stale' };
    adapter.beforeRequest(chat);
    expect(chat.body.model).toBe('chat-model');
    expect(chat.body.service_tier).toBe('priority');
    expect(chat.headers['x-codex-routing-hint']).toBe('model=chat-model;tier=priority');
    expect(Object.keys(chat.headers).filter((key) => key.toLowerCase() === 'x-codex-routing-hint')).toEqual(['x-codex-routing-hint']);

    const responses = request(RESPONSES_PATH, false, { model: 'responses-model', service_tier: 'priority' });
    responses.headers = { 'X-Codex-Routing-Hint': 'model=attacker-model' };
    adapter.beforeRequest(responses);
    expect(responses.body.model).toBe('responses-model');
    expect(responses.headers['x-codex-routing-hint']).toBe('model=responses-model;tier=priority');

    const noTier = request(RESPONSES_PATH, false, { model: 'tierless-model', service_tier: 'auto' });
    adapter.beforeRequest(noTier);
    expect(noTier.body.service_tier).toBeUndefined();
    expect(noTier.headers['x-codex-routing-hint']).toBe('model=tierless-model');
  });

  test('removes stale hints when the final model is missing or unsafe', () => {
    for (const model of [undefined, 'bad\r\nInjected: yes', 'bad\u0000model']) {
      const context = request(RESPONSES_PATH, false, { model });
      context.headers = { 'X-Codex-Routing-Hint': 'stale' };
      new ChatgptOauthAdapter().beforeRequest(context);
      expect(Object.keys(context.headers).some((key) => key.toLowerCase() === 'x-codex-routing-hint')).toBe(false);
    }
  });

  test('sanitizes native Codex Responses hints without changing its body, URL, or other headers', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const profile = manifest.contributes.upstreamSources[0].credentialPolicy.allowedRequests
      .find((item: any) => item.pathname === CODEX_RESPONSES_PATH).outboundHeaders;
    const context = request(CODEX_RESPONSES_PATH, true, {
      model: 'native-model', service_tier: 'auto', input: 'unchanged',
    });
    context.headers = {
      'X-Codex-Routing-Hint': 'model=stale-one',
      'x-codex-routing-hint': 'model=stale-two;tier=priority',
      'X-Trace-Id': 'trace-1',
      Accept: 'application/json',
    };
    const originalUrl = context.url.href;
    const originalBody = context.body;

    expect(new ChatgptOauthAdapter().beforeRequest(context)).toBe(context);
    expect(context.url.href).toBe(originalUrl);
    expect(context.body).toBe(originalBody);
    expect(context.body).toEqual({ model: 'native-model', stream: true, service_tier: 'auto', input: 'unchanged' });
    expect(context.headers['X-Trace-Id']).toBe('trace-1');
    expect(context.headers.Accept).toBe('application/json');
    expect(Object.keys(context.headers).filter((key) => key.toLowerCase() === 'x-codex-routing-hint'))
      .toEqual(['x-codex-routing-hint']);
    expect(context.headers['x-codex-routing-hint']).toBe('model=native-model');

    const finalHeaders = applyOutboundHeaderProfile(new Headers(context.headers), profile);
    expect(finalHeaders.get('user-agent')).toBe(CODEX_RESPONSES_USER_AGENT);
    expect(finalHeaders.get('x-codex-routing-hint')).toBe('model=native-model');

    for (const body of [
      { model: 'bad\r\nInjected: yes', service_tier: 'priority' },
      { model: undefined, service_tier: 'priority' },
    ]) {
      const invalid = request(CODEX_RESPONSES_PATH, true, body);
      invalid.headers = { 'X-Codex-Routing-Hint': 'model=stale;tier=priority' };
      new ChatgptOauthAdapter().beforeRequest(invalid);
      expect(Object.keys(invalid.headers).some((key) => key.toLowerCase() === 'x-codex-routing-hint')).toBe(false);
      expect(applyOutboundHeaderProfile(new Headers(invalid.headers), profile).has('x-codex-routing-hint')).toBe(false);
    }
  });

  test('late routing-hint tap tracks model mapping after the OAuth conversion tap', async () => {
    const hooks = createPluginHooks();
    new ChatgptOauthPlugin({ accountRef: 'test-account' }).register(hooks);
    new ModelMappingPlugin({ modelMappings: { 'client-model': 'mapped-model' } }).register(hooks);
    const context = request(CHAT_COMPLETIONS_PATH, true, {
      model: 'client-model', service_tier: 'priority',
    });
    context.headers = { 'X-Codex-Routing-Hint': 'model=malicious-client;tier=priority' };

    const result = await hooks.onBeforeRequest.promise(context);

    expect(result.url.pathname).toBe(CODEX_RESPONSES_PATH);
    expect(result.body.model).toBe('mapped-model');
    expect(result.body.service_tier).toBe('priority');
    expect(result.headers['x-codex-routing-hint']).toBe('model=mapped-model;tier=priority');
    expect(Object.keys(result.headers).filter((key) => key.toLowerCase() === 'x-codex-routing-hint'))
      .toEqual(['x-codex-routing-hint']);

    const native = request(CODEX_RESPONSES_PATH, true, {
      model: 'client-model', service_tier: 'priority', input: 'native-input',
    });
    native.headers = { 'X-Codex-Routing-Hint': 'model=malicious-native;tier=priority' };
    const nativeResult = await hooks.onBeforeRequest.promise(native);
    expect(nativeResult.url.pathname).toBe(CODEX_RESPONSES_PATH);
    expect(nativeResult.body).toMatchObject({ model: 'mapped-model', service_tier: 'priority', input: 'native-input' });
    expect(nativeResult.headers['x-codex-routing-hint']).toBe('model=mapped-model;tier=priority');
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

  test('allows missing Content-Type only for ChatGPT Codex Responses SSE', async () => {
    const nonStream = request(RESPONSES_PATH, false);
    const adapter = new ChatgptOauthAdapter();
    adapter.beforeRequest(nonStream);
    const nonStreamResult = await adapter.rawResponse({
      response: responseWithoutContentType(completionSse), completion: completion(),
    }, rawContext(nonStream));
    expect(nonStreamResult.response.status).toBe(200);
    expect(await nonStreamResult.response.json()).toMatchObject({ status: 'completed' });
    await expect(nonStreamResult.completion).resolves.toMatchObject({ status: 'completed' });

    const stream = request(RESPONSES_PATH, true);
    adapter.beforeRequest(stream);
    const streamResult = await adapter.rawResponse({
      response: responseWithoutContentType(completionSse), completion: completion(),
    }, rawContext(stream));
    expect(streamResult.response.status).toBe(200);
    expect(streamResult.response.headers.get('content-type')).toBe('text/event-stream');
    const streamBody = await streamResult.response.text();
    expect(streamBody).toContain('response.created');
    expect(streamBody).toContain('response.completed');
    expect(streamBody).toContain('[DONE]');
    await expect(streamResult.completion).resolves.toMatchObject({ status: 'completed' });
  });

  test('missing Content-Type still requires valid SSE and does not leak malformed bodies', async () => {
    const invalidBody = 'data: {bad-json}\n\n';
    const adapter = new ChatgptOauthAdapter();

    const nonStream = request(RESPONSES_PATH, false);
    adapter.beforeRequest(nonStream);
    const nonStreamResult = await adapter.rawResponse({
      response: responseWithoutContentType(invalidBody), completion: completion(),
    }, rawContext(nonStream));
    expect(nonStreamResult.response.status).toBe(502);
    expect(await nonStreamResult.response.text()).not.toContain('bad-json');
    await expect(nonStreamResult.completion).resolves.toEqual({ status: 'failed', code: 'invalid_sse' });

    const stream = request(RESPONSES_PATH, true);
    adapter.beforeRequest(stream);
    const streamResult = await adapter.rawResponse({
      response: responseWithoutContentType(invalidBody), completion: completion(),
    }, rawContext(stream));
    await expect(streamResult.response.text()).rejects.toBeDefined();
    await expect(streamResult.completion).resolves.toEqual({ status: 'failed', code: 'invalid_sse' });
  });

  test('rejects explicit non-SSE Content-Type values and drains the upstream body', async () => {
    for (const contentType of ['application/json', 'text/plain', '', 'text/event-streamish']) {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads++;
          controller.enqueue(new TextEncoder().encode('secret-invalid-content-type'));
          controller.close();
        },
      });
      const context = request(RESPONSES_PATH, false);
      const adapter = new ChatgptOauthAdapter();
      adapter.beforeRequest(context);
      const result = await adapter.rawResponse({
        response: new Response(body, { headers: { 'content-type': contentType } }), completion: completion(),
      }, rawContext(context));
      expect(result.response.status).toBe(502);
      expect(await result.response.text()).not.toContain('secret-invalid-content-type');
      await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'invalid_content_type' });
      expect(reads).toBe(1);
    }
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
    for (const headers of [
      { 'content-type': 'application/json', 'retry-after': '7' },
      { 'retry-after': '7' },
    ] as Record<string, string>[]) {
      const adapter = new ChatgptOauthAdapter();
      let consumed = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { consumed++; controller.enqueue(new TextEncoder().encode('secret-429-marker')); controller.close(); },
      });
      const context = request(CHAT_COMPLETIONS_PATH, false);
      adapter.beforeRequest(context);
      const provider = new Response(body, { status: 429, headers });
      const result = await adapter.rawResponse({ response: provider, completion: completion() }, rawContext(context));
      const text = await result.response.text();
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get('retry-after')).toBe('7');
      expect(text).not.toContain('secret-429-marker');
      expect(text).not.toContain('429');
      expect(consumed).toBe(1);
      await expect(result.completion).resolves.toMatchObject({ status: 'failed' });
    }
  });

  test('models use the managed upstream response and expose only real listed models', async () => {
    const adapter = new ChatgptOauthAdapter();
    const context = modelsRequest();
    adapter.beforeRequest(context);
    expect(context.url.toString()).toBe(`https://chatgpt.com${CODEX_MODELS_PATH}?client_version=${encodeURIComponent(CODEX_COMPATIBILITY_VERSION)}`);
    expect(context.method).toBe('GET');
    expect(context.body).toBeUndefined();
    expect(context.headers).toMatchObject({ accept: 'application/json', 'user-agent': CODEX_MODELS_USER_AGENT, originator: 'codex_cli_rs' });
    expect(context.headers['x-codex-routing-hint']).toBeUndefined();

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

  test('models without Content-Type remain invalid', async () => {
    const adapter = new ChatgptOauthAdapter();
    const context = modelsRequest();
    adapter.beforeRequest(context);
    const result = await adapter.rawResponse({
      response: responseWithoutContentType(JSON.stringify({ models: [] })), completion: completion(),
    }, rawContext(context));
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).not.toContain('models');
    await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'invalid_content_type' });
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

  test('applies the session intersection without inventing a session', () => {
    const explicit = request(RESPONSES_PATH, false, { input: 'hi', prompt_cache_key: 'derived-session' });
    explicit.headers = { 'Session-Id': 'explicit-session', 'User-Agent': 'attacker', Originator: 'attacker' };
    new ChatgptOauthAdapter().beforeRequest(explicit);
    expect(explicit.headers['session-id']).toBe('explicit-session');
    expect(explicit.body.prompt_cache_key).toBe('derived-session');
    expect(explicit.headers['user-agent']).toBe(CODEX_RESPONSES_USER_AGENT);
    expect(explicit.headers.originator).toBe('codex-tui');

    const derived = request(CHAT_COMPLETIONS_PATH, true, { prompt_cache_key: 'chat-session' });
    new ChatgptOauthAdapter().beforeRequest(derived);
    expect(derived.body.prompt_cache_key).toBe('chat-session');
    expect(derived.headers['session-id']).toBe('chat-session');

    const absent = request(RESPONSES_PATH, false, { prompt_cache_key: '\r\ninvalid' });
    new ChatgptOauthAdapter().beforeRequest(absent);
    expect(absent.headers['session-id']).toBeUndefined();
    expect(absent.body.prompt_cache_key).toBe('\r\ninvalid');

    const none = request(RESPONSES_PATH, false);
    new ChatgptOauthAdapter().beforeRequest(none);
    expect(none.headers['session-id']).toBeUndefined();
  });

  test('manifest profile keeps the Responses UA separate from the Models compatibility version', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const requests = manifest.contributes.upstreamSources[0].credentialPolicy.allowedRequests;
    const models = requests.find((item: any) => item.pathname === CODEX_MODELS_PATH).outboundHeaders;
    const responses = requests.find((item: any) => item.pathname === CODEX_RESPONSES_PATH).outboundHeaders;
    expect(models.passthrough).toEqual([]);
    expect(responses.passthrough).toEqual([
      'Version', 'X-Codex-Beta-Features', 'X-Codex-Turn-Metadata', 'X-Client-Request-Id',
      'X-Codex-Window-Id', 'Thread-Id', 'Session-Id', 'X-Codex-Routing-Hint',
      'X-OpenAI-Internal-Codex-Responses-Lite',
    ]);
    expect(models.set).toEqual({ Accept: 'application/json', 'User-Agent': CODEX_MODELS_USER_AGENT, Originator: 'codex_cli_rs' });
    expect(responses.set).toEqual({
      Accept: 'text/event-stream', 'Content-Type': 'application/json',
      'User-Agent': CODEX_RESPONSES_USER_AGENT,
      Originator: 'codex-tui',
    });
    expect(models.set['User-Agent']).toContain(`codex_cli_rs/${CODEX_COMPATIBILITY_VERSION}`);
  });

  test('manifest outbound profile preserves the adapter routing hint and overrides its UA', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const responsePolicy = manifest.contributes.upstreamSources[0].credentialPolicy.allowedRequests
      .find((item: any) => item.pathname === CODEX_RESPONSES_PATH);
    const profile = responsePolicy.outboundHeaders;
    expect(profile.passthrough).toContain('X-Codex-Routing-Hint');

    const context = request(RESPONSES_PATH, false, { model: 'final-model', service_tier: 'priority' });
    context.headers = { 'X-Codex-Routing-Hint': 'model=stale-client-model' };
    const adapted = new ChatgptOauthAdapter().beforeRequest(context);
    const finalHeaders = applyOutboundHeaderProfile(new Headers(adapted.headers), profile);

    expect(finalHeaders.get('user-agent')).toBe(CODEX_RESPONSES_USER_AGENT);
    expect(finalHeaders.get('x-codex-routing-hint')).toBe('model=final-model;tier=priority');
    expect(finalHeaders.get('x-codex-routing-hint')).not.toContain('stale-client-model');
  });

  test('missing Content-Type is not permitted for another origin or by a stale attempt state', async () => {
    const adapter = new ChatgptOauthAdapter();
    const allowed = { ...request(RESPONSES_PATH, false), requestId: 'reused-request' };
    adapter.beforeRequest(allowed);

    const denied = { ...request(RESPONSES_PATH, false), requestId: allowed.requestId };
    denied.url = new URL(`https://other.example${RESPONSES_PATH}`);
    adapter.beforeRequest(denied);
    const result = await adapter.rawResponse({
      response: responseWithoutContentType(completionSse), completion: completion(),
    }, rawContext(denied));
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).not.toContain('response.completed');
    await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'invalid_content_type' });
  });

  test('preserves a validated Responses terminal when its reader is cancelled before EOF', async () => {
    for (const terminal of ['completed', 'incomplete'] as const) {
      const adapter = new ChatgptOauthAdapter();
      const context = request(RESPONSES_PATH, true);
      adapter.beforeRequest(context);
      const source = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: `response.${terminal}`, response: {
          status: terminal, output: [], ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        } })}\n\n`));
      } });
      const result = await adapter.rawResponse({ response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }), completion: completion() }, rawContext(context));
      const reader = result.response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(`response.${terminal}`);
      await reader.cancel('client stops after terminal');
      await expect(result.completion).resolves.toMatchObject({ status: terminal });
    }
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

  for (const routeId of [RESPONSES_PATH, CHAT_COMPLETIONS_PATH]) {
    for (const terminal of ['completed', 'incomplete'] as const) {
      test(`real adapter and handler preserve ${terminal} when ${routeId} is cancelled after terminal`, async () => {
        await ensureDataPlaneSchema();
        const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
          import('../../../packages/core/src/worker/request/handler'),
          import('../../../packages/core/src/worker/state/runtime-state'),
          import('../../../packages/core/src/logger/access-log-writer'),
        ]);
        const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../', import.meta.url)));
        await registry.createInstance({ type: 'upstream', routeId, upstreamId: 'primary' },
          { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any);
        setScopedPluginRegistry(registry);
        const terminalFrame = `data: ${JSON.stringify({ type: `response.${terminal}`, response: {
          status: terminal, output: [], ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        } })}\n\n`;
        global.fetch = (async () => new Response(terminalFrame + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch;
        const config = {
          services: [{ name: 'terminal', failover: { enabled: true, retry_on: [503] },
            endpoints: [{ id: 'primary', target: 'https://chatgpt.com' }] }],
          routes: [{ path: routeId, service: 'terminal' }],
        } as any;
        runtime.initializeRuntimeState(config);
        try {
          const controller = new AbortController();
          const response = await handleRequest(new Request(`http://localhost${routeId}`, {
            method: 'POST', signal: controller.signal,
            body: JSON.stringify({ model: 'codex', stream: true,
              ...(routeId === RESPONSES_PATH ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }) }),
            headers: { 'content-type': 'application/json' },
          }), config);
          const reader = response.body!.getReader();
          let received = '';
          const decoder = new TextDecoder();
          const marker = routeId === RESPONSES_PATH ? `response.${terminal}` : '[DONE]';
          while (!received.includes(marker)) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('missing terminal');
            received += decoder.decode(chunk.value, { stream: true });
          }
          controller.abort('closed after terminal');
          await reader.cancel('closed after terminal');
          await accessLogWriter.flush();
          const row = accessLogWriter.getDatabase().query(
            'SELECT success, protocol_outcome FROM access_logs WHERE path = ? ORDER BY id DESC LIMIT 1',
          ).get(routeId);
          expect(row).toEqual({ success: terminal === 'completed' ? 1 : 0, protocol_outcome: terminal });
          expect(runtime.getActiveRequestCount('terminal', 'primary')).toBe(0);
        } finally {
          accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE path = ?').run(routeId);
          runtime.runtimeState.clear();
          setScopedPluginRegistry(null);
          await registry.destroy();
          global.fetch = originalFetch;
        }
      });
    }
  }

  test('real adapter and handler preserve a safe upstream 400 without failover or health failure', async () => {
    await ensureDataPlaneSchema();
    const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
      import('../../../packages/core/src/worker/request/handler'),
      import('../../../packages/core/src/worker/state/runtime-state'),
      import('../../../packages/core/src/logger/access-log-writer'),
    ]);
    const routeId = CHAT_COMPLETIONS_PATH;
    const pluginManifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
    expect(await Bun.file(pluginManifestPath).exists()).toBe(true);
    const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../', import.meta.url)));
    await registry.createInstance(
      { type: 'upstream', routeId, upstreamId: 'primary' },
      { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any,
    );
    setScopedPluginRegistry(registry);
    let fetchCount = 0;
    let originalUpstreamResponse: Response | undefined;
    global.fetch = (async () => {
      fetchCount++;
      originalUpstreamResponse = new Response('upstream-secret', { status: 400, headers: { 'content-type': 'application/json' } });
      return originalUpstreamResponse;
    }) as unknown as typeof fetch;

    const config = {
      services: [{
        name: 'chatgpt-integration-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          { id: 'primary', target: 'https://chatgpt.com', priority: 0 },
          { id: 'secondary', target: 'https://fallback.example.test', priority: 1 },
        ],
      }],
      routes: [{ path: routeId, service: 'chatgpt-integration-service' }],
    } as any;
    runtime.initializeRuntimeState(config);

    try {
      const response = await handleRequest(new Request(`http://localhost${routeId}`, {
        method: 'POST',
        body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'hello' }] }),
        headers: { 'content-type': 'application/json' },
      }), config);
      const body = await response.text();
      await accessLogWriter.flush();
      const row = accessLogWriter.getDatabase().prepare(
        'SELECT status, success, protocol_outcome, protocol_code FROM access_logs WHERE path = ? ORDER BY timestamp DESC LIMIT 1',
      ).get(routeId) as { status: number; success: number; protocol_outcome: string; protocol_code: string } | null;

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(body).not.toContain('upstream-secret');
      expect(originalUpstreamResponse?.bodyUsed).toBe(true);
      expect(fetchCount).toBe(1);
      expect(runtime.runtimeState.get('chatgpt-integration-service')?.upstreams).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'primary', status: 'HEALTHY', consecutive_failures: 0 }),
      ]));
      expect(row).toEqual({ status: 400, success: 0, protocol_outcome: 'failed', protocol_code: 'upstream_http_error' });
      accessLogWriter.getDatabase().prepare('DELETE FROM access_logs WHERE path = ?').run(routeId);
    } finally {
      runtime.runtimeState.clear();
      setScopedPluginRegistry(null);
      await registry.destroy();
      global.fetch = originalFetch;
    }
  });

  test('real managed ChatGPT 401 rejects the lease once and returns a safe failed response', async () => {
    await ensureDataPlaneSchema();
    const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
      import('../../../packages/core/src/worker/request/handler'),
      import('../../../packages/core/src/worker/state/runtime-state'),
      import('../../../packages/core/src/logger/access-log-writer'),
    ]);
    const routeId = CHAT_COMPLETIONS_PATH;
    const endpointId = 'managed-primary';
    const bindingId = 'managed-binding';
    const pluginManifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
    expect(await Bun.file(pluginManifestPath).exists()).toBe(true);
    const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../', import.meta.url)));
    await registry.createInstance(
      { type: 'upstream', routeId, upstreamId: endpointId },
      { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any,
    );
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    setPluginRegistry({
      getPluginStateSnapshot: () => ({
        pluginName: 'chatgpt-oauth', discovery: 'discovered', validation: 'validated',
        persistedEnabled: 'enabled', manifest,
      }),
    } as any);
    const controlCalls: Array<{ method: string; attempt?: { revision: number; endpointId: string; attemptId: string } }> = [];
    setBoundControlClientProvider((_binding, attempt) => ({
      call: async <T>(method: string): Promise<T> => {
        controlCalls.push({ method, attempt: attempt as typeof controlCalls[number]['attempt'] });
        if (method === 'getCredential') {
          return {
            version: 7,
            expiresAt: Date.now() + 10_000,
            headers: { authorization: 'Bearer managed-secret', 'chatgpt-account-id': 'managed-account' },
          } as T;
        }
        return true as T;
      },
    }));
    setScopedPluginRegistry(registry);
    let originalUpstreamResponse: Response | undefined;
    let fetchCount = 0;
    global.fetch = (async () => {
      fetchCount++;
      originalUpstreamResponse = new Response(JSON.stringify({ error: {
        code: 'invalid_token', type: 'authentication_error',
        message: 'Lease rejected: managed-secret managed-account', private: 'managed-upstream-secret',
      } }), { status: 401, headers: { 'content-type': 'application/json' } });
      return originalUpstreamResponse;
    }) as unknown as typeof fetch;
    const config = {
      services: [{
        name: 'managed-chatgpt-401',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{
          id: endpointId,
          target: 'https://chatgpt.com',
          priority: 0,
          managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId },
          plugins: [{ id: bindingId, name: 'chatgpt-oauth', options: { accountRef: 'integration-account' }, enabled: true }],
        }, {
          id: 'managed-secondary', target: 'https://fallback.example.test', priority: 1,
        }],
      }],
      routes: [{ path: routeId, service: 'managed-chatgpt-401' }],
    } as any;
    runtime.initializeRuntimeState(config);

    try {
      const response = await handleRequest(new Request(`http://localhost${routeId}`, {
        method: 'POST',
        body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'hello' }] }),
        headers: { 'content-type': 'application/json' },
      }), config, { servingRevision: 26 });
      const body = await response.text();
      await accessLogWriter.flush();
      const row = accessLogWriter.getDatabase().prepare(
        'SELECT status, success, protocol_outcome, protocol_code FROM access_logs WHERE path = ? ORDER BY timestamp DESC LIMIT 1',
      ).get(routeId) as { status: number; success: number; protocol_outcome: string; protocol_code: string } | null;
      const selected = runtime.runtimeState.get('managed-chatgpt-401')?.upstreams[0];

      expect(response.status).toBe(401);
      expect(body).not.toContain('managed-upstream-secret');
      expect(body).not.toContain('managed-secret');
      expect(body).not.toContain('managed-account');
      expect(body).toContain('invalid_token');
      expect(body).toContain('Lease rejected');
      expect(originalUpstreamResponse?.bodyUsed).toBe(true);
      expect(fetchCount).toBe(1);
      expect(controlCalls.map(({ method }) => method)).toEqual(['getCredential', 'rejectAccess']);
      expect(controlCalls[0]?.attempt).toMatchObject({ revision: 26, endpointId, attemptId: controlCalls[1]?.attempt?.attemptId });
      expect(selected).toMatchObject({ status: 'HEALTHY', consecutive_failures: 1 });
      expect(row).toEqual({ status: 401, success: 0, protocol_outcome: 'failed', protocol_code: 'upstream_http_error' });
      accessLogWriter.getDatabase().prepare('DELETE FROM access_logs WHERE path = ?').run(routeId);
    } finally {
      runtime.runtimeState.clear();
      setScopedPluginRegistry(null);
      setPluginRegistry(null);
      setBoundControlClientProvider(null);
      await registry.destroy();
      global.fetch = originalFetch;
    }
  });
});
