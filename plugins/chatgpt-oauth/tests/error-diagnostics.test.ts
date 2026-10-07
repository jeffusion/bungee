import { expect, test } from 'bun:test';
import type { MutableRequestContext, RawResponseContext } from '../../../packages/core/src/hooks';
import { ChatgptOauthAdapter, CHAT_COMPLETIONS_PATH, RESPONSES_PATH } from '../server/adapter';
import { errorDiagnostic } from '../server/error-diagnostics';

function setup(path = RESPONSES_PATH, stream = true) {
  const adapter = new ChatgptOauthAdapter();
  const request: MutableRequestContext = {
    method: 'POST', originalUrl: new URL(`http://localhost${path}`), url: new URL(`https://chatgpt.com${path}`),
    headers: {}, body: { model: 'codex', stream, input: 'hi', messages: [{ role: 'user', content: 'hi' }] },
    clientIP: '127.0.0.1', requestId: crypto.randomUUID(),
  };
  adapter.beforeRequest(request);
  const context: RawResponseContext = {
    method: 'POST', originalUrl: request.originalUrl, requestId: request.requestId,
    decodeResponseBody: response => response.body,
    clientIP: request.clientIP, attemptId: 'error-test', signal: new AbortController().signal,
    redactDiagnostic: value => value.replaceAll('opaque-managed-secret', '[REDACTED]'),
  };
  const adapt = (response: Response) => adapter.rawResponse({ response, completion: Promise.resolve({ status: 'completed' }) }, context);
  return { adapt, context };
}

for (const path of [RESPONSES_PATH, CHAT_COMPLETIONS_PATH]) {
  for (const shape of ['response.failed', 'error']) {
    test(`${path} delivers ${shape} diagnostics without forwarding the failed response payload`, async () => {
      const { adapt } = setup(path);
      const error = { code: 'server_error', type: 'upstream_failure', message: 'Please retry opaque-managed-secret Bearer bearer-secret', private: 'private-error-field' };
      const event = shape === 'response.failed'
        ? { type: shape, response: { status: 'failed', error, input: 'private-input', output: 'private-output' } }
        : { type: shape, error };
      const result = await adapt(new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
      const text = await result.response.text();
      expect(result.response.status).toBe(200);
      expect(text).toContain('server_error');
      expect(text).toContain('Please retry');
      expect(text).toContain('[REDACTED]');
      for (const secret of ['opaque-managed-secret', 'bearer-secret', 'private-input', 'private-output', 'private-error-field', '[DONE]']) expect(text).not.toContain(secret);
      if (path === RESPONSES_PATH) {
        expect(text).toContain('event: error');
        expect(text).toContain('"type":"error"');
      }
      await expect(result.completion).resolves.toMatchObject({ status: 'failed', code: 'failed', error: {
        source: 'upstream', code: 'server_error', type: 'upstream_failure', message: 'Please retry [REDACTED] Bearer [REDACTED]',
      } });
    });
  }
}

test('HTTP errors retain structured diagnostics, original status and retry-after', async () => {
  const { adapt } = setup(RESPONSES_PATH, false);
  const result = await adapt(new Response(JSON.stringify({ error: {
    code: 'usage_limit_reached', type: 'rate_limit_error', message: 'Quota exhausted; access_token=opaque-managed-secret',
    request: { input: 'private-request' },
  } }), { status: 429, headers: { 'retry-after': '7' } }));
  expect(result.response.status).toBe(429);
  expect(result.response.headers.get('retry-after')).toBe('7');
  expect(await result.response.json()).toEqual({ error: {
    code: 'usage_limit_reached', type: 'rate_limit_error', message: 'Quota exhausted; access_token=[REDACTED]',
  } });
  await expect(result.completion).resolves.toMatchObject({ status: 'failed', code: 'upstream_http_error', error: { code: 'usage_limit_reached' } });
});

test('nonstream SSE failures retain provider diagnostics in the JSON error', async () => {
  const { adapt } = setup(RESPONSES_PATH, false);
  const result = await adapt(new Response('data: {"type":"error","code":"invalid_model","message":"Model unavailable"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  expect(result.response.status).toBe(502);
  expect(await result.response.json()).toMatchObject({ error: { code: 'invalid_model', message: 'Model unavailable' } });
  await expect(result.completion).resolves.toMatchObject({ status: 'failed', code: 'failed', error: { code: 'invalid_model' } });
});

test('transport failures keep the socket cause and deliver a safe error frame', async () => {
  const { adapt } = setup();
  let count = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    if (count++ === 0) controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"r1"}}\n\n'));
    else controller.error(new TypeError('Read failed opaque-managed-secret', { cause: Object.assign(new Error('Socket closed'), { code: 'ECONNRESET' }) }));
  } }, { highWaterMark: 0 });
  const result = await adapt(new Response(source, { headers: { 'content-type': 'text/event-stream' } }));
  const text = await result.response.text();
  expect(text).toContain('response.created');
  expect(text).toContain('ECONNRESET');
  expect(text).toContain('Socket closed');
  expect(text).not.toContain('opaque-managed-secret');
  await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'body_error', error: {
    source: 'transport', type: 'TypeError', code: 'ECONNRESET', message: 'Read failed [REDACTED]; Socket closed',
  } });
});

test('diagnostics are bounded and strip token patterns, controls and non-scalar fields', () => {
  const error = errorDiagnostic({ code: 'server_error', type: 'bad\nvalue', message: 'sk-secret-token\nrefresh_token=opaque ' + 'x'.repeat(20_000), stack: 'private-stack' }, 'upstream', 'fallback');
  expect(error.message.length).toBeLessThanOrEqual(1024);
  expect(JSON.stringify(error)).not.toContain('secret-token');
  expect(JSON.stringify(error)).not.toContain('opaque');
  expect(JSON.stringify(error)).not.toContain('private-stack');
  expect(error.type).toBeUndefined();
});

test('an unfinished HTTP error body has a bounded diagnostic read and is cancelled', async () => {
  const { adapt } = setup();
  let cancelled = 0;
  const result = await adapt(new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }));
  expect(result.response.status).toBe(503);
  expect(cancelled).toBe(1);
  await expect(result.completion).resolves.toEqual({ status: 'failed', code: 'upstream_http_error' });
}, 3000);
