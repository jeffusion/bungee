import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import {
  cleanupPluginRegistry,
  handleRequest,
  initializePluginRegistryForTests,
  initializeRuntimeState,
} from '../../src/worker';

const originalFetch = globalThis.fetch;

const mockedFetch = mock(async (_request: Request | string, options?: RequestInit) => {
  let requestBody: Record<string, unknown> = {};
  if (options?.body) {
    const bodyText = typeof options.body === 'string'
      ? options.body
      : await new Response(options.body).text();

    if (bodyText.trim().length > 0) {
      requestBody = JSON.parse(bodyText) as Record<string, unknown>;
    }
  }

  if (requestBody.stream === true) {
    if (requestBody.force_length_finish_stream === true) {
      const lengthStream = [
        'data: {"id":"chatcmpl_resp_length_stream","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_resp_length_stream","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_resp_length_stream","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":128,"total_tokens":138}}\n\n',
        'data: [DONE]\n\n'
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(lengthStream));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    if (requestBody.force_tool_call_stream === true) {
      const toSSE = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;
      const toolCallStream = [
        toSSE({
          id: 'chatcmpl_resp_tool_stream',
          object: 'chat.completion.chunk',
          created: 123456,
          model: 'gpt-4o-mini',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        }),
        toSSE({
          id: 'chatcmpl_resp_tool_stream',
          object: 'chat.completion.chunk',
          created: 123456,
          model: 'gpt-4o-mini',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_resp_stream_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Shanghai"}'
                }
              }]
            },
            finish_reason: null
          }]
        }),
        toSSE({
          id: 'chatcmpl_resp_tool_stream',
          object: 'chat.completion.chunk',
          created: 123456,
          model: 'gpt-4o-mini',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 }
        }),
        'data: [DONE]\n\n'
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(toolCallStream));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    const streamContent = [
      'data: {"id":"chatcmpl_resp_stream","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl_resp_stream","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl_resp_stream","object":"chat.completion.chunk","created":123456,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n',
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

  if (requestBody.force_multi_choice_response === true) {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_resp_multi',
        object: 'chat.completion',
        created: 123456,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'first choice',
              tool_calls: [
                {
                  id: 'call_resp_multi_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          },
          {
            index: 1,
            message: {
              role: 'assistant',
              content: 'second choice'
            },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  if (requestBody.force_multi_choice_mixed_terminal === true) {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_resp_multi_mixed',
        object: 'chat.completion',
        created: 123456,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'first choice'
            },
            finish_reason: 'stop'
          },
          {
            index: 1,
            message: {
              role: 'assistant',
              content: 'second choice'
            },
            finish_reason: 'length'
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  if (typeof requestBody.force_terminal_finish_reason === 'string') {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_resp_terminal',
        object: 'chat.completion',
        created: 123456,
        model: 'gpt-4o-mini',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'terminal test'
          },
          finish_reason: requestBody.force_terminal_finish_reason
        }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  return new Response(
    JSON.stringify({
      id: 'chatcmpl_resp_mock',
      object: 'chat.completion',
      created: 123456,
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok from chat completion' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
});

function createConfig(plugins: PluginConfig[]): AppConfig {
  return {
    routes: [
      {
        path: '/v1/openai-compat',
        pathRewrite: { '^/v1/openai-compat': '/v1' },
        plugins,
        upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }]
      }
    ]
  };
}

function createShortPathConfig(plugins: PluginConfig[]): AppConfig {
  return {
    routes: [
      {
        path: '/openai-compat-short',
        pathRewrite: { '^/openai-compat-short': '' },
        plugins,
        upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }]
      }
    ]
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
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        payloads.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }

  return payloads;
}

describe('openai-messages-to-chat plugin (responses compatibility path)', () => {
  beforeEach(async () => {
    globalThis.fetch = mockedFetch as unknown as typeof fetch;
    await reinitialize(createConfig([{ name: 'openai-messages-to-chat' }]));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupPluginRegistry();
  });

  test('fills assistant tool call reasoning_content from thinking tags in reasoning context', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        reasoning: { effort: 'high', summary: 'auto' },
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Need weather' }] },
          {
            role: 'assistant',
            content: '<thinking>Need weather tool before final answer.</thinking>',
            tool_calls: [
              {
                id: 'call_resp_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
              }
            ]
          }
        ]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.object).toBe('response');
    expect(responseBody.status).toBe('completed');

    const { url, options } = getForwardedCall();
    expect(url).toContain('/v1/chat/completions');
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[1].reasoning_content).toBe('Need weather tool before final answer.');
  });

  test('defaults assistant tool call reasoning_content to empty string in reasoning context', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        reasoning: { effort: 'medium', summary: 'auto' },
        input: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_resp_2',
                type: 'function',
                function: { name: 'get_time', arguments: '{}' }
              }
            ]
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(Object.prototype.hasOwnProperty.call(messages[0], 'reasoning_content')).toBe(true);
    expect(messages[0].reasoning_content).toBe('');
  });

  test('normalizes assistant tool call reasoning_content even when reasoning context is absent', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_resp_3',
                type: 'function',
                function: { name: 'get_time', arguments: '{}' }
              }
            ]
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(Object.prototype.hasOwnProperty.call(messages[0], 'reasoning_content')).toBe(true);
    expect(messages[0].reasoning_content).toBe('');
  });

  test('fills reasoning_content for assistant tool-use blocks in input content', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        reasoning: { effort: 'medium', summary: 'auto' },
        input: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'Need to call weather tool first.' },
              {
                type: 'tool_use',
                id: 'toolu_weather_9',
                name: 'get_weather',
                input: { city: 'Hangzhou' }
              }
            ]
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('Need to call weather tool first.');
  });

  test('fills reasoning_content when tool_calls is JSON string and thinking.enabled=true', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        thinking: { enabled: true },
        input: [
          {
            role: 'assistant',
            content: null,
            tool_calls: JSON.stringify([
              {
                id: 'call_resp_compat_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
              }
            ])
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('');
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls[0].id).toBe('call_resp_compat_1');
  });

  test('returns 400 when assistant tool_calls is malformed JSON string in strict mode', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [
          {
            role: 'assistant',
            tool_calls: '[{"id":"bad_call"',
          }
        ]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('tool_calls');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('fills reasoning_content for assistant tool calls in messages field', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        reasoning_effort: 'high',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_resp_compat_2',
                type: 'function',
                function: { name: 'get_time', arguments: '{}' }
              }
            ]
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('');
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls[0].id).toBe('call_resp_compat_2');
  });

  test('fills reasoning_content when enable_thinking is enabled string', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        enable_thinking: 'enabled',
        input: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_resp_compat_3',
                type: 'function',
                function: { name: 'get_calendar', arguments: '{}' }
              }
            ]
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('');
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls[0].id).toBe('call_resp_compat_3');
  });

  test('fills reasoning_content when tool_calls is object', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        reasoning: { effort: 'low' },
        input: [
          {
            role: 'assistant',
            content: null,
            tool_calls: {
              id: 'call_resp_compat_4',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' }
            }
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('');
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls[0].id).toBe('call_resp_compat_4');
  });

  test('fills reasoning_content when content has custom *_call block', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        thinking: { budget_tokens: 2048 },
        input: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Need one internal call.' },
              {
                type: 'provider_call',
                id: 'provider_call_1',
                name: 'lookup',
                arguments: '{"q":"weather"}'
              }
            ]
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('Need one internal call.');
  });

  test('fills reasoning_content for nested message wrapper shape', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        input: [
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_resp_compat_5',
                  type: 'function',
                  function: { name: 'get_time', arguments: '{}' }
                }
              ]
            }
          }
        ]
      })
    });

    await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('');
  });

  test('respects trimWhitespace=false option', async () => {
    const config = createConfig([
      {
        name: 'openai-messages-to-chat',
        options: {
          trimWhitespace: false
        }
      }
    ]);

    await reinitialize(config);

    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        reasoning: { effort: 'medium', summary: 'auto' },
        input: [
          {
            role: 'assistant',
            content: null,
            reasoning_content: '  preserve-space  ',
            tool_calls: [
              {
                id: 'call_resp_4',
                type: 'function',
                function: { name: 'get_time', arguments: '{}' }
              }
            ]
          }
        ]
      })
    });

    await handleRequest(req, config);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('  preserve-space  ');
  });

  test('drops state reference fields while keeping stateless input/messages downgrade', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        previous_response_id: 'resp_prev_001',
        conversation: 'conv_123',
        response_id: 'resp_legacy',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'stateless turn' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(200);

    const { url, options } = getForwardedCall();
    expect(url).toContain('/v1/chat/completions');
    const forwardedBody = await readForwardedBody(options);

    expect(Object.prototype.hasOwnProperty.call(forwardedBody, 'previous_response_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(forwardedBody, 'conversation')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(forwardedBody, 'response_id')).toBe(false);

    const messages = forwardedBody.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0].role).toBe('user');
  });

  test('returns explicit stateless error when only state reference fields are provided', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        previous_response_id: 'resp_prev_only'
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('local compatibility cache');
    expect(body.error.message).toContain('previous_response_id');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('reuses cached prior response context when previous_response_id is resolvable', async () => {
    const config = createConfig([{ name: 'openai-messages-to-chat' }]);
    await reinitialize(config);

    const firstReq = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'first turn' }] }]
      })
    });

    const firstResponse = await handleRequest(firstReq, config);
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    expect(typeof firstBody.id).toBe('string');

    mockedFetch.mockClear();

    const secondReq = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        previous_response_id: firstBody.id,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'second turn' }] }]
      })
    });

    const secondResponse = await handleRequest(secondReq, config);
    expect(secondResponse.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages.length).toBeGreaterThanOrEqual(3);
    const assistantMessage = messages.find((message) => message.role === 'assistant');
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.content).toBe('ok from chat completion');
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.role).toBe('user');
  });

  test('reuses cached prior response context when response_id is resolvable', async () => {
    const config = createConfig([{ name: 'openai-messages-to-chat' }]);
    await reinitialize(config);

    const firstReq = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'first turn by response_id' }] }]
      })
    });

    const firstResponse = await handleRequest(firstReq, config);
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    expect(typeof firstBody.id).toBe('string');

    mockedFetch.mockClear();

    const secondReq = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        response_id: firstBody.id,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'second turn by response_id' }] }]
      })
    });

    const secondResponse = await handleRequest(secondReq, config);
    expect(secondResponse.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.some((message) => message.role === 'assistant' && message.content === 'ok from chat completion')).toBe(true);
    expect(messages[messages.length - 1].role).toBe('user');
    expect(Object.prototype.hasOwnProperty.call(forwardedBody, 'response_id')).toBe(false);
  });

  test('reuses cached prior response context by conversation id mapping', async () => {
    const config = createConfig([{ name: 'openai-messages-to-chat' }]);
    await reinitialize(config);

    const firstReq = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        conversation: 'conv_cache_001',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'first conversation turn' }] }]
      })
    });

    const firstResponse = await handleRequest(firstReq, config);
    expect(firstResponse.status).toBe(200);

    mockedFetch.mockClear();

    const secondReq = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        conversation: 'conv_cache_001',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'second conversation turn' }] }]
      })
    });

    const secondResponse = await handleRequest(secondReq, config);
    expect(secondResponse.status).toBe(200);

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.some((message) => message.role === 'assistant' && message.content === 'ok from chat completion')).toBe(true);
    expect(messages[messages.length - 1].role).toBe('user');
    expect(Object.prototype.hasOwnProperty.call(forwardedBody, 'conversation')).toBe(false);
  });

  test('emits responses text lifecycle events for stream conversion', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'stream text' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
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

    const payloads = parseSSEJsonPayloads(allData);
    const createdIndex = payloads.findIndex((event) => event.type === 'response.created');
    const inProgressIndex = payloads.findIndex((event) => event.type === 'response.in_progress');
    const messageAddedIndex = payloads.findIndex((event) => event.type === 'response.output_item.added' && event.output_index === 0);
    const contentPartAddedIndex = payloads.findIndex((event) => event.type === 'response.content_part.added' && event.output_index === 0);
    const textDeltaIndex = payloads.findIndex((event) => event.type === 'response.output_text.delta' && event.output_index === 0);
    const textDoneIndex = payloads.findIndex((event) => event.type === 'response.output_text.done' && event.output_index === 0);
    const contentPartDoneIndex = payloads.findIndex((event) => event.type === 'response.content_part.done' && event.output_index === 0);
    const messageDoneIndex = payloads.findIndex((event) => event.type === 'response.output_item.done' && event.output_index === 0);
    const completedIndex = payloads.findIndex((event) => event.type === 'response.completed');

    expect(createdIndex).toBeGreaterThanOrEqual(0);
    expect(inProgressIndex).toBeGreaterThan(createdIndex);
    expect(messageAddedIndex).toBeGreaterThan(inProgressIndex);
    expect(contentPartAddedIndex).toBeGreaterThan(messageAddedIndex);
    expect(textDeltaIndex).toBeGreaterThan(contentPartAddedIndex);
    expect(textDoneIndex).toBeGreaterThan(textDeltaIndex);
    expect(contentPartDoneIndex).toBeGreaterThan(textDoneIndex);
    expect(messageDoneIndex).toBeGreaterThanOrEqual(contentPartDoneIndex);
    expect(completedIndex).toBeGreaterThan(messageDoneIndex);

    const completedPayload = payloads[completedIndex] as Record<string, unknown>;
    const completedResponse = completedPayload.response as Record<string, unknown>;
    expect(completedResponse.status).toBe('completed');
    const output = completedResponse.output as Array<Record<string, unknown>>;
    expect(output[0].type).toBe('message');
    expect((output[0].content as Array<Record<string, unknown>>)[0].text).toBe('hello');
  });

  test('maps non-stream multi-choice chat completion into responses output items', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        force_multi_choice_response: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'multi choice please' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(Array.isArray(body.output)).toBe(true);

    const output = body.output as Array<Record<string, unknown>>;
    const messages = output.filter((item) => item.type === 'message');
    const functionCalls = output.filter((item) => item.type === 'function_call');

    expect(messages.length).toBe(2);
    expect(functionCalls.length).toBe(1);
    expect(functionCalls[0].name).toBe('get_weather');
    expect(body.metadata.finish_reasons).toEqual(['tool_calls', 'stop']);
  });

  test('maps non-stream finish_reason=length to response.incomplete', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        force_terminal_finish_reason: 'length',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'limited output' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.object).toBe('response');
    expect(body.status).toBe('incomplete');
    expect(body.incomplete_details.reason).toBe('max_output_tokens');
  });

  test('maps non-stream finish_reason=content_filter to response.incomplete', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        force_terminal_finish_reason: 'content_filter',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'filtered output' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.object).toBe('response');
    expect(body.status).toBe('incomplete');
    expect(body.incomplete_details.reason).toBe('content_filter');
  });

  test('maps non-stream finish_reason=error to response.failed', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        force_terminal_finish_reason: 'error',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'error output' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.object).toBe('response');
    expect(body.status).toBe('failed');
    expect(body.error.code).toBe('completion_terminated');
  });

  test('aggregates multi-choice terminal state with priority incomplete over completed', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        force_multi_choice_mixed_terminal: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'mixed terminal' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.object).toBe('response');
    expect(body.status).toBe('incomplete');
    expect(body.incomplete_details.reason).toBe('max_output_tokens');
    expect(body.metadata.finish_reasons).toEqual(['stop', 'length']);
  });

  test('emits response.incomplete when stream finish_reason is length', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        force_length_finish_stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'long answer' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
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
    const incomplete = payloads.find((event) => event.type === 'response.incomplete') as Record<string, unknown> | undefined;
    expect(incomplete).toBeDefined();

    const incompleteResponse = incomplete?.response as Record<string, unknown>;
    expect(incompleteResponse.status).toBe('incomplete');
    expect((incompleteResponse.incomplete_details as Record<string, unknown>).reason).toBe('max_output_tokens');
  });

  test('returns 400 for non-POST /v1/responses requests on compatibility route', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('only supports POST');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('returns 400 for unsupported /v1/responses/{id} resource endpoints', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses/resp_123', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('not supported');
    expect(mockedFetch.mock.calls).toHaveLength(0);
  });

  test('does not rewrite /responses short alias when allowShortPathAlias=false', async () => {
    const config = createShortPathConfig([
      {
        name: 'openai-messages-to-chat',
        options: {
          allowShortPathAlias: false
        }
      }
    ]);

    await reinitialize(config);

    const req = new Request('http://localhost/openai-compat-short/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      })
    });

    await handleRequest(req, config);

    const { url } = getForwardedCall();
    expect(url).toContain('/responses');
    expect(url).not.toContain('/v1/chat/completions');
  });

  test('keeps responses stream output_index consistent for tool-call-only chunks', async () => {
    const req = new Request('http://localhost/v1/openai-compat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        force_tool_call_stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Need weather' }] }]
      })
    });

    const response = await handleRequest(req, createConfig([{ name: 'openai-messages-to-chat' }]));
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

    const payloads = parseSSEJsonPayloads(allData);
    const added = payloads.find((event) => event.type === 'response.output_item.added' && (event as Record<string, unknown>).output_index === 1);
    const argsDelta = payloads.find((event) => event.type === 'response.function_call_arguments.delta' && (event as Record<string, unknown>).output_index === 1);
    const argsDone = payloads.find((event) => event.type === 'response.function_call_arguments.done' && (event as Record<string, unknown>).output_index === 1);
    const done = payloads.find((event) => event.type === 'response.output_item.done' && (event as Record<string, unknown>).output_index === 1);
    const messageDone = payloads.find((event) => event.type === 'response.output_item.done' && (event as Record<string, unknown>).output_index === 0);
    const completed = payloads.find((event) => event.type === 'response.completed') as Record<string, unknown> | undefined;

    expect(added).toBeDefined();
    expect(argsDelta).toBeDefined();
    expect(argsDone).toBeDefined();
    expect(messageDone).toBeDefined();
    expect(done).toBeDefined();
    expect(completed).toBeDefined();

    const argsDoneIndex = payloads.findIndex((event) => event.type === 'response.function_call_arguments.done' && (event as Record<string, unknown>).output_index === 1);
    const doneIndex = payloads.findIndex((event) => event.type === 'response.output_item.done' && (event as Record<string, unknown>).output_index === 1);
    expect(argsDoneIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(argsDoneIndex);

    const completedResponse = completed && typeof completed.response === 'object' && completed.response !== null
      ? completed.response as Record<string, unknown>
      : null;
    expect(completedResponse).not.toBeNull();

    const output = completedResponse?.output as Array<Record<string, unknown>>;
    expect(Array.isArray(output)).toBe(true);
    expect(output[0].type).toBe('message');
    expect(output[1].type).toBe('function_call');
  });
});
