/**
 * Gemini to Anthropic Integration Tests
 * Tests the complete request-response flow through the transformer
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-shared';
import { handleRequest, initializeRuntimeState } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with gemini-to-anthropic transformer
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/gemini-to-anthropic',
      pathRewrite: { '^/v1/gemini-to-anthropic': '/v1' },
      transformer: 'gemini-to-anthropic',
      upstreams: [{ target: 'http://mock-anthropic.com', weight: 100, priority: 1 }]
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

  if (url.includes('mock-anthropic.com')) {
    // Check if it's a streaming request
    if (requestBody.stream) {
      // Return streaming response
      const streamContent = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-3-opus-20240229","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
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
        'data: {"type":"message_stop"}\n\n'
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
    const anthropicResponse = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'This is a response from Anthropic.' }
      ],
      model: 'claude-3-opus-20240229',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 15,
        output_tokens: 25
      }
    };

    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Not found', { status: 404 });
});

global.fetch = mockedFetch as any;

describe('Gemini to Anthropic - Integration Tests', () => {
  beforeEach(() => {
    setMockEnv();
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert basic Gemini request to Anthropic and back', async () => {
    const geminiRequest = {
      model: 'claude-3-opus-20240229',
      contents: [
        { role: 'user', parts: [{ text: 'Hello, how are you?' }] }
      ],
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.7
      }
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
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
    expect(responseBody.candidates[0].content.parts[0].text).toBe('This is a response from Anthropic.');
    expect(responseBody.candidates[0].finishReason).toBe('STOP');
    expect(responseBody.usageMetadata.promptTokenCount).toBe(15);
    expect(responseBody.usageMetadata.candidatesTokenCount).toBe(25);
    expect(responseBody.usageMetadata.totalTokenCount).toBe(40);

    // Verify the request was transformed to Anthropic format
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];

    expect(fetchUrl).toContain('mock-anthropic.com');
    expect(fetchUrl).toContain('/v1/messages');

    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.model).toBe('claude-3-opus-20240229');
    expect(forwardedBody.messages).toBeDefined();
    expect(forwardedBody.messages[0].role).toBe('user');
    expect(forwardedBody.messages[0].content).toBe('Hello, how are you?');
    expect(forwardedBody.temperature).toBe(0.7);
    expect(forwardedBody.max_tokens).toBe(100);
  });

  test('should handle systemInstruction correctly', async () => {
    const geminiRequest = {
      model: 'claude-3-opus-20240229',
      systemInstruction: {
        parts: [{ text: 'You are a helpful assistant.' }]
      },
      contents: [
        { role: 'user', parts: [{ text: 'Hello!' }] }
      ],
      generationConfig: {
        maxOutputTokens: 100
      }
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // System instruction should be in system field
    expect(forwardedBody.system).toBe('You are a helpful assistant.');
    expect(forwardedBody.messages[0].role).toBe('user');
    expect(forwardedBody.messages[0].content).toBe('Hello!');
  });

  test('should convert streaming requests', async () => {
    const geminiRequest = {
      model: 'claude-3-opus-20240229',
      contents: [{ role: 'user', parts: [{ text: 'Hello!' }] }],
      generationConfig: { maxOutputTokens: 100 },
      stream: true
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
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

    // Verify Gemini streaming format
    expect(events.length).toBeGreaterThan(0);
    // Should have candidates array with parts
    const textEvents = events.filter(e => e.candidates?.[0]?.content?.parts?.some((p: any) => p.text));
    expect(textEvents.length).toBeGreaterThan(0);
  });

  test('should handle model role conversion to assistant', async () => {
    const geminiRequest = {
      model: 'claude-3-opus-20240229',
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi there!' }] },
        { role: 'user', parts: [{ text: 'How are you?' }] }
      ],
      generationConfig: { maxOutputTokens: 100 }
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
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
      model: 'claude-3-opus-20240229',
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
      generationConfig: {
        temperature: 0.8,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 150,
        stopSequences: ['STOP', 'END']
      }
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
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
    expect(forwardedBody.top_k).toBe(40);
    expect(forwardedBody.max_tokens).toBe(150);
    expect(forwardedBody.stop_sequences).toEqual(['STOP', 'END']);
  });

  test('should use ANTHROPIC_MAX_TOKENS when maxOutputTokens not provided', async () => {
    const geminiRequest = {
      model: 'claude-3-opus-20240229',
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }]
      // No generationConfig.maxOutputTokens
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should use ANTHROPIC_MAX_TOKENS from env (32000)
    expect(forwardedBody.max_tokens).toBe(32000);
  });

  test('should convert stop reasons correctly', async () => {
    const geminiRequest = {
      model: 'claude-3-opus-20240229',
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
      generationConfig: { maxOutputTokens: 100 }
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
      method: 'POST',
      body: JSON.stringify(geminiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // Anthropic 'end_turn' should map to Gemini 'STOP'
    expect(responseBody.candidates[0].finishReason).toBe('STOP');
  });

  test('should preserve usage metadata', async () => {
    const geminiRequest = {
      model: 'claude-3-opus-20240229',
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
      generationConfig: { maxOutputTokens: 100 }
    };

    const req = new Request('http://localhost/v1/gemini-to-anthropic/generateContent', {
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
});

console.log('✅ Gemini to Anthropic integration tests created');
