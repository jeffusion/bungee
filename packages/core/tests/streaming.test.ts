import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AppConfig } from '../src/config';
import { handleRequest, initializeRuntimeState } from '../src/worker';
import { createSseTransformerStream } from '../src/streaming';

// Mock config with streaming transformer
const mockStreamingConfig: AppConfig = {
  routes: [
    {
      path: '/v1/messages',
      transformer: 'anthropic-to-gemini',
      upstreams: [{ target: 'http://mock-gemini-stream.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/multi-event-test',
      transformer: {
        path: { action: 'replace', match: '.*', replace: '/test' },
        response: [
          {
            match: { status: "^2..$" },
            rules: {
              stream: {
                // ✅ 添加阶段检测，确保正确识别 end 事件
                phaseDetection: {
                  isEnd: '{{ body.finishReason }}'
                },
                start: {
                  body: {
                    add: { type: 'stream_start', data: 'starting' },
                    remove: ['originalField']
                  }
                },
                chunk: {
                  body: {
                    add: { type: 'stream_chunk', text: '{{ body.text }}' },
                    remove: ['originalField']
                  }
                },
                end: {
                  body: {
                    add: {
                      __multi_events: [
                        { type: 'stream_delta', final: true },
                        { type: 'stream_stop' }
                      ]
                    },
                    remove: ['originalField']
                  }
                }
              }
            }
          }
        ]
      },
      upstreams: [{ target: 'http://mock-multi-event.com', weight: 100, priority: 1 }],
    },
    {
      path: '/v1/legacy-stream-test',
      transformer: {
        path: { action: 'replace', match: '.*', replace: '/legacy' },
        response: [
          {
            match: { status: "^2..$" },
            rules: {
              stream: {
                body: {
                  add: { type: 'legacy_chunk', content: '{{ body.text }}' },
                  remove: ['originalField']
                }
              }
            }
          }
        ]
      },
      upstreams: [{ target: 'http://mock-legacy-stream.com', weight: 100, priority: 1 }],
    }
  ],
};

// Mock fetch for streaming responses
const mockedFetch = mock(async (request: Request | string, options?: RequestInit) => {
  const url = typeof request === 'string' ? request : request.url;

  if (url.startsWith('http://mock-gemini-stream.com')) {
    // Simulate Gemini streaming response
    const streamContent = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1},"modelVersion":"gemini-2.5-pro"}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" there!"}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":3},"modelVersion":"gemini-2.5-pro"}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":3},"modelVersion":"gemini-2.5-pro"}\n\n'
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

  if (url.startsWith('http://mock-multi-event.com')) {
    const streamContent = [
      'data: {"text":"start data","originalField":"remove me"}\n\n',
      'data: {"text":"first chunk","originalField":"remove me"}\n\n',
      'data: {"text":"second chunk","originalField":"remove me"}\n\n',
      'data: {"text":"","finishReason":"STOP","originalField":"remove me"}\n\n'
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

  if (url.startsWith('http://mock-legacy-stream.com')) {
    const streamContent = [
      'data: {"text":"legacy chunk","originalField":"remove me"}\n\n',
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

  return new Response('not found', { status: 404 });
});

global.fetch = mockedFetch as any;

describe('Streaming Architecture Tests', () => {
  beforeEach(() => {
    mockedFetch.mockClear();
    initializeRuntimeState(mockStreamingConfig);
  });

  test('should transform Gemini streaming to Anthropic format using state machine', async () => {
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockStreamingConfig);
    expect(response.status).toBe(200);
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

    // Parse and validate the streaming events
    const events = allData.split('\n\n').filter(line => line.startsWith('data: ')).map(line => {
      const dataContent = line.substring(6);
      return JSON.parse(dataContent);
    });

    // 基本检查
    expect(events.length).toBeGreaterThan(0);
  });

  test('should support multi-event end phase', async () => {
    const req = new Request('http://localhost/v1/multi-event-test', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockStreamingConfig);
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

    // Should have: start, chunk, chunk, end (2 events from multi-event) = 5 total
    expect(events.length).toBe(5);

    // Verify start event (first input event is treated as start)
    expect(events[0].type).toBe('stream_start');
    expect(events[0].data).toBe('starting');
    expect(events[0]).not.toHaveProperty('originalField');

    // Verify chunk events (2nd and 3rd input events)
    expect(events[1].type).toBe('stream_chunk');
    expect(events[1].text).toBe('first chunk');
    expect(events[1]).not.toHaveProperty('originalField');

    expect(events[2].type).toBe('stream_chunk');
    expect(events[2].text).toBe('second chunk');

    // Last two events are from multi-event end
    expect(events[3].type).toBe('stream_delta');
    expect(events[3].final).toBe(true);
    expect(events[4].type).toBe('stream_stop');
  });

  test('should support legacy single-rule streaming format', async () => {
    const req = new Request('http://localhost/v1/legacy-stream-test', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleRequest(req, mockStreamingConfig);
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

    // Should have one transformed chunk (legacy mode only processes chunks)
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('legacy_chunk');
    expect(events[0].content).toBe('legacy chunk');
    expect(events[0]).not.toHaveProperty('originalField');
  });
});

describe('Streaming Transform Stream Unit Tests', () => {
  test('should handle state machine rules correctly', async () => {
    const mockRules = {
      // ✅ 添加阶段检测，确保正确识别 end 事件
      phaseDetection: {
        isEnd: '{{ body.finishReason }}'
      },
      start: {
        body: {
          add: { type: 'test_start', id: '{{ "start_" + crypto.randomUUID() }}' },
          remove: ['unwanted']
        }
      },
      chunk: {
        body: {
          add: { type: 'test_chunk', data: '{{ body.text }}', index: '{{ stream.chunkIndex }}' },
          remove: ['unwanted']
        }
      },
      end: {
        body: {
          add: {
            __multi_events: [
              { type: 'test_end', final: true },
              { type: 'test_complete' }
            ]
          },
          remove: ['unwanted']
        }
      }
    };

    const mockContext = {
      headers: {},
      body: {},
      url: { pathname: '/test', search: '', host: 'localhost', protocol: 'http:' },
      method: 'POST',
      env: {}
    };

    const transformer = createSseTransformerStream(mockRules, mockContext, { requestId: 'test' });

    // Simulate input stream
    const inputData = [
      'data: {"text":"start","unwanted":"remove"}\n\n',
      'data: {"text":"first","unwanted":"remove"}\n\n',
      'data: {"text":"second","unwanted":"remove"}\n\n',
      'data: {"text":"","finishReason":"STOP","unwanted":"remove"}\n\n'
    ].join('');

    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(inputData));
        controller.close();
      }
    });

    const outputStream = inputStream.pipeThrough(transformer);
    const reader = outputStream.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value);
    }

    const events = result.split('\n\n').filter(line => line.startsWith('data: ')).map(line => {
      const dataContent = line.substring(6);
      return JSON.parse(dataContent);
    });

    // Should have: start, chunk, chunk, end (2 events from multi-event) = 5 total
    expect(events.length).toBe(5);

    // Verify start event (first input "start" is treated as start)
    expect(events[0].type).toBe('test_start');
    expect(events[0].id).toMatch(/^start_/);
    expect(events[0]).not.toHaveProperty('unwanted');

    // Verify chunk events (2nd and 3rd inputs: "first" and "second")
    expect(events[1].type).toBe('test_chunk');
    expect(events[1].data).toBe('first');
    expect(events[1].index).toBe(0);
    expect(events[1]).not.toHaveProperty('unwanted');

    expect(events[2].type).toBe('test_chunk');
    expect(events[2].data).toBe('second');
    expect(events[2].index).toBe(1);
    expect(events[2]).not.toHaveProperty('unwanted');

    // Verify end events (multi-event from 4th input with finishReason)
    // Multi-event end at positions 3 and 4
    expect(events[3].type).toBe('test_end');
    expect(events[3].final).toBe(true);
    expect(events[4].type).toBe('test_complete');
  });

  test('should handle legacy single-rule format', async () => {
    const legacyRules = {
      body: {
        add: { type: 'legacy_format', content: '{{ body.text }}' },
        remove: ['original']
      }
    };

    const mockContext = {
      headers: {},
      body: {},
      url: { pathname: '/test', search: '', host: 'localhost', protocol: 'http:' },
      method: 'POST',
      env: {}
    };

    const transformer = createSseTransformerStream(legacyRules, mockContext, { requestId: 'test' });

    const inputData = 'data: {"text":"test content","original":"remove"}\n\n';
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(inputData));
        controller.close();
      }
    });

    const outputStream = inputStream.pipeThrough(transformer);
    const reader = outputStream.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value);
    }

    const events = result.split('\n\n').filter(line => line.startsWith('data: ')).map(line => {
      const dataContent = line.substring(6);
      return JSON.parse(dataContent);
    });

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('legacy_format');
    expect(events[0].content).toBe('test content');
    expect(events[0]).not.toHaveProperty('original');
  });

  test('should handle [DONE] signal correctly', async () => {
    const mockRules = {
      end: {
        body: {
          add: { type: 'final_event' }
        }
      }
    };

    const mockContext = {
      headers: {},
      body: {},
      url: { pathname: '/test', search: '', host: 'localhost', protocol: 'http:' },
      method: 'POST',
      env: {}
    };

    const transformer = createSseTransformerStream(mockRules, mockContext, { requestId: 'test' });

    const inputData = 'data: [DONE]\n\n';
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(inputData));
        controller.close();
      }
    });

    const outputStream = inputStream.pipeThrough(transformer);
    const reader = outputStream.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value);
    }

    const events = result.split('\n\n').filter(line => line.startsWith('data: ')).map(line => {
      const dataContent = line.substring(6);
      return JSON.parse(dataContent);
    });

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('final_event');
  });
});