import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import {
  cleanupPluginRegistry,
  handleRequest,
  initializePluginRegistryForTests,
  initializeRuntimeState,
} from '../../src/worker';

const testConfig: AppConfig = {
  routes: [
    {
      path: '/v1/sanitize',
      pathRewrite: { '^/v1/sanitize': '/v1' },
      upstreams: [{ target: 'http://mock-anthropic.com', weight: 100, priority: 1 }],
    },
  ],
};

const mockedFetch = mock(async (request: Request | string, _init?: RequestInit) => {
  const url = typeof request === 'string' ? request : request.url;
  if (url.includes('mock-anthropic.com')) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('not found', { status: 404 });
});

const originalFetch = globalThis.fetch;

function getForwardedCall(): { url: string; options: RequestInit } {
  expect(mockedFetch.mock.calls.length).toBeGreaterThan(0);
  const firstCall = mockedFetch.mock.calls[0];
  const request = firstCall[0];
  const options = firstCall[1];
  expect(options).toBeDefined();
  const url = typeof request === 'string' ? request : request.url;
  return { url, options: options! };
}

describe('anthropic-request-sanitizer plugin', () => {
  beforeEach(async () => {
    mockedFetch.mockClear();
    globalThis.fetch = mockedFetch as unknown as typeof fetch;
    initializeRuntimeState(testConfig);
    await initializePluginRegistryForTests(testConfig);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupPluginRegistry();
  });

  test('strips cache_control recursively and normalizes deferred tools in normal mode', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [
            {
              name: 'anthropic-request-sanitizer',
              options: {
                sanitizeMode: 'normal',
                stripCacheControl: true,
                betaMode: 'allowlist',
                betaAllowlist: 'claude-code-20250219',
                removeBetaQuery: true,
              },
            },
          ],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages?beta=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'foo,claude-code-20250219,bar',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        cache_control: { type: 'ephemeral' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
            ],
          },
        ],
        tools: [
          {
            type: 'deferred',
            deferred: true,
            tool: {
              name: 'weather_tool',
              description: 'Weather lookup',
              input_schema: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                },
                required: ['city'],
              },
              cache_control: { type: 'ephemeral' },
            },
          },
        ],
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedHeaders = new Headers(forwarded.options.headers);
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwarded.url.includes('beta=true')).toBe(false);
    expect(forwardedHeaders.get('anthropic-beta')).toBe('claude-code-20250219');

    expect(forwardedBody.cache_control).toBeUndefined();
    expect(forwardedBody.messages[0].content[0].cache_control).toBeUndefined();
    expect(forwardedBody.tools).toHaveLength(1);
    expect(forwardedBody.tools[0].type).toBeUndefined();
    expect(forwardedBody.tools[0].deferred).toBeUndefined();
    expect(forwardedBody.tools[0].tool).toBeUndefined();
    expect(forwardedBody.tools[0].name).toBe('weather_tool');
    expect(forwardedBody.tools[0].cache_control).toBeUndefined();
  });

  test('aggressive mode strips compatibility-risk fields but respects independent beta/cache settings', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [
            {
              name: 'anthropic-request-sanitizer',
              options: {
                sanitizeMode: 'aggressive',
                betaMode: 'passthrough',
                removeBetaQuery: true,
              },
            },
          ],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages?beta=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'claude-code-20250219,computer-use-2025-01-24',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        cache_control: { type: 'ephemeral' },
        context_management: { type: 'auto' },
        container: { id: 'c1' },
        metadata: { user_id: 'u1' },
        effort: 'high',
        service_tier: 'priority',
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedHeaders = new Headers(forwarded.options.headers);
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwarded.url.includes('beta=true')).toBe(false);
    expect(forwardedHeaders.get('anthropic-beta')).toBe('claude-code-20250219,computer-use-2025-01-24');
    expect(forwardedBody.cache_control).toEqual({ type: 'ephemeral' });

    expect(forwardedBody.context_management).toBeUndefined();
    expect(forwardedBody.container).toBeUndefined();
    expect(forwardedBody.metadata).toBeUndefined();
    expect(forwardedBody.effort).toBeUndefined();
    expect(forwardedBody.service_tier).toBeUndefined();
  });

  test('removeBetaQuery only removes beta=true and keeps other beta values', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [
            {
              name: 'anthropic-request-sanitizer',
              options: {
                sanitizeMode: 'aggressive',
                removeBetaQuery: true,
              },
            },
          ],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages?beta=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    expect(forwarded.url).toContain('beta=false');
  });

  test('stripCacheControl works independently when sanitizeMode is none', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [
            {
              name: 'anthropic-request-sanitizer',
              options: {
                sanitizeMode: 'none',
                stripCacheControl: true,
              },
            },
          ],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        cache_control: { type: 'ephemeral' },
        metadata: { keep: true },
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwardedBody.cache_control).toBeUndefined();
    expect(forwardedBody.metadata).toEqual({ keep: true });
  });

  test('does not modify existing auth headers', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [
            {
              name: 'anthropic-request-sanitizer',
              options: {
                betaMode: 'strip',
              },
            },
          ],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer original-token',
        'x-api-key': 'original-key',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedHeaders = new Headers(forwarded.options.headers);

    expect(forwardedHeaders.get('authorization')).toBe('Bearer original-token');
    expect(forwardedHeaders.get('x-api-key')).toBe('original-key');
    expect(forwardedHeaders.get('anthropic-beta')).toBeNull();
  });

  test('filters orphan tool_result and removes emptied messages when enabled', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [
            {
              name: 'anthropic-request-sanitizer',
              options: {
                filterOrphanToolResults: true,
              },
            },
          ],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'weather', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'phantom', content: 'x' }],
          },
        ],
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwardedBody.messages).toHaveLength(1);
    expect(forwardedBody.messages[0].role).toBe('user');
  });

  test('can disable orphan tool_result filtering', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [
            {
              name: 'anthropic-request-sanitizer',
              options: {
                filterOrphanToolResults: false,
              },
            },
          ],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'weather', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'phantom', content: 'x' }],
          },
        ],
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwardedBody.messages).toHaveLength(3);
    expect(forwardedBody.messages[2].content[0].tool_use_id).toBe('phantom');
  });

  test('removes unmatched assistant tool_use when next user message has no tool_result', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [{ name: 'anthropic-request-sanitizer', options: { filterOrphanToolResults: true } }],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Shanghai' } },
              { type: 'text', text: 'checking' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwardedBody.messages[1].role).toBe('assistant');
    expect(forwardedBody.messages[1].content).toEqual([{ type: 'text', text: 'checking' }]);
  });

  test('normalizes assistant tool_use blocks to a contiguous tail segment', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [{ name: 'anthropic-request-sanitizer', options: { filterOrphanToolResults: true } }],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const req = new Request('http://localhost/v1/sanitize/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'first' },
              { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} },
              { type: 'text', text: 'middle' },
              { type: 'tool_use', id: 'toolu_2', name: 'b', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'r1' },
              { type: 'tool_result', tool_use_id: 'toolu_2', content: 'r2' },
              { type: 'text', text: 'ok' },
            ],
          },
        ],
      }),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedBody = JSON.parse(String(forwarded.options.body));
    const assistantContent = forwardedBody.messages[1].content;

    expect(assistantContent.map((b: { type?: string }) => b.type)).toEqual([
      'text',
      'text',
      'tool_use',
      'tool_use',
    ]);
  });

  test('default config (no options) does not modify request at all', async () => {
    const config: AppConfig = {
      routes: [
        {
          ...testConfig.routes[0],
          plugins: [{ name: 'anthropic-request-sanitizer' }],
        },
      ],
    };

    initializeRuntimeState(config);
    await initializePluginRegistryForTests(config);

    const originalBody = {
      model: 'claude-3-5-sonnet-20241022',
      cache_control: { type: 'ephemeral' },
      context_management: { type: 'auto' },
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'weather', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'phantom', content: 'x' }],
        },
      ],
    };

    const req = new Request('http://localhost/v1/sanitize/messages?beta=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'foo,bar',
      },
      body: JSON.stringify(originalBody),
    });

    await handleRequest(req, config);

    const forwarded = getForwardedCall();
    const forwardedHeaders = new Headers(forwarded.options.headers);
    const forwardedBody = JSON.parse(String(forwarded.options.body));

    expect(forwardedBody.cache_control).toEqual({ type: 'ephemeral' });
    expect(forwardedBody.context_management).toEqual({ type: 'auto' });
    expect(forwardedBody.messages).toHaveLength(3);
    expect(forwardedBody.messages[2].content[0].tool_use_id).toBe('phantom');

    expect(forwardedHeaders.get('anthropic-beta')).toBe('foo,bar');

    expect(forwarded.url).toContain('beta=true');
  });
});
