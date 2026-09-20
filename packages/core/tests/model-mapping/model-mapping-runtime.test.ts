import { describe, expect, test } from 'bun:test';
import { createPluginHooks, type MutableRequestContext } from '../../src/hooks';
import ModelMappingPlugin from '../../../../plugins/model-mapping/server/index';

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
