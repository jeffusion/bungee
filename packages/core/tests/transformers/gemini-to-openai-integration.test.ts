/**
 * Gemini to OpenAI Integration Tests
 * Tests the complete request-response flow through the transformer
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import { handleRequest, initializeRuntimeState, initializePluginRegistryForTests, cleanupPluginRegistry } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with gemini-to-openai transformer
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/gemini-to-openai',
      pathRewrite: { '^/v1/gemini-to-openai': '/v1' },
      plugins: ['gemini-to-openai'],
      upstreams: [{ target: 'http://mock-openai.com', weight: 100, priority: 1 }]
    }
  ]
};

// Mock fetch responses
const mockedFetch = mock(async (request: Request | string, options?: RequestInit) => {
  const url = typeof request === 'string' ? request : request.url;

  // Parse request body if present
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
      // Return streaming response
      const streamContent = [
        'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" there!"},"finish_reason":null}]}\n\n',
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
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'This is a response from OpenAI.'
          },
          finish_reason: 'stop'
        }
      ],
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

describe('Gemini to OpenAI - Integration Tests', () => {
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

  test('should convert basic Gemini request to OpenAI and back', async () => {
    const geminiRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'Hello, how are you?' }] }
      ],
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.7
      }
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();

    // Verify Gemini response format
    expect(responseBody.candidates).toBeDefined();
    expect(responseBody.candidates).toHaveLength(1);
    expect(responseBody.candidates[0].content.role).toBe('model');
    expect(responseBody.candidates[0].content.parts[0].text).toBe('This is a response from OpenAI.');
    expect(responseBody.candidates[0].finishReason).toBe('STOP');
    expect(responseBody.usageMetadata.promptTokenCount).toBe(15);
    expect(responseBody.usageMetadata.candidatesTokenCount).toBe(25);
    expect(responseBody.usageMetadata.totalTokenCount).toBe(40);

    // Verify the request was transformed to OpenAI format
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];

    expect(fetchUrl).toContain('mock-openai.com');
    expect(fetchUrl).toContain('/v1/chat/completions');

    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.messages).toBeDefined();
    expect(forwardedBody.messages[0].role).toBe('user');
    expect(forwardedBody.messages[0].content).toBe('Hello, how are you?');
    expect(forwardedBody.temperature).toBe(0.7);
    expect(forwardedBody.max_tokens).toBe(100);
  });

  test('should handle systemInstruction correctly', async () => {
    const geminiRequest = {
      systemInstruction: {
        parts: [{ text: 'You are a helpful assistant.' }]
      },
      contents: [
        { role: 'user', parts: [{ text: 'Hello!' }] }
      ]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // System instruction should be first message with role: system
    expect(forwardedBody.messages[0].role).toBe('system');
    expect(forwardedBody.messages[0].content).toBe('You are a helpful assistant.');
    expect(forwardedBody.messages[1].role).toBe('user');
    expect(forwardedBody.messages[1].content).toBe('Hello!');
  });

  test('should convert streaming requests', async () => {
    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Hello!' }] }],
      stream: true
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/streamGenerateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
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

    // Parse SSE events
    const events = allData
      .split('\n\n')
      .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(line => {
        const dataContent = line.substring(6);
        try {
          return JSON.parse(dataContent);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Verify Gemini streaming format
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].candidates).toBeDefined();
    expect(events[0].candidates[0].content).toBeDefined();
  });

  test('should handle model role conversion to assistant', async () => {
    const geminiRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi there!' }] },
        { role: 'user', parts: [{ text: 'How are you?' }] }
      ]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Model role should be converted to 'assistant'
    expect(forwardedBody.messages).toHaveLength(3);
    expect(forwardedBody.messages[0].role).toBe('user');
    expect(forwardedBody.messages[1].role).toBe('assistant');
    expect(forwardedBody.messages[1].content).toBe('Hi there!');
    expect(forwardedBody.messages[2].role).toBe('user');
  });

  test('should convert generationConfig parameters', async () => {
    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
      generationConfig: {
        temperature: 0.8,
        topP: 0.9,
        maxOutputTokens: 150,
        stopSequences: ['STOP', 'END']
      }
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Generation config should be mapped
    expect(forwardedBody.temperature).toBe(0.8);
    expect(forwardedBody.top_p).toBe(0.9);
    expect(forwardedBody.max_tokens).toBe(150);
    expect(forwardedBody.stop).toEqual(['STOP', 'END']);
  });

  test('should convert finish reasons correctly', async () => {
    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // OpenAI 'stop' should map to Gemini 'STOP'
    expect(responseBody.candidates[0].finishReason).toBe('STOP');
  });

  test('should preserve usage metadata', async () => {
    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // Usage metadata should be converted
    expect(responseBody.usageMetadata).toBeDefined();
    expect(responseBody.usageMetadata.promptTokenCount).toBe(15);
    expect(responseBody.usageMetadata.candidatesTokenCount).toBe(25);
    expect(responseBody.usageMetadata.totalTokenCount).toBe(40);
  });

  test('should convert functionDeclarations to tools', async () => {
    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Get weather' }] }],
      tools: [{
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather info',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' }
              },
              required: ['location']
            }
          }
        ]
      }]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.tools).toBeDefined();
    expect(forwardedBody.tools).toHaveLength(1);
    expect(forwardedBody.tools[0].type).toBe('function');
    expect(forwardedBody.tools[0].function.name).toBe('get_weather');
    expect(forwardedBody.tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location']
    });
  });

  test('should convert functionCall to tool_calls', async () => {
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
                arguments: '{"location":"NYC"}'
              }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Weather in NYC?' }] }]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    expect(responseBody.candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(responseBody.candidates[0].content.parts[0].functionCall.name).toBe('get_weather');
    expect(responseBody.candidates[0].content.parts[0].functionCall.args).toEqual({ location: 'NYC' });
    expect(responseBody.candidates[0].finishReason).toBe('TOOL_USE');
  });

  test('should convert functionResponse from tool role', async () => {
    const geminiRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'Weather?' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { location: 'SF' } } }]
        },
        {
          role: 'tool',
          parts: [{
            functionResponse: {
              name: 'get_weather',
              response: { temperature: 72, condition: 'sunny' }
            }
          }]
        }
      ]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Tool response should become a 'tool' role message in OpenAI
    const toolMsg = forwardedBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toMatch(/^call_get_weather_/);
    expect(toolMsg.content).toContain('temperature');
    expect(toolMsg.content).toContain('72');
  });

  test('should convert multi-modal inlineData to image_url', async () => {
    const geminiRequest = {
      contents: [{
        role: 'user',
        parts: [
          { text: 'Describe image' },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: '/9j/4AAQSkZJRg=='
            }
          }
        ]
      }]
    };

    const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.messages[0].content).toHaveLength(2);
    expect(forwardedBody.messages[0].content[0]).toEqual({ type: 'text', text: 'Describe image' });
    expect(forwardedBody.messages[0].content[1].type).toBe('image_url');
    expect(forwardedBody.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  });

  test('should convert thinkingConfig to reasoning parameters', async () => {
    const originalEnv = process.env.GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD;
    process.env.GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD = '12000';

    try {
      const geminiRequest = {
        contents: [{ role: 'user', parts: [{ text: 'Complex problem' }] }],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 16000 }
        }
      };

      const req = new Request('http://localhost/v1/gemini-to-openai/generateContent', {
        method: 'POST',
        body: JSON.stringify(geminiRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      await handleRequest(req, mockConfig);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);

      expect(forwardedBody.reasoning_effort).toBe('high');
      expect(forwardedBody.max_completion_tokens).toBeDefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD = originalEnv;
      } else {
        delete process.env.GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD;
      }
    }
  });
});

console.log('✅ Gemini to OpenAI integration tests created');
