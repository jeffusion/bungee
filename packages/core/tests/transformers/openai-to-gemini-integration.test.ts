/**
 * OpenAI to Gemini Integration Tests
 * Tests the complete request-response flow through the transformer
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-shared';
import { handleRequest, initializeRuntimeState } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with openai-to-gemini transformer
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/openai-to-gemini',
      pathRewrite: { '^/v1/openai-to-gemini': '/v1' },
      transformer: 'openai-to-gemini',
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
  beforeEach(() => {
    setMockEnv();
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
  });

  afterEach(() => {
    cleanupEnv();
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
});

console.log('✅ OpenAI to Gemini integration tests created');
