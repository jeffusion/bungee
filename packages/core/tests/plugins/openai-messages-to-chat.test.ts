import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import {
  cleanupPluginRegistry,
  handleRequest,
  initializePluginRegistryForTests,
  initializeRuntimeState,
} from '../../src/worker';

const originalFetch = globalThis.fetch;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const mockedFetch = mock(async (request: Request | string, options?: RequestInit) => {
  const url = typeof request === 'string' ? request : request.url;

  let requestBody: Record<string, unknown> = {};
  if (options?.body) {
    const bodyText = typeof options.body === 'string'
      ? options.body
      : await new Response(options.body).text();

    if (bodyText.trim().length > 0) {
      requestBody = JSON.parse(bodyText) as Record<string, unknown>;
    }
  }

  if (url.includes('mock-openai.com')) {
    if (requestBody.stream === true) {
      const streamOptions = isObject(requestBody.stream_options)
        ? requestBody.stream_options
        : undefined;
      const includeUsage = streamOptions?.include_usage !== false;
      const forceStreamError = requestBody.force_stream_error === true;

      const firstChunk =
        'data: {"id":"chatcmpl_stream_mock","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
      const secondChunk =
        'data: {"id":"chatcmpl_stream_mock","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
      const thirdChunk =
        'data: {"id":"chatcmpl_stream_mock","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n';
      const finalChunk = includeUsage
        ? 'data: {"id":"chatcmpl_stream_mock","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n'
        : 'data: {"id":"chatcmpl_stream_mock","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';

      if (forceStreamError) {
        let emittedFirstChunk = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (!emittedFirstChunk) {
              emittedFirstChunk = true;
              controller.enqueue(new TextEncoder().encode(firstChunk));
              return;
            }

            controller.error(new Error('mock stream transport error'));
          }
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }

      const streamContent = [
        firstChunk,
        secondChunk,
        thirdChunk,
        finalChunk,
        'data: [DONE]\n\n'
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(streamContent));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    if (requestBody.force_tool_call_response === true) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_tool_mock',
          object: 'chat.completion',
          created: 123456,
          model: 'gpt-4o-mini',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_weather_compat',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Beijing"}'
                }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl_mock',
        object: 'chat.completion',
        created: 123456,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (url.includes('mock-anthropic.com')) {
    return new Response(
      JSON.stringify({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [{ type: 'text', text: 'anthropic ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response('not found', { status: 404 });
});

function createRouteConfig(
  path: string,
  pathRewrite: Record<string, string>,
  plugins: PluginConfig[],
  upstreamTarget: string
): AppConfig {
  return {
    routes: [
      {
        path,
        pathRewrite,
        plugins,
        upstreams: [{ target: upstreamTarget, weight: 100, priority: 1 }],
      },
    ],
  };
}

function getForwardedCall(index = 0): { url: string; options: RequestInit } {
  expect(mockedFetch.mock.calls.length).toBeGreaterThan(index);
  const call = mockedFetch.mock.calls[index];
  const request = call[0];
  const options = call[1];
  expect(options).toBeDefined();

  const url = typeof request === 'string' ? request : request.url;
  return { url, options: options! };
}

async function readForwardedBody(options: RequestInit): Promise<Record<string, unknown>> {
  const requestBody = options.body;
  if (!requestBody) {
    return {};
  }

  const bodyText = typeof requestBody === 'string'
    ? requestBody
    : await new Response(requestBody).text();

  return JSON.parse(bodyText) as Record<string, unknown>;
}

async function reinitialize(config: AppConfig): Promise<void> {
  await cleanupPluginRegistry();
  initializeRuntimeState(config);
  await initializePluginRegistryForTests(config);
  mockedFetch.mockClear();
}

function parseSSEJsonPayloads(raw: string): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];

  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const dataText = dataLines.join('\n');
    if (dataText === '[DONE]') {
      continue;
    }

    try {
      const parsed = JSON.parse(dataText) as unknown;
      if (isObject(parsed)) {
        payloads.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return payloads;
}

describe('openai-messages-to-chat plugin', () => {
  beforeEach(async () => {
    globalThis.fetch = mockedFetch as unknown as typeof fetch;

    const defaultConfig = createRouteConfig(
      '/v1/messages-compat',
      { '^/v1/messages-compat': '/v1' },
      [{ name: 'openai-messages-to-chat' }],
      'http://mock-openai.com'
    );

    initializeRuntimeState(defaultConfig);
    await initializePluginRegistryForTests(defaultConfig);
    mockedFetch.mockClear();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupPluginRegistry();
  });

  test('rewrites /v1/messages to /v1/chat/completions and forwards chat payload', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.2,
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.type).toBe('message');
    expect(responseBody.role).toBe('assistant');
    expect(responseBody.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(responseBody.stop_reason).toBe('end_turn');
    expect(responseBody.usage).toEqual({ input_tokens: 9, output_tokens: 3 });

    const { url, options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);

    expect(url).toContain('mock-openai.com');
    expect(url).toContain('/v1/chat/completions');
    expect(forwardedBody.model).toBe('gpt-4o-mini');
    expect(forwardedBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(forwardedBody.temperature).toBe(0.2);
  });

  test('supports /messages alias when allowShortPathAlias is enabled', async () => {
    const shortAliasConfig = createRouteConfig(
      '/compat-short',
      { '^/compat-short': '' },
      [{ name: 'openai-messages-to-chat' }],
      'http://mock-openai.com'
    );

    await reinitialize(shortAliasConfig);

    const req = new Request('http://localhost/compat-short/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'short alias' }],
      }),
    });

    const response = await handleRequest(req, shortAliasConfig);
    expect(response.status).toBe(200);

    const { url } = getForwardedCall();
    expect(url).toContain('/v1/chat/completions');
  });

  test('trims assistant reasoning_content on /v1/messages by default', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'call the tool' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: '  trim-me  ',
            tool_calls: [
              {
                id: 'call_trim_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
              }
            ]
          }
        ]
      })
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[1].reasoning_content).toBe('trim-me');
  });

  test('preserves assistant reasoning_content whitespace on /v1/messages when trimWhitespace=false', async () => {
    const config = createRouteConfig(
      '/v1/messages-compat',
      { '^/v1/messages-compat': '/v1' },
      [
        {
          name: 'openai-messages-to-chat',
          options: { trimWhitespace: false }
        }
      ],
      'http://mock-openai.com'
    );

    await reinitialize(config);

    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'call the tool' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: '  keep-space  ',
            tool_calls: [
              {
                id: 'call_trim_2',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
              }
            ]
          }
        ]
      })
    });

    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[1].reasoning_content).toBe('  keep-space  ');
  });

  test('normalizes input_text/input_image message parts into chat-completions parts', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe this image.' },
              { type: 'input_image', image_url: 'https://example.com/cat.png' },
            ],
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;
    const forwardedContent = forwardedMessages[0].content as Array<Record<string, unknown>>;

    expect(forwardedContent).toEqual([
      { type: 'text', text: 'Describe this image.' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ]);
  });

  test('converts anthropic-style tool_use/tool_result blocks into assistant.tool_calls and role=tool messages', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'What is the weather in Shanghai?' }],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_weather_1',
                name: 'get_weather',
                input: { city: 'Shanghai' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_weather_1',
                content: { temperature: 22, condition: 'sunny' },
              },
              { type: 'text', text: 'Now summarize briefly.' },
            ],
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(forwardedMessages[1]).toEqual({
      role: 'assistant',
      reasoning_content: '',
      content: null,
      tool_calls: [
        {
          id: 'toolu_weather_1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"city":"Shanghai"}',
          },
        },
      ],
    });

    expect(forwardedMessages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_weather_1',
      content: '{"temperature":22,"condition":"sunny"}',
    });

    const lastMessage = forwardedMessages[3];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toEqual([{ type: 'text', text: 'Now summarize briefly.' }]);
  });

  test('defaults reasoning_content for assistant tool_calls when content is omitted', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: 'Use tool and continue',
          },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_weather_compat_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Shanghai"}',
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_weather_compat_1',
            content: '{"temperature":22}',
          },
          {
            role: 'user',
            content: 'Continue',
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(forwardedMessages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_weather_compat_1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"city":"Shanghai"}',
          },
        },
      ],
    });
  });

  test('normalizes assistant tool_calls object into array on /v1/messages', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: 'Use tool and continue',
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: {
              id: 'call_weather_object_1',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Shanghai"}',
              },
            },
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;
    const toolCalls = forwardedMessages[1].tool_calls as Array<Record<string, unknown>>;

    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls[0].id).toBe('call_weather_object_1');
    expect(forwardedMessages[1].reasoning_content).toBe('');
  });

  test('normalizes assistant tool_calls JSON string into array on /v1/messages', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: 'Use tool and continue',
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: JSON.stringify([
              {
                id: 'call_weather_json_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Shanghai"}',
                },
              },
            ]),
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;
    const toolCalls = forwardedMessages[1].tool_calls as Array<Record<string, unknown>>;

    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls[0].id).toBe('call_weather_json_1');
    expect(forwardedMessages[1].reasoning_content).toBe('');
  });

  test('returns 400 when assistant tool_calls is malformed JSON string in strict mode', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: 'Use tool and continue',
          },
          {
            role: 'assistant',
            tool_calls: '[{"id":"bad_call"',
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('tool_calls');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('defaults reasoning_content for assistant tool_calls when content is an array', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: 'Use tool and continue',
          },
          {
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Calling weather tool...' }],
            tool_calls: [
              {
                id: 'call_weather_compat_2',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Hangzhou"}',
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_weather_compat_2',
            content: '{"temperature":24}',
          },
          {
            role: 'user',
            content: 'Continue',
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(forwardedMessages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_weather_compat_2',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"city":"Hangzhou"}',
          },
        },
      ],
    });

    expect(forwardedMessages[1].content).toEqual([
      {
        type: 'text',
        text: 'Calling weather tool...'
      }
    ]);
  });

  test('maps assistant thinking blocks to reasoning_content when tool_use is present', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Need weather and explain reasoning' }],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Need to call weather API first.' },
              {
                type: 'tool_use',
                id: 'toolu_weather_2',
                name: 'get_weather',
                input: { city: 'Hangzhou' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_weather_2',
                content: { temperature: 24, condition: 'cloudy' },
              },
            ],
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(forwardedMessages[1]).toEqual({
      role: 'assistant',
      reasoning_content: 'Need to call weather API first.',
      content: null,
      tool_calls: [
        {
          id: 'toolu_weather_2',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"city":"Hangzhou"}',
          },
        },
      ],
    });
  });

  test('injects empty reasoning_content into converted assistant tool_use response for follow-up compatibility', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        force_tool_call_response: true,
        messages: [{ role: 'user', content: 'Call weather tool' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather by city',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                }
              }
            }
          }
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);
    const responseBody = await response.json();

    expect(responseBody.type).toBe('message');
    expect(responseBody.role).toBe('assistant');
    expect(responseBody.reasoning_content).toBe('');
    expect(Array.isArray(responseBody.content)).toBe(true);
    expect(responseBody.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_weather_compat',
        name: 'get_weather',
        input: {
          city: 'Beijing'
        }
      }
    ]);
  });

  test('normalizes thinking content parts into text parts for non-assistant messages', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'thinking', thinking: 'This is hidden planning text.' },
              { type: 'text', text: 'Return concise answer.' },
            ],
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const forwardedMessages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(forwardedMessages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'This is hidden planning text.' },
        { type: 'text', text: 'Return concise answer.' },
      ],
    });
  });

  test('returns 400 when anthropic tool_result block is missing tool_use_id in strict mode', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                content: 'missing linkage id',
              },
            ],
          },
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('tool_use_id');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('normalizes JSON-string anthropic-style tools and tool_choice into chat-completions format', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Use weather tool' }],
        tools: JSON.stringify([
          {
            name: 'weather_lookup',
            description: 'Lookup weather by city',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ]),
        tool_choice: {
          type: 'tool',
          name: 'weather_lookup',
        },
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    expect(forwardedBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'weather_lookup',
          description: 'Lookup weather by city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      },
    ]);
    expect(forwardedBody.tool_choice).toEqual({
      type: 'function',
      function: {
        name: 'weather_lookup',
      },
    });
  });

  test('returns 400 for invalid tools entries in strict mode before upstream call', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            name: 'ok_tool',
            input_schema: {
              type: 'object',
              properties: {},
            },
          },
          'not-a-tool-object',
        ],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('tools[1]');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('returns 400 when strict mode sees conflicting Responses fields', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: 'hello from responses',
        messages: [{ role: 'user', content: 'hello from chat' }],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('input');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('returns 400 when model is missing', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'missing model' }],
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('model');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('works before ai-transformer in composed routes (messages -> chat -> anthropic)', async () => {
    const composedConfig = createRouteConfig(
      '/v1/messages-to-anthropic',
      { '^/v1/messages-to-anthropic': '/v1' },
      [
        { name: 'openai-messages-to-chat' },
        {
          name: 'ai-transformer',
          options: {
            from: 'openai',
            to: 'anthropic',
          },
        },
      ],
      'http://mock-anthropic.com'
    );

    await reinitialize(composedConfig);

    const req = new Request('http://localhost/v1/messages-to-anthropic/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello Anthropic chain' }],
        max_tokens: 64,
      }),
    });

    const response = await handleRequest(req, composedConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();
    expect(responseBody.type).toBe('message');
    expect(responseBody.role).toBe('assistant');
    expect(responseBody.content).toEqual([{ type: 'text', text: 'anthropic ok' }]);
    expect(responseBody.stop_reason).toBe('end_turn');
    expect(responseBody.usage).toEqual({ input_tokens: 12, output_tokens: 8 });

    const { url, options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);

    expect(url).toContain('mock-anthropic.com');
    expect(url).toContain('/v1/messages');
    expect(forwardedBody.model).toBe('claude-3-5-sonnet-20241022');
    expect(Array.isArray(forwardedBody.messages)).toBe(true);
  });

  test('converts streaming chat chunks back to messages SSE events', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'stream please' }],
        stream: true,
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let allData = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allData += decoder.decode(value);
      }
    }

    expect(allData).toContain('event: message_start');
    expect(allData).toContain('event: content_block_start');
    expect(allData).toContain('event: content_block_delta');
    expect(allData).toContain('event: message_stop');

    const payloads = parseSSEJsonPayloads(allData);
    const messageStartPayload = payloads.find((payload) => payload.type === 'message_start');
    expect(messageStartPayload).toBeDefined();
    const messageStart = messageStartPayload && isObject(messageStartPayload.message)
      ? messageStartPayload.message
      : null;
    expect(messageStart).toBeDefined();
    expect(messageStart?.reasoning_content).toBe('');

    const messageDelta = payloads.find(
      (payload) => payload.type === 'message_delta'
        && isObject(payload.delta)
        && payload.delta.stop_reason === 'end_turn'
    );
    expect(messageDelta).toBeDefined();
    const usage = messageDelta && isObject(messageDelta.usage)
      ? messageDelta.usage
      : null;
    expect(usage).toEqual({ input_tokens: 11, output_tokens: 2 });

    const { url } = getForwardedCall();
    expect(url).toContain('/v1/chat/completions');
  });

  test('fills zero usage in message_delta when upstream stream has no usage block', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'stream without usage please' }],
        stream: true,
        stream_options: {
          include_usage: false,
        },
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let allData = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allData += decoder.decode(value);
      }
    }

    const payloads = parseSSEJsonPayloads(allData);
    const messageDelta = payloads.find(
      (payload) => payload.type === 'message_delta'
        && isObject(payload.delta)
        && payload.delta.stop_reason === 'end_turn'
    );

    expect(messageDelta).toBeDefined();
    const usage = messageDelta && isObject(messageDelta.usage)
      ? messageDelta.usage
      : null;
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('fallback terminal message_delta includes usage when stream transport breaks', async () => {
    const req = new Request('http://localhost/v1/messages-compat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'break stream transport' }],
        stream: true,
        force_stream_error: true,
      }),
    });

    const response = await handleRequest(req, {
      routes: [
        {
          path: '/v1/messages-compat',
          pathRewrite: { '^/v1/messages-compat': '/v1' },
          plugins: [{ name: 'openai-messages-to-chat' }],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let allData = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allData += decoder.decode(value);
      }
    }

    const payloads = parseSSEJsonPayloads(allData);
    const messageDelta = payloads.find(
      (payload) => payload.type === 'message_delta'
        && isObject(payload.delta)
        && payload.delta.stop_reason === 'end_turn'
    );

    expect(allData).toContain('event: message_stop');
    expect(messageDelta).toBeDefined();
    const usage = messageDelta && isObject(messageDelta.usage)
      ? messageDelta.usage
      : null;
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
