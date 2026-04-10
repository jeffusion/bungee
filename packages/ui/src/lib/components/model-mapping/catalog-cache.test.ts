import { describe, expect, test } from 'bun:test';
import { getCachedPluginModelCatalog, resetPluginModelCatalogCache } from './catalog-cache';

describe('plugin model catalog cache', () => {
  test('reuses cached responses for repeated requests in the same UI session', async () => {
    resetPluginModelCatalogCache();

    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return {
        provider: '',
        source: 'fresh' as const,
        models: [{ value: 'gpt-4o', label: 'GPT-4o', provider: 'openai' }]
      };
    };

    const first = await getCachedPluginModelCatalog(fetcher, 'model-mapping');
    const second = await getCachedPluginModelCatalog(fetcher, 'model-mapping');

    expect(first.models).toHaveLength(1);
    expect(second.models[0]?.value).toBe('gpt-4o');
    expect(calls).toBe(1);
  });

  test('deduplicates concurrent in-flight requests for the same plugin catalog', async () => {
    resetPluginModelCatalogCache();

    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await Promise.resolve();
      return {
        provider: '',
        source: 'fresh' as const,
        models: [{ value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', provider: 'anthropic' }]
      };
    };

    const [first, second] = await Promise.all([
      getCachedPluginModelCatalog(fetcher, 'model-mapping'),
      getCachedPluginModelCatalog(fetcher, 'model-mapping')
    ]);

    expect(first.models[0]?.value).toBe('claude-3-5-sonnet');
    expect(second.models[0]?.provider).toBe('anthropic');
    expect(calls).toBe(1);
  });
});
