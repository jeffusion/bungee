import { afterEach, describe, expect, test } from 'bun:test';
import { createPluginHooks, type MutableRequestContext } from '../../src/hooks';
import ModelMappingPlugin, { resetModelMappingCatalogCache } from '../../../../plugins/model-mapping/server/index';

afterEach(() => {
  resetModelMappingCatalogCache();
});

function createMockRequestContext(model: string): MutableRequestContext {
  return {
    method: 'POST',
    originalUrl: new URL('http://localhost/v1/chat/completions'),
    clientIP: '127.0.0.1',
    requestId: 'test-request-id',
    routeId: '/v1/test',
    url: new URL('http://mock-upstream/v1/chat/completions'),
    headers: {
      'content-type': 'application/json'
    },
    body: {
      model,
      messages: [{ role: 'user', content: 'hello' }]
    }
  };
}

function createMockGeminiRequestContext(model: string, isStreaming = false): MutableRequestContext {
  const endpoint = isStreaming ? 'streamGenerateContent' : 'generateContent';
  return {
    method: 'POST',
    originalUrl: new URL(`http://localhost/v1beta/models/${model}:${endpoint}`),
    clientIP: '127.0.0.1',
    requestId: 'test-request-id',
    routeId: '/v1/test',
    url: new URL(`http://mock-upstream/v1beta/models/${model}:${endpoint}`),
    headers: {
      'content-type': 'application/json'
    },
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
    }
  };
}

describe('model-mapping runtime behavior', () => {
  test('should fetch online full catalog and return model ids', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          openai: {
            id: 'openai',
            models: {
              'gpt-4o': {
                id: 'gpt-4o',
                name: 'GPT-4o',
                limit: { context: 128000 },
                last_updated: '2026-03-20'
              }
            }
          },
          anthropic: {
            id: 'anthropic',
            models: {
              'claude-3-5-sonnet-20241022': {
                id: 'claude-3-5-sonnet-20241022',
                name: 'Claude 3.5 Sonnet',
                limit: { context: 200000 },
                last_updated: '2026-03-19'
              }
            }
          }
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }) as unknown as typeof globalThis.fetch;

    const plugin = new ModelMappingPlugin({});

    try {
      const response = await plugin.getModels(new Request('http://localhost/models'));
      const payload = await response.json() as {
        models: Array<{ value: string; provider?: string }>;
        source: 'fresh' | 'static';
      };

      expect(response.status).toBe(200);
      expect(payload.source).toBe('fresh');
      expect(fetchCalls).toBeGreaterThan(0);
      expect(payload.models.length).toBe(2);
      expect(payload.models.some((model) => model.value === 'gpt-4o' && model.provider === 'openai')).toBe(true);
      expect(payload.models.some((model) => model.value === 'claude-3-5-sonnet-20241022' && model.provider === 'anthropic')).toBe(true);
      expect(payload.models.every((model) => !model.value.startsWith('openai:'))).toBe(true);
      expect(payload.models.every((model) => !model.value.startsWith('anthropic:'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('should fallback to static catalog when online fetch fails', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;

    const plugin = new ModelMappingPlugin({});

    try {
      const response = await plugin.getModels(new Request('http://localhost/models'));
      const payload = await response.json() as {
        provider: string;
        models: Array<{ value: string; provider?: string }>;
        source: 'fresh' | 'static';
      };

      expect(response.status).toBe(200);
      expect(payload.provider).toBe('');
      expect(payload.source).toBe('static');
      expect(payload.models.length).toBeGreaterThan(0);
      expect(payload.models.some((model) => model.value.startsWith('openai:'))).toBe(false);
      expect(payload.models.some((model) => model.value.startsWith('anthropic:'))).toBe(false);
      expect(payload.models.some((model) => typeof model.provider === 'string' && model.provider.length > 0)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('should match canonical source IDs and normalize canonical target IDs', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'openai:gpt-4o-mini',
          target: 'anthropic:claude-3-5-sonnet-20241022'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockRequestContext('gpt-4o-mini');
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.body.model).toBe('claude-3-5-sonnet-20241022');
  });

  test('should map Gemini URL path model to target model', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'gemini-pro',
          target: 'gemini-1.5-pro'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockGeminiRequestContext('gemini-pro');
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.url.pathname).toBe('/v1beta/models/gemini-1.5-pro:generateContent');
  });

  test('should map Gemini streaming URL path model', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'gemini-pro',
          target: 'gemini-1.5-flash'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockGeminiRequestContext('gemini-pro', true);
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.url.pathname).toBe('/v1beta/models/gemini-1.5-flash:streamGenerateContent');
  });

  test('should handle URL encoded model names in Gemini path', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'models/gemini-pro',
          target: 'gemini-1.5-pro'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const encodedModel = encodeURIComponent('models/gemini-pro');
    const context = createMockGeminiRequestContext(encodedModel);
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.url.pathname).toBe('/v1beta/models/gemini-1.5-pro:generateContent');
  });

  test('should prefer body.model over URL path model when both exist', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'gpt-4',
          target: 'claude-3-opus'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockRequestContext('gpt-4');
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.body.model).toBe('claude-3-opus');
  });
});
