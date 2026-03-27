import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import {
  cleanupPluginRegistry,
  handleRequest,
  initializePluginRegistryForTests,
  initializeRuntimeState,
} from '../../src/worker';

const originalFetch = globalThis.fetch;

const mockedFetch = mock(async (_request: Request | string, _options?: RequestInit) => {
  return new Response(
    JSON.stringify({ id: 'resp_mock', object: 'response' }),
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
        path: '/v1/responses-guard',
        pathRewrite: { '^/v1/responses-guard': '/v1' },
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

describe('openai-responses-guard plugin', () => {
  beforeEach(async () => {
    globalThis.fetch = mockedFetch as unknown as typeof fetch;
    await reinitialize(createConfig([{ name: 'openai-responses-guard' }]));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupPluginRegistry();
  });

  test('fills assistant tool call reasoning_content from thinking tags in reasoning context', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { url, options } = getForwardedCall();
    expect(url).toContain('/v1/responses');
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(input[1].reasoning_content).toBe('Need weather tool before final answer.');
  });

  test('defaults assistant tool call reasoning_content to empty string in reasoning context', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(Object.prototype.hasOwnProperty.call(input[0], 'reasoning_content')).toBe(true);
    expect(input[0].reasoning_content).toBe('');
  });

  test('keeps assistant tool call message untouched when reasoning context is absent', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(Object.prototype.hasOwnProperty.call(input[0], 'reasoning_content')).toBe(false);
  });

  test('fills reasoning_content for assistant tool-use blocks in input content', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(input[0].reasoning_content).toBe('Need to call weather tool first.');
  });

  test('fills reasoning_content when tool_calls is JSON string and thinking.enabled=true', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(input[0].reasoning_content).toBe('');
  });

  test('fills reasoning_content for assistant tool calls in messages field', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const messages = forwardedBody.messages as Array<Record<string, unknown>>;

    expect(messages[0].reasoning_content).toBe('');
  });

  test('fills reasoning_content when enable_thinking is enabled string', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(input[0].reasoning_content).toBe('');
  });

  test('fills reasoning_content when tool_calls is object', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(input[0].reasoning_content).toBe('');
  });

  test('fills reasoning_content when content has custom *_call block', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(input[0].reasoning_content).toBe('Need one internal call.');
  });

  test('fills reasoning_content for nested message wrapper shape', async () => {
    const req = new Request('http://localhost/v1/responses-guard/responses', {
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

    await handleRequest(req, createConfig([{ name: 'openai-responses-guard' }]));

    const { options } = getForwardedCall();
    const forwardedBody = await readForwardedBody(options);
    const input = forwardedBody.input as Array<Record<string, unknown>>;
    const wrappedMessage = input[0].message as Record<string, unknown>;

    expect(wrappedMessage.reasoning_content).toBe('');
  });

  test('respects trimWhitespace=false option', async () => {
    const config = createConfig([
      {
        name: 'openai-responses-guard',
        options: {
          trimWhitespace: false
        }
      }
    ]);

    await reinitialize(config);

    const req = new Request('http://localhost/v1/responses-guard/responses', {
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
    const input = forwardedBody.input as Array<Record<string, unknown>>;

    expect(input[0].reasoning_content).toBe('  preserve-space  ');
  });
});
