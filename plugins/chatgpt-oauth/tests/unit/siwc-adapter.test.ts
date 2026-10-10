import { ChatgptOauthAdapter } from '../helpers/shared-body-fixture';
import { describe, expect, test } from 'bun:test';
import type { MutableRequestContext, RawResponseContext } from '../../../../packages/core/src/hooks';


function request(path = '/v1/responses', body: Record<string, unknown> = { model: 'test-model', input: 'hello' }): MutableRequestContext {
  return {
    requestId: crypto.randomUUID(), clientIP: '127.0.0.1', method: path === '/v1/models' ? 'GET' : 'POST',
    originalUrl: new URL(`http://localhost${path}`), url: new URL(`https://api.openai.com${path}`),
    headers: { 'Chatgpt-Account-Id': 'legacy-id', 'User-Agent': 'codex-tui', 'Originator': 'codex-tui', 'X-Codex-Routing-Hint': 'legacy', 'Session-Id': 'legacy' }, body,
  };
}
const rawContext = (context: MutableRequestContext): RawResponseContext => ({
  method: context.method, originalUrl: context.originalUrl, clientIP: context.clientIP,
  requestId: context.requestId, attemptId: 'test-attempt', signal: new AbortController().signal,
});
const completed = () => Promise.resolve({ status: 'completed' as const });
const sse = [
  'data: {"type":"response.created","response":{"id":"test-response","created_at":1,"model":"test-model"}}\n\n',
  'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
  'data: [DONE]\n\n',
].join('');

describe('SIWC public API adapter', () => {
  test('accepts SIWC SSE without Content-Type for streaming and aggregated Responses and chat', async () => {
    for (const path of ['/v1/responses', '/v1/chat/completions']) {
      for (const stream of [true, false]) {
        const adapter = new ChatgptOauthAdapter();
        const context = request(path, { model: 'test-model', input: 'hello', messages: [{ role: 'user', content: 'hello' }], stream });
        adapter.beforeRequest(context);
        // A stream body avoids Response adding a default text/plain header.
        const response = new Response(new Blob([sse]).stream());
        expect(response.headers.get('content-type')).toBeNull();
        const result = await adapter.rawResponse({ response, completion: completed() }, rawContext(context));
        expect(result.response.status).toBe(200);
        if (stream) {
          expect(result.response.headers.get('content-type')).toBe('text/event-stream');
          expect(await result.response.text()).toContain('hello');
        } else {
          const body = await result.response.json();
          expect(path.endsWith('completions') ? body.choices[0].message.content : body.output[0].content[0].text).toBe('hello');
        }
        expect(await result.completion).toEqual({ status: 'completed' });
      }
    }
  });

  test('missing Content-Type still requires valid SSE and a terminal event', async () => {
    for (const body of ['{"secret":"not SSE"}', '<html>not SSE</html>', 'data: {"type":"response.created","response":{"id":"r"}}\n\n']) {
      for (const stream of [true, false]) {
        const adapter = new ChatgptOauthAdapter(), context = request('/v1/responses', { input: 'hello', stream });
        adapter.beforeRequest(context);
        const result = await adapter.rawResponse({ response: new Response(new Blob([body]).stream()), completion: completed() }, rawContext(context));
        try { await result.response.text(); } catch { /* streaming protocol failure */ }
        expect((await result.completion).status).toBe('failed');
      }
    }
  });

  test('still rejects explicitly incompatible content types and models without Content-Type', async () => {
    for (const [path, response] of [
      ['/v1/responses', new Response(sse, { headers: { 'content-type': 'application/json' } })],
      ['/v1/models', new Response(new Blob(['{"models":[]}']).stream())],
    ] as const) {
      const adapter = new ChatgptOauthAdapter(), context = request(path);
      adapter.beforeRequest(context);
      const result = await adapter.rawResponse({ response, completion: completed() }, rawContext(context));
      expect(result.response.status).toBe(502);
      await result.response.text();
      expect(await result.completion).toEqual({ status: 'failed', code: 'invalid_content_type' });
    }
  });

  test('flattens Chat custom grammar to Responses format and keeps Responses grammar unchanged', () => {
    const grammar = { syntax: 'lark', definition: 'start: "ok"' };
    const original = { model: 'test', messages: [], tools: [{ type: 'custom', custom: { name: 'execute', format: { type: 'grammar', grammar } } }] };
    const context = request('/v1/chat/completions', original);
    const adapter = new ChatgptOauthAdapter();
    adapter.beforeRequest(context);
    expect(context.body.tools[0]).toEqual({ type: 'custom', name: 'execute', format: { type: 'grammar', ...grammar } });
    adapter.reconcileOutboundRequest(context);
    expect(context.body.tools[0].format).toEqual({ type: 'grammar', ...grammar });
    expect(original.tools[0].custom.format.grammar).toEqual(grammar);
    expect(() => adapter.beforeRequest(request('/v1/chat/completions', { messages: [], tools: [{ type: 'custom', custom: { name: 'bad', format: { type: 'grammar', grammar: { syntax: 'invalid', definition: 'x' } } } }] }))).toThrow('grammar is invalid');
  });

  test('preserves custom and function response types in streaming and aggregated Chat responses', async () => {
    const custom = { id: 'ct_1', type: 'custom_tool_call', call_id: 'call_custom', name: 'execute', input: 'print(1)' };
    const fn = { id: 'fc_1', type: 'function_call', call_id: 'call_function', name: 'lookup', arguments: '{}' };
    const events = [
      { type: 'response.created', response: { id: 'r', model: 'test', created_at: 1 } },
      { type: 'response.output_item.added', output_index: 0, item: { ...custom, input: '' } },
      { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: 'print(' },
      { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: '1)' },
      { type: 'response.custom_tool_call_input.done', output_index: 0, input: custom.input },
      { type: 'response.output_item.done', output_index: 0, item: custom },
      // Also exercise the fallback with no preceding output_item.added event.
      { type: 'response.output_item.done', output_index: 1, item: fn },
      { type: 'response.completed', response: { status: 'completed', output: [custom, fn] } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    for (const stream of [true, false]) {
      const adapter = new ChatgptOauthAdapter();
      const context = request('/v1/chat/completions', { messages: [], model: 'test', stream });
      adapter.beforeRequest(context);
      const result = await adapter.rawResponse({ response: new Response(events, { headers: { 'content-type': 'text/event-stream' } }), completion: completed() }, rawContext(context));
      if (stream) {
        const chunks = (await result.response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
        const calls = chunks.flatMap(chunk => chunk.choices.flatMap((choice: any) => choice.delta.tool_calls ?? []));
        expect(calls.find(call => call.id === 'call_custom')).toEqual({ index: 0, id: 'call_custom', type: 'custom', custom: { name: 'execute', input: '' } });
        expect(calls.filter(call => call.index === 0).map(call => call.custom.input).join('')).toBe(custom.input);
        expect(calls.find(call => call.id === 'call_function')).toEqual({ index: 1, id: 'call_function', type: 'function', function: { name: 'lookup', arguments: '{}' } });
        expect(calls.filter(call => call.index === 0).every(call => call.function === undefined)).toBe(true);
      } else {
        const body = await result.response.json();
        expect(body.choices[0].message.tool_calls).toEqual([
          { id: 'call_custom', type: 'custom', custom: { name: 'execute', input: 'print(1)' } },
          { id: 'call_function', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ]);
        expect(body.choices[0].finish_reason).toBe('tool_calls');
      }
      expect(await result.completion).toEqual({ status: 'completed' });
    }
  });

  test('keeps Responses public, normalizes input and removes forbidden fields without modifying the caller body', () => {
    const forbidden = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user'];
    const original = { model: 'test-model', input: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }], store: true, stream: false, ...Object.fromEntries(forbidden.map(key => [key, 'unsupported'])) };
    const context = request('/v1/responses', original);
    const adapter = new ChatgptOauthAdapter();
    adapter.beforeRequest(context);
    expect(context.url.href).toBe('https://api.openai.com/v1/responses');
    expect(context.body.store).toBe(false);
    expect(context.body.stream).toBe(true);
    expect(context.body.input[0].role).toBe('developer');
    for (const field of forbidden) expect(context.body[field]).toBeUndefined();
    expect(original.store).toBe(true);
    expect(original.input[0].role).toBe('system');
    expect(context.headers['user-agent']).toBe('Bungee/5.11.0');
    expect(context.headers.originator).toBe('Bungee');
    expect(Object.keys(context.headers).some(name => /chatgpt|codex|session-id/i.test(name))).toBe(false);
    // A later transform cannot restore unsupported fields or Codex headers.
    context.body.temperature = 1;
    context.body.store = true;
    context.headers['Chatgpt-Account-Id'] = 'restored';
    adapter.reconcileOutboundRequest(context);
    expect(context.body.temperature).toBeUndefined();
    expect(context.body.store).toBe(false);
    expect(context.headers['Chatgpt-Account-Id']).toBeUndefined();
  });

  test('converts chat history and function/custom calls while keeping /v1/responses', () => {
    const context = request('/v1/chat/completions', { model: 'test-model', messages: [
      { role: 'system', content: 'rules' }, { role: 'user', content: 'hello' },
      { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }, { id: 'call-2', type: 'custom', custom: { name: 'execute', input: 'print(1)' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' }, { role: 'tool', tool_call_id: 'call-2', content: '1' },
    ], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }, { type: 'custom', custom: { name: 'execute', format: { type: 'text' } } }] });
    new ChatgptOauthAdapter().beforeRequest(context);
    expect(context.url.href).toBe('https://api.openai.com/v1/responses');
    expect(context.body.input[0].role).toBe('developer');
    expect(context.body.input.map((item: any) => item.type)).toEqual(['message', 'message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output']);
    expect(context.body.tools.map((tool: any) => tool.name)).toEqual(['lookup', 'execute']);
    expect(context.body.store).toBe(false);
  });

  test('rejects server-side history and unsupported hosted tools at both request passes', () => {
    const adapter = new ChatgptOauthAdapter();
    expect(() => adapter.beforeRequest(request('/v1/responses', { input: [], previous_response_id: 'previous' }))).toThrow('full conversation');
    expect(() => adapter.beforeRequest(request('/v1/responses', { input: { role: 'user', content: 'hello' } }))).toThrow('array');
    for (const type of ['mcp', 'tool_search', 'computer', 'computer_use_preview', 'image_generation', 'file_search', 'code_interpreter']) {
      expect(() => adapter.beforeRequest(request('/v1/responses', { input: [], tools: [{ type }] }))).toThrow('function and custom');
      expect(() => adapter.beforeRequest(request('/v1/chat/completions', { messages: [], tools: [{ type }] }))).toThrow('function and custom');
      expect(() => adapter.reconcileOutboundRequest(request('/v1/responses', { input: [], tool_choice: { type } }))).toThrow('function and custom');
    }
    expect(() => adapter.beforeRequest(request('/v1/responses', { input: [{ type: 'mcp_call' }] }))).toThrow('unsupported item');
  });

  test('does not rewrite SIWC models or backend paths to Codex', () => {
    const adapter = new ChatgptOauthAdapter();
    const context = request('/v1/models');
    adapter.beforeRequest(context);
    expect(context.url.href).toBe('https://api.openai.com/v1/models');
    expect(context.body).toBeUndefined();
    expect(context.headers.accept).toBe('application/json');
    const backend = request('/backend-api/codex/responses', { model: 'test', parallel_tool_calls: true });
    adapter.beforeRequest(backend);
    expect(backend.body).toEqual({ model: 'test', parallel_tool_calls: true });
  });

  test('lists visible SIWC models without requiring Codex supported_in_api metadata', async () => {
    const adapter = new ChatgptOauthAdapter(), context = request('/v1/models');
    adapter.beforeRequest(context);
    const result = await adapter.rawResponse({ response: Response.json({ models: [
      { slug: 'visible-model', display_name: 'Visible model', visibility: 'list' },
      { slug: 'hidden-model', display_name: 'Hidden model', visibility: 'hidden' },
    ] }), completion: completed() }, rawContext(context));
    expect(await result.response.json()).toEqual({ object: 'list', data: [{ id: 'visible-model', object: 'model', owned_by: 'openai' }] });
    expect(await result.completion).toEqual({ status: 'completed' });
  });

  test('retains bounded model responses and sanitizes malformed model envelopes', async () => {
    for (const body of [JSON.stringify({ models: [{ slug: 'bad', visibility: 1 }] }), JSON.stringify({ models: Array.from({ length: 513 }, () => ({ slug: 'x', visibility: 'list' })) }), 'x'.repeat(256 * 1024 + 1)]) {
      const adapter = new ChatgptOauthAdapter(), context = request('/v1/models');
      adapter.beforeRequest(context);
      const result = await adapter.rawResponse({ response: new Response(body, { headers: { 'content-type': 'application/json' } }), completion: completed() }, rawContext(context));
      expect(result.response.status).toBe(502);
      expect((await result.completion).status).toBe('failed');
      expect(await result.response.text()).not.toContain('bad');
    }
  });

  test('reuses terminal aggregation for nonstream Responses and chat', async () => {
    for (const path of ['/v1/responses', '/v1/chat/completions']) {
      const adapter = new ChatgptOauthAdapter(), context = request(path, { model: 'test-model', input: 'hello', messages: [{ role: 'user', content: 'hello' }], stream: false });
      adapter.beforeRequest(context);
      expect(context.body.stream).toBe(true);
      const result = await adapter.rawResponse({ response: new Response(sse, { headers: { 'content-type': 'text/event-stream' } }), completion: completed() }, rawContext(context));
      const body = await result.response.json();
      expect(path.endsWith('completions') ? body.choices[0].message.content : body.output[0].content[0].text).toBe('hello');
      expect(await result.completion).toEqual({ status: 'completed' });
    }
  });

  test('streams chat deltas and usage, then preserves terminal completion', async () => {
    const adapter = new ChatgptOauthAdapter(), context = request('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: true, stream_options: { include_usage: true } });
    adapter.beforeRequest(context);
    const result = await adapter.rawResponse({ response: new Response(sse, { headers: { 'content-type': 'text/event-stream' } }), completion: completed() }, rawContext(context));
    const text = await result.response.text();
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"total_tokens":3');
    expect(text).toContain('data: [DONE]');
    expect(await result.completion).toEqual({ status: 'completed' });
  });

  test('leaves legacy Codex behavior in its original branch', () => {
    const context = request();
    context.url = new URL('https://chatgpt.com/v1/responses');
    new ChatgptOauthAdapter().beforeRequest(context);
    expect(context.url.pathname).toBe('/backend-api/codex/responses');
    expect(context.headers['user-agent']).toContain('codex-tui');
    expect(context.headers.originator).toBe('codex-tui');
  });
});
