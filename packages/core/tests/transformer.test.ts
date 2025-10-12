import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-shared';
import { handleRequest, initializeRuntimeState } from '../src/worker';

// Mock config with updated transformer structure
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/anthropic-proxy',
      pathRewrite: { '^/v1/anthropic-proxy': '/v1' },
      transformer: 'anthropic-to-openai',
      upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/openai-proxy',
      pathRewrite: { '^/v1/openai-proxy': '/v1' },
      transformer: 'openai-to-anthropic',
      upstreams: [{ target: 'http://mock-anthropic.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/gemini-proxy',
      pathRewrite: { '^/v1/gemini-proxy': '/v1' },
      transformer: 'anthropic-to-gemini',
      upstreams: [{ target: 'http://mock-gemini.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/inline-proxy',
      transformer: { // Single inline rule
        path: { action: 'replace', match: '^/v1/inline-proxy$', replace: '/inline-endpoint' },
        request: { body: { add: { inline_request: true } } },
        response: [
          {
            match: { status: "^2..$" },
            rules: {
              default: {
                body: { add: { inline_response: true } }
              }
            }
          }
        ],
      },
      upstreams: [{ target: 'http://mock-inline.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/multi-rule-proxy',
      transformer: [ // Array of inline rules
        {
          path: { action: 'replace', match: '/v1/multi-rule-proxy/path-a', replace: '/path-a-rewritten' },
          request: { body: { add: { rule: 'A' } } },
        },
        {
          path: { action: 'replace', match: '/v1/multi-rule-proxy/path-b', replace: '/path-b-rewritten' },
          request: { body: { add: { rule: 'B' } } },
        }
      ],
      upstreams: [{ target: 'http://mock-multi-rule.com', weight: 100, priority: 1 }],
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
    {
      path: '/v1/base-path-test',
      upstreams: [{
        target: 'http://mock-base-path.com/sub/path',
        weight: 100,
        priority: 1,
        transformer: {
          path: { action: 'replace', match: '.*', replace: '/final-endpoint' },
        }
      }],
    },
    {
      path: '/v1/onion-model-test',
      upstreams: [{
        target: 'http://mock-onion-test.com',
        weight: 100,
        priority: 1,
        transformer: {
          path: {
            action: 'replace',
            match: '.*', // Match everything for this test
            replace: "{{ `/v1/models/${body.model}:generateContent` }}"
          },
          request: {
            body: {
              // The transformer still removes the model field, but after the path has been processed
              remove: ['model']
            }
          }
        },
        body: {
          replace: {
            model: 'gemini-1.5-pro-from-upstream'
          }
        }
      }],
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
      choices: [{ message: { content: 'This is a test response from mock OpenAI.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };
    return new Response(JSON.stringify(openAIResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://mock-anthropic.com')) {
    const anthropicResponse = {
      id: 'msg_abc123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'This is a test response from mock Anthropic.' }],
      model: 'claude-3-opus-20240229',
      stop_reason: 'end_turn',
      usage: { input_tokens: 15, output_tokens: 25 },
    };
    return new Response(JSON.stringify(anthropicResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://mock-gemini.com')) {
    const geminiResponse = {
      candidates: [{ content: { parts: [{ text: 'This is a test response from mock Gemini.' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 25 },
    };
    return new Response(JSON.stringify(geminiResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://mock-inline.com') || url.startsWith('http://mock-multi-rule.com')) {
    return new Response(JSON.stringify({ received_body: requestBody }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://mock-onion-test.com')) {
    return new Response('onion model ok', { status: 200 });
  }

  if (url.startsWith('http://mock-base-path.com')) {
    return new Response('base path ok', { status: 200 });
  }

  if (url.startsWith('http://mock-rewrite-target.com')) {
    return new Response('path rewrite middleware', { status: 200 });
  }

  return new Response('proxied', { status: 200 });
});
global.fetch = mockedFetch as any;

describe('Transformer Logic (New Architecture)', () => {
  beforeEach(() => {
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
  });

  test('should transform Anthropic request to OpenAI and rewrite path', async () => {
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

  test('should select and apply the correct rule from a multi-rule transformer', async () => {
    // Test request to path-a
    const reqA = new Request('http://localhost/v1/multi-rule-proxy/path-a', {
      method: 'POST', body: JSON.stringify({ original: true }), headers: { 'Content-Type': 'application/json' }
    });
    await handleRequest(reqA, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrlA, fetchOptionsA] = mockedFetch.mock.calls[0];
    const forwardedBodyA = JSON.parse(fetchOptionsA!.body as string);

    expect(fetchUrlA).toBe('http://mock-multi-rule.com/path-a-rewritten');
    expect(forwardedBodyA.rule).toBe('A');
    expect(forwardedBodyA.original).toBe(true);

    mockedFetch.mockClear();

    // Test request to path-b
    const reqB = new Request('http://localhost/v1/multi-rule-proxy/path-b', {
      method: 'POST', body: JSON.stringify({ original: true }), headers: { 'Content-Type': 'application/json' }
    });
    await handleRequest(reqB, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrlB, fetchOptionsB] = mockedFetch.mock.calls[0];
    const forwardedBodyB = JSON.parse(fetchOptionsB!.body as string);

    expect(fetchUrlB).toBe('http://mock-multi-rule.com/path-b-rewritten');
    expect(forwardedBodyB.rule).toBe('B');
  });

  test('should handle route.pathRewrite before transformer path matching', async () => {
    const configWithRewriteAndTransformer: AppConfig = {
      routes: [
        {
          path: '/api',
          pathRewrite: { '^/api': '' }, // Strips /api prefix
          transformer: 'anthropic-to-openai', // Expects to match on the rewritten path
          upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }],
        },
      ],
    };

    const req = new Request('http://localhost/api/v1/messages', {
      method: 'POST', body: JSON.stringify({ messages: [] }), headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, configWithRewriteAndTransformer);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl] = mockedFetch.mock.calls[0];

    // pathRewrite removed /api, then transformer matched /v1/messages and rewrote it
    expect(fetchUrl).toBe('http://mock-openai.com/v1/chat/completions');
  });

  test('should rewrite path using http-proxy-middleware style rules', async () => {
    const req1 = new Request('http://localhost/api/v1/users', { method: 'GET' });
    await handleRequest(req1, mockConfig);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl1] = mockedFetch.mock.calls[0];
    expect(fetchUrl1).toBe('http://mock-rewrite-target.com/v1-internal/users');

    mockedFetch.mockClear();

    const req2 = new Request('http://localhost/api/health', { method: 'GET' });
    await handleRequest(req2, mockConfig);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl2] = mockedFetch.mock.calls[0];
    expect(fetchUrl2).toBe('http://mock-rewrite-target.com/health');
  });

  test('should handle single inline transformer rule', async () => {
    const req = new Request('http://localhost/v1/inline-proxy', {
      method: 'POST',
      body: JSON.stringify({ original: 'data' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(fetchUrl).toBe('http://mock-inline.com/inline-endpoint');
    expect(forwardedBody.inline_request).toBe(true);
    expect(forwardedBody.original).toBe('data');
    expect(responseBody.received_body).toEqual(forwardedBody);
    expect(responseBody.inline_response).toBe(true);
  });

  test('should transform Anthropic request to Gemini and handle streaming', async () => {
    const anthropicRequestBody = {
      model: 'claude-3-opus-20240229',
      max_tokens_to_sample: 1024,
      messages: [{ role: 'user', content: 'Hello, world' }],
      stream: true
    };
    const req = new Request('http://localhost/v1/gemini-proxy/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    const modelInRequest = anthropicRequestBody.model;
    expect(fetchUrl).toBe(`http://mock-gemini.com/v1beta/models/${modelInRequest}:streamGenerateContent?alt=sse`);
    expect(forwardedBody.generationConfig.maxOutputTokens).toBe(1024);
  });

  test('should prepend upstream target path to the rewritten request path', async () => {
    const req = new Request('http://localhost/v1/base-path-test', { method: 'POST' });

    await handleRequest(req, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl] = mockedFetch.mock.calls[0];

    expect(fetchUrl).toBe('http://mock-base-path.com/sub/path/final-endpoint');
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

    // The mock implementation is only for one call, so let's check it was called
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    expect(finalResponse.status).toBe(404); // Status should be passed through
    expect(finalBody.type).toBe('error');
    expect(finalBody.error.type).toBe('api_error');
    expect(finalBody.error.message).toBe('The requested model was not found.');
  });

  test('should apply upstream body rules before transformer rules (Onion Model)', async () => {
    const req = new Request('http://localhost/v1/onion-model-test', {
      method: 'POST',
      body: JSON.stringify({
        model: 'original-model-from-client',
        messages: [],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // 1. Verify URL construction: The URL should be built using the body *after* the upstream rule was applied.
    expect(fetchUrl).toContain('gemini-1.5-pro-from-upstream');
    expect(fetchUrl).not.toContain('original-model-from-client');

    // 2. Verify final body modification: The transformer's `remove` rule should be applied last.
    expect(forwardedBody).not.toHaveProperty('model');
  });

  test('should support multi-event response transformation', async () => {
    const multiEventConfig: AppConfig = {
      routes: [
        {
          path: '/v1/multi-event-test',
          transformer: {
            path: { action: 'replace', match: '.*', replace: '/test' },
            response: [
              {
                match: { status: "^2..$" },
                rules: {
                  default: {
                    body: {
                      add: {
                        __multi_events: [
                          {
                            id: '{{ "event_1_" + crypto.randomUUID() }}',
                            type: 'first_event',
                            data: '{{ body.original_data }}'
                          },
                          {
                            id: '{{ "event_2_" + crypto.randomUUID() }}',
                            type: 'second_event',
                            processed: true
                          }
                        ]
                      },
                      remove: ['original_data', 'unwanted_field']
                    }
                  }
                }
              }
            ]
          },
          upstreams: [{ target: 'http://mock-multi-event-test.com', weight: 100, priority: 1 }],
        }
      ]
    };

    // Mock fetch for multi-event test
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      return new Response(JSON.stringify({
        original_data: 'test_data',
        unwanted_field: 'should_be_removed',
        keep_field: 'should_remain'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    const req = new Request('http://localhost/v1/multi-event-test', {
      method: 'POST',
      body: JSON.stringify({ test: 'data' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, multiEventConfig);
    const responseBody = await response.json();

    // Restore original fetch
    global.fetch = originalFetch;

    // Should return an array of events
    expect(Array.isArray(responseBody)).toBe(true);
    expect(responseBody.length).toBe(2);

    // Verify first event
    expect(responseBody[0].id).toMatch(/^event_1_/);
    expect(responseBody[0].type).toBe('first_event');
    expect(responseBody[0].data).toBe('test_data');

    // Verify second event
    expect(responseBody[1].id).toMatch(/^event_2_/);
    expect(responseBody[1].type).toBe('second_event');
    expect(responseBody[1].processed).toBe(true);

    // Verify fields were properly removed/kept
    for (const event of responseBody) {
      expect(event).not.toHaveProperty('original_data');
      expect(event).not.toHaveProperty('unwanted_field');
    }
  });

  test('should transform OpenAI request to Anthropic and rewrite path', async () => {
    const openAIRequestBody = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, world!' },
      ],
      max_tokens: 100,
      temperature: 0.7,
    };
    const req = new Request('http://localhost/v1/openai-proxy/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openAIRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Check path transformation
    expect(fetchUrl).toBe('http://mock-anthropic.com/v1/messages');

    // Check request body transformation
    expect(forwardedBody.system).toBe('You are a helpful assistant.');
    expect(forwardedBody.messages).toHaveLength(1);
    expect(forwardedBody.messages[0].role).toBe('user');
    expect(forwardedBody.messages[0].content).toBe('Hello, world!');
    expect(forwardedBody.max_tokens).toBe(100);
    expect(forwardedBody.temperature).toBe(0.7);

    // OpenAI-specific fields should be removed
    expect(forwardedBody).not.toHaveProperty('stop');
    expect(forwardedBody).not.toHaveProperty('n');
  });

  test('should transform Anthropic response to OpenAI format', async () => {
    const openAIRequestBody = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 50,
    };
    const req = new Request('http://localhost/v1/openai-proxy/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openAIRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // Check OpenAI response format
    expect(responseBody.id).toMatch(/^chatcmpl-/);
    expect(responseBody.object).toBe('chat.completion');
    expect(responseBody.created).toBeDefined();
    expect(typeof responseBody.created).toBe('number');
    expect(responseBody.model).toBe('claude-3-opus-20240229');

    // Check choices structure
    expect(responseBody.choices).toHaveLength(1);
    expect(responseBody.choices[0].index).toBe(0);
    expect(responseBody.choices[0].message.role).toBe('assistant');
    expect(responseBody.choices[0].message.content).toBe('This is a test response from mock Anthropic.');
    expect(responseBody.choices[0].finish_reason).toBe('stop');

    // Check usage transformation
    expect(responseBody.usage.prompt_tokens).toBe(15);
    expect(responseBody.usage.completion_tokens).toBe(25);
    expect(responseBody.usage.total_tokens).toBe(40);

    // Anthropic-specific fields should be removed
    expect(responseBody).not.toHaveProperty('type');
    expect(responseBody).not.toHaveProperty('role');
    expect(responseBody).not.toHaveProperty('content');
    expect(responseBody).not.toHaveProperty('stop_reason');
  });

  test('should handle OpenAI requests with multiple system messages', async () => {
    const openAIRequestBody = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi!' },
      ],
      max_tokens: 50,
    };
    const req = new Request('http://localhost/v1/openai-proxy/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openAIRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // System messages should be joined with newline
    expect(forwardedBody.system).toBe('You are helpful.\nBe concise.');
    expect(forwardedBody.messages).toHaveLength(1);
    expect(forwardedBody.messages[0].role).toBe('user');
  });

  test('should handle OpenAI requests without system message', async () => {
    const openAIRequestBody = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ],
      max_tokens: 50,
    };
    const req = new Request('http://localhost/v1/openai-proxy/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openAIRequestBody),
      headers: { 'Content-Type': 'application/json' },
    });

    await handleRequest(req, mockConfig);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // No system field should be present
    expect(forwardedBody.system).toBeUndefined();
    expect(forwardedBody.messages).toHaveLength(3);
    expect(forwardedBody.messages[0].role).toBe('user');
    expect(forwardedBody.messages[1].role).toBe('assistant');
    expect(forwardedBody.messages[2].role).toBe('user');
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
});
