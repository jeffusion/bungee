import { expect, test } from 'bun:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import type { MutableRequestContext, RawResponseContext } from '../../../packages/core/src/hooks';
import { decodeStream } from '../../../packages/core/src/worker/request/body-source';
import { ChatgptOauthAdapter } from '../server/adapter';
import ChatgptOauthPlugin from '../server';

function request(path = '/v1/responses', stream = true): MutableRequestContext {
  return {
    method: 'POST', originalUrl: new URL(`http://localhost${path}`), url: new URL(`https://api.openai.com${path}`),
    requestId: crypto.randomUUID(), clientIP: '127.0.0.1', headers: {}, body: { model: 'test', input: [], messages: [], stream },
  };
}
function rawContext(context: MutableRequestContext, decode: RawResponseContext['decodeResponseBody']): RawResponseContext {
  return { ...context, attemptId: 'test', signal: new AbortController().signal, decodeResponseBody: decode };
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
      const response = new Response(wire, { headers: { 'content-encoding': coding, 'content-length': String(wire.length), 'content-type': 'text/event-stream' } });
      let calls = 0;
      const result = await adapter.rawResponse({ response, completion: completed() }, rawContext(context, source => {
        expect(source).toBe(response);
        calls++;
        return decodeStream(source.body!, coding, 1024 * 1024);
      }));
      expect(calls).toBe(1);
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
    }
  }
});

test('Responses serialization keeps real SSE metadata independent of JSON type', async () => {
  const adapter = new ChatgptOauthAdapter();
  const context = request();
  adapter.beforeRequest(context);
  const source = ':heartbeat\nevent: actual-wire-name\nid:\nretry: 12\ndata: {"type":"response.created","response":{"id":"r"}}\n\n'
    + 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: [DONE]\n\n';
  const result = await adapter.rawResponse({ response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }), completion: completed() }, rawContext(context, response => response.body));
  const text = await result.response.text();
  expect(text).toContain(':heartbeat\nevent: actual-wire-name\nid: \nretry: 12\n');
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
  const result = await adapter.rawResponse({ response, completion: Promise.resolve({ status: 'failed', code: 'upstream_failed' }) }, rawContext(context, value => value.body));
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
  const response = new Response(wire, { headers: { 'content-encoding': 'gzip' } });
  const input = { response, completion: completed() };
  const output = await adapter.rawResponse(input, rawContext(context, () => { throw new Error('unexpected decode'); }));
  expect(output).toBe(input);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(wire));
});
