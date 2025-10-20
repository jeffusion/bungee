/**
 * Anthropic to Gemini Integration Tests
 *
 * Tests the complete request-response flow for anthropic-to-gemini transformer
 * Based on specification in docs/ai-provider-conversion.md Section 3.1.2 (Anthropic → Gemini)
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-shared';
import { handleRequest, initializeRuntimeState, initializePluginRegistryForTests, cleanupPluginRegistry } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with anthropic-to-gemini transformer
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/anthropic-to-gemini',
      pathRewrite: { '^/v1/anthropic-to-gemini': '/v1' },
      plugins: ['anthropic-to-gemini'],
      upstreams: [{ target: 'http://mock-gemini.com', weight: 100, priority: 1 }]
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

  if (url.includes('mock-gemini.com')) {
    // Extract model from URL
    const modelMatch = url.match(/\/models\/([^:]+):/);
    const model = modelMatch ? modelMatch[1] : 'gemini-pro';

    // Check if it's a streaming request
    if (url.includes(':streamGenerateContent')) {
      const streamContent = [
        `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}],"modelVersion":"${model}"}\n\n`,
        `data: {"candidates":[{"content":{"parts":[{"text":" world!"}],"role":"model"}}],"modelVersion":"${model}"}\n\n`,
        `data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13},"modelVersion":"${model}"}\n\n`
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
      candidates: [{
        content: {
          parts: [{ text: 'This is a mock Gemini response.' }],
          role: 'model'
        },
        finishReason: 'STOP'
      }],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 25,
        totalTokenCount: 40
      },
      modelVersion: model
    };

    return new Response(JSON.stringify(geminiResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Not found', { status: 404 });
});

global.fetch = mockedFetch as any;

describe('Anthropic to Gemini - Integration Tests', () => {
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

  test('should convert basic Anthropic request to Gemini and back', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'Hello, how are you?' }
      ],
      max_tokens: 100,
      temperature: 0.7
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();

    // Verify Anthropic response format (按文档 3.2.2 Gemini → Anthropic)
    expect(responseBody.id).toBeDefined();
    expect(responseBody.type).toBe('message');
    expect(responseBody.role).toBe('assistant');
    expect(responseBody.content).toHaveLength(1);
    expect(responseBody.content[0].type).toBe('text');
    expect(responseBody.content[0].text).toBe('This is a mock Gemini response.');
    expect(responseBody.stop_reason).toBe('end_turn'); // STOP → end_turn
    expect(responseBody.usage.input_tokens).toBe(15);
    expect(responseBody.usage.output_tokens).toBe(25);

    // Verify the request was transformed to Gemini format
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];

    expect(fetchUrl).toContain('mock-gemini.com');
    expect(fetchUrl).toContain('/v1beta/models/gemini-pro:generateContent');

    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.system_instruction).toBeDefined();
    // 按 Gemini API 规范：system_instruction.parts 是数组
    expect(forwardedBody.system_instruction.parts[0].text).toBe('You are a helpful assistant.');
    expect(forwardedBody.contents).toHaveLength(1);
    expect(forwardedBody.contents[0].role).toBe('user');
    expect(forwardedBody.contents[0].parts[0].text).toBe('Hello, how are you?');
    expect(forwardedBody.generationConfig.temperature).toBe(0.7);
    expect(forwardedBody.generationConfig.maxOutputTokens).toBe(100);
  });

  test('should convert assistant role to model role', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify role mapping (按文档 3.1.2 → Gemini)
    expect(forwardedBody.contents).toHaveLength(3);
    expect(forwardedBody.contents[0].role).toBe('user');
    expect(forwardedBody.contents[1].role).toBe('model'); // assistant → model
    expect(forwardedBody.contents[2].role).toBe('user');
  });

  test('should convert tool_use to functionCall', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: 'get_weather',
                args: { location: 'NYC', unit: 'celsius' }
              }
            }],
            role: 'model'
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const anthropicRequest = {
      model: 'gemini-pro',
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

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // Verify functionCall in response (按文档 3.2.2 Gemini → Anthropic)
    expect(responseBody.content).toHaveLength(1);
    expect(responseBody.content[0].type).toBe('tool_use');
    expect(responseBody.content[0].name).toBe('get_weather');
    expect(responseBody.content[0].input).toEqual({ location: 'NYC', unit: 'celsius' });
    expect(responseBody.stop_reason).toBe('tool_use'); // STOP with tool → tool_use

    // Verify request conversion
    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.contents[1].role).toBe('model');
    expect(forwardedBody.contents[1].parts[0].functionCall).toBeDefined();
    expect(forwardedBody.contents[1].parts[0].functionCall.name).toBe('get_weather');
    expect(forwardedBody.contents[1].parts[0].functionCall.args).toEqual({ location: 'NYC', unit: 'celsius' });
  });

  test('should convert tool_result to functionResponse', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
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

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tool_result → functionResponse (按文档 3.1.2 → Gemini)
    const toolResponseMsg = forwardedBody.contents.find((m: any) =>
      m.parts?.some((p: any) => p.functionResponse)
    );
    expect(toolResponseMsg).toBeDefined();
    expect(toolResponseMsg.role).toBe('user'); // tool_result is in user message
    expect(toolResponseMsg.parts[0].functionResponse).toBeDefined();
    expect(toolResponseMsg.parts[0].functionResponse.name).toBe('get_weather');
  });

  test('should convert multi-modal base64 images to inlineData', async () => {
    const anthropicRequest = {
      model: 'gemini-pro-vision',
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

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify image conversion (按文档 3.1.2 → Gemini)
    expect(forwardedBody.contents[0].parts).toHaveLength(2);
    expect(forwardedBody.contents[0].parts[0].inlineData).toBeDefined();
    expect(forwardedBody.contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg');
    expect(forwardedBody.contents[0].parts[0].inlineData.data).toBe('/9j/4AAQSkZJRg==');
    expect(forwardedBody.contents[0].parts[1].text).toBe('What is in this image?');
  });

  test('should convert thinking content blocks to text parts with thought: true', async () => {
    mockedFetch.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: 'Let me think...', thought: true },
              { text: 'The answer is 42.' }
            ],
            role: 'model'
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [{
        role: 'user',
        content: [
          { type: 'thinking', thinking: 'Internal reasoning' },
          { type: 'text', text: 'What is the answer?' }
        ]
      }],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // Verify thinking content (按文档 3.2.2 Gemini → Anthropic)
    expect(responseBody.content.some((c: any) => c.type === 'thinking')).toBe(true);
    expect(responseBody.content.some((c: any) => c.type === 'text')).toBe(true);

    // Verify request conversion
    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    expect(forwardedBody.contents[0].parts[0].text).toBe('Internal reasoning');
    expect(forwardedBody.contents[0].parts[1].text).toBe('What is the answer?');
  });

  test('should convert thinking.budget_tokens to thinkingConfig', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [{ role: 'user', content: 'Complex reasoning task' }],
      max_tokens: 4096,
      thinking: {
        type: 'enabled',
        budget_tokens: 8192
      }
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify thinking config (按文档 3.1.2 → Gemini)
    expect(forwardedBody.generationConfig.thinkingConfig).toBeDefined();
    expect(forwardedBody.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
  });

  test('should handle dynamic thinking when budget_tokens not provided', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [{ role: 'user', content: 'Think about this' }],
      max_tokens: 4096,
      thinking: {
        type: 'enabled'
        // No budget_tokens provided
      }
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify dynamic thinking (按文档 3.1.2: 未提供预算则设置为 -1)
    expect(forwardedBody.generationConfig.thinkingConfig).toBeDefined();
    expect(forwardedBody.generationConfig.thinkingConfig.thinkingBudget).toBe(-1);
  });

  test('should convert tools to functionDeclarations with schema cleaning', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [{ role: 'user', content: 'Get weather' }],
      max_tokens: 100,
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather',
          input_schema: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'City name',
                minLength: 1,
                maxLength: 100,
                pattern: '^[A-Za-z ]+$'
              }
            },
            required: ['location'],
            additionalProperties: false
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tools conversion with schema cleaning (按文档 3.1.2 → Gemini)
    expect(forwardedBody.tools).toBeDefined();
    expect(forwardedBody.tools[0].functionDeclarations).toHaveLength(1);

    const funcDecl = forwardedBody.tools[0].functionDeclarations[0];
    expect(funcDecl.name).toBe('get_weather');
    expect(funcDecl.description).toBe('Get current weather');

    // Verify schema cleaning - unsupported fields should be removed
    expect(funcDecl.parameters).not.toHaveProperty('additionalProperties');

    // minLength, maxLength, pattern 现在是有效字段（参考 llms 项目）
    expect(funcDecl.parameters.properties.location.minLength).toBe(1);
    expect(funcDecl.parameters.properties.location.maxLength).toBe(100);
    expect(funcDecl.parameters.properties.location.pattern).toBe('^[A-Za-z ]+$');

    // Verify allowed fields are preserved
    expect(funcDecl.parameters.type).toBe('object');
    expect(funcDecl.parameters.properties.location.type).toBe('string');
    expect(funcDecl.parameters.required).toEqual(['location']);
  });

  test('should filter invalid required fields in tool schema', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [{ role: 'user', content: 'Test tools' }],
      max_tokens: 100,
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool with invalid required fields',
          input_schema: {
            type: 'object',
            properties: {
              valid_field: {
                type: 'string',
                description: 'A valid field'
              },
              another_valid: {
                type: 'number',
                minimum: 0,
                maximum: 100
              }
            },
            // required 包含一个不存在的字段
            required: ['valid_field', 'nonexistent_field', 'another_valid'],
            additionalProperties: false,
            $schema: 'http://json-schema.org/draft-07/schema#',
            title: 'Test Schema'
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tools conversion
    expect(forwardedBody.tools).toBeDefined();
    const funcDecl = forwardedBody.tools[0].functionDeclarations[0];

    // Verify schema cleaning removed invalid fields
    expect(funcDecl.parameters).not.toHaveProperty('$schema');
    expect(funcDecl.parameters).not.toHaveProperty('additionalProperties');
    expect(funcDecl.parameters).not.toHaveProperty('title');

    // minimum 和 maximum 现在是有效字段（参考 llms 项目）
    expect(funcDecl.parameters.properties.another_valid.minimum).toBe(0);
    expect(funcDecl.parameters.properties.another_valid.maximum).toBe(100);

    // Verify required array was filtered to only include existing properties
    expect(funcDecl.parameters.required).toEqual(['valid_field', 'another_valid']);
    expect(funcDecl.parameters.required).not.toContain('nonexistent_field');

    // Verify valid fields are preserved
    expect(funcDecl.parameters.type).toBe('object');
    expect(funcDecl.parameters.properties.valid_field.type).toBe('string');
    expect(funcDecl.parameters.properties.valid_field.description).toBe('A valid field');
    expect(funcDecl.parameters.properties.another_valid.type).toBe('number');
  });

  test('should handle streaming response conversion', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      stream: true
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
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

    // Verify Anthropic SSE format (按文档 3.3.2 Gemini chunk → Anthropic SSE)
    expect(allData).toContain('event: message_start');
    expect(allData).toContain('event: content_block_start');
    expect(allData).toContain('event: content_block_delta');
    expect(allData).toContain('event: message_stop');
  });

  test('should handle parameter mapping correctly', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      messages: [{ role: 'user', content: 'Test' }],
      max_tokens: 2048,
      temperature: 0.8,
      top_p: 0.95,
      top_k: 40,
      stop_sequences: ['END', 'STOP']
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify parameter mapping (按文档 3.1.2 → Gemini)
    expect(forwardedBody.generationConfig.temperature).toBe(0.8);
    expect(forwardedBody.generationConfig.topP).toBe(0.95);
    expect(forwardedBody.generationConfig.topK).toBe(40);
    expect(forwardedBody.generationConfig.maxOutputTokens).toBe(2048);
    expect(forwardedBody.generationConfig.stopSequences).toEqual(['END', 'STOP']);
  });

  test('should handle system as content block array (Claude Code format)', async () => {
    const anthropicRequest = {
      model: 'gemini-pro',
      system: [
        {
          type: 'text',
          text: 'You are Claude Code, a helpful assistant.',
          cache_control: { type: 'ephemeral' }
        },
        {
          type: 'text',
          text: 'Always be concise and accurate.',
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify system instruction was merged correctly and cache_control was ignored
    expect(forwardedBody.system_instruction).toBeDefined();
    expect(forwardedBody.system_instruction.parts).toHaveLength(1);
    expect(forwardedBody.system_instruction.parts[0].text).toBe(
      'You are Claude Code, a helpful assistant.\nAlways be concise and accurate.'
    );
    expect(forwardedBody.system_instruction.parts[0].cache_control).toBeUndefined();
  });

  test('should handle count_tokens endpoint correctly', async () => {
    const anthropicRequest = {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'user', content: 'Test message for token counting' }
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather information',
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

    const req = new Request('http://localhost/v1/anthropic-to-gemini/messages/count_tokens', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    // Verify URL was rewritten correctly
    const [fetchUrl, fetchOptions] = mockedFetch.mock.calls[0];
    expect(fetchUrl).toBe('http://mock-gemini.com/v1beta/models/gemini-2.5-pro:countTokens');

    // Verify request body has generateContentRequest with model field
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.generateContentRequest).toBeDefined();
    expect(forwardedBody.generateContentRequest.model).toBe('models/gemini-2.5-pro');
    expect(forwardedBody.generateContentRequest.contents).toBeDefined();
    expect(forwardedBody.generateContentRequest.tools).toBeDefined();
  });
});

console.log('✅ Anthropic to Gemini integration tests created');
