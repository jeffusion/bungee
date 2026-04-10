import { afterEach, describe, expect, mock, test } from 'bun:test';
import { handleAPIRequest } from '../../src/api/router';
import { cleanupPluginRegistry, initializePluginRuntime } from '../../src/worker/state/plugin-manager';
import { getScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { resetModelMappingCatalogCache } from '../../../../plugins/model-mapping/server/index';

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetModelMappingCatalogCache();
  await cleanupPluginRegistry();
});

describe('plugin editor model catalog API', () => {
  test('serves model catalog for upstream-scoped model-mapping without requiring a global runtime instance', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          openai: {
            id: 'openai',
            models: {
              'gpt-4o': {
                id: 'gpt-4o',
                name: 'GPT-4o',
                limit: { context: 128000 },
                last_updated: '2026-04-10'
              }
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof globalThis.fetch;

    await initializePluginRuntime({
      plugins: [],
      routes: [{
        path: '/chat',
        upstreams: [{
          id: 'u1',
          target: 'http://mock-openai.com',
          plugins: [{ name: 'model-mapping', enabled: true }]
        }]
      }],
    }, { basePath: process.cwd() });

    const scopedRegistry = getScopedPluginRegistry();
    expect(scopedRegistry?.getGlobalInstances().find((instance) => instance.handler.pluginName === 'model-mapping')).toBeUndefined();

    const response = await handleAPIRequest(
      new Request('http://localhost/api/plugins/model-mapping/models'),
      '/api/plugins/model-mapping/models'
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { source: 'fresh' | 'static'; models: Array<{ value: string; provider?: string }> };
    expect(payload.source).toBe('fresh');
    expect(payload.models.some((model) => model.value === 'gpt-4o' && model.provider === 'openai')).toBe(true);

    const secondResponse = await handleAPIRequest(
      new Request('http://localhost/api/plugins/model-mapping/models'),
      '/api/plugins/model-mapping/models'
    );

    expect(secondResponse.status).toBe(200);
    const secondPayload = await secondResponse.json() as { source: 'fresh' | 'static'; models: Array<{ value: string; provider?: string }> };
    expect(secondPayload.models.some((model) => model.value === 'gpt-4o' && model.provider === 'openai')).toBe(true);
    expect(calls).toBe(1);
  });

  test('serves provider-filtered ai-transformer model catalogs without requiring a global runtime instance', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          id: 'openai',
          models: {
            'gpt-4o-mini': {
              id: 'gpt-4o-mini',
              name: 'GPT-4o mini',
              limit: { context: 128000 },
              last_updated: '2026-04-10'
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof globalThis.fetch;

    await initializePluginRuntime({
      plugins: [],
      routes: [{
        path: '/chat',
        plugins: [{ name: 'ai-transformer', enabled: true, options: { from: 'openai', to: 'anthropic' } }],
        upstreams: [{ id: 'u1', target: 'http://mock-anthropic.com' }]
      }],
    }, { basePath: process.cwd() });

    const scopedRegistry = getScopedPluginRegistry();
    expect(scopedRegistry?.getGlobalInstances().find((instance) => instance.handler.pluginName === 'ai-transformer')).toBeUndefined();

    const response = await handleAPIRequest(
      new Request('http://localhost/api/plugins/ai-transformer/models?provider=openai'),
      '/api/plugins/ai-transformer/models'
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { provider: string; source: 'fresh' | 'static'; models: Array<{ value: string }> };
    expect(payload.provider).toBe('openai');
    expect(['fresh', 'static']).toContain(payload.source);
    expect(payload.models.some((model) => model.value === 'gpt-4o-mini')).toBe(true);
  });
});
