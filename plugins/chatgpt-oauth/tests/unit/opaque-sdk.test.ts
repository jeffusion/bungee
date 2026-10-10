import { expect, test } from 'bun:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import type { MutableRequestContext, RawResponseContext } from '../../../../packages/core/src/hooks';
import { responseBodyFixture } from '../helpers/shared-body-fixture';
import { bodyMetrics } from '../../../../packages/core/src/gateway/body-resources';
import { ChatgptOauthAdapter } from '../../server/adapter';
import ChatgptOauthPlugin from '../../server';

function request(path = '/v1/responses', stream = true): MutableRequestContext {
  return {
    method: 'POST', originalUrl: new URL(`http://localhost${path}`), url: new URL(`https://api.openai.com${path}`),
    requestId: crypto.randomUUID(), clientIP: '127.0.0.1', headers: {}, body: { model: 'test', input: [], messages: [], stream },
  };
}
function rawContext(context: MutableRequestContext, response: Response): RawResponseContext {
  const base = { ...context, attemptId: 'test', signal: new AbortController().signal };
  return { ...base, bodyHandle: responseBodyFixture(response, base).handle };
}

const completed = () => Promise.resolve({ status: 'completed' as const });
const custom = { id: 'custom-1', type: 'custom_tool_call', call_id: 'call-1', name: 'execute', input: 'print(1)' };
const payload = `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: custom })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [custom] } })}\n\ndata: [DONE]\n\n`;

test('gzip and zstd SIWC responses use host decoding and preserve custom tools', async () => {
  for (const coding of ['gzip', 'zstd']) {
    for (const stream of [true, false]) {
      const adapter = new ChatgptOauthAdapter();
      const context = request('/v1/chat/completions', stream);
      adapter.beforeRequest(context);
      const wire = coding === 'gzip' ? gzipSync(Buffer.from(payload)) : zstdCompressSync(Buffer.from(payload));
      const response = new Response(new Uint8Array(wire), { headers: { 'content-encoding': coding, 'content-length': String(wire.length), 'content-type': 'text/event-stream' } });
      const before = { ...bodyMetrics };
      const result = await adapter.rawResponse({ response, completion: completed() }, rawContext(context, response));
      expect(result.response.headers.get('content-encoding')).toBeNull();
      expect(result.response.headers.get('content-length')).toBeNull();
      if (stream) {
        expect(await result.response.text()).toContain('"type":"custom","custom":{"name":"execute","input":"print(1)"}');
      } else {
        expect((await result.response.json()).choices[0].message.tool_calls).toEqual([
          { id: 'call-1', type: 'custom', custom: { name: 'execute', input: 'print(1)' } },
        ]);
      }
      expect(await result.completion).toEqual({ status: 'completed' });
      expect(bodyMetrics.decompressions - before.decompressions).toBe(1);
      expect(bodyMetrics.sseParses - before.sseParses).toBe(1);
    }
  }
});

test('Responses serialization keeps real SSE metadata independent of JSON type', async () => {
  const adapter = new ChatgptOauthAdapter();
  const context = request();
  adapter.beforeRequest(context);
  const source = ':heartbeat\nevent: actual-wire-name\nid:\nretry: 12\ndata: {"type":"response.created","response":{"id":"r"}}\n\n'
    + 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: [DONE]\n\n';
  const response = new Response(source, { headers: { 'content-type': 'text/event-stream' } });
  const result = await adapter.rawResponse({ response, completion: completed() }, rawContext(context, response));
  const text = await result.response.text();
  expect(text).toContain(':heartbeat\nevent: actual-wire-name\nid:\nretry: 12\n');
  expect(text).not.toContain('event: response.created');
  expect(text).not.toContain('event: response.completed');
  const first = JSON.parse(text.split('\n').find(line => line.startsWith('data: {'))!.slice(6));
  expect(first).toEqual({ type: 'response.created', response: { id: 'r' } });
  expect(await result.completion).toEqual({ status: 'completed' });
});

test('an upstream failure settles an adapted stream whose body has no terminal', async () => {
  const adapter = new ChatgptOauthAdapter();
  const context = request();
  adapter.beforeRequest(context);
  const response = new Response(new ReadableStream<Uint8Array>({}), { headers: { 'content-type': 'text/event-stream' } });
  const result = await adapter.rawResponse({ response, completion: Promise.resolve({ status: 'failed', code: 'upstream_failed' }) }, rawContext(context, response));
  const timeout = setTimeout(() => { throw new Error('failed upstream did not settle completion'); }, 1000);
  try { expect(await result.completion).toEqual({ status: 'failed', code: 'upstream_failed' }); }
  finally { clearTimeout(timeout); await result.response.body!.cancel('test finished'); }
});

test('none request demand and an unadapted compressed response remain transparent', async () => {
  const plugin = new ChatgptOauthPlugin({});
  expect(plugin.bodyRequirements({ requestId: 'test', method: 'POST', url: new URL('https://api.openai.com/upload'), stage: 'selected' })).toEqual({ request: 'none' });
  const adapter = new ChatgptOauthAdapter();
  const context = request('/upload');
  adapter.beforeRequest(context);
  const wire = gzipSync(Buffer.from('opaque body'));
  const response = new Response(new Uint8Array(wire), { headers: { 'content-encoding': 'gzip' } });
  const input = { response, completion: completed() };
  const output = await adapter.rawResponse(input, { ...context, attemptId: 'test', signal: new AbortController().signal });
  expect(output).toBe(input);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(wire));
});


test('one compressed representation shares parsed frozen SSE events with an observer', async () => {
  for (const coding of ['gzip', 'zstd']) {
    const adapter = new ChatgptOauthAdapter();
    const context = request('/v1/responses', true);
    adapter.beforeRequest(context);
    const wire = coding === 'gzip' ? gzipSync(Buffer.from(payload)) : zstdCompressSync(Buffer.from(payload));
    const response = new Response(new Uint8Array(wire), { headers: { 'content-type': 'text/event-stream', 'content-encoding': coding } });
    const base = { ...context, attemptId: 'shared-observer', signal: new AbortController().signal };
    const fixture = responseBodyFixture(response, base);
    const before = { ...bodyMetrics };
    const observed = fixture.source.handle().events({ id: 'observer', mandatory: false })[Symbol.asyncIterator]();
    const first = observed.next();
    const result = await adapter.rawResponse({ response, completion: completed() }, { ...base, bodyHandle: fixture.handle });
    const text = await result.response.text();
    expect(text).toBe(payload);
    const frame = (await first).value!;
    expect(Object.isFrozen(frame.json)).toBe(true);
    expect(Object.isFrozen((frame.json as any).item)).toBe(true);
    expect(frame.json).toMatchObject({ type: 'response.output_item.done', item: custom });
    await observed.return?.();
    expect(bodyMetrics.decompressions - before.decompressions).toBe(1);
    expect(bodyMetrics.sseParses - before.sseParses).toBe(1);
    expect(bodyMetrics.jsonParses - before.jsonParses).toBe(3);
    fixture.source.dispose();
  }
});

test('models inherit the host limit and reuse one decoded JSON view', async () => {
  for (const coding of ['gzip', 'zstd']) {
    const adapter = new ChatgptOauthAdapter();
    const context = request('/v1/models', false);
    adapter.beforeRequest(context);
    const json = JSON.stringify({ models: [{ slug: 'listed', visibility: 'list', metadata: 'x'.repeat(300 * 1024) }] });
    const wire = coding === 'gzip' ? gzipSync(Buffer.from(json)) : zstdCompressSync(Buffer.from(json));
    const response = new Response(new Uint8Array(wire), { headers: { 'content-type': 'application/json', 'content-encoding': coding } });
    const base = { ...context, attemptId: 'model-json', signal: new AbortController().signal };
    const fixture = responseBodyFixture(response, base, 1024 * 1024);
    const before = { ...bodyMetrics };
    const result = await adapter.rawResponse({ response, completion: completed() }, { ...base, bodyHandle: fixture.handle });
    expect(await result.response.json()).toEqual({ object: 'list', data: [{ id: 'listed', object: 'model', owned_by: 'openai' }] });
    const cached = await fixture.handle.json({ id: 'model-observer', mandatory: false });
    expect(Object.isFrozen(cached)).toBe(true);
    expect(bodyMetrics.decompressions - before.decompressions).toBe(1);
    expect(bodyMetrics.jsonParses - before.jsonParses).toBe(1);
    fixture.source.dispose();
  }
});

test('host model limit produces a safe failure without a private adapter limit', async () => {
  const adapter = new ChatgptOauthAdapter();
  const context = request('/v1/models', false);
  adapter.beforeRequest(context);
  const response = Response.json({ models: [{ slug: 'secret-model', visibility: 'list' }] });
  const base = { ...context, attemptId: 'model-limit', signal: new AbortController().signal };
  const fixture = responseBodyFixture(response, base, 16);
  const result = await adapter.rawResponse({ response, completion: completed() }, { ...base, bodyHandle: fixture.handle });
  expect(result.response.status).toBe(502);
  expect(await result.response.text()).not.toContain('secret-model');
  expect(await result.completion).toEqual({ status: 'failed', code: 'body_limit' });
  fixture.source.dispose();
});

test('HTTP error capture deadline cancels the central reader and returns the original status', async () => {
  let cancelled = 0;
  const adapter = new ChatgptOauthAdapter();
  const context = request();
  adapter.beforeRequest(context);
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status: 429 });
  const result = await adapter.rawResponse({ response, completion: completed() }, rawContext(context, response));
  expect(result.response.status).toBe(429);
  expect(await result.completion).toEqual({ status: 'failed', code: 'upstream_http_error' });
  expect(cancelled).toBe(1);
}, 3000);

test('attempt cancellation interrupts nonstream event aggregation and releases the owner', async () => {
  let cancelled = 0;
  const adapter = new ChatgptOauthAdapter();
  const context = request('/v1/responses', false);
  adapter.beforeRequest(context);
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  const controller = new AbortController();
  const base = { ...context, attemptId: 'cancelled-aggregate', signal: controller.signal };
  const fixture = responseBodyFixture(response, base);
  const pending = adapter.rawResponse({ response, completion: new Promise(() => undefined) }, { ...base, bodyHandle: fixture.handle });
  setTimeout(() => controller.abort('attempt deadline'), 10);
  const result = await pending;
  expect(await result.completion).toEqual({ status: 'cancelled' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancelled).toBe(1);
  fixture.source.dispose();
}, 1000);
