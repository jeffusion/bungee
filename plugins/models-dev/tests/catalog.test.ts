import { describe, expect, test } from 'bun:test';
import { MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT } from '../contract';
import { buildCatalogIndex, modelOptions, resolveModelInCatalog, resolveProviderFromUrl } from '../server/catalog';
import { CatalogView, catalogServiceOf } from '../server/local';
import { Database } from 'bun:sqlite';
import { HostSnapshotStore } from '../../../packages/core/src/plugin-services/snapshot-store';
import { PluginCommunicationStore } from '../../../packages/core/src/plugin-services/persistence';

const catalog = {
  'openai': { id: 'openai', name: 'OpenAI', models: { 'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', cost: { input: 2.5, output: 10, cache_read: 1.25 } } } },
  'anthropic': {
    id: 'anthropic', name: 'Anthropic', api: 'https://api.anthropic.com/v1/',
    models: { 'claude-3-5-sonnet': { id: 'claude-3-5-sonnet', name: 'Claude', cost: { input: 3, output: 15, cache_write: 3.75 } } },
  },
  'deepinfra': { id: 'deepinfra', name: 'Deep Infra', models: { 'tencent/Hy3': { id: 'tencent/Hy3', name: 'Hy3', cost: { input: 0.13, output: 0.53, tiers: [{ input: 1, output: 2, tier: { type: 'context', size: 32000 } }] } } } },
  'zai': { id: 'zai', name: 'Z.AI', api: 'https://api.z.ai/api/paas/v4', models: { 'glm-5.3': { id: 'glm-5.3', name: 'GLM', cost: { input: 1, output: 2 } } } },
  'zai-mirror': { id: 'zai-mirror', name: 'Z.AI mirror', api: 'https://api.z.ai/api/paas/v4', models: { 'glm-5.3': { id: 'glm-5.3', name: 'GLM mirror', cost: { input: 1, output: 2 } } } },
  'free': { id: 'free', name: 'Free', models: { 'free-model': { id: 'free-model', name: 'Free', cost: { input: 0, output: 0 } }, 'no-price': { id: 'no-price', name: 'No price' } } },
};

const index = buildCatalogIndex({ version: 7, fetchedAt: 1234, catalog });

describe('models-dev catalog index', () => {
  test('keeps providers without prices, no-price models and provider.api', () => {
    expect(index.modelCount).toBe(7);
    expect(index.providers.map(p => p.id).sort()).toEqual(['anthropic', 'deepinfra', 'free', 'openai', 'zai', 'zai-mirror']);
    expect(index.byProvider.get('openai')!.api).toBeNull();
    expect(index.byProvider.get('anthropic')!.api).toBe('https://api.anthropic.com/v1/');
    expect(index.byProvider.get('free')!.models.has('no-price')).toBe(true);
    // A zero price is a real, known price.
    expect(index.byProvider.get('free')!.models.get('free-model')!.price).toMatchObject({ input: 0, output: 0 });
  });

  test('resolves a provider from a real URL by normalized host and path, refusing ambiguity', () => {
    expect(resolveProviderFromUrl(index, 'https://api.anthropic.com/v1/messages')).toEqual({ provider: 'anthropic' });
    expect(resolveProviderFromUrl(index, 'https://API.ANTHROPIC.COM/v1/messages')).toEqual({ provider: 'anthropic' });
    expect(resolveProviderFromUrl(index, 'https://api.anthropic.com/v1/messages/batches')).toEqual({ provider: 'anthropic' });
    // A different path segment is not a prefix match.
    expect(resolveProviderFromUrl(index, 'https://api.anthropic.com/v2/messages')).toBeNull();
    // A lookalike host must never match.
    expect(resolveProviderFromUrl(index, 'https://api.anthropic.com.evil.example/v1/messages')).toBeNull();
    // The same api host under two providers is ambiguous, never guessed.
    expect(resolveProviderFromUrl(index, 'https://api.z.ai/api/paas/v4/chat/completions')).toBeNull();
    // A provider without `api` cannot be inferred from a URL.
    expect(resolveProviderFromUrl(index, 'https://api.openai.com/v1/chat/completions')).toBeNull();
  });

  test('resolves models exactly and case-sensitively, never guessing across providers', () => {
    expect(resolveModelInCatalog(index, { model: 'gpt-4o', pricingProvider: 'openai' })).toMatchObject({ provider: 'openai', input: 2.5, output: 10 });
    expect(resolveModelInCatalog(index, { model: 'GPT-4O', pricingProvider: 'openai' })).toBeNull();
    expect(resolveModelInCatalog(index, { model: 'gpt-4o' })).toMatchObject({ provider: 'openai' });
    // Same id under two providers without a provider is ambiguous.
    expect(resolveModelInCatalog(index, { model: 'glm-5.3' })).toBeNull();
    expect(resolveModelInCatalog(index, { model: 'glm-5.3', pricingProvider: 'zai' })).toMatchObject({ provider: 'zai' });
    // Provider prefix and URL resolution both work.
    expect(resolveModelInCatalog(index, { model: 'openai:gpt-4o' })).toMatchObject({ provider: 'openai' });
    expect(resolveModelInCatalog(index, { model: 'claude-3-5-sonnet', url: 'https://api.anthropic.com/v1/messages' })).toMatchObject({ provider: 'anthropic' });
    // Tiered pricing is flagged rather than expanded.
    expect(resolveModelInCatalog(index, { model: 'tencent/Hy3', pricingProvider: 'deepinfra' })).toMatchObject({ tiered: true });
    // A known provider that lacks the model is unknown, not redirected.
    expect(resolveModelInCatalog(index, { model: 'gpt-4o', pricingProvider: 'anthropic' })).toBeNull();
  });

  test('exposes a read-only service over the index', () => {
    const view = new CatalogView();
    view.apply(index);
    const service = catalogServiceOf(view);
    expect(service.status()).toMatchObject({ state: 'ready', version: 7, fetchedAt: 1234, providerCount: 6, modelCount: 7, error: null });
    expect(service.modelOptions({ search: 'claude' }).total).toBe(1);
    expect(service.providers().find(p => p.provider === 'anthropic')?.api).toBe('https://api.anthropic.com/v1/');
  });

  test('the durable host snapshot store publishes immutable versions with digests', async () => {
    const db = new Database(':memory:');
    try {
      const namespace = new PluginCommunicationStore(db).forNamespace('models-dev');
      const store = new HostSnapshotStore(namespace, { owner: 'models-dev', schemaVersion: 1, maxVersions: 3, maxBytes: 4 * 1024 * 1024 });
      expect(store.current()).toBeNull();
      const v1 = store.publish(1, new TextEncoder().encode('{"v":1}'));
      expect(v1.version).toBe(1);
      expect(v1.digest).toMatch(/^sha256:/);
      const source = store.version(1)!;
      expect(new TextDecoder().decode(await source.read(0, v1.size))).toBe('{"v":1}');
      store.publish(2, { v: 2 });
      expect(store.current()!.descriptor.version).toBe(2);
      expect(store.version(1)!.descriptor.version).toBe(1);
      expect(store.version(3)).toBeNull();
    } finally { db.close(); }
    expect(MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT.id).toBe('models-dev.catalog.snapshot.v1');
  });

  test('model options validate page size and bound the response', () => {
    const page = modelOptions(index, { pageSize: 2, page: 1 });
    expect(page.models).toHaveLength(2);
    expect(page.pageSize).toBe(2);
    expect(modelOptions(index, { pageSize: 5_000 }).pageSize).toBe(100);
  });
});
