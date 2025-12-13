/**
 * Anthropic Filter Error Tool Results Plugin Tests
 *
 * Tests the anthropic-filter-error-tool-results plugin functionality
 *
 * Logic:
 * - Iterate through messages
 * - For 'user' messages, check tool_result items
 * - Verify against tool_use IDs from the PREVIOUS 'assistant' message
 * - Remove tool_result items that don't have a matching tool_use ID in the previous message
 * - Remove messages that become empty after filtering
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import { handleRequest, initializeRuntimeState, initializePluginRegistryForTests, cleanupPluginRegistry } from '../../src/worker';
import { setMockEnv, cleanupEnv } from './test-helpers';

// Mock config with anthropic-filter-error-tool-results plugin
const mockConfig: AppConfig = {
  routes: [
    {
      path: '/v1/test-filter',
      pathRewrite: { '^/v1/test-filter': '/v1' },
      plugins: ['anthropic-filter-error-tool-results'],
      upstreams: [{ target: 'http://mock-anthropic.com', weight: 100, priority: 1 }]
    }
  ]
};

// Mock fetch responses
const mockedFetch = mock(async (request: Request | string, options?: RequestInit) => {
  const url = typeof request === 'string' ? request : request.url;

  if (url.includes('mock-anthropic.com')) {
    // Mock Anthropic response
    const anthropicResponse = {
      id: `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'This is a mock response.'
        }
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 15
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

describe('Anthropic Filter Error Tool Results Plugin - Unit Tests', () => {
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

  test('should keep valid matching tool_result', async () => {
    const request = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: 'Weather?'
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'weather', input: {} }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'Sunny' }
          ]
        }
      ]
    };

    const req = new Request('http://localhost/v1/test-filter/messages', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should keep everything (3 messages)
    expect(forwardedBody.messages).toHaveLength(3);
    expect(forwardedBody.messages[2].content).toHaveLength(1);
    expect(forwardedBody.messages[2].content[0].tool_use_id).toBe('t1');
  });

  test('should remove phantom tool_result and the empty message', async () => {
    const request = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: 'Weather?'
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'weather', input: {} }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't999', content: 'Phantom' } // t999 not in t1
          ]
        }
      ]
    };

    const req = new Request('http://localhost/v1/test-filter/messages', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should remove the phantom tool_result
    // Since message becomes empty, it should be removed from messages array
    expect(forwardedBody.messages).toHaveLength(2);
    expect(forwardedBody.messages[1].role).toBe('assistant');
  });

  test('should handle mixed valid and invalid tool_results', async () => {
    const request = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        { role: 'user', content: 'Start' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'tool1', input: {} },
            { type: 'tool_use', id: 't2', name: 'tool2', input: {} }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'Valid' },
            { type: 'tool_result', tool_use_id: 't3', content: 'Invalid' },
            { type: 'text', text: 'Some comment' },
            { type: 'tool_result', tool_use_id: 't2', content: 'Valid' }
          ]
        }
      ]
    };

    const req = new Request('http://localhost/v1/test-filter/messages', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should keep t1, t2 and text
    // Should remove t3
    expect(forwardedBody.messages[2].content).toHaveLength(3);
    expect(forwardedBody.messages[2].content[0].tool_use_id).toBe('t1');
    expect(forwardedBody.messages[2].content[1].type).toBe('text');
    expect(forwardedBody.messages[2].content[2].tool_use_id).toBe('t2');
  });

  test('should remove orphan tool_result (no previous assistant message)', async () => {
    const request = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'Orphan' }
          ]
        }
      ]
    };

    const req = new Request('http://localhost/v1/test-filter/messages', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Should remove the orphan tool_result
    // Message becomes empty, so it should be removed
    expect(forwardedBody.messages).toHaveLength(0);
  });

  test('should keep text content in user message unchanged', async () => {
    const request = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: 'Just text'
        },
        {
          role: 'assistant',
          content: 'Response'
        },
        {
          role: 'user',
          content: [
             { type: 'text', text: 'More text' }
          ]
        }
      ]
    };

    const req = new Request('http://localhost/v1/test-filter/messages', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' }
    });

    await handleRequest(req, mockConfig);

    const [, fetchOptions] = mockedFetch.mock.calls[0];
    const forwardedBody = JSON.parse(fetchOptions!.body as string);

    // Text-only messages are valid
    expect(forwardedBody.messages).toHaveLength(3);
    expect(forwardedBody.messages[0].content).toBe('Just text');
    expect(forwardedBody.messages[2].content[0].text).toBe('More text');
  });
});

console.log('✅ Anthropic Filter Error Tool Results plugin tests created');
