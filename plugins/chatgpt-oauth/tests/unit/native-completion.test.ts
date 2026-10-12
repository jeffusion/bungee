import { expect, test } from 'bun:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import type { MutableRequestContext, RawResponseContext } from '@jeffusion/bungee-core/plugin';
import { ChatgptOauthAdapter, CODEX_RESPONSES_PATH } from '../../server/adapter';
import { responseBodyFixture } from '../helpers/shared-body-fixture';

async function nativeResponse(payload: string | Uint8Array, headers: HeadersInit = {}, open = false) {
  const adapter = new ChatgptOauthAdapter();
  const request: MutableRequestContext = {
    method: 'POST', originalUrl: new URL('http://localhost/chatgpt/responses'),
    url: new URL(`https://chatgpt.com${CODEX_RESPONSES_PATH}`), headers: {},
    body: { model: 'codex', stream: true }, clientIP: '127.0.0.1', requestId: crypto.randomUUID(),
  };
  const signal = new AbortController().signal;
  const context: RawResponseContext = { method: 'POST', originalUrl: request.originalUrl, upstreamUrl: request.url.href,
    clientIP: request.clientIP, requestId: request.requestId, attemptId: crypto.randomUUID(), signal };
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(typeof payload === 'string' ? new TextEncoder().encode(payload) : payload); if (!open) controller.close(); },
  }), { headers });
  const fixture = responseBodyFixture(response, context);
  const result = await adapter.rawResponse({ response, completion: new Promise(() => {}) }, { ...context, bodyHandle: fixture.handle });
  return { result, dispose: () => fixture.source.dispose() };
}

test('native completion preserves arbitrary tools, encrypted items, comments and CRLF envelopes', async () => {
  const payload = ':keepalive\r\n\r\n'
    + 'event: provider.extension\r\nid: 7\r\ndata: {"type":"provider.extension","value":"原生"}\r\n\r\n'
    + 'event: ignored-name\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"custom_tool_call","input":"raw command"},{"type":"reasoning","encrypted_content":"opaque"},{"type":"provider_tool"}]}}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n';
  const { result, dispose } = await nativeResponse(payload, { 'x-request-id': 'provider-id', 'content-type': 'application/octet-stream', 'content-length': '999' });
  try {
    expect(await result.response.text()).toBe(payload);
    await expect(result.completion).resolves.toEqual({ status: 'completed' });
    expect(result.response.headers.get('x-request-id')).toBe('provider-id');
    expect(result.response.headers.get('content-length')).toBeNull();
    expect(result.response.headers.get('content-type')).toBe('text/event-stream');
  } finally { dispose(); }
});

for (const payload of [
  'data: [DONE]\n\n',
  'event: response.completed\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
]) test(`native EOF without a complete payload terminal fails (${payload.slice(0, 30)})`, async () => {
  const { result, dispose } = await nativeResponse(payload);
  try {
    await result.response.text();
    await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'unexpected_eof' });
  } finally { dispose(); }
});

for (const response of [{ status: 'in_progress', output: [] }, { status: 'completed' }, { status: 'completed', output: [], error: { code: 'bad' } }])
  test(`native malformed terminal cannot prove completion (${JSON.stringify(response)})`, async () => {
    const { result, dispose } = await nativeResponse(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
    try {
      await result.response.text();
      await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'invalid_response' });
    } finally { dispose(); }
  });

for (const status of ['completed', 'incomplete', 'failed'] as const) test(`native ${status} terminal survives cancellation before EOF`, async () => {
  const { result, dispose } = await nativeResponse(`data: ${JSON.stringify({ type: `response.${status}`, response: { status, output: [] } })}\n\n`, {}, true);
  try {
    const reader = result.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(`response.${status}`);
    await reader.cancel('client closed after terminal');
    await expect(result.completion).resolves.toMatchObject({ status });
  } finally { dispose(); }
});

test('native HTTP errors preserve quota fields, status and request correlation headers', async () => {
  const adapter = new ChatgptOauthAdapter();
  const request = { method: 'POST', originalUrl: new URL('http://localhost/chatgpt/responses'),
    url: new URL(`https://chatgpt.com${CODEX_RESPONSES_PATH}`), headers: {}, body: { model: 'codex', stream: true },
    clientIP: '127.0.0.1', requestId: crypto.randomUUID() };
  adapter.beforeRequest(request);
  const payload = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'Quota reached',
    plan_type: 'pro', resets_at: 12345, resets_in_seconds: 60 } });
  const response = new Response(payload, { status: 429, headers: { 'content-type': 'application/json', 'x-request-id': 'provider-error', 'retry-after': '60' } });
  const input = { response, completion: Promise.resolve({ status: 'completed' as const }) };
  const result = await adapter.rawResponse(input, { ...request, upstreamUrl: request.url.href, signal: new AbortController().signal, attemptId: 'error-attempt' });
  expect(result).toBe(input);
  expect(await result.response.text()).toBe(payload);
  expect(result.response.status).toBe(429);
  expect(result.response.headers.get('x-request-id')).toBe('provider-error');
  expect(result.response.headers.get('retry-after')).toBe('60');
});

for (const coding of ['gzip', 'zstd']) test(`native ${coding} event view clears wire encoding and keeps protocol completion`, async () => {
  const payload = 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
  const wire = coding === 'gzip' ? gzipSync(Buffer.from(payload)) : zstdCompressSync(Buffer.from(payload));
  const { result, dispose } = await nativeResponse(wire, { 'content-type': 'application/octet-stream',
    'content-encoding': coding, 'content-length': String(wire.length) });
  try {
    expect(await result.response.text()).toBe(payload);
    expect(result.response.headers.get('content-encoding')).toBeNull();
    expect(result.response.headers.get('content-length')).toBeNull();
    await expect(result.completion).resolves.toEqual({ status: 'completed' });
  } finally { dispose(); }
});

test('native cancellation before a terminal remains cancelled', async () => {
  const { result, dispose } = await nativeResponse('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n', {}, true);
  try {
    const reader = result.response.body!.getReader();
    await reader.read();
    await reader.cancel('client stopped generation');
    await expect(result.completion).resolves.toEqual({ status: 'cancelled' });
  } finally { dispose(); }
});

test('raw native recognition is restricted to the actual Codex upstream endpoint', async () => {
  const adapter = new ChatgptOauthAdapter();
  for (const upstreamUrl of ['https://other.example/backend-api/codex/responses', 'https://chatgpt.com/other']) {
    const input = { response: new Response('opaque'), completion: Promise.resolve({ status: 'completed' as const }) };
    const output = await adapter.rawResponse(input, { method: 'POST', originalUrl: new URL('http://local/chatgpt/responses'),
      upstreamUrl, requestId: crypto.randomUUID(), clientIP: '127.0.0.1', attemptId: 'raw', signal: new AbortController().signal });
    expect(output).toBe(input);
  }
});
