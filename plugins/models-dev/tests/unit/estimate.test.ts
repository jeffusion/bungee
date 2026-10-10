import { expect, test } from 'bun:test';
import { buildCatalogIndex, resolveModelInCatalog } from '../../server/catalog';
import { CatalogView } from '../../server/local';

const priced = (input: number) => ({ cost: { input, output: input * 2 } });
const entries = {
  'gpt-6.1-sol': priced(2),
  'gpt-6.1-sol-mini': priced(0.1),
  'gpt-6.1-sol-20261001': priced(4),
  'gpt-6.2-pro-20260901': priced(6),
  'gpt-6.2-pro-2026-10-01': priced(8),
  'gpt-6.2-pro-20261001': priced(10),
};
const catalog = {
  openai: { models: entries },
  reseller: { api: 'https://reseller.example/v1', models: { 'gpt-6.1-sol': priced(100) } },
  anthropic: { models: { 'claude-sonnet-4-5': priced(3), 'claude-sonnet-4-5-20261001': priced(30) } },
  google: { models: { 'gemini-3.8-flash': priced(1) } },
  xai: { models: { 'grok-4.7': priced(2) } },
  other: { models: { 'MixedCase': priced(1), 'custom-20261001': priced(5), 'ambiguous': priced(1) } },
  mirror: { models: { ambiguous: priced(2) } },
};
const index = buildCatalogIndex({ version: 1, fetchedAt: 1, catalog });
const estimate = (model: string, extra = {}) => resolveModelInCatalog(index, { model, mode: 'estimate', ...extra });

test('estimate resolves original labs while exact service preserves its previous semantics', () => {
  expect(resolveModelInCatalog(index, { model: 'gpt-6.1-sol' })).toBeNull();
  expect(resolveModelInCatalog(index, { model: 'GPT-6.1-SOL', pricingProvider: 'openai' })).toBeNull();
  expect(estimate('gpt-6.1-sol', { pricingProvider: 'https://chatgpt.com/backend-api/codex/responses' }))
    .toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', input: 2 });
  expect(estimate('GPT-6.1-SOL')).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol' });
  expect(estimate('MixedCase')).toMatchObject({ provider: 'other', model: 'MixedCase' });
  expect(estimate('mixedcase')).toMatchObject({ provider: 'other', model: 'MixedCase' });
  expect(estimate('ambiguous')).toBeNull();
  expect(estimate('nonexistent')).toBeNull();
});

test('explicit IDs and prefixes bind, URL hints may fall back, known reseller rates win', () => {
  expect(estimate('gpt-6.1-sol', { pricingProvider: 'reseller' })).toMatchObject({ input: 100 });
  expect(estimate('reseller:gpt-6.1-sol')).toMatchObject({ input: 100 });
  expect(estimate('gpt-6.1-sol', { url: 'https://reseller.example/v1/responses' })).toMatchObject({ input: 100 });
  expect(estimate('gpt-6.1-sol', { pricingProvider: 'anthropic' })).toBeNull();
  expect(estimate('gpt-6.1-sol', { pricingProvider: 'absent' })).toBeNull();
  expect(estimate('anthropic:gpt-6.1-sol')).toBeNull();
  expect(estimate('grok-4.7', { url: 'https://reseller.example/v1/responses' })).toMatchObject({ provider: 'xai' });
});

test('normalizes composed suffixes, resource paths and Claude spellings without changing exact priority', () => {
  expect(estimate('gpt-6.1-sol-20261001')).toMatchObject({ input: 4 });
  for (const name of [' gpt-6.1-sol-2026-10-03-high ', 'gpt-6.1-sol-high-20261003', 'gpt-6.1-sol-preview-high']) {
    expect(estimate(name)).toMatchObject({ model: 'gpt-6.1-sol', input: 2 });
  }
  expect(estimate('claude-sonnet-4.5-high')).toMatchObject({ model: 'claude-sonnet-4-5', input: 3 });
  expect(estimate('claude-sonnet-4.5-20261001')).toMatchObject({ model: 'claude-sonnet-4-5-20261001', input: 30 });
  expect(estimate('projects/p/locations/us/publishers/google/models/gemini-3.8-flash-high'))
    .toMatchObject({ provider: 'google', model: 'gemini-3.8-flash' });
  expect(estimate('models/gemini-3.8-flash')).toMatchObject({ provider: 'google' });
});

test('family fallback picks a base before dated models, or newest date with stable ID ties', () => {
  expect(estimate('gpt-6.1-sol-20270101')).toMatchObject({ model: 'gpt-6.1-sol', input: 2 });
  expect(estimate('gpt-6.2-pro')).toMatchObject({ model: 'gpt-6.2-pro-2026-10-01', input: 8 });
  expect(estimate('gpt-6.2-pro-20270101-high')).toMatchObject({ model: 'gpt-6.2-pro-2026-10-01' });
  expect(estimate('custom')).toMatchObject({ provider: 'other', model: 'custom-20261001' });
  for (const model of ['gpt-6.1-sol-pro', 'gpt-6.1-sol-codex', 'gpt-6.1-sol-max', 'gpt-7.1-sol']) expect(estimate(model)).toBeNull();
  expect(estimate('gpt-6.1-sol-mini-high')).toMatchObject({ model: 'gpt-6.1-sol-mini' });
  const reversed = buildCatalogIndex({ version: 2, fetchedAt: 2, catalog: {
    ...catalog, openai: { models: Object.fromEntries(Object.entries(entries).reverse()) },
  } });
  expect(resolveModelInCatalog(reversed, { model: 'gpt-6.2-pro', mode: 'estimate' })).toEqual(estimate('gpt-6.2-pro'));
});

test('request lookups use prebuilt name indexes and refresh swaps them atomically', () => {
  const view = new CatalogView();
  // Traversal fails if pricing tries to scan catalog providers/models per request.
  view.apply({ ...index, providers: new Proxy(index.providers, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) throw new Error('request-time provider traversal');
      return Reflect.get(target, key, receiver);
    },
  }) });
  const traversals = index.providers.map(provider => provider.models);
  for (const object of traversals) Object.defineProperty(object, Symbol.iterator, {
    value: () => { throw new Error('request-time catalog traversal'); }, configurable: true,
  });
  try {
    expect(view.resolveModel({ model: 'gpt-6.1-sol-high', mode: 'estimate' })).toMatchObject({ input: 2 });
    expect(view.resolveModel({ model: 'custom', mode: 'estimate' })).toMatchObject({ input: 5 });
    view.fail('refresh failed');
    expect(view.resolveModel({ model: 'gpt-6.1-sol', mode: 'estimate' })).toMatchObject({ input: 2 });
    view.apply(buildCatalogIndex({ version: 2, fetchedAt: 2, catalog: { openai: { models: { 'gpt-6.1-sol': priced(9) } } } }));
    expect(view.resolveModel({ model: 'gpt-6.1-sol', mode: 'estimate' })).toMatchObject({ input: 9 });
  } finally {
    for (const object of traversals) Reflect.deleteProperty(object, Symbol.iterator);
  }
});
