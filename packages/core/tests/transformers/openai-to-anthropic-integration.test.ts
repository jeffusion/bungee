/**
 * OpenAI to Anthropic Integration Tests
 * Tests the enhanced openai-to-anthropic transformer with full feature support
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-shared';
import { handleRequest, initializeRuntimeState } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with openai-to-anthropic transformer
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/openai-to-anthropic',
      pathRewrite: { '^/v1/openai-to-anthropic': '/v1' },
      transformer: 'openai-to-anthropic',
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
      const hasToolCalls = requestBody.tools && requestBody.tools.length > 0;
      const streamContent = hasToolCalls ? [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-3-opus-20240229","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"get_weather"}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":\\""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"NYC\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n'
      ].join('') : [
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
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
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

    // Non-streaming response - check for tool calls
    const hasToolCalls = requestBody.tools && requestBody.tools.length > 0;
    const anthropicResponse = hasToolCalls ? {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'get_weather',
          input: { location: 'NYC' }
        }
      ],
      model: 'claude-3-opus-20240229',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 15,
        output_tokens: 25
      }
    } : {
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

describe('OpenAI to Anthropic - Enhanced Integration Tests', () => {
  beforeEach(() => {
    setMockEnv();
    mockedFetch.mockClear();
    initializeRuntimeState(mockConfig);
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert basic OpenAI request to Anthropic and back', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [
        { role: 'user', content: 'Hello, how are you?' }
      ],
      max_tokens: 100,
      temperature: 0.7
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    expect(response.status).toBe(200);

    const responseBody = await response.json();

    // Verify OpenAI response format
    expect(responseBody.id).toBeDefined();
    expect(responseBody.object).toBe('chat.completion');
    expect(responseBody.choices).toBeDefined();
    expect(responseBody.choices).toHaveLength(1);
    expect(responseBody.choices[0].message.role).toBe('assistant');
    expect(responseBody.choices[0].message.content).toBe('This is a response from Anthropic.');
    expect(responseBody.choices[0].finish_reason).toBe('stop');

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
    expect(forwardedBody.max_tokens).toBe(100);
    expect(forwardedBody.temperature).toBe(0.7);
  });

  test('should handle system messages correctly', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // System message should be in system field
    expect(forwardedBody.system).toBe('You are a helpful assistant.');
    expect(forwardedBody.messages[0].role).toBe('user');
    expect(forwardedBody.messages[0].content).toBe('Hello!');
  });

  test('should handle tool calls in request', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [
        { role: 'user', content: 'What is the weather in NYC?' }
      ],
      max_tokens: 100,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' }
              }
            }
          }
        }
      ]
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handleRequest(req, mockConfig);
    const responseBody = await response.json();

    // Verify tool_calls in response
    expect(responseBody.choices[0].message.tool_calls).toBeDefined();
    expect(responseBody.choices[0].message.tool_calls).toHaveLength(1);
    expect(responseBody.choices[0].message.tool_calls[0].type).toBe('function');
    expect(responseBody.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    expect(responseBody.choices[0].finish_reason).toBe('tool_calls');

    // Verify tools were transformed correctly
    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);
    expect(forwardedBody.tools).toBeDefined();
    expect(forwardedBody.tools[0].name).toBe('get_weather');
    expect(forwardedBody.tools[0].input_schema).toBeDefined();
  });

  test('should handle tool results in messages', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"NYC"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: 'The weather is sunny, 72°F'
        },
        { role: 'user', content: 'Thanks!' }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify tool_use conversion
    expect(forwardedBody.messages[1].role).toBe('assistant');
    expect(forwardedBody.messages[1].content).toHaveLength(1);
    expect(forwardedBody.messages[1].content[0].type).toBe('tool_use');
    expect(forwardedBody.messages[1].content[0].name).toBe('get_weather');

    // Verify tool_result conversion
    expect(forwardedBody.messages[2].role).toBe('user');
    expect(forwardedBody.messages[2].content[0].type).toBe('tool_result');
    expect(forwardedBody.messages[2].content[0].tool_use_id).toBe('call_123');
    expect(forwardedBody.messages[2].content[0].content).toBe('The weather is sunny, 72°F');
  });

  test('should handle multi-modal content with images', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' } }
          ]
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify multi-modal content - images should come first
    expect(forwardedBody.messages[0].content).toHaveLength(2);
    expect(forwardedBody.messages[0].content[0].type).toBe('image');
    expect(forwardedBody.messages[0].content[0].source.type).toBe('base64');
    expect(forwardedBody.messages[0].content[0].source.media_type).toBe('image/jpeg');
    expect(forwardedBody.messages[0].content[1].type).toBe('text');
  });

  test('should handle thinking tags in user messages', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [
        {
          role: 'user',
          content: 'Before answering: <thinking>Let me think about this carefully</thinking> What is 2+2?'
        }
      ],
      max_tokens: 100
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Verify thinking content extraction
    expect(Array.isArray(forwardedBody.messages[0].content)).toBe(true);
    const content = forwardedBody.messages[0].content;
    expect(content.some((c: any) => c.type === 'text' && c.text === 'Before answering:')).toBe(true);
    expect(content.some((c: any) => c.type === 'thinking' && c.thinking === 'Let me think about this carefully')).toBe(true);
    expect(content.some((c: any) => c.type === 'text' && c.text === 'What is 2+2?')).toBe(true);
  });

  test('should handle max_tokens fallback to ANTHROPIC_MAX_TOKENS', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [
        { role: 'user', content: 'Hello!' }
      ]
      // No max_tokens specified
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should use ANTHROPIC_MAX_TOKENS from env (32000)
    expect(forwardedBody.max_tokens).toBe(32000);
  });

  test('should convert streaming responses', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      stream: true
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
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

    // Verify OpenAI streaming format
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].object).toBe('chat.completion.chunk');
    expect(events[0].choices).toBeDefined();
  });

  test('should handle reasoning effort to thinking budget conversion', async () => {
    const openaiRequest = {
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: 'Solve this complex problem' }],
      max_completion_tokens: 4096,
      reasoning_effort: 'high'
    };

    const req = new Request('http://localhost/v1/openai-to-anthropic/chat/completions', {
      method: 'POST',
      body: JSON.stringify(openaiRequest),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should use OPENAI_HIGH_TO_ANTHROPIC_TOKENS from env
    expect(forwardedBody.thinking).toBeDefined();
    expect(forwardedBody.thinking.type).toBe('enabled');
    expect(forwardedBody.thinking.budget_tokens).toBe(16384);
  });
});

console.log('✅ OpenAI to Anthropic enhanced integration tests created');
