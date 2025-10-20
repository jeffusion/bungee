/**
 * OpenAI to Gemini Integration Tests
 * Tests the complete request-response flow through the transformer
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-shared';
import { handleRequest, initializeRuntimeState, initializePluginRegistryForTests, cleanupPluginRegistry } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with openai-to-gemini transformer
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/openai-to-gemini',
      pathRewrite: { '^/v1/openai-to-gemini': '/v1' },
      plugins: ['openai-to-gemini'],
      upstreams: [{ target: 'http://mock-gemini.com', weight: 100, priority: 1 }]
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

  if (url.includes('mock-gemini.com')) {
    // Extract model from URL path
    const modelMatch = url.match(/\/models\/([^:]+):/);
    const model = modelMatch ? modelMatch[1] : 'gemini-pro';

    // Check if it's a streaming request
    if (url.includes(':streamGenerateContent')) {
      // Return streaming response
      const streamContent = [
        `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model","model":"${model}"}}],"modelVersion":"${model}"}\n\n`,
        `data: {"candidates":[{"content":{"parts":[{"text":" there!"}],"role":"model","model":"${model}"}}],"modelVersion":"${model}"}\n\n`,
        `data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model","model":"${model}"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13},"modelVersion":"${model}"}\n\n`
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
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'This is a response from Gemini.' }],
            role: 'model',
            model: model  // Include model in candidate
          },
          finishReason: 'STOP'
        }
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 25,
        totalTokenCount: 40
      },
      modelVersion: model  // Also include at top level
    };

    return new Response(JSON.stringify(geminiResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Not found', { status: 404 });
});

global.fetch = mockedFetch as any;

describe('OpenAI to Gemini - Integration Tests', () => {
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

  test('should convert basic OpenAI request to Gemini and back', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello, how are you?' }
      ],
      max_tokens: 100,
      temperature: 0.7
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();

    // Verify OpenAI response format
    expect(responseBody.id).toMatch(/^chatcmpl-/);
    expect(responseBody.object).toBe('chat.completion');
    expect(responseBody.created).toBeDefined();
    expect(responseBody.model).toBe('gpt-4');
    expect(responseBody.choices).toHaveLength(1);
    expect(responseBody.choices[0].message.role).toBe('assistant');
    expect(responseBody.choices[0].message.content).toBe('This is a response from Gemini.');
    expect(responseBody.choices[0].finish_reason).toBe('stop');
    expect(responseBody.usage.prompt_tokens).toBe(15);
    expect(responseBody.usage.completion_tokens).toBe(25);
    expect(responseBody.usage.total_tokens).toBe(40);

    // Verify the request was transformed to Gemini format
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];

    expect(fetchUrl).toContain('mock-gemini.com');
    expect(fetchUrl).toContain('/v1beta/models/gpt-4:generateContent');

    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.contents).toBeDefined();
    expect(forwardedBody.contents[0].role).toBe('user');
    expect(forwardedBody.contents[0].parts[0].text).toBe('Hello, how are you?');
    expect(forwardedBody.generationConfig.temperature).toBe(0.7);
    expect(forwardedBody.generationConfig.maxOutputTokens).toBe(100);
  });

  test('should handle system messages correctly', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // System message should be in system_instruction
    expect(forwardedBody.system_instruction).toBeDefined();
    expect(forwardedBody.system_instruction.parts[0].text).toBe('You are a helpful assistant.');

    // Contents should only have user message
    expect(forwardedBody.contents).toHaveLength(1);
    expect(forwardedBody.contents[0].role).toBe('user');
    expect(forwardedBody.contents[0].parts[0].text).toBe('Hello!');
  });

  test('should convert streaming requests', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);

    // Verify it's a streaming response
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // Verify Gemini streaming URL was used
    const [fetchUrl] = mockedFetch.mock.calls[0];
    expect(fetchUrl).toContain(':streamGenerateContent?alt=sse');

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
      .filter(line => line.startsWith('data: '))
      .map(line => {
        const dataContent = line.substring(6);
        try {
          return JSON.parse(dataContent);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Verify OpenAI streaming format
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].object).toBe('chat.completion.chunk');
    expect(events[0].choices[0].delta).toBeDefined();
  });

  test('should handle multiple system messages', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi!' }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Multiple system messages should be joined with newline
    expect(forwardedBody.system_instruction.parts[0].text).toBe('You are helpful.\nBe concise.');
  });

  test('should handle assistant role conversion to model', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Assistant role should be converted to 'model'
    expect(forwardedBody.contents).toHaveLength(3);
    expect(forwardedBody.contents[0].role).toBe('user');
    expect(forwardedBody.contents[1].role).toBe('model');
    expect(forwardedBody.contents[1].parts[0].text).toBe('Hi there!');
    expect(forwardedBody.contents[2].role).toBe('user');
  });

  test('should remove OpenAI-specific parameters', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      n: 1,
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
      logit_bias: { '50256': -100 },
      user: 'user123'
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // OpenAI-specific fields should not be present
    expect(forwardedBody.n).toBeUndefined();
    expect(forwardedBody.presence_penalty).toBeUndefined();
    expect(forwardedBody.frequency_penalty).toBeUndefined();
    expect(forwardedBody.logit_bias).toBeUndefined();
    expect(forwardedBody.user).toBeUndefined();
  });

  test('should use ANTHROPIC_MAX_TOKENS when max_tokens not provided', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }]
      // No max_tokens
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should use ANTHROPIC_MAX_TOKENS from env (32000)
    expect(forwardedBody.generationConfig.maxOutputTokens).toBe(32000);
  });

  test('should convert tools to functionDeclarations with schema cleaning', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Get weather' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather',
            parameters: {
              type: 'object',
              properties: {
                location: {
                  type: 'string',
                  description: 'City name',
                  minLength: 1,
                  maxLength: 100
                },
                unit: {
                  type: 'string',
                  enum: ['celsius', 'fahrenheit']
                }
              },
              required: ['location'],
              additionalProperties: false,
              $schema: 'http://json-schema.org/draft-07/schema#'
            }
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tools transformation
    expect(forwardedBody.tools).toBeDefined();
    expect(forwardedBody.tools[0].functionDeclarations).toHaveLength(1);

    const funcDecl = forwardedBody.tools[0].functionDeclarations[0];
    expect(funcDecl.name).toBe('get_weather');
    expect(funcDecl.description).toBe('Get the current weather');

    // Verify schema cleaning - these fields should be removed
    expect(funcDecl.parameters).not.toHaveProperty('$schema');
    expect(funcDecl.parameters).not.toHaveProperty('additionalProperties');
    expect(funcDecl.parameters.properties.location).not.toHaveProperty('minLength');
    expect(funcDecl.parameters.properties.location).not.toHaveProperty('maxLength');

    // Verify allowed fields are preserved
    expect(funcDecl.parameters.type).toBe('object');
    expect(funcDecl.parameters.properties.location.type).toBe('string');
    expect(funcDecl.parameters.properties.unit.enum).toEqual(['celsius', 'fahrenheit']);
    expect(funcDecl.parameters.required).toEqual(['location']);
  });

  test('should convert assistant tool_calls to functionCall', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'What is the weather in NYC?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_get_weather_abc123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"NYC","unit":"celsius"}'
              }
            }
          ]
        }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify assistant message with tool call
    const assistantMsg = forwardedBody.contents[1];
    expect(assistantMsg.role).toBe('model');
    expect(assistantMsg.parts).toHaveLength(1);
    expect(assistantMsg.parts[0].functionCall).toBeDefined();
    expect(assistantMsg.parts[0].functionCall.name).toBe('get_weather');
    expect(assistantMsg.parts[0].functionCall.args).toEqual({
      location: 'NYC',
      unit: 'celsius'
    });
  });

  test('should convert tool role messages to functionResponse', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_get_weather_xyz789',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' }
          }]
        },
        {
          role: 'tool',
          tool_call_id: 'call_get_weather_xyz789',
          content: '{"temperature":18,"condition":"sunny"}'
        }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tool response conversion
    const toolMsg = forwardedBody.contents[2];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.parts[0].functionResponse).toBeDefined();
    expect(toolMsg.parts[0].functionResponse.name).toBe('get_weather');
    expect(toolMsg.parts[0].functionResponse.response).toEqual({
      temperature: 18,
      condition: 'sunny'
    });
  });

  test('should convert multi-modal images to inlineData', async () => {
    const openaiRequest = {
      model: 'gpt-4-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }
            }
          ]
        }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify multi-modal content
    const userMsg = forwardedBody.contents[0];
    expect(userMsg.parts).toHaveLength(2);

    // Text part
    expect(userMsg.parts[0].text).toBe('What is in this image?');

    // Image part
    expect(userMsg.parts[1].inlineData).toBeDefined();
    expect(userMsg.parts[1].inlineData.mimeType).toBe('image/jpeg');
    expect(userMsg.parts[1].inlineData.data).toBe('/9j/4AAQSkZJRg==');
  });

  test('should convert reasoning_effort to thinkingConfig', async () => {
    // Set up env var for reasoning conversion
    const originalEnv = process.env.OPENAI_HIGH_TO_GEMINI_TOKENS;
    process.env.OPENAI_HIGH_TO_GEMINI_TOKENS = '16384';

    try {
      const openaiRequest = {
        model: 'o1-preview',
        messages: [{ role: 'user', content: 'Solve this complex problem' }],
        max_completion_tokens: 4096,
        reasoning_effort: 'high'
      };

      const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
        method: 'POST',
        body: JSON.stringify(openaiRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      await handleRequest(req, mockConfig);

      const [, fetchOptions] = mockedFetch.mock.calls[0];
      const forwardedBody = JSON.parse(fetchOptions!.body as string);

      // Verify thinking config
      expect(forwardedBody.generationConfig.thinkingConfig).toBeDefined();
      expect(forwardedBody.generationConfig.thinkingConfig.thinkingBudget).toBe(16384);
    } finally {
      if (originalEnv !== undefined) {
        process.env.OPENAI_HIGH_TO_GEMINI_TOKENS = originalEnv;
      } else {
        delete process.env.OPENAI_HIGH_TO_GEMINI_TOKENS;
      }
    }
  });

  test('should convert response_format to response_schema', async () => {
    const openaiRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Generate JSON' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
              code: { type: 'number' }
            },
            required: ['result']
          }
        }
      }
    };

    const req = new Request('http://localhost/v1/openai-to-gemini/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify response format conversion
    expect(forwardedBody.generationConfig.response_mime_type).toBe('application/json');
    expect(forwardedBody.generationConfig.response_schema).toEqual({
      type: 'object',
      properties: {
        result: { type: 'string' },
        code: { type: 'number' }
      },
      required: ['result']
    });
  });
});

console.log('✅ OpenAI to Gemini integration tests created');
