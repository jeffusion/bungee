import { initializeTokenStatsTestDatabase } from '../../../../packages/core/tests/helpers/token-stats-database';
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQLitePluginStorage } from '../../../../packages/core/src/plugin-storage';
import type { ControlHostContext } from '../../../../packages/core/src/plugin-control/contracts';
import { PluginServiceHost } from '../../../../packages/core/src/plugin-services';
import { withTokenStatsMetering } from '../../server/storage';
import { TokenStatsPricing, calculateTokenStatsCost } from '../../server/pricing';
import { createControl } from '../../server/control';
import { PRICE_MODEL_MAPPINGS_KEY, parsePriceModelMappings } from '../../server/model-mappings';
import { MODELS_DEV_CATALOG_SERVICE_ID } from '../../../models-dev/contract';
import { rawCatalogService } from '../helpers/catalog-service';

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
};
const service = rawCatalogService(catalog);
const mappings = [{ source: 'deepseek-ai/deepseek-v4-flash', provider: 'deepseek', model: 'deepseek-v4-flash' },
  { source: 'GLM-5.3-flash', provider: 'zhipuai', model: 'glm-5.3-flash' }];
const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const db = new Database(':memory:');
  initializeTokenStatsTestDatabase(db);
  const storage = withTokenStatsMetering(new SQLitePluginStorage(db, 'token-stats'));
  const host = new PluginServiceHost();
  const provider = host.createContext('models-dev');
  provider.publish(MODELS_DEV_CATALOG_SERVICE_ID, 1, rawCatalogService(catalog));
  host.markReady('models-dev');
  const controlHost: ControlHostContext = {
    storage, signal: new AbortController().signal, secretStore: {} as ControlHostContext['secretStore'],
    services: host.createContext('token-stats', 'global', { 'models-dev': '^1.0.0' }),
  };
  const control = createControl(controlHost);
  cleanups.push(() => db.close(), () => control.dispose());
  const invoke = (handler: string, method = 'GET', body?: unknown) => control.api.find(api => api.handler === handler)!.invoke({
    ...controlHost, requestSignal: new AbortController().signal,
    request: new Request('http://localhost/pricing', { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  });
  return { db, storage, invoke, control };
}

test('exact aliases choose explicit provider prices, ignore host hints and never alter the input model', () => {
  const input = { model: mappings[0]!.source, provider: 'openai', ...usage, cacheReadTokens: 100_000 };
  expect(calculateTokenStatsCost(service, input)).toBeNull();
  expect(calculateTokenStatsCost(service, input, mappings)).toBeCloseTo(1.11, 10);
  expect(input.model).toBe('deepseek-ai/deepseek-v4-flash');
  expect(calculateTokenStatsCost(service, { model: 'GLM-5.3-flash', ...usage }, mappings)).toBeCloseTo(5.6, 10);
  // Without the alias the same id resolves ambiguously across providers -> unknown.
  expect(calculateTokenStatsCost(service, { model: 'glm-5.3-flash', ...usage })).toBeNull();
  expect(calculateTokenStatsCost(service, { model: 'GLM-5.3-FLASH', ...usage }, mappings)).toBeNull();
  expect(calculateTokenStatsCost(service, { model: 'deepseek:deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
  expect(calculateTokenStatsCost(service, { model: 'deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
  expect(calculateTokenStatsCost(service, { model: 'openrouter:deepseek/deepseek-v4-flash', ...usage })).toBeCloseTo(7.8, 10);
  expect(calculateTokenStatsCost(service, { model: 'deepseek/deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
  const override = [{ source: 'deepseek-v4-flash', provider: 'zai', model: 'glm-5.3-flash' }];
  expect(calculateTokenStatsCost(service, { model: 'deepseek-v4-flash', ...usage }, override)).toBeCloseTo(3.4, 10);
  expect(calculateTokenStatsCost(service, { model: 'deepseek-v4-flash', ...usage }, [{ ...override[0]!, model: 'deleted' }])).toBeNull();
  expect(calculateTokenStatsCost(service, { model: 'deepseek-ai/deepseek-v4-flash', inputTokens: 10 }, mappings)).toBeNull();
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
  expect(calculateTokenStatsCost(service, { model: '__proto__', ...usage })).toBeNull();
  expect(calculateTokenStatsCost(service, { model: 'constructor:toString', ...usage })).toBeNull();
});

test('catalog service keeps every provider, including no-price models and slash IDs', () => {
  expect(service.status().providerCount).toBe(4);
  expect(service.status().modelCount).toBe(5);
  // A provider without any usable price still resolves to an explicit unknown.
  expect(service.resolveModel({ model: 'missing-price', pricingProvider: 'deepseek' })).toBeNull();
  expect(service.resolveModel({ model: 'deepseek/deepseek-v4-flash', pricingProvider: 'openrouter' })?.input).toBe(7);
  expect(service.modelOptions({ provider: 'deepseek' }).total).toBe(2);
});

test('control APIs validate mapping targets against the models-dev catalog', async () => {
  const f = fixture();
  const modelsResponse = await f.invoke('getPricingModels');
  expect(modelsResponse.status).toBe(200);
  const { models } = await modelsResponse.json();
  expect(models).toHaveLength(5);
  expect(models).toContainEqual({ provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' });
  expect(await (await f.invoke('getPricingMappings')).json()).toEqual({ mappings: [] });
  expect((await f.invoke('configurePricingMappings', 'PUT', mappings)).status).toBe(200);
  expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual(mappings);
  for (const value of [[{ ...mappings[0], model: 'missing-price' }], [{ ...mappings[0], provider: 'unknown' }], [mappings[0], mappings[0]], [{}]]) {
    expect((await f.invoke('configurePricingMappings', 'PUT', value)).status).toBe(400);
    expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual(mappings);
  }
  expect((await f.invoke('configurePricingMappings', 'PUT', [])).status).toBe(200);
  expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual([]);
});

test('one pricing reader sees alias edits and removal without a catalog refresh; settlement is pinned', async () => {
  const pricing = new TokenStatsPricing(service);
  const recorded: number[] = [];
  const mappingsLoad = async () => mappings;
  pricing.setMappings(await mappingsLoad());
  expect(pricing.estimate({ model: mappings[0]!.source, ...usage })).toBeCloseTo(1.2, 10);
  expect(pricing.estimate({ model: mappings[0]!.source, provider: 'openai', ...usage })).toBeCloseTo(1.2, 10);
  pricing.setMappings([{ ...mappings[0]!, provider: 'zai', model: 'glm-5.3-flash' }]);
  expect(pricing.estimate({ model: mappings[0]!.source, ...usage })).toBeCloseTo(3.4, 10);
  pricing.setMappings([]);
  expect(pricing.estimate({ model: mappings[0]!.source, ...usage })).toBeNull();
  // A mapping read/parse failure must stay unknown, not fall back to another price.
  pricing.setMappings(undefined);
  expect(pricing.estimate({ model: 'deepseek-v4-flash', ...usage })).toBeNull();
  pricing.setMappings([]);
  expect(pricing.estimate({ model: 'deepseek-v4-flash', ...usage })).toBeCloseTo(1.2, 10);
  expect(recorded).toEqual([]);
});

test('raw malformed SQLite JSON and query errors are not treated as absent aliases', async () => {
  const f = fixture();
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, [{ source: 'deepseek-v4-flash', provider: 'zai', model: 'glm-5.3-flash' }]);
  f.db.query('UPDATE plugin_storage SET value = ? WHERE plugin_name = ? AND key = ?').run('{broken', 'token-stats', PRICE_MODEL_MAPPINGS_KEY);
  expect((await f.invoke('getPricingMappings')).status).toBe(500);
  expect(f.db.query<{ value: string }, []>("SELECT value FROM plugin_storage WHERE key = 'pricing:model-mappings:v1'").get()!.value).toBe('{broken');
  f.db.run('ALTER TABLE plugin_storage RENAME TO unavailable_storage');
  expect((await f.invoke('getPricingMappings')).status).toBe(500);
  f.db.run('ALTER TABLE unavailable_storage RENAME TO plugin_storage');
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, mappings);
  expect(await (await f.invoke('getPricingMappings')).json()).toEqual({ mappings });
});

test('edits and deletions validate only changed targets', async () => {
  const f = fixture();
  await f.storage.set(PRICE_MODEL_MAPPINGS_KEY, mappings);
  const mixed = [mappings[0]!, { ...mappings[1]!, provider: 'zai' }];
  expect((await f.invoke('configurePricingMappings', 'PUT', mixed)).status).toBe(200);
  expect((await f.invoke('configurePricingMappings', 'PUT', [mappings[0]!])).status).toBe(200);
  expect((await f.invoke('configurePricingMappings', 'PUT', [{ ...mappings[0]!, source: 'new-alias' }])).status).toBe(200);
  expect((await f.invoke('configurePricingMappings', 'PUT', [{ ...mappings[0]!, source: 'bad-alias', model: 'missing-price' }])).status).toBe(400);
  expect((await f.invoke('configurePricingMappings', 'PUT', [{ ...mappings[0]!, source: 'bad-provider', provider: 'unknown' }])).status).toBe(400);
  expect(await f.storage.get(PRICE_MODEL_MAPPINGS_KEY)).toEqual([{ ...mappings[0]!, source: 'new-alias' }]);
});
