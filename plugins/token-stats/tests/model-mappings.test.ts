import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ModelCatalog } from 'tokenlens';
import { SQLitePluginStorage } from '../../../packages/core/src/plugin-storage';
import { migration as storageMigration } from '../../../packages/core/src/migrations/versions/002_add_plugin_storage';
import { migration as statsMigration } from '../../../packages/core/src/migrations/versions/005_token_stats_metering';
import { migration as keyMigration } from '../../../packages/core/src/migrations/versions/007_token_stats_key';
import type { ControlHostContext } from '../../../packages/core/src/plugin-control/contracts';
import type { TokenMeteringResult } from '../../../packages/core/src/plugin-services';
import { withTokenStatsMetering } from '../server/storage';
import { TokenStatsPricing, calculateTokenStatsCost } from '../server/pricing';
import { TokenStatsPricingService } from '../server';
import { createControl } from '../server/control';
import { PRICE_CACHE_KEY, PRICE_SETTINGS_KEY, PRICE_STATUS_KEY, PriceCatalogManager, pricedCatalog } from '../server/price-catalog';
import { PRICE_MODEL_MAPPINGS_KEY, parsePriceModelMappings } from '../server/model-mappings';

const catalog = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', models: {
    'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', cost: { input: 1, output: 2, cache_read: 0.1 } },
    'missing-price': { id: 'missing-price', cost: { input: 1 } },
  } },
  zai: { id: 'zai', name: 'Z.AI', models: {
    'glm-5.3-flash': { id: 'glm-5.3-flash', name: 'GLM', cost: { input: 3, output: 4 } },
  } },
  zhipuai: { id: 'zhipuai', name: '智谱', models: {
    'glm-5.3-flash': { id: 'glm-5.3-flash', name: 'GLM', cost: { input: 5, output: 6 } },
  } },
  openrouter: { id: 'openrouter', name: 'OpenRouter', models: {
    'deepseek/deepseek-v4-flash': { id: 'deepseek/deepseek-v4-flash', name: 'Flash', cost: { input: 7, output: 8 } },
  } },
} as unknown as ModelCatalog;
const mappings = [{ source: 'deepseek-ai/deepseek-v4-flash', provider: 'deepseek', model: 'deepseek-v4-flash' },
  { source: 'GLM-5.3-flash', provider: 'zhipuai', model: 'glm-5.3-flash' }];
const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const db = new Database(':memory:');
  storageMigration.up(db); statsMigration.up(db); keyMigration.up(db);
  const storage = withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats'));
  const host = { storage, signal: new AbortController().signal, secretStore: {} } as ControlHostContext;
  const control = createControl(host);
  cleanups.push(() => db.close(), () => control.dispose());
  const invoke = (handler: string, method = 'GET', body?: unknown) => control.api.find(api => api.handler === handler)!.invoke({
    ...host, requestSignal: new AbortController().signal,
    request: new Request('http://localhost/pricing', { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  });
  return { db, storage, invoke, host, control };
}

test('exact aliases choose explicit provider prices, ignore host hints and never alter the input model', () => {
  const input = { model: mappings[0]!.source, provider: 'openai' as const, ...usage, cacheReadTokens: 100_000 };
  expect(calculateTokenStatsCost(catalog, input)).toBeNull();
  expect(calculateTokenStatsCost(catalog, input, mappings)).toBeCloseTo(1.11, 10);
  expect(input.model).toBe('deepseek-ai/deepseek-v4-flash');
  expect(calculateTokenStatsCost(catalog, { model: 'GLM-5.3-flash', ...usage }, mappings)).toBeCloseTo(5.6, 10);
  expect(calculateTokenStatsCost(catalog, { model: 'glm-5.3-flash', ...usage }, mappings)).toBeNull();
  expect(calculateTokenStatsCost(catalog, { model: 'GLM-5.3-FLASH', ...usage }, mappings)).toBeNull();
  expect(calculateTokenStatsCost(catalog, { model: 'deepseek:deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
  expect(calculateTokenStatsCost(catalog, { model: 'deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
  expect(calculateTokenStatsCost(catalog, { model: 'openrouter:deepseek/deepseek-v4-flash', ...usage })).toBeCloseTo(7.8, 10);
  expect(calculateTokenStatsCost(catalog, { model: 'deepseek/deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
  const override = [{ source: 'deepseek-v4-flash', provider: 'zai', model: 'glm-5.3-flash' }];
  expect(calculateTokenStatsCost(catalog, { model: 'deepseek-v4-flash', ...usage }, override)).toBeCloseTo(3.4, 10);
  expect(calculateTokenStatsCost(catalog, { model: 'deepseek-v4-flash', ...usage }, [{ ...override[0]!, model: 'deleted' }])).toBeNull();
  expect(calculateTokenStatsCost(catalog, { model: 'deepseek-ai/deepseek-v4-flash', inputTokens: 10 }, mappings)).toBeNull();
});

test('mapping validation is bounded, exact, duplicate-safe and rejects malformed fields', () => {
  expect(parsePriceModelMappings(mappings)).toEqual(mappings);
  expect(parsePriceModelMappings([])).toEqual([]);
  for (const value of [null, {}, [null], [{}], [mappings[0], mappings[0]],
    [{ ...mappings[0], source: ' alias' }], [{ ...mappings[0], source: 'alias\n' }],
    [{ ...mappings[0], model: '' }], [{ ...mappings[0], provider: 3 }], [{ ...mappings[0], extra: true }],
    [{ ...mappings[0], source: 'x'.repeat(257) }], Array.from({ length: 101 }, (_, i) => ({ ...mappings[0], source: `a${i}` }))]) {
    expect(() => parsePriceModelMappings(value)).toThrow('invalid_input');
  }
  expect(parsePriceModelMappings([{ ...mappings[0]!, source: '__proto__' }])).toHaveLength(1);
  expect(calculateTokenStatsCost(catalog, { model: '__proto__', ...usage })).toBeNull();
  expect(calculateTokenStatsCost(catalog, { model: 'constructor:toString', ...usage })).toBeNull();
});

test('catalog keeps valid prices from all providers including slash IDs and filters missing rates', () => {
  const cache = pricedCatalog(catalog);
  expect(Object.keys(cache)).toEqual(['deepseek', 'zai', 'zhipuai', 'openrouter']);
  expect(cache.deepseek!.models['missing-price']).toBeUndefined();
  expect(cache.deepseek!.models['deepseek-v4-flash']!.cost).toEqual({ input: 1, output: 2, cache_read: 0.1 });
  expect(cache.openrouter!.models['deepseek/deepseek-v4-flash']).toBeDefined();
});

test('control APIs use persisted catalog targets, reject invalid updates and keep refresh settings separate', async () => {
  const f = fixture();
  await f.storage.set(PRICE_SETTINGS_KEY, { autoRefresh: false, intervalMinutes: 60, timeoutSeconds: 15 });
  await f.storage.set(PRICE_CACHE_KEY, { version: 1, fetchedAt: 1000, catalog });
  const modelsResponse = await f.invoke('getPricingModels');
  expect(modelsResponse.status).toBe(200);
  const { models } = await modelsResponse.json();
  expect(models).toHaveLength(4);
  expect(models).toContainEqual({ provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' });
  expect(await (await f.invoke('getPricingMappings')).json()).toEqual({ mappings: [] });
  expect((await f.invoke('configurePricingMappings', 'PUT', mappings)).status).toBe(200);
  expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual(mappings);
  for (const value of [[{ ...mappings[0], model: 'missing-price' }], [{ ...mappings[0], provider: 'unknown' }], [mappings[0], mappings[0]], [{}]]) {
    expect((await f.invoke('configurePricingMappings', 'PUT', value)).status).toBe(400);
    expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual(mappings);
  }
  expect((await f.invoke('configurePricing', 'PUT', { autoRefresh: false, intervalMinutes: 5, timeoutSeconds: 30 })).status).toBe(200);
  expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual(mappings);
  expect((await f.invoke('configurePricingMappings', 'PUT', [])).status).toBe(200);
  expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual([]);
});

test('two worker pricing readers see alias edits and removal without catalog refresh; settlement is pinned', async () => {
  const f = fixture();
  await f.storage.set(PRICE_SETTINGS_KEY, { autoRefresh: false, intervalMinutes: 60, timeoutSeconds: 15 });
  await f.storage.set(PRICE_CACHE_KEY, { version: 1, fetchedAt: 1000, catalog });
  await f.storage.set(PRICE_STATUS_KEY, { lastSuccessAt: 1000 });
  const workers = [new TokenStatsPricing({ storage: f.storage.uncached() }), new TokenStatsPricing({ storage: f.storage.uncached() })];
  const service = new TokenStatsPricingService(workers[0]!);
  const result = { requestId: 'req', attemptId: 'alias-attempt', settlementVersion: 1, model: mappings[0]!.source,
    provider: 'openai', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    inputSource: 'official', outputSource: 'official', outcome: 'completed' } as TokenMeteringResult;
  expect(await service.canPrice({ model: result.model })).toBe(false);
  await f.invoke('configurePricingMappings', 'PUT', mappings);
  expect(await service.canPrice({ model: result.model, pricingProvider: 'openai' })).toBe(true);
  const first = await service.price(result);
  expect(first).toEqual({ costUsd: 1.2, costNanoUsd: 1_200_000_000 });
  for (const worker of workers) {
    await worker.ready();
    expect(worker.estimate({ model: result.model, ...usage })).toBeCloseTo(1.2, 10);
  }
  const edited = [{ ...mappings[0]!, provider: 'zai', model: 'glm-5.3-flash' }];
  await f.invoke('configurePricingMappings', 'PUT', edited);
  expect(await service.price({ ...result })).toEqual(first);
  for (const worker of workers) {
    await worker.ready();
    expect(worker.estimate({ model: result.model, ...usage })).toBeCloseTo(3.4, 10);
  }
  expect(await service.price({ ...result, attemptId: 'next-attempt' })).toEqual({ costUsd: 3.4, costNanoUsd: 3_400_000_000 });
  await f.invoke('configurePricingMappings', 'PUT', []);
  for (const worker of workers) {
    await worker.ready();
    expect(worker.estimate({ model: result.model, ...usage })).toBeNull();
  }
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, { corrupt: true });
  await workers[0]!.ready();
  expect(workers[0]!.estimate({ model: 'deepseek-v4-flash', ...usage })).toBeNull();
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, []);
  await workers[0]!.ready();
  expect(workers[0]!.estimate({ model: 'deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
});

test('refresh and control restart preserve aliases, but a removed target stays unknown', async () => {
  const f = fixture();
  await f.storage.set(PRICE_SETTINGS_KEY, { autoRefresh: false, intervalMinutes: 60, timeoutSeconds: 15 });
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, mappings);
  let fetched: ModelCatalog = catalog;
  const manager = new PriceCatalogManager(f.storage, { fetch: async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => fetched, text: async () => JSON.stringify(fetched) }) });
  cleanups.push(() => manager.stop());
  await manager.start(); await manager.refresh();
  expect(await manager.mappings()).toEqual(mappings);
  const restarted = new PriceCatalogManager(f.storage);
  cleanups.push(() => restarted.stop());
  await restarted.start();
  expect(await restarted.mappings()).toEqual(mappings);
  expect(restarted.models()).toHaveLength(4);
  const worker = new TokenStatsPricing({ storage: f.storage });
  await worker.ready();
  expect(worker.estimate({ model: mappings[0]!.source, ...usage })).toBeCloseTo(1.2, 10);
  fetched = { zai: catalog.zai! };
  await manager.refresh(); await worker.ready();
  expect(worker.estimate({ model: mappings[0]!.source, ...usage })).toBeNull();
  expect(await manager.mappings()).toEqual(mappings);
});

test('raw malformed SQLite JSON and query errors are not treated as absent aliases', async () => {
  const f = fixture();
  await f.storage.set(PRICE_CACHE_KEY, { version: 1, fetchedAt: 1000, catalog });
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, [{ source: 'deepseek-v4-flash', provider: 'zai', model: 'glm-5.3-flash' }]);
  const worker = new TokenStatsPricing({ storage: f.storage.uncached() });
  await worker.ready();
  expect(worker.estimate({ model: 'deepseek-v4-flash', ...usage })).toBeCloseTo(3.4, 10);
  f.db.query('UPDATE plugin_storage SET value = ? WHERE plugin_name = ? AND key = ?').run('{broken', 'token-stats', PRICE_MODEL_MAPPINGS_KEY);
  expect((await f.invoke('getPricingMappings')).status).toBe(500);
  await worker.ready();
  expect(worker.estimate({ model: 'deepseek-v4-flash', ...usage })).toBeNull();
  expect(f.db.query<{ value: string }, []>("SELECT value FROM plugin_storage WHERE key = 'pricing:model-mappings:v1'").get()!.value).toBe('{broken');
  f.db.run('ALTER TABLE plugin_storage RENAME TO unavailable_storage');
  expect((await f.invoke('getPricingMappings')).status).toBe(500);
  await worker.ready();
  expect(worker.estimate({ model: 'deepseek-v4-flash', ...usage })).toBeNull();
  f.db.run('ALTER TABLE unavailable_storage RENAME TO plugin_storage');
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, mappings);
  await worker.ready();
  expect(worker.estimate({ model: mappings[0]!.source, ...usage })).toBeCloseTo(1.2, 10);
});

test('an unchanged unavailable target does not block editing or deleting other mappings', async () => {
  const f = fixture();
  await f.storage.set(PRICE_SETTINGS_KEY, { autoRefresh: false, intervalMinutes: 60, timeoutSeconds: 15 });
  await f.storage.set(PRICE_CACHE_KEY, { version: 1, fetchedAt: 1000, catalog: { zai: catalog.zai, zhipuai: catalog.zhipuai } });
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, mappings);
  const mixed = [mappings[0]!, { ...mappings[1]!, provider: 'zai' }];
  expect((await f.invoke('configurePricingMappings', 'PUT', mixed)).status).toBe(200);
  expect((await f.invoke('configurePricingMappings', 'PUT', [mappings[0]!])).status).toBe(200);
  expect((await f.invoke('configurePricingMappings', 'PUT', [{ ...mappings[0]!, source: 'new-alias' }])).status).toBe(400);
  expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual([mappings[0]!]);
});
