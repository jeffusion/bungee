import { afterEach, expect, test } from 'bun:test';
import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import type { FetchLike } from 'tokenlens/fetch';
import {
  PriceCatalogManager, PRICE_CACHE_KEY, PRICE_SETTINGS_KEY, parsePriceSettings,
} from '../server/price-catalog';
import { TokenStatsPricing } from '../server/pricing';

const catalog = { openai: { id: 'openai', name: 'OpenAI', models: {
  'gpt-test': { id: 'gpt-test', name: 'Test', cost: { input: 1, output: 2, cache_read: 0.1 } },
} } };
const managers: PriceCatalogManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); });

function fixture(fetch: FetchLike) {
  const data = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(data.get(key) ?? null); },
    async set(key: string, value: unknown) { data.set(key, structuredClone(value)); },
  } as unknown as PluginStorage;
  let now = 1000;
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  const create = () => {
    const manager = new PriceCatalogManager(storage, {
      fetch, now: () => now,
      schedule(fn, ms) { callback = fn; delay = ms; return 1 as unknown as ReturnType<typeof setTimeout>; },
      cancel() { callback = undefined; delay = undefined; },
    });
    managers.push(manager);
    return manager;
  };
  return { storage, data, create, get delay() { return delay; }, advance(ms: number) { now += ms; callback?.(); } };
}
const response: FetchLike = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => catalog, text: async () => JSON.stringify(catalog) });

test('automatic first load, periodic refresh and persisted restart configuration', async () => {
  let calls = 0;
  const f = fixture(async (...args) => { calls++; return response(...args); });
  const manager = f.create();
  await manager.start();
  expect(f.delay).toBe(0);
  f.advance(0);
  await manager.refresh();
  expect(calls).toBe(1);
  expect(manager.status().modelCount).toBe(1);
  expect(f.delay).toBe(60 * 60_000);
  f.advance(60 * 60_000);
  await manager.refresh();
  expect(calls).toBe(2);
  await manager.configure({ autoRefresh: true, intervalMinutes: 5, timeoutSeconds: 30 });
  expect(f.delay).toBe(5 * 60_000);
  manager.stop();
  const restarted = f.create();
  await restarted.start();
  expect(restarted.status().settings).toEqual({ autoRefresh: true, intervalMinutes: 5, timeoutSeconds: 30 });
  expect(restarted.status().modelCount).toBe(1);
  expect(calls).toBe(2);
  expect(f.delay).toBe(5 * 60_000);
});

test('disabled automatic refresh still allows manual refresh and workers read persisted prices without downloading', async () => {
  let calls = 0;
  const f = fixture(async (...args) => { calls++; return response(...args); });
  f.data.set(PRICE_SETTINGS_KEY, { autoRefresh: false, intervalMinutes: 60, timeoutSeconds: 15 });
  const manager = f.create();
  await manager.start();
  expect(f.delay).toBeUndefined();
  const pricing = new TokenStatsPricing({ storage: f.storage, fetch: async () => { throw new Error('Worker must not fetch'); } });
  pricing.start();
  await pricing.ready();
  expect(pricing.estimate({ model: 'gpt-test', inputTokens: 10, outputTokens: 5 })).toBeNull();
  await manager.refresh();
  await pricing.ready();
  expect(pricing.estimate({ model: 'gpt-test', inputTokens: 10, outputTokens: 5 })).toBeCloseTo(0.00002, 8);
  expect(calls).toBe(1);
  expect(manager.status().nextRefreshAt).toBeNull();
  expect(f.delay).toBeUndefined();
  pricing.stop();
});

test('concurrent refresh requests share one download', async () => {
  let calls = 0;
  let resolve!: (value: Awaited<ReturnType<FetchLike>>) => void;
  const f = fixture(async () => { calls++; return new Promise(r => { resolve = r; }); });
  const manager = f.create();
  await manager.start();
  const first = manager.refresh();
  const second = manager.refresh();
  expect(second).toBe(first);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  resolve(await response('https://models.dev/api.json'));
  await first;
  expect(manager.status().refreshing).toBe(false);
});

test('network and invalid catalog failures preserve last valid prices and schedule backoff', async () => {
  let mode = 'ok';
  const f = fixture(async (...args) => {
    if (mode === 'network') throw new Error('secret-like upstream error must not be persisted');
    if (mode === 'invalid') return { ok: true, status: 200, statusText: 'OK', json: async () => ({}), text: async () => '{}' };
    return response(...args);
  });
  const manager = f.create();
  await manager.start(); await manager.refresh();
  const cache = structuredClone(f.data.get(PRICE_CACHE_KEY));
  const success = manager.status().lastSuccessAt;
  mode = 'network'; await manager.refresh();
  expect(manager.status().lastError).toBe('network');
  expect(f.delay).toBe(60_000);
  mode = 'invalid'; await manager.refresh();
  expect(manager.status().lastError).toBe('invalid_catalog');
  expect(f.delay).toBe(120_000);
  expect(f.data.get(PRICE_CACHE_KEY)).toEqual(cache);
  expect(manager.status().lastSuccessAt).toBe(success);
  mode = 'ok'; await manager.refresh();
  expect(manager.status().lastError).toBeNull();
  expect(manager.status().consecutiveFailures).toBe(0);
});

test('stop aborts an uncooperative request and prevents late cache writes', async () => {
  let resolve!: (value: Awaited<ReturnType<FetchLike>>) => void;
  const f = fixture(async () => new Promise(r => { resolve = r; }));
  const manager = f.create();
  await manager.start();
  const task = manager.refresh();
  await Promise.resolve(); await Promise.resolve();
  manager.stop();
  await task;
  resolve(await response('https://models.dev/api.json'));
  await Promise.resolve();
  expect(f.data.has(PRICE_CACHE_KEY)).toBe(false);
  expect(f.delay).toBeUndefined();
});

test('download has a hard timeout even if the fetch ignores abort', async () => {
  const f = fixture(async () => new Promise(() => {}));
  f.data.set(PRICE_SETTINGS_KEY, { autoRefresh: false, intervalMinutes: 1, timeoutSeconds: 5 });
  const manager = f.create();
  await manager.start();
  await manager.refresh();
  expect(manager.status().lastError).toBe('timeout');
  expect(manager.status().refreshing).toBe(false);
}, 7000);

test('price settings reject unknown fields, strings, out of range and fractional values', () => {
  for (const value of [null, {}, { autoRefresh: 'yes', intervalMinutes: 60, timeoutSeconds: 15 },
    { autoRefresh: true, intervalMinutes: 0, timeoutSeconds: 15 },
    { autoRefresh: true, intervalMinutes: 1.5, timeoutSeconds: 15 },
    { autoRefresh: true, intervalMinutes: 60, timeoutSeconds: 61 },
    { autoRefresh: true, intervalMinutes: 60, timeoutSeconds: 15, url: 'http://internal' }]) {
    expect(() => parsePriceSettings(value)).toThrow('invalid_input');
  }
});
