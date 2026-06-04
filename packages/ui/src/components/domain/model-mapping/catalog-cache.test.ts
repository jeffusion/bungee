import { describe, expect, test } from 'bun:test';
import { getCachedPluginModelCatalog, resetPluginModelCatalogCache } from './catalog-cache';

describe('plugin model catalog cache', () => {
  test('passes through repeated requests without session caching', async () => {
    resetPluginModelCatalogCache();

    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return {
        provider: '',
        source: 'stored' as const,
        models: [{ value: 'gpt-4o', label: 'GPT-4o', provider: 'openai' }]
      };
    };

    const first = await getCachedPluginModelCatalog(fetcher, 'model-mapping');
    const second = await getCachedPluginModelCatalog(fetcher, 'model-mapping');

    expect(first.models).toHaveLength(1);
    expect(second.models[0]?.value).toBe('gpt-4o');
    expect(calls).toBe(2);
  });

  test('keeps repeated requests independent even for static fallback results', async () => {
    resetPluginModelCatalogCache();

    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return {
        provider: '',
        source: calls === 1 ? 'static' as const : 'stored' as const,
        models: [{ value: calls === 1 ? 'fallback-model' : 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', provider: 'anthropic' }]
      };
    };

    const first = await getCachedPluginModelCatalog(fetcher, 'model-mapping');
    const second = await getCachedPluginModelCatalog(fetcher, 'model-mapping');

    expect(first.models[0]?.value).toBe('fallback-model');
    expect(second.models[0]?.provider).toBe('anthropic');
    expect(calls).toBe(2);
  });
});
