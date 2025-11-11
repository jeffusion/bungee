/**
 * Routing Integration Tests
 *
 * Tests architecture-level features that involve routing, path rewriting,
 * and transformer plugin integration. This is distinct from individual
 * transformer tests which focus on format conversion logic.
 *
 * Covers:
 * - pathRewrite functionality (http-proxy-middleware style)
 * - pathRewrite + transformer combination scenarios
 * - Environment variable validation for plugins
 * - Detailed streaming response SSE event sequences
 * - Error response format transformation
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { PluginContext } from '../src/plugin.types';
import { OpenAIToAnthropicPlugin } from '../src/plugins/transformers/openai-to-anthropic.plugin';
import { handleRequest, initializeRuntimeState, initializePluginRegistryForTests, cleanupPluginRegistry } from '../src/worker';

// Mock config for routing tests
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/anthropic-proxy',
      pathRewrite: { '^/v1/anthropic-proxy': '/v1' },
      plugins: ['anthropic-to-openai'],
      upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/openai-proxy',
      pathRewrite: { '^/v1/openai-proxy': '/v1' },
      plugins: ['openai-to-anthropic'],
      upstreams: [{ target: 'http://mock-anthropic.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/gemini-proxy',
      pathRewrite: { '^/v1/gemini-proxy': '/v1' },
      plugins: ['anthropic-to-gemini'],
      upstreams: [{ target: 'http://mock-gemini.com', weight: 100, priority: 1 }],
    },
    {
      path: '/api',
      pathRewrite: {
        '^/api/v1': '/v1-internal',
        '^/api': ''
      },
      upstreams: [{
        target: 'http://mock-rewrite-target.com',
        weight: 100,
        priority: 1
      }]
    },
  ],
};

// Mock the global fetch
const mockedFetch = mock(async (request: Request | string, options?: RequestInit) => {
  const url = typeof request === 'string' ? request : request.url;

  let requestBody: any = {};
  if (options?.body) {
    let bodyString = '';
    if (typeof options.body === 'string') {
      bodyString = options.body;
    } else if (options.body instanceof ReadableStream) {
      const reader = options.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyString += decoder.decode(value);
      }
    }
    if (bodyString) {
      try {
        requestBody = JSON.parse(bodyString);
      } catch (e) {
        console.error("Failed to parse body string:", bodyString);
        throw e;
      }
    }
  }

  if (url.startsWith('http://mock-openai.com')) {
    const openAIResponse = {
      choices: [{ message: { content: 'Mock OpenAI response.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };
    return new Response(JSON.stringify(openAIResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://mock-anthropic.com')) {
    const anthropicResponse = {
      id: 'msg_abc123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Mock Anthropic response.' }],
      model: 'claude-3-opus-20240229',
      stop_reason: 'end_turn',
      usage: { input_tokens: 15, output_tokens: 25 },
    };
    return new Response(JSON.stringify(anthropicResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://mock-gemini.com')) {
    const geminiResponse = {
      candidates: [{ content: { parts: [{ text: 'Mock Gemini response.' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 25 },
    };
    return new Response(JSON.stringify(geminiResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://mock-rewrite-target.com')) {
    return new Response('path rewrite success', { status: 200 });
  }

  return new Response('proxied', { status: 200 });
});
global.fetch = mockedFetch as any;

describe('Path Rewrite Functionality', () => {
  beforeEach(async () => {
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
    await initializePluginRegistryForTests(mockConfig);
  });

  afterEach(async () => {
    await cleanupPluginRegistry();
  });

  test('should rewrite path using http-proxy-middleware style rules', async () => {
    // Test first rule: ^/api/v1 -> /v1-internal
    const req1 = new Request('http://localhost/api/v1/users', { method: 'GET' });
    await handleRequest(req1, mockConfig);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl1] = mockedFetch.mock.calls[0];
    expect(fetchUrl1).toBe('http://mock-rewrite-target.com/v1-internal/users');

    mockedFetch.mockClear();

    // Test second rule: ^/api -> (strip prefix)
    const req2 = new Request('http://localhost/api/health', { method: 'GET' });
    await handleRequest(req2, mockConfig);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl2] = mockedFetch.mock.calls[0];
    expect(fetchUrl2).toBe('http://mock-rewrite-target.com/health');
  });

  test('should handle route.pathRewrite before plugin path matching', async () => {
    const configWithRewriteAndPlugin: AppConfig = {
      routes: [
        {
          path: '/api',
          pathRewrite: { '^/api': '' }, // Strips /api prefix
          plugins: ['anthropic-to-openai'], // Expects to match on the rewritten path
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    };

    const req = new Request('http://localhost/api/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, configWithRewriteAndPlugin);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl] = mockedFetch.mock.calls[0];

    // pathRewrite removed /api, then plugin matched /v1/messages and rewrote it
    expect(fetchUrl).toBe('http://mock-openai.com/v1/chat/completions');
  });

  test('should transform Anthropic request to OpenAI with path rewrite', async () => {
    const anthropicRequestBody = {
      model: 'claude-3-opus-20240229',
      max_tokens_to_sample: 1024,
      messages: [{ role: 'user', content: 'Hello, world' }],
    };
    const req = new Request('http://localhost/v1/anthropic-proxy/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Check path transformation from the matched rule
    expect(fetchUrl).toBe('http://mock-openai.com/v1/chat/completions');

    // Check request body transformation
    expect(forwardedBody.max_tokens).toBe(1024);
    expect(forwardedBody).not.toHaveProperty('max_tokens_to_sample');
  });
});

describe('Error Response Transformation', () => {
  beforeEach(async () => {
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
    await initializePluginRegistryForTests(mockConfig);
  });

  afterEach(async () => {
    await cleanupPluginRegistry();
  });

  test('should transform Gemini error response to Anthropic error format', async () => {
    // Override the global mock fetch for this single test to simulate an error
    mockedFetch.mockImplementationOnce(async (request: Request | string, options?: RequestInit) => {
      const geminiErrorResponse = {
        error: {
          code: 404,
          message: 'The requested model was not found.',
          status: 'NOT_FOUND',
        },
      };
      return new Response(JSON.stringify(geminiErrorResponse), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const req = new Request('http://localhost/v1/gemini-proxy/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-pro', messages: [] }),
      headers: { 'Content-Type': 'application/json' },
    });

    const finalResponse = await handleRequest(req, mockConfig);
    const finalBody = await finalResponse.json();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(finalResponse.status).toBe(404);
    expect(finalBody.type).toBe('error');
    expect(finalBody.error.type).toBe('api_error');
    expect(finalBody.error.message).toBe('The requested model was not found.');
  });
});

describe('Streaming Response - Detailed SSE Event Testing', () => {
  beforeEach(async () => {
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
    await initializePluginRegistryForTests(mockConfig);
  });

  afterEach(async () => {
    await cleanupPluginRegistry();
  });

  test('should transform Anthropic streaming response to OpenAI streaming format', async () => {
    // Mock streaming response from Anthropic
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      const anthropicStreamContent = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_test123","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there!"}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","usage":{"output_tokens":3}}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(anthropicStreamContent));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }) as any;

    const openAIRequestBody = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 50,
      stream: true,
    };
    const req = new Request('http://localhost/v1/openai-proxy/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openAIRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockConfig);

    // Restore original fetch
    global.fetch = originalFetch;

    // Should be a streaming response
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // Read the streaming response
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

    // Parse SSE events
    const events = allData.split('\n\n').filter(line => line.startsWith('data: ')).map(line => {
      const dataContent = line.substring(6);
      return JSON.parse(dataContent);
    });

    // Should have at least start, content chunks, and end
    expect(events.length).toBeGreaterThan(0);

    // Verify start event (first event)
    expect(events[0].object).toBe('chat.completion.chunk');
    expect(events[0].choices).toBeDefined();
    expect(events[0].choices[0].delta.role).toBe('assistant');
    expect(events[0].choices[0].finish_reason).toBeNull();

    // Verify content chunks (middle events)
    const contentChunks = events.filter(e => e.choices[0].delta.content);
    expect(contentChunks.length).toBeGreaterThan(0);

    // Verify we have the content we expect
    const allContent = contentChunks.map(e => e.choices[0].delta.content).join('');
    expect(allContent).toBe('Hello there!');

    // Verify all content chunks have correct structure
    for (const chunk of contentChunks) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.id).toMatch(/^chatcmpl-/);
      expect(chunk.choices[0].index).toBe(0);
      expect(chunk.choices[0].finish_reason).toBeNull();
    }

    // Verify end event (last event)
    const lastEvent = events[events.length - 1];
    expect(lastEvent.object).toBe('chat.completion.chunk');
    expect(lastEvent.choices[0].finish_reason).toBe('stop');
    expect(lastEvent.choices[0].delta).toEqual({});
  });

  test('should map Anthropic max_tokens stop_reason to OpenAI length finish_reason', async () => {
    // Mock streaming response with max_tokens stop reason
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      const anthropicStreamContent = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_test456","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Test"}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","usage":{"output_tokens":1}}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(anthropicStreamContent));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }) as any;

    const openAIRequestBody = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      max_tokens: 1,
      stream: true,
    };
    const req = new Request('http://localhost/v1/openai-proxy/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openAIRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockConfig);

    // Restore original fetch
    global.fetch = originalFetch;

    // Read the streaming response
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

    // Parse SSE events
    const events = allData.split('\n\n').filter(line => line.startsWith('data: ')).map(line => {
      const dataContent = line.substring(6);
      return JSON.parse(dataContent);
    });

    // Verify end event has finish_reason: "length" (mapped from max_tokens)
    const lastEvent = events[events.length - 1];
    expect(lastEvent.choices[0].finish_reason).toBe('length');
  });

  test('should handle Anthropic streaming response with tool_use stop_reason', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      const anthropicStreamContent = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_tool","type":"message","role":"assistant","content":[],"model":"claude-3-opus-20240229","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"get_weather"}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":\\""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"NYC\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","usage":{"output_tokens":5}}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(anthropicStreamContent));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }) as any;

    const openAIRequestBody = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      max_tokens: 100,
      stream: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { location: { type: 'string' } } }
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/openai-proxy/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openAIRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockConfig);
    global.fetch = originalFetch;

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

    const events = allData.split('\n\n').filter(line => line.startsWith('data: ')).map(line => {
      const dataContent = line.substring(6);
      return JSON.parse(dataContent);
    });

    // Verify tool_use is mapped to tool_calls
    const lastEvent = events[events.length - 1];
    expect(lastEvent.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('Environment Variable Validation', () => {
  const plugin = new OpenAIToAnthropicPlugin();

  const buildContext = (body: any): PluginContext => ({
    method: 'POST',
    url: new URL('http://localhost/v1/chat/completions'),
    headers: {},
    body,
    request: {}
  });

  test('throws when reasoning mapping environment variable is missing', async () => {
    const original = process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS;
    delete process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS;

    try {
      const ctx = buildContext({
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Need reasoning' }],
        max_completion_tokens: 1024,
        reasoning_effort: 'high'
      });

      await expect(plugin.onBeforeRequest(ctx)).rejects.toThrow(
        'Environment variable OPENAI_HIGH_TO_ANTHROPIC_TOKENS not configured for reasoning_effort conversion'
      );
    } finally {
      if (original !== undefined) {
        process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS = original;
      } else {
        delete process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS;
      }
    }
  });

  test('throws when reasoning mapping environment variable is not an integer', async () => {
    const original = process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS;
    process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS = 'not-a-number';

    try {
      const ctx = buildContext({
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Need reasoning' }],
        max_completion_tokens: 1024,
        reasoning_effort: 'high'
      });

      await expect(plugin.onBeforeRequest(ctx)).rejects.toThrow(
        'Invalid OPENAI_HIGH_TO_ANTHROPIC_TOKENS value: must be integer'
      );
    } finally {
      if (original !== undefined) {
        process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS = original;
      } else {
        delete process.env.OPENAI_HIGH_TO_ANTHROPIC_TOKENS;
      }
    }
  });

});

console.log('✅ Routing integration tests created');
