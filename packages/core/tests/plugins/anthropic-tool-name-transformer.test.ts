import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppConfig, PluginConfigOptions } from '@jeffusion/bungee-types';
import { handleRequest } from '../../src/worker/request/handler';
import { initializeRuntimeState } from '../../src/worker/state/runtime-state';
import { cleanupPluginRegistry, initializePluginRegistryForTests } from '../../src/worker/state/plugin-manager';

const baseConfig: AppConfig = {
  routes: [
    {
      path: '/v1/transform',
      path_rewrite: { '^/v1/transform': '/v1' },
      endpoints: [{ target: 'http://mock-anthropic.com', weight: 100, priority: 1 }],
    },
  ],
};

const originalFetch = globalThis.fetch;

function createConfig(pluginOptions?: PluginConfigOptions): AppConfig {
  return {
    routes: [
      {
        ...baseConfig.routes[0],
        plugins: [
          pluginOptions
            ? { name: 'anthropic-tool-name-transformer', options: pluginOptions }
            : { name: 'anthropic-tool-name-transformer' },
        ],
      },
    ],
  };
}

function getForwardedCall(fetchMock: ReturnType<typeof mock>): { url: string; options: RequestInit } {
  expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  const call = fetchMock.mock.calls[0];
  const request = call[0];
  const options = call[1];
  const url = typeof request === 'string' ? request : request.url;
  return { url, options: options! };
}

async function readStreamText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  return output;
}

describe('anthropic-tool-name-transformer plugin', () => {
  beforeEach(async () => {
    initializeRuntimeState(baseConfig);
    await initializePluginRegistryForTests(baseConfig, process.cwd());
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupPluginRegistry();
  });

  test('transforms request tool names using custom mapping and pascal-case fallback', async () => {
    const fetchMock = mock(async (request: Request | string, _init?: RequestInit) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.includes('mock-anthropic.com')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = createConfig({ nameMap: 'todowrite=TodoWrite' });
    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config, process.cwd());

    const req = new Request('http://localhost/v1/transform/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        tools: [
          { name: 'todowrite', input_schema: { type: 'object' } },
          { name: 'google_search', input_schema: { type: 'object' } },
        ],
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'webfetch', input: {} }],
          },
        ],
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall(fetchMock);
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwardedBody.tools[0].name).toBe('TodoWrite');
    expect(forwardedBody.tools[1].name).toBe('GoogleSearch');
    expect(forwardedBody.messages[0].content[0].name).toBe('Webfetch');
  });

  test('fixes serialized arrays and objects in JSON response when enabled', async () => {
    const fetchMock = mock(async (request: Request | string, _init?: RequestInit) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.includes('mock-anthropic.com')) {
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'TodoWrite',
                input: {
                  list: '[1,2,3]',
                  payload: '{"city":"shanghai"}',
                  plain: 'not-json',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return new Response('not found', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = createConfig({ fixSerializedArrays: true });
    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config, process.cwd());

    const req = new Request('http://localhost/v1/transform/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const response = await handleRequest(req, config);
    const data = await response.json();

    expect(data.content[0].input.list).toEqual([1, 2, 3]);
    expect(data.content[0].input.payload).toEqual({ city: 'shanghai' });
    expect(data.content[0].input.plain).toBe('not-json');
  });

  test('keeps original response body readable when upstream JSON is invalid', async () => {
    const fetchMock = mock(async (request: Request | string, _init?: RequestInit) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.includes('mock-anthropic.com')) {
        return new Response('{invalid', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = createConfig({ fixSerializedArrays: true });
    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config, process.cwd());

    const req = new Request('http://localhost/v1/transform/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const response = await handleRequest(req, config);
    const text = await response.text();

    expect(text).toBe('{invalid');
  });

  test('transforms tool_use name in SSE content_block_start', async () => {
    const fetchMock = mock(async (request: Request | string, _init?: RequestInit) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.includes('mock-anthropic.com')) {
        const streamContent = [
          'event: message_start\n',
          'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
          'event: content_block_start\n',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"google_search"}}\n\n',
          'event: message_stop\n',
          'data: {"type":"message_stop"}\n\n',
        ].join('');

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(streamContent));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = createConfig();
    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config, process.cwd());

    const req = new Request('http://localhost/v1/transform/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });

    const response = await handleRequest(req, config);
    const allData = await readStreamText(response);

    expect(allData).toContain('"name":"GoogleSearch"');
  });
});
