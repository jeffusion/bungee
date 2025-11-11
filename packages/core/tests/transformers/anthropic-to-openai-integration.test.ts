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

// Mock config with anthropic-to-openai transformer
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/anthropic-to-openai',
      pathRewrite: { '^/v1/anthropic-to-openai': '/v1' },
      plugins: ['anthropic-to-openai'],
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

  test('should convert thinking content blocks to <thinking> tags', async () => {
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

    // Verify thinking tag extraction (按文档 3.2.1 OpenAI → Anthropic)
    expect(responseBody.content.length).toBeGreaterThan(1);
    expect(responseBody.content.some((c: any) => c.type === 'thinking')).toBe(true);
    expect(responseBody.content.some((c: any) => c.type === 'text')).toBe(true);
  });

  test('should convert thinking.budget_tokens to reasoning_effort', async () => {
    const originalLow = process.env.ANTHROPIC_TO_OPENAI_LOW_REASONING_THRESHOLD;
    const originalHigh = process.env.ANTHROPIC_TO_OPENAI_HIGH_REASONING_THRESHOLD;
    const originalMaxTokens = process.env.OPENAI_REASONING_MAX_TOKENS;

    process.env.ANTHROPIC_TO_OPENAI_LOW_REASONING_THRESHOLD = '4000';
    process.env.ANTHROPIC_TO_OPENAI_HIGH_REASONING_THRESHOLD = '12000';
    process.env.OPENAI_REASONING_MAX_TOKENS = '32000';

    try {
      const anthropicRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Complex reasoning task' }],
        max_tokens: 4096,
        thinking: {
          type: 'enabled',
          budget_tokens: 16000 // > 12000 → high
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

      // Verify thinking → reasoning conversion (按文档 3.1.1 → OpenAI)
      expect(forwardedBody.reasoning_effort).toBe('high');
      expect(forwardedBody.max_completion_tokens).toBe(4096);
    } finally {
      if (originalLow) process.env.ANTHROPIC_TO_OPENAI_LOW_REASONING_THRESHOLD = originalLow;
      else delete process.env.ANTHROPIC_TO_OPENAI_LOW_REASONING_THRESHOLD;
      if (originalHigh) process.env.ANTHROPIC_TO_OPENAI_HIGH_REASONING_THRESHOLD = originalHigh;
      else delete process.env.ANTHROPIC_TO_OPENAI_HIGH_REASONING_THRESHOLD;
      if (originalMaxTokens) process.env.OPENAI_REASONING_MAX_TOKENS = originalMaxTokens;
      else delete process.env.OPENAI_REASONING_MAX_TOKENS;
    }
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
});

console.log('✅ Anthropic to OpenAI integration tests created');
