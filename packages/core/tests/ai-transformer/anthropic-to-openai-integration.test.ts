/**
 * Anthropic to OpenAI Integration Tests
 *
 * Tests the complete request-response flow for anthropic-to-openai transformer
 * Based on specification in docs/ai-provider-conversion.md Section 3.1.1 (Anthropic → OpenAI)
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import { handleRequest, initializeRuntimeState, initializePluginRegistryForTests, cleanupPluginRegistry } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with ai-transformer plugin (anthropic to openai)
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/anthropic-to-openai',
      pathRewrite: { '^/v1/anthropic-to-openai': '/v1' },
      plugins: [
        {
          name: 'ai-transformer',
          options: {
            from: 'anthropic',
            to: 'openai'
          }
        }
      ],
      upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }]
    }
  ]
};

// Mock fetch responses
const mockedFetch = mock(async (request: Request | string, options?: RequestInit) => {
  const url = typeof request === 'string' ? request : request.url;

  let requestBody: any = {};
  if (options?.body) {
    try {
      const bodyString = typeof options.body === 'string' ? options.body : await new Response(options.body).text();
      requestBody = JSON.parse(bodyString);
    } catch (e) {
      console.error('Failed to parse request body:', e);
    }
  }

  if (url.includes('mock-openai.com')) {
    if (url.includes('/v1/responses/input_tokens')) {
      const countTokensResponse = {
        object: 'response.input_tokens',
        input_tokens: 23
      };

      return new Response(JSON.stringify(countTokensResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if it's a streaming request
    if (requestBody.stream) {
      const streamContent = [
        'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world!"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
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

    // Non-streaming response
    const openaiResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'This is a mock OpenAI response.'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40
      }
    };

    return new Response(JSON.stringify(openaiResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Not found', { status: 404 });
});

global.fetch = mockedFetch as any;

describe('Anthropic to OpenAI - Integration Tests', () => {
  beforeEach(async () => {
    setMockEnv();
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
    await initializePluginRegistryForTests(mockConfig);
  });

  afterEach(async () => {
    cleanupEnv();
    await cleanupPluginRegistry();
  });

  test('should convert basic Anthropic request to OpenAI and back', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'Hello, how are you?' }
      ],
      max_tokens: 100,
      temperature: 0.7
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();

    // Verify Anthropic response format (按文档 3.2.1 OpenAI → Anthropic)
    expect(responseBody.id).toBeDefined();
    expect(responseBody.type).toBe('message');
    expect(responseBody.role).toBe('assistant');
    expect(responseBody.content).toHaveLength(1);
    expect(responseBody.content[0].type).toBe('text');
    expect(responseBody.content[0].text).toBe('This is a mock OpenAI response.');
    expect(responseBody.stop_reason).toBe('end_turn'); // stop → end_turn
    expect(responseBody.usage.input_tokens).toBe(15);
    expect(responseBody.usage.output_tokens).toBe(25);

    // Verify the request was transformed to OpenAI format
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];

    expect(fetchUrl).toContain('mock-openai.com');
    expect(fetchUrl).toContain('/v1/chat/completions');

    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.model).toBe('gpt-4');
    expect(forwardedBody.messages).toHaveLength(2);
    expect(forwardedBody.messages[0].role).toBe('system');
    expect(forwardedBody.messages[0].content).toBe('You are a helpful assistant.');
    expect(forwardedBody.messages[1].role).toBe('user');
    expect(forwardedBody.messages[1].content).toBe('Hello, how are you?');
    expect(forwardedBody.max_tokens).toBe(100);
    expect(forwardedBody.temperature).toBe(0.7);
  });

  test('should map anthropic max_tokens_to_sample to openai max_tokens', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello with legacy token field' }
      ],
      max_tokens_to_sample: 321
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.max_tokens).toBe(321);
  });

  test('should not inject a fallback model when anthropic request has no model', async () => {
    const anthropicRequest = {
      messages: [
        { role: 'user', content: 'Hello without explicit model' }
      ]
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.model).toBeUndefined();
  });

  test('should keep fallback empty user message when anthropic request omits messages', async () => {
    const anthropicRequest = {
      model: 'gpt-4'
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.messages).toEqual([
      { role: 'user', content: '' }
    ]);
  });

  test('should apply configured model mapping for date-suffixed Anthropic model names', async () => {
    const mappedConfig: AppConfig = {
      routes: [
        {
          path: '/v1/anthropic-to-openai-mapped',
          pathRewrite: { '^/v1/anthropic-to-openai-mapped': '/v1' },
          plugins: [
            {
              name: 'model-mapping',
              options: {
                modelMappings: [
                  {
                    source: 'claude-sonnet-4-5',
                    target: 'gpt-5.3-codex'
                  }
                ]
              }
            },
            {
              name: 'ai-transformer',
              options: {
                from: 'anthropic',
                to: 'openai',
                anthropicToOpenAIApiMode: 'responses'
              }
            }
          ],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }]
        }
      ]
    };

    await cleanupPluginRegistry();
    initializeRuntimeState(mappedConfig);
    await initializePluginRegistryForTests(mappedConfig);

    const anthropicRequest = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'Map this model please.' }],
      max_tokens: 64
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai-mapped/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mappedConfig);
    expect(response.status).toBe(200);

    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    expect(fetchUrl).toContain('/v1/responses');

    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.model).toBe('gpt-5.3-codex');
  });

  test('should handle anthropic count_tokens via OpenAI usage prompt_tokens', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      system: 'Count tokens only',
      messages: [
        { role: 'user', content: 'Token count request' }
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather by city',
          input_schema: {
            type: 'object',
            properties: {
              city: { type: 'string' }
            }
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages/count_tokens', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();
    expect(responseBody).toEqual({ input_tokens: 15 });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    expect(fetchUrl).toContain('mock-openai.com');
    expect(fetchUrl).toContain('/v1/chat/completions');

    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.model).toBe('gpt-4');
    expect(Array.isArray(forwardedBody.messages)).toBe(true);
    expect(forwardedBody.tools).toEqual([
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
    ]);
    expect(forwardedBody.max_tokens).toBe(1);
    expect(forwardedBody.stream).toBe(false);
    expect(forwardedBody.reasoning_effort).toBeUndefined();
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
  });

  test('should convert tool_use to tool_calls', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_abc123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"NYC","unit":"celsius"}'
              }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'What is the weather in NYC?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'get_weather',
              input: { location: 'NYC', unit: 'celsius' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc',
              content: '{"temperature":10,"condition":"cloudy"}'
            }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // Verify tool_calls in response (按文档 3.2.1 OpenAI → Anthropic)
    expect(responseBody.content).toHaveLength(1);
    expect(responseBody.content[0].type).toBe('tool_use');
    expect(responseBody.content[0].name).toBe('get_weather');
    expect(responseBody.content[0].input).toEqual({ location: 'NYC', unit: 'celsius' });
    expect(responseBody.stop_reason).toBe('tool_use'); // tool_calls → tool_use

    // Verify request conversion
    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages[1].role).toBe('assistant');
    expect(forwardedBody.messages[1].tool_calls).toBeDefined();
    expect(forwardedBody.messages[1].tool_calls[0].function.name).toBe('get_weather');
    expect(forwardedBody.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_abc',
      content: '{"temperature":10,"condition":"cloudy"}'
    });
  });

  test('should convert tool_result to tool role messages', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: { location: 'SF' } }]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: '{"temperature":72,"condition":"sunny"}'
            }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tool_result → tool role (按文档 3.1.1 → OpenAI)
    const toolMsg = forwardedBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('toolu_123');
    expect(toolMsg.content).toContain('temperature');
  });

  test('should preserve assistant text when tool_use exists in same assistant content array', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Need weather and summary.' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will call a tool first.' },
            { type: 'tool_use', id: 'toolu_mix_1', name: 'get_weather', input: { location: 'NYC' } }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_mix_1',
              content: '{"temperature":22}'
            }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages[1].role).toBe('assistant');
    expect(forwardedBody.messages[1].content).toBe('I will call a tool first.');
    expect(forwardedBody.messages[1].tool_calls).toHaveLength(1);
    expect(forwardedBody.messages[1].tool_calls[0].function.name).toBe('get_weather');
  });

  test('should convert anthropic image source url using cc-switch base64 data URL fallback', async () => {
    const anthropicRequest = {
      model: 'gpt-4-vision',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'url',
                url: 'https://example.com/remote-image.jpg'
              }
            },
            { type: 'text', text: 'Describe this image.' }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages[0].content[0].type).toBe('image_url');
    expect(forwardedBody.messages[0].content[0].image_url.url).toBe('data:image/png;base64,');
    expect(forwardedBody.messages[0].content[1]).toEqual({ type: 'text', text: 'Describe this image.' });
  });

  test('should convert structured tool_result content to serialized tool message content', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Run OCR and return details.' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_ocr_1', name: 'ocr_image', input: { image: 'sample' } }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ocr_1',
              is_error: true,
              content: [
                { type: 'text', text: 'OCR failed due to low quality.' },
                {
                  type: 'image',
                  source: {
                    type: 'url',
                    url: 'https://example.com/ocr-failed.png'
                  }
                }
              ]
            }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    const toolMsg = forwardedBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('toolu_ocr_1');

    const parsedToolContent = JSON.parse(toolMsg.content);
    expect(parsedToolContent).toEqual([
      { type: 'text', text: 'OCR failed due to low quality.' },
      {
        type: 'image',
        source: {
          type: 'url',
          url: 'https://example.com/ocr-failed.png'
        }
      }
    ]);
  });

  test('should preserve non-tool user content when tool_result and text/image are mixed in same user message', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Start tool flow.' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_mix_keep_1', name: 'analyze_image', input: { imageId: 'img-1' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'This is additional context.' },
            {
              type: 'image',
              source: {
                type: 'url',
                url: 'https://example.com/context.jpg'
              }
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_mix_keep_1',
              content: { score: 0.99, status: 'ok' }
            }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    const toolMsg = forwardedBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('toolu_mix_keep_1');
    expect(JSON.parse(toolMsg.content)).toEqual({ score: 0.99, status: 'ok' });

    const extraUserMsg = forwardedBody.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content));
    expect(extraUserMsg).toBeDefined();
    expect(extraUserMsg.content).toEqual([
      { type: 'text', text: 'This is additional context.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' } }
    ]);

    expect(forwardedBody.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_mix_keep_1',
      content: '{"score":0.99,"status":"ok"}'
    });
    expect(forwardedBody.messages[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'This is additional context.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' } }
      ]
    });
  });

  test('should keep tool_result before trailing user text when same user content starts with tool_result', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Start tool flow.' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_order_1', name: 'search_docs', input: { query: 'x' } }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_order_1',
              content: 'ok'
            },
            { type: 'text', text: 'Also note this context.' }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_order_1',
      content: 'ok'
    });
    expect(forwardedBody.messages[3]).toEqual({
      role: 'user',
      content: 'Also note this context.'
    });
  });

  test('should skip tool_result blocks without tool_use_id', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              content: 'missing tool_use_id'
            },
            { type: 'text', text: 'fallback user text' }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: '',
        content: 'missing tool_use_id'
      },
      {
        role: 'user',
        content: 'fallback user text'
      }
    ]);
  });

  test('should preserve unmatched assistant tool_calls and tool-only message', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_unmatched', name: 'get_weather', input: { city: 'NYC' } }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'toolu_unmatched',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' }
        }]
      }
    ]);
  });

  test('should preserve assistant text with unmatched tool_calls', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I can still answer directly.' },
            { type: 'tool_use', id: 'toolu_unmatched_text', name: 'lookup', input: { query: 'x' } }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages).toHaveLength(2);
    expect(forwardedBody.messages[1]).toEqual({
      role: 'assistant',
      content: 'I can still answer directly.',
      tool_calls: [{
        id: 'toolu_unmatched_text',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"x"}' }
      }]
    });
  });

  test('should convert OpenAI response with both content and tool_calls into mixed Anthropic blocks', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-999',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'I will call a tool and summarize after.',
            tool_calls: [{
              id: 'call_mixed_1',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"NYC"}'
              }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Need weather.' }],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    expect(responseBody.content).toHaveLength(2);
    expect(responseBody.content[0]).toEqual({
      type: 'text',
      text: 'I will call a tool and summarize after.'
    });
    expect(responseBody.content[1]).toEqual({
      type: 'tool_use',
      id: 'call_mixed_1',
      name: 'get_weather',
      input: { location: 'NYC' }
    });
  });

  test('should fallback tool_use input to empty object when OpenAI tool arguments parse to non-object JSON', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1000',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_scalar_args',
              type: 'function',
              function: {
                name: 'parse_data',
                arguments: '123'
              }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'trigger tool call.' }],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    expect(responseBody.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_scalar_args',
      name: 'parse_data',
      input: {}
    });
  });

  test('should convert multi-modal base64 images to data URLs', async () => {
    const anthropicRequest = {
      model: 'gpt-4-vision',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: '/9j/4AAQSkZJRg=='
            }
          },
          { type: 'text', text: 'What is in this image?' }
        ]
      }],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify image conversion (按文档 3.1.1 → OpenAI)
    expect(forwardedBody.messages[0].content).toHaveLength(2);
    expect(forwardedBody.messages[0].content[0].type).toBe('image_url');
    expect(forwardedBody.messages[0].content[0].image_url.url).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    expect(forwardedBody.messages[0].content[1].type).toBe('text');
    expect(forwardedBody.messages[0].content[1].text).toBe('What is in this image?');
  });

  test('should keep thinking tags in chat completion text content', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Let me think...<thinking>Internal reasoning process</thinking>The answer is 42.'
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'What is the answer?' }],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    expect(responseBody.content).toEqual([{
      type: 'text',
      text: 'Let me think...<thinking>Internal reasoning process</thinking>The answer is 42.'
    }]);
  });

  test('should ignore chat completions reasoning fields outside content', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-reasoning-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-5.4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            reasoning_content: 'Need to compare implementations first.',
            content: 'Final answer from chat completions.'
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Need reasoning output in chat mode' }],
        max_tokens: 128
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();
    expect(responseBody.content).toEqual([{
      type: 'text',
      text: 'Final answer from chat completions.'
    }]);
  });

  test('should ignore chat completions reasoning_details outside content', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-reasoning-details-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-5.4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            reasoning_details: [
              { type: 'summary', text: 'First evaluate constraints.' },
              { summary: [{ text: 'Then compare trade-offs.' }] },
              { summary: 'Finally select the safest path.' }
            ],
            content: 'Final answer after structured reasoning.'
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 13, completion_tokens: 10, total_tokens: 23 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Need reasoning_details compatibility in chat mode' }],
        max_tokens: 128
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();
    expect(responseBody.content).toEqual([{
      type: 'text',
      text: 'Final answer after structured reasoning.'
    }]);
  });

  test('should infer reasoning_effort from thinking budget format', async () => {
    const anthropicRequest = {
      model: 'o3-mini',
      messages: [{ role: 'user', content: 'Complex reasoning task' }],
      max_tokens: 4096,
      thinking: {
        type: 'enabled',
        budget_tokens: 16000
      }
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.reasoning_effort).toBe('high');
    expect(forwardedBody.max_completion_tokens).toBe(4096);
    expect(forwardedBody.max_tokens).toBeUndefined();
  });

  test('should drop invalid reasoning format fields without guessing', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'invalid reasoning format' }],
        max_tokens: 256,
        thinking: {
          type: 'invalid_type',
          effort: 'invalid_effort'
        },
        output_config: {
          effort: 'invalid_effort'
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning_effort).toBeUndefined();
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBe(256);
  });

  test('should prioritize output_config effort over thinking effort when both are present', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'effort precedence check' }],
        max_tokens: 256,
        thinking: {
          type: 'enabled',
          effort: 'low'
        },
        output_config: {
          effort: 'max'
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning_effort).toBe('xhigh');
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBe(256);
  });

  test('should keep explicit reasoning_effort even when max_tokens is absent in chat mode', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'effort without token limit' }],
        thinking: {
          type: 'enabled',
          effort: 'high'
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning_effort).toBe('high');
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBeUndefined();
  });

  test('should keep explicit reasoning effort in responses mode when max_tokens is absent', async () => {
    const responsesConfig: AppConfig = {
      routes: [
        {
          path: '/v1/anthropic-to-openai-responses',
          pathRewrite: { '^/v1/anthropic-to-openai-responses': '/v1' },
          plugins: [
            {
              name: 'ai-transformer',
              options: {
                from: 'anthropic',
                to: 'openai',
                anthropicToOpenAIApiMode: 'responses'
              }
            }
          ],
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }]
        }
      ]
    };

    await cleanupPluginRegistry();
    initializeRuntimeState(responsesConfig);
    await initializePluginRegistryForTests(responsesConfig);

    const req = new Request('http://localhost/v1/anthropic-to-openai-responses/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'responses effort without token limit' }],
        output_config: {
          effort: 'high'
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, responsesConfig);

    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    expect(fetchUrl).toContain('/v1/responses');
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning).toEqual({ effort: 'high' });
    expect(forwardedBody.max_output_tokens).toBeUndefined();
  });

  test('should infer high reasoning_effort from enabled thinking budget default', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'max effort chat mode' }],
        max_tokens: 2048,
        thinking: {
          type: 'enabled'
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning_effort).toBe('high');
    expect(forwardedBody.max_completion_tokens).toBe(2048);
    expect(forwardedBody.max_tokens).toBeUndefined();
  });

  test('should preserve max reasoning_effort for gpt-5 codex model', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1-codex-max',
        messages: [{ role: 'user', content: 'max effort codex max model' }],
        max_tokens: 2048,
        thinking: {
          type: 'enabled',
          effort: 'max'
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning_effort).toBe('xhigh');
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBe(2048);
  });

  test('should map thinking effort max to xhigh reasoning_effort for gpt-5.2+ models', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'max effort gpt-5.4 model' }],
        max_tokens: 2048,
        thinking: {
          type: 'enabled',
          effort: 'max'
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning_effort).toBe('xhigh');
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBe(2048);
  });

  test('should not inject reasoning token limit when thinking is enabled but max_tokens is absent', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'thinking enabled without max tokens' }],
        thinking: {
          type: 'enabled',
          budget_tokens: 16000
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.reasoning_effort).toBe('high');
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBeUndefined();
  });

  test('should keep max_tokens for non-o model even when thinking budget is present', async () => {
    const anthropicRequest = {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Normal chat model request' }],
      max_tokens: 256,
      thinking: {
        type: 'enabled',
        budget_tokens: 8000
      }
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.reasoning_effort).toBeUndefined();
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBe(256);
  });

  test('should merge anthropic system array blocks into a single leading OpenAI system message', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      system: [
        { type: 'text', text: 'System block one.' },
        { type: 'text', text: 'System block two.' }
      ],
      messages: [
        { role: 'user', content: 'hello' }
      ],
      max_tokens: 50
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages[0]).toEqual({ role: 'system', content: 'System block one.\nSystem block two.' });
    expect(forwardedBody.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  test('should preserve empty tool_call id when anthropic tool_use id is missing', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Need tool call' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'lookup_weather', input: { city: 'NYC' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: '', content: '{"ok":true}' }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages[1].tool_calls).toHaveLength(1);
    expect(forwardedBody.messages[1].tool_calls[0].id).toBe('');
    expect(forwardedBody.messages[1].tool_calls[0].function.name).toBe('lookup_weather');
    expect(forwardedBody.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: '',
      content: '{"ok":true}'
    });
  });

  test('should convert stop_sequences to stop array', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      max_tokens: 100,
      stop_sequences: ['END', 'STOP', 'FINISH']
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify stop_sequences conversion (按文档 3.1.1 → OpenAI)
    expect(forwardedBody.stop).toEqual(['END', 'STOP', 'FINISH']);
  });

  test('should handle streaming response conversion', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      stream: true
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);

    // Verify it's a streaming response
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // Read the stream
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

    // Verify Anthropic SSE format (按文档 3.3.1 OpenAI chunk → Anthropic SSE)
    expect(allData).toContain('event: message_start');
    expect(allData).toContain('event: content_block_start');
    expect(allData).toContain('event: content_block_delta');
    expect(allData).toContain('event: message_stop');

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.stream_options).toBeUndefined();
  });

  test('should convert chat completions reasoning deltas into anthropic thinking deltas', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      const streamContent = [
        'data: {"id":"chatcmpl-reasoning-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"reasoning_content":"Need to inspect "},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"reasoning_content":"constraints."},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Final answer."},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
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
    });

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'stream reasoning in chat mode' }],
        max_tokens: 128,
        stream: true
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
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

    expect(allData).toContain('"type":"thinking"');
    expect(allData).toContain('"type":"thinking_delta"');
    expect(allData).toContain('"thinking":"Need to inspect "');
    expect(allData).toContain('"thinking":"constraints."');
    expect(allData).toContain('"type":"text_delta"');
    expect(allData).toContain('"text":"Final answer."');
  });

  test('should convert chat stream reasoning_details deltas in content parts into anthropic thinking deltas', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      const streamContent = [
        'data: {"id":"chatcmpl-reasoning-details-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-details-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":[{"type":"reasoning","text":"Need to inspect "}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-details-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":[{"type":"reasoning","delta":"constraints."}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-details-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Final answer."},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-reasoning-details-stream","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
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
    });

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'stream reasoning_details content parts in chat mode' }],
        max_tokens: 128,
        stream: true
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
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

    expect(allData).toContain('"type":"thinking"');
    expect(allData).toContain('"type":"thinking_delta"');
    expect(allData).toContain('"thinking":"Need to inspect"');
    expect(allData).toContain('"thinking":"constraints."');
    expect(allData).toContain('"type":"text_delta"');
    expect(allData).toContain('"text":"Final answer."');
  });

  test('should remove content-length header for transformed SSE responses', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      const streamContent = [
        'data: {"id":"chatcmpl-sse-length","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-sse-length","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-sse-length","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
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
        headers: {
          'Content-Type': 'text/event-stream',
          'Content-Length': String(streamContent.length)
        }
      });
    });

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'stream with upstream length' }],
        max_tokens: 100,
        stream: true
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('content-length')).toBeNull();
  });

  test('should preserve usage when OpenAI returns usage-only trailing stream chunk', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      const streamContent = [
        'data: {"id":"chatcmpl-usage-only","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-usage-only","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-usage-only","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chatcmpl-usage-only","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":4,"total_tokens":25}}\n\n',
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
    });

    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'usage chunk check' }],
      max_tokens: 100,
      stream: true
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
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

    expect(allData).toContain('event: message_delta');
    expect(allData).toContain('"input_tokens":21');
    expect(allData).toContain('"output_tokens":4');
    expect(allData).toContain('event: message_stop');
  });

  test('should emit synthetic end_turn when chat stream ends with [DONE] without finish_reason', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      const streamContent = [
        'data: {"id":"chatcmpl-no-finish","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-no-finish","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
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
    });

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'stream without finish reason' }],
        max_tokens: 100,
        stream: true
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
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

    expect(allData).toContain('event: message_delta');
    expect(allData).toContain('"stop_reason":"end_turn"');
    expect(allData).toContain('event: message_stop');
  });

  test('should emit early message_start and ping for responses progress events', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const responseCreated = {
          type: 'response.created',
          response: {
            id: 'resp_progress_1',
            model: 'gpt-5.4',
            status: 'in_progress'
          }
        };
        const responseInProgress = {
          type: 'response.in_progress',
          response: {
            id: 'resp_progress_1',
            model: 'gpt-5.4',
            status: 'in_progress'
          }
        };

        const streamContent = [
          'event: response.created\n',
          `data: ${JSON.stringify(responseCreated)}\n\n`,
          'event: response.in_progress\n',
          `data: ${JSON.stringify(responseInProgress)}\n\n`
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
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'long reasoning startup events' }],
          max_tokens: 128,
          stream: true
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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

      expect(allData).toContain('event: message_start');
      expect(allData).not.toContain('event: ping');
      expect(allData).toContain('"stop_reason":"end_turn"');
      expect(allData).toContain('event: message_stop');
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should close responses stream with anthropic terminal events when upstream aborts after progress', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const responseCreated = {
          type: 'response.created',
          response: {
            id: 'resp_abort_after_progress_1',
            model: 'gpt-5.4',
            status: 'in_progress'
          }
        };

        let emittedCreated = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emittedCreated) {
              emittedCreated = true;
              controller.enqueue(new TextEncoder().encode(
                `event: response.created\n` +
                `data: ${JSON.stringify(responseCreated)}\n\n`
              ));
              return;
            }

            controller.error(new Error('simulated upstream abort after progress'));
          }
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'abort after progress should still terminate cleanly' }],
          max_tokens: 128,
          stream: true
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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

      expect(allData).toContain('event: message_start');
      expect(allData).toContain('event: message_delta');
      expect(allData).toContain('"stop_reason":"end_turn"');
      expect(allData).toContain('event: message_stop');
      expect(allData).not.toContain('data: [DONE]');
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should handle tools parameter conversion', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Get weather' }],
      max_tokens: 100,
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather',
          input_schema: {
            type: 'object',
            properties: {
              location: { type: 'string' }
            },
            required: ['location']
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tools conversion (按文档 3.1.1 → OpenAI)
    expect(forwardedBody.tools).toBeDefined();
    expect(forwardedBody.tools[0].type).toBe('function');
    expect(forwardedBody.tools[0].function.name).toBe('get_weather');
    expect(forwardedBody.tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location']
    });
  });

  test('should normalize tool object schema without properties for OpenAI compatibility', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Run no-arg tool' }],
      max_tokens: 100,
      tools: [
        {
          name: 'mcp__pencil__get_style_guide_tags',
          description: 'Get style guide tags',
          input_schema: {
            type: 'object'
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.tools).toHaveLength(1);
    expect(forwardedBody.tools[0].function.name).toBe('mcp__pencil__get_style_guide_tags');
    expect(forwardedBody.tools[0].function.parameters).toEqual({
      type: 'object',
      properties: {}
    });
  });

  test('should align OpenAI-compatible request metadata with cc-switch proxy conversion', async () => {
    const anthropicRequest = {
      model: 'gpt-4',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.120; cch=abc;\nProject instructions',
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: 'Hello with cache metadata',
          cache_control: { type: 'ephemeral', ttl: '5m' }
        }]
      }],
      max_tokens: 100,
      metadata: { prompt_cache_key: 'provider-cache-key' },
      tools: [
        {
          type: 'BatchTool',
          name: 'batch_tool',
          input_schema: { type: 'object' }
        },
        {
          name: 'fetch_url',
          description: 'Fetch URL',
          input_schema: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri' }
            }
          },
          cache_control: { type: 'ephemeral' }
        }
      ]
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.prompt_cache_key).toBe('provider-cache-key');
    expect(forwardedBody.messages[0]).toEqual({
      role: 'system',
      content: 'Project instructions',
      cache_control: { type: 'ephemeral' }
    });
    expect(forwardedBody.messages[1].content).toEqual([{
      type: 'text',
      text: 'Hello with cache metadata',
      cache_control: { type: 'ephemeral', ttl: '5m' }
    }]);
    expect(forwardedBody.tools).toHaveLength(1);
    expect(forwardedBody.tools[0].function.name).toBe('fetch_url');
    expect(forwardedBody.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(forwardedBody.tools[0].function.parameters.properties.url).toEqual({ type: 'string' });
  });

  test('should route to OpenAI responses API when ANTHROPIC_TO_OPENAI_API_MODE=responses', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_123',
        object: 'response',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'This is a responses API answer.' }
            ]
          }
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 8
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    try {
      const anthropicRequest = {
        model: 'gpt-4.1',
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'Hello responses endpoint' }],
        max_tokens: 128,
        temperature: 0.3
      };

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify(anthropicRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
      expect(response.status).toBe(200);

      const responseBody = await response.json();
      expect(responseBody.type).toBe('message');
      expect(responseBody.content[0]).toEqual({
        type: 'text',
        text: 'This is a responses API answer.'
      });
      expect(responseBody.usage.input_tokens).toBe(12);
      expect(responseBody.usage.output_tokens).toBe(8);

      const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
      expect(fetchUrl).toContain('/v1/responses');
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.model).toBe('gpt-4.1');
      expect(forwardedBody.max_output_tokens).toBe(128);
      expect(forwardedBody.input).toBeDefined();
      expect(forwardedBody.instructions).toBe('Be concise.');
      expect(forwardedBody.input).toEqual([{
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello responses endpoint' }]
      }]);
      expect(forwardedBody.messages).toBeUndefined();
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should convert responses reasoning summary items to anthropic thinking blocks', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_reasoning_summary_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.4',
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [
              {
                type: 'summary_text',
                text: 'Need to compare options first.'
              }
            ]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Final answer from responses.' }]
          }
        ],
        usage: {
          input_tokens: 14,
          output_tokens: 9
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    try {
      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'show reasoning summary please' }],
          max_tokens: 128,
          output_config: {
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
      expect(response.status).toBe(200);

      const responseBody = await response.json();
      expect(responseBody.content.some((block: any) => block.type === 'thinking' && block.thinking.includes('Need to compare options first.'))).toBe(true);
      expect(responseBody.content.some((block: any) => block.type === 'text' && block.text.includes('Final answer from responses.'))).toBe(true);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should convert responses reasoning stream events into anthropic thinking deltas', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const streamContent = [
          'event: response.output_item.added\n',
          'data: {"type":"response.output_item.added","response_id":"resp_reasoning_stream_1","output_index":0,"item":{"type":"reasoning","id":"rs_stream_1","summary":[]}}\n\n',
          'event: response.reasoning_summary_text.delta\n',
          'data: {"type":"response.reasoning_summary_text.delta","response_id":"resp_reasoning_stream_1","output_index":0,"item_id":"rs_stream_1","delta":"Need to inspect "}\n\n',
          'event: response.reasoning_summary_text.delta\n',
          'data: {"type":"response.reasoning_summary_text.delta","response_id":"resp_reasoning_stream_1","output_index":0,"item_id":"rs_stream_1","delta":"constraints."}\n\n',
          'event: response.output_text.delta\n',
          'data: {"type":"response.output_text.delta","response_id":"resp_reasoning_stream_1","output_index":1,"delta":"Final answer."}\n\n',
          'event: response.completed\n',
          'data: {"type":"response.completed","response":{"id":"resp_reasoning_stream_1","model":"gpt-5.4","usage":{"input_tokens":17,"output_tokens":5}}}\n\n'
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
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'stream reasoning summary please' }],
          max_tokens: 128,
          stream: true,
          output_config: {
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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

      expect(allData).toContain('"type":"thinking"');
      expect(allData).toContain('"type":"thinking_delta"');
      expect(allData).toContain('"thinking":"Need to inspect "');
      expect(allData).toContain('"thinking":"constraints."');
      expect(allData).toContain('"type":"text_delta"');
      expect(allData).toContain('"text":"Final answer."');
      expect(allData).toContain('"input_tokens":17');
      expect(allData).toContain('"output_tokens":5');

      const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
      expect(fetchUrl).toContain('/v1/responses');
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should prefer plugin api mode setting over environment variable for A2O routing', async () => {
    setMockEnv();
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'chat_completions';

    const configWithPluginMode: AppConfig = JSON.parse(JSON.stringify(mockConfig));
    const firstRoute = configWithPluginMode.routes?.[0];
    const firstPlugin = firstRoute && Array.isArray(firstRoute.plugins) ? firstRoute.plugins[0] : undefined;
    if (!firstRoute || !firstPlugin || typeof firstPlugin === 'string') {
      throw new Error('Invalid test config for ai-transformer plugin');
    }
    const nextOptions = typeof firstPlugin.options === 'object' && firstPlugin.options !== null
      ? { ...firstPlugin.options }
      : {};
    nextOptions.anthropicToOpenAIApiMode = 'responses';
    firstPlugin.options = nextOptions;

    await cleanupPluginRegistry();
    initializeRuntimeState(configWithPluginMode);
    await initializePluginRegistryForTests(configWithPluginMode);

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_plugin_mode_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'plugin mode wins' }]
          }
        ],
        usage: { input_tokens: 5, output_tokens: 2 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'plugin mode check' }],
        max_tokens: 32
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, configWithPluginMode);
    expect(response.status).toBe(200);

    const [fetchUrl] = mockedFetch.mock.calls[0];
    expect(fetchUrl).toContain('/v1/responses');
    expect(fetchUrl).not.toContain('/v1/chat/completions');
  });

  test('should ignore removed A2O threshold options and not infer effort from budget_tokens', async () => {
    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'budget tokens without explicit effort' }],
        max_tokens: 128,
        thinking: {
          type: 'enabled',
          budget_tokens: 1500
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.reasoning_effort).toBe('low');
    expect(forwardedBody.max_completion_tokens).toBeUndefined();
    expect(forwardedBody.max_tokens).toBe(128);
  });

  test('should keep responses endpoint when responses mode is enabled and stream=true', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const streamContent = [
          'event: response.output_text.delta\n',
          'data: {"type":"response.output_text.delta","response_id":"resp_stream_1","delta":"Hello"}\n\n',
          'event: response.output_text.delta\n',
          'data: {"type":"response.output_text.delta","response_id":"resp_stream_1","delta":" world"}\n\n',
          'event: response.completed\n',
          'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-4.1","usage":{"input_tokens":11,"output_tokens":2}}}\n\n'
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
      });

      const anthropicRequest = {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'stream please' }],
        max_tokens: 64,
        stream: true
      };

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify(anthropicRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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
      expect(allData).toContain('event: content_block_delta');
      expect(allData).toContain('"text":"Hello"');
      expect(allData).toContain('"text":" world"');
      expect(allData).toContain('"input_tokens":11');
      expect(allData).toContain('"output_tokens":2');

      const [fetchUrl] = mockedFetch.mock.calls[0];
      expect(fetchUrl).toContain('/v1/responses');
      expect(fetchUrl).not.toContain('/v1/chat/completions');
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should keep responses endpoint for reasoning stream when responses mode is enabled', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'reasoning stream fallback check' }],
          max_tokens: 128,
          stream: true,
          output_config: {
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
      expect(fetchUrl).toContain('/v1/responses');
      expect(fetchUrl).not.toContain('/v1/chat/completions');

      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.stream).toBe(true);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
      expect(forwardedBody.max_output_tokens).toBe(128);
      expect(forwardedBody.max_tokens).toBeUndefined();
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should include reasoning fields for streaming requests by default', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'stream reasoning disabled by default' }],
          max_tokens: 128,
          stream: true,
          output_config: {
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
      expect(response.status).toBe(200);

      const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
      expect(fetchUrl).toContain('/v1/responses');

      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
      expect(forwardedBody.max_output_tokens).toBe(128);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should convert responses stream function-call events into anthropic tool_use blocks', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const outputItemAdded = {
          type: 'response.output_item.added',
          response_id: 'resp_tool_stream_1',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_weather_1',
            name: 'get_weather',
            arguments: ''
          }
        };
        const functionArgsDelta = {
          type: 'response.function_call_arguments.delta',
          response_id: 'resp_tool_stream_1',
          output_index: 0,
          item_id: 'fc_1',
          delta: '{"city":"Shanghai"}'
        };
        const outputItemDone = {
          type: 'response.output_item.done',
          response_id: 'resp_tool_stream_1',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_weather_1',
            name: 'get_weather',
            arguments: '{"city":"Shanghai"}'
          }
        };
        const responseCompleted = {
          type: 'response.completed',
          response: {
            id: 'resp_tool_stream_1',
            model: 'gpt-4.1',
            usage: {
              input_tokens: 16,
              output_tokens: 3
            }
          }
        };

        const streamContent = [
          'event: response.output_item.added\n',
          `data: ${JSON.stringify(outputItemAdded)}\n\n`,
          'event: response.function_call_arguments.delta\n',
          `data: ${JSON.stringify(functionArgsDelta)}\n\n`,
          'event: response.output_item.done\n',
          `data: ${JSON.stringify(outputItemDone)}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify(responseCompleted)}\n\n`
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
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'stream tool call' }],
          tools: [{
            name: 'get_weather',
            description: 'Get weather by city',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string' }
              }
            }
          }],
          max_tokens: 64,
          stream: true
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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

      expect(allData).toContain('event: content_block_start');
      expect(allData).toContain('"type":"tool_use"');
      expect(allData).toContain('"name":"get_weather"');
      expect(allData).toContain('"id":"call_weather_1"');
      expect(allData).toContain('"partial_json":"{\\"city\\":\\"Shanghai\\"}"');
      expect(allData).toContain('"stop_reason":"tool_use"');

      const jsonDeltaMatches = allData.match(/"type":"input_json_delta"/g) ?? [];
      expect(jsonDeltaMatches.length).toBeGreaterThan(0);

      const [fetchUrl] = mockedFetch.mock.calls[0];
      expect(fetchUrl).toContain('/v1/responses');
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should emit tool_use from responses function_call_arguments.done when delta is absent', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const outputItemAdded = {
          type: 'response.output_item.added',
          response_id: 'resp_tool_done_only_1',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_done_1',
            call_id: 'call_lookup_1',
            name: 'lookup_weather',
            arguments: ''
          }
        };
        const argsDone = {
          type: 'response.function_call_arguments.done',
          response_id: 'resp_tool_done_only_1',
          output_index: 0,
          item_id: 'fc_done_1',
          call_id: 'call_lookup_1',
          name: 'lookup_weather',
          arguments: '{"city":"Beijing"}'
        };
        const outputItemDone = {
          type: 'response.output_item.done',
          response_id: 'resp_tool_done_only_1',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_done_1',
            call_id: 'call_lookup_1',
            name: 'lookup_weather',
            arguments: '{"city":"Beijing"}'
          }
        };
        const responseCompleted = {
          type: 'response.completed',
          response: {
            id: 'resp_tool_done_only_1',
            model: 'gpt-4.1',
            usage: {
              input_tokens: 9,
              output_tokens: 2
            }
          }
        };

        const streamContent = [
          'event: response.output_item.added\n',
          `data: ${JSON.stringify(outputItemAdded)}\n\n`,
          'event: response.function_call_arguments.done\n',
          `data: ${JSON.stringify(argsDone)}\n\n`,
          'event: response.output_item.done\n',
          `data: ${JSON.stringify(outputItemDone)}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify(responseCompleted)}\n\n`
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
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'done-only tool call' }],
          max_tokens: 64,
          stream: true
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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

      expect(allData).toContain('"type":"tool_use"');
      expect(allData).toContain('"id":"call_lookup_1"');
      expect(allData).toContain('"name":"lookup_weather"');
      expect(allData).toContain('"partial_json":"{\\"city\\":\\"Beijing\\"}"');
      expect(allData).toContain('"stop_reason":"tool_use"');

      const jsonDeltaMatches = allData.match(/"type":"input_json_delta"/g) ?? [];
      expect(jsonDeltaMatches.length).toBeGreaterThan(0);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should ignore late responses function_call_arguments.delta after done', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const outputItemAdded = {
          type: 'response.output_item.added',
          response_id: 'resp_tool_late_delta_1',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_late_delta_1',
            call_id: 'call_late_delta_1',
            name: 'lookup_weather',
            arguments: ''
          }
        };
        const argsDone = {
          type: 'response.function_call_arguments.done',
          response_id: 'resp_tool_late_delta_1',
          output_index: 0,
          item_id: 'fc_late_delta_1',
          call_id: 'call_late_delta_1',
          name: 'lookup_weather',
          arguments: '{"city":"Beijing"}'
        };
        const lateDelta = {
          type: 'response.function_call_arguments.delta',
          response_id: 'resp_tool_late_delta_1',
          output_index: 0,
          item_id: 'fc_late_delta_1',
          call_id: 'call_late_delta_1',
          name: 'lookup_weather',
          delta: '{"city":"Shanghai"}'
        };
        const responseCompleted = {
          type: 'response.completed',
          response: {
            id: 'resp_tool_late_delta_1',
            model: 'gpt-4.1',
            usage: {
              input_tokens: 9,
              output_tokens: 2
            }
          }
        };

        const streamContent = [
          'event: response.output_item.added\n',
          `data: ${JSON.stringify(outputItemAdded)}\n\n`,
          'event: response.function_call_arguments.done\n',
          `data: ${JSON.stringify(argsDone)}\n\n`,
          'event: response.function_call_arguments.delta\n',
          `data: ${JSON.stringify(lateDelta)}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify(responseCompleted)}\n\n`
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
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'ignore late delta after done' }],
          max_tokens: 64,
          stream: true
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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

      expect(allData).toContain('"partial_json":"{\\"city\\":\\"Beijing\\"}"');
      expect(allData).not.toContain('"partial_json":"{\\"city\\":\\"Shanghai\\"}"');

      const jsonDeltaMatches = allData.match(/"type":"input_json_delta"/g) ?? [];
      expect(jsonDeltaMatches.length).toBe(1);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should ignore duplicate responses terminal events after completion', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const outputItemAdded = {
          type: 'response.output_item.added',
          response_id: 'resp_terminal_dupe_1',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_terminal_dupe_1',
            call_id: 'call_terminal_dupe_1',
            name: 'lookup_weather',
            arguments: ''
          }
        };
        const argsDone = {
          type: 'response.function_call_arguments.done',
          response_id: 'resp_terminal_dupe_1',
          output_index: 0,
          item_id: 'fc_terminal_dupe_1',
          call_id: 'call_terminal_dupe_1',
          name: 'lookup_weather',
          arguments: '{"city":"Beijing"}'
        };
        const responseCompleted = {
          type: 'response.completed',
          response: {
            id: 'resp_terminal_dupe_1',
            model: 'gpt-4.1',
            usage: {
              input_tokens: 9,
              output_tokens: 2
            }
          }
        };

        const streamContent = [
          'event: response.output_item.added\n',
          `data: ${JSON.stringify(outputItemAdded)}\n\n`,
          'event: response.function_call_arguments.done\n',
          `data: ${JSON.stringify(argsDone)}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify(responseCompleted)}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify(responseCompleted)}\n\n`
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
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'ignore duplicate completed event' }],
          max_tokens: 64,
          stream: true
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
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

      const messageStartMatches = allData.match(/"type":"message_start"/g) ?? [];
      const messageDeltaMatches = allData.match(/"type":"message_delta"/g) ?? [];
      const messageStopMatches = allData.match(/"type":"message_stop"/g) ?? [];

      expect(messageStartMatches.length).toBe(1);
      expect(messageDeltaMatches.length).toBe(1);
      expect(messageStopMatches.length).toBe(1);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should keep reasoning mapping when streaming responses tool calls with output_config effort', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    try {
      mockedFetch.mockImplementationOnce(async () => {
        const outputItemAdded = {
          type: 'response.output_item.added',
          response_id: 'resp_reasoning_tool_1',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_reasoning_1',
            call_id: 'call_reasoning_1',
            name: 'run_check',
            arguments: ''
          }
        };
        const argsDone = {
          type: 'response.function_call_arguments.done',
          response_id: 'resp_reasoning_tool_1',
          output_index: 0,
          item_id: 'fc_reasoning_1',
          call_id: 'call_reasoning_1',
          name: 'run_check',
          arguments: '{"target":"repo"}'
        };
        const responseCompleted = {
          type: 'response.completed',
          response: {
            id: 'resp_reasoning_tool_1',
            model: 'gpt-5-codex-max',
            usage: {
              input_tokens: 21,
              output_tokens: 4
            }
          }
        };

        const streamContent = [
          'event: response.output_item.added\n',
          `data: ${JSON.stringify(outputItemAdded)}\n\n`,
          'event: response.function_call_arguments.done\n',
          `data: ${JSON.stringify(argsDone)}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify(responseCompleted)}\n\n`
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
      });

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5-codex-max',
          messages: [{ role: 'user', content: 'stream tool call with reasoning' }],
          tools: [{
            name: 'run_check',
            description: 'Run a repository check',
            input_schema: {
              type: 'object',
              properties: {
                target: { type: 'string' }
              }
            }
          }],
          max_tokens: 128,
          output_config: {
            effort: 'max'
          },
          stream: true
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await handleRequest(req, mockConfig);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
      expect(forwardedBody.max_output_tokens).toBe(128);
      expect(forwardedBody.tools?.[0]?.name).toBe('run_check');

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

      expect(allData).toContain('"type":"tool_use"');
      expect(allData).toContain('"name":"run_check"');
      expect(allData).toContain('"partial_json":"{\\"target\\":\\"repo\\"}"');
      expect(allData).toContain('"stop_reason":"tool_use"');

      const [fetchUrl] = mockedFetch.mock.calls[0];
      expect(fetchUrl).toContain('/v1/responses');
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should keep temperature and top_p in responses mode without model-based stripping', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_reasoning_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }]
          }
        ],
        usage: { input_tokens: 4, output_tokens: 2 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    try {
      const anthropicRequest = {
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'reasoning please' }],
        max_tokens: 200,
        temperature: 0.9,
        top_p: 0.8
      };

      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify(anthropicRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      await handleRequest(req, mockConfig);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.model).toBe('o3-mini');
      expect(forwardedBody.temperature).toBe(0.9);
      expect(forwardedBody.top_p).toBe(0.8);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should preserve thinking effort max in responses mode', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_reasoning_max_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ],
        usage: { input_tokens: 8, output_tokens: 4 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    try {
      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'o3-mini',
          messages: [{ role: 'user', content: 'reasoning max please' }],
          max_tokens: 512,
          thinking: {
            type: 'enabled',
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      await handleRequest(req, mockConfig);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
      expect(forwardedBody.max_output_tokens).toBe(512);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should map output_config effort max to high reasoning effort in responses mode for models without xhigh support', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_output_config_effort_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ],
        usage: { input_tokens: 8, output_tokens: 4 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    try {
      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'o3-mini',
          messages: [{ role: 'user', content: 'output config effort max please' }],
          max_tokens: 512,
          output_config: {
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      await handleRequest(req, mockConfig);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
      expect(forwardedBody.max_output_tokens).toBe(512);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should map output_config effort max to xhigh reasoning effort for codex-max models in responses mode', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_output_config_effort_codex_max_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.1-codex-max',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ],
        usage: { input_tokens: 8, output_tokens: 4 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    try {
      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.1-codex-max',
          messages: [{ role: 'user', content: 'output config effort max codex model' }],
          max_tokens: 512,
          output_config: {
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      await handleRequest(req, mockConfig);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
      expect(forwardedBody.max_output_tokens).toBe(512);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should map output_config effort max to xhigh reasoning effort for gpt-5.2+ models in responses mode', async () => {
    const originalApiMode = process.env.ANTHROPIC_TO_OPENAI_API_MODE;
    process.env.ANTHROPIC_TO_OPENAI_API_MODE = 'responses';

    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'resp_output_config_effort_gpt54_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ],
        usage: { input_tokens: 8, output_tokens: 4 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    try {
      const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'output config effort max gpt-5.4 model' }],
          max_tokens: 512,
          output_config: {
            effort: 'max'
          }
        }),
        headers: { 'Content-Type': 'application/json' }
      });

      await handleRequest(req, mockConfig);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);
      expect(forwardedBody.reasoning).toEqual({ effort: 'xhigh' });
      expect(forwardedBody.max_output_tokens).toBe(512);
    } finally {
      if (originalApiMode !== undefined) {
        process.env.ANTHROPIC_TO_OPENAI_API_MODE = originalApiMode;
      } else {
        delete process.env.ANTHROPIC_TO_OPENAI_API_MODE;
      }
    }
  });

  test('should map anthropic tool_choice type=tool to OpenAI function tool_choice', async () => {
    const anthropicRequest = {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Call the weather tool' }],
      max_tokens: 64,
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather by city',
          input_schema: {
            type: 'object',
            properties: {
              city: { type: 'string' }
            }
          }
        }
      ],
      tool_choice: {
        type: 'tool',
        name: 'get_weather'
      }
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.tool_choice).toEqual({
      type: 'tool',
      name: 'get_weather'
    });
  });

  test('should convert OpenAI response image_url parts to Anthropic image blocks', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-image-1',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4.1',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: 'https://example.com/assistant-image.png'
                }
              },
              {
                type: 'text',
                text: 'Here is the image analysis.'
              }
            ]
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          total_tokens: 30
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const anthropicRequest = {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Return multimodal response' }],
      max_tokens: 64
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    expect(responseBody.content[0]).toEqual({
      type: 'text',
      text: 'Here is the image analysis.'
    });
  });

  test('should convert OpenAI non-2xx error body to Anthropic error shape', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        error: {
          message: 'Invalid schema for function parameter',
          type: 'invalid_request_error'
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const anthropicRequest = {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'trigger upstream bad request' }],
      max_tokens: 64
    };

    const req = new Request('http://localhost/v1/anthropic-to-openai/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(400);

    const responseBody = await response.json();
    expect(responseBody).toEqual({
      type: 'error',
      error: {
          type: 'invalid_request_error',
        message: 'Invalid schema for function parameter'
      }
    });
  });
});

console.log('✅ Anthropic to OpenAI integration tests created');
