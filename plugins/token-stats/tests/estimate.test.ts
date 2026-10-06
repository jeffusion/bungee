import { expect, test } from 'bun:test';
import { calculateTokenStatsCost, TokenStatsPricing } from '../server/pricing';
import { rawCatalogService } from './support/catalog-service';
import { normalizePrice } from '../../models-dev/server/catalog';

const base = { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 };
const tier = (size: number, extra = {}) => ({ input: 4, output: 15, cache_read: 0.2, cache_write: 5, tier: { type: 'context', size }, ...extra });
const cost = { ...base, tiers: [tier(272_000)], context_over_200k: { input: 100, output: 100 } };
const catalog = rawCatalogService({
  openai: { models: {
    'gpt-6.1-sol': { cost },
    base: { cost: base },
    incomplete: { cost: { input: 1 } },
    unsupported: { cost: { ...base, tiers: [{ tier: { type: 'unknown', size: 1 }, input: 9, output: 9 }] } },
    'missing-cache': { cost: { input: 2, output: 10, tiers: [tier(100, { cache_read: undefined, cache_write: undefined })] } },
    'inherited-cache': { cost: { ...base, tiers: [tier(100, { cache_read: undefined, cache_write: undefined })] } },
    zero: { cost: { input: 0, output: 0, tiers: [tier(100, { cache_read: 0, cache_write: 0 })] } },
  } },
  mirror: { models: { 'gpt-6.1-sol': { cost: { input: 100, output: 100 } } } },
});
const estimate = (model: string, inputTokens: number, cacheReadTokens = 0, outputTokens = 100, cacheWriteTokens = 0) =>
  calculateTokenStatsCost(catalog, { model, provider: 'https://chatgpt.com/backend-api/codex/responses', inputTokens, cacheReadTokens, outputTokens, cacheWriteTokens });

test('unmapped GPT prices use original lab rates and canonical tiers instead of legacy 200k', () => {
  for (const [input, cached, expected] of [
    [100_000, 80_000, 0.049], [199_999, 0, 0.400998], [200_000, 0, 0.401],
    [200_001, 0, 0.401002], [271_999, 270_000, 0.031998],
    [272_000, 270_000, 0.0635], [272_001, 270_000, 0.063504],
    [600_000, 0, 2.4015],
  ]) expect(estimate('gpt-6.1-sol', input!, cached!)).toBeCloseTo(expected!, 12);
});

test('valid tiers are sorted, legacy is exclusive, invalid bands fall back without rejecting usage', () => {
  expect(normalizePrice(cost)?.contextTiers.map(t => t.minimumInputTokens)).toEqual([272_000]);
  const sorted = normalizePrice({ ...base, tiers: [tier(300), tier(100, { input: 3 })] })!;
  expect(sorted.contextTiers.map(t => t.minimumInputTokens)).toEqual([100, 300]);
  const sortedService = rawCatalogService({ test: { models: { model: { cost: { ...base, tiers: [tier(300), tier(100, { input: 3 })] } } } } });
  for (const [input, expected] of [[99, 0.000198], [100, 0.0003], [299, 0.000897], [300, 0.0012]]) {
    expect(calculateTokenStatsCost(sortedService, { model: 'model', inputTokens: input, outputTokens: 0 })).toBeCloseTo(expected!, 12);
  }
  for (const tiers of [[tier(100), tier(100)], [tier(-1)], [tier(1.5)], [tier(100, { input: -1 })], [tier(100, { output: NaN })]]) {
    expect(normalizePrice({ ...base, tiers })?.contextTiers).toEqual([]);
    expect(normalizePrice({ ...base, tiers, context_over_200k: { input: 4, output: 15 } })?.contextTiers)
      .toMatchObject([{ minimumInputTokens: 200_001, input: 4 }]);
  }
  expect(estimate('unsupported', 500_000, 0, 0)).toBe(1);
});

test('cache prices prefer the selected band, then base, then selected input price, preserving zero', () => {
  expect(estimate('gpt-6.1-sol', 272_000, 250_000, 100, 10_000)).toBeCloseTo(0.1495, 12);
  expect(estimate('inherited-cache', 100, 80, 0, 10)).toBeCloseTo(0.000073, 12);
  expect(estimate('missing-cache', 100, 80, 0, 10)).toBeCloseTo(0.0004, 12);
  expect(estimate('zero', 100, 90, 0, 10)).toBe(0);
  expect(estimate('base', 0, 0, 0)).toBe(0);
});

test('explicit mappings remain strict and automatic name normalization preserves caller values', () => {
  const input = { model: ' GPT-6.1-SOL-HIGH ', inputTokens: 100, outputTokens: 10 };
  expect(calculateTokenStatsCost(catalog, input)).toBeCloseTo(0.0003, 12);
  expect(input.model).toBe(' GPT-6.1-SOL-HIGH ');
  const usage = { model: 'gpt-6.1-sol', inputTokens: 100, outputTokens: 10 };
  expect(calculateTokenStatsCost(catalog, usage, [{ source: 'gpt-6.1-sol', provider: 'mirror', model: 'gpt-6.1-sol' }])).toBeCloseTo(0.011, 12);
  expect(calculateTokenStatsCost(catalog, usage, [{ source: 'gpt-6.1-sol', provider: 'mirror', model: 'absent' }])).toBeNull();
  expect(calculateTokenStatsCost(catalog, usage, [{ source: 'gpt-6.1-sol', provider: 'openai', model: 'GPT-6.1-SOL' }])).toBeNull();
  const pricing = new TokenStatsPricing(catalog); pricing.setMappings(undefined);
  expect(pricing.estimate(usage)).toBeNull();
});

test('missing catalog prices and invalid token measurements remain unknown', () => {
  expect(estimate('incomplete', 100)).toBeNull();
  expect(estimate('absent', 100)).toBeNull();
  for (const input of [
    { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.5, outputTokens: 0 },
    { inputTokens: 10, outputTokens: NaN }, { inputTokens: 10, outputTokens: 0, cacheReadTokens: 11 },
    { inputTokens: 10, outputTokens: 0, cacheWriteTokens: -1 }, { inputTokens: 10 },
  ]) expect(calculateTokenStatsCost(catalog, { model: 'gpt-6.1-sol', ...input })).toBeNull();
});
