import { describe, expect, test } from 'bun:test';
import type { ModelCatalog } from 'tokenlens';
import type { FetchLike } from 'tokenlens/fetch';
import { calculateTokenStatsCost, TokenStatsPricing } from '../server/pricing';

const catalog = {
  xai: {
    id: 'xai', name: 'xAI', models: {
      'grok-4.7': {
        id: 'grok-4.7', name: 'Grok 4.7', cost: {
          input: 2, output: 6, cache_read: 0.5, cache_write: 1,
          context_over_200k: { input: 4, output: 12, cache_read: 1 },
        },
      },
      'xai-only-model': { id: 'xai-only-model', name: 'xAI only', cost: { input: 2, output: 6 } },
      'missing-cache-rate': { id: 'missing-cache-rate', name: 'Missing cache rate', cost: { input: 2, output: 6 } },
      'missing-output-rate': { id: 'missing-output-rate', name: 'Missing output rate', cost: { input: 2 } },
      'negative-rate': { id: 'negative-rate', name: 'Negative rate', cost: { input: -2, output: 6 } },
    },
  },
  openai: {
    id: 'openai', name: 'OpenAI', models: {
      'grok-4.7': { id: 'grok-4.7', name: 'Different Grok', cost: { input: 100, output: 200 } },
      'gpt-4o-mini': { id: 'gpt-4o-mini', name: 'GPT-4o mini', cost: { input: 1, output: 2 } },
    },
  },
  anthropic: { id: 'anthropic', models: {} },
  google: { id: 'google', models: {} },
} as unknown as ModelCatalog;

function fakeFetcher(response: unknown): FetchLike {
  return async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
}

describe('token-stats cost estimate', () => {
  test('prices exact direct-provider matches, subtracts cached input, and rejects ambiguity or unsupported tiers', () => {
    const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 1_000 };
    expect(calculateTokenStatsCost(catalog, { model: 'grok-4.7', provider: 'xai', ...usage })).toBeCloseTo(0.2585, 12);
    expect(calculateTokenStatsCost(catalog, { model: 'xai:grok-4.7', ...usage })).toBeCloseTo(0.2585, 12);
    expect(calculateTokenStatsCost(catalog, { model: 'grok-4.7', ...usage })).toBeNull();
    expect(calculateTokenStatsCost(catalog, {
      model: 'xai-only-model', inputTokens: 100_000, outputTokens: 10_000,
    })).toBeCloseTo(0.26, 12);
    expect(calculateTokenStatsCost(catalog, {
      model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 1,
    })).toBeCloseTo(0.000012, 12);
    expect(calculateTokenStatsCost(catalog, {
      model: 'not-in-catalog', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
    expect(calculateTokenStatsCost(catalog, {
      model: 'grok-4.7', provider: 'openai', inputTokens: 100_000, outputTokens: 10_000,
    })).toBeCloseTo(12, 12);
    expect(calculateTokenStatsCost(catalog, { model: 'GROK-4.7', provider: 'xai', ...usage })).toBeNull();
    expect(calculateTokenStatsCost(catalog, {
      model: 'grok-4.7', provider: 'xai', inputTokens: 199_999, outputTokens: 0,
    })).toBeCloseTo(0.399998, 12);
    expect(calculateTokenStatsCost(catalog, {
      model: 'grok-4.7', provider: 'xai', inputTokens: 200_000, outputTokens: 0,
    })).toBeNull();
  });

  test('returns zero only for known priced zero usage and refuses incomplete/invalid pricing inputs', () => {
    expect(calculateTokenStatsCost(catalog, {
      model: 'gpt-4o-mini', provider: 'openai', inputTokens: 0, outputTokens: 0,
    })).toBe(0);
    expect(calculateTokenStatsCost(catalog, {
      model: 'grok-4.7', provider: 'xai', inputTokens: 10, outputTokens: 1,
      cacheReadTokens: 1, cacheWriteTokens: 10,
    })).toBeNull();
    expect(calculateTokenStatsCost(catalog, {
      model: 'missing-cache-rate', provider: 'xai', inputTokens: 10, outputTokens: 1, cacheReadTokens: 1,
    })).toBeNull();
    expect(calculateTokenStatsCost(catalog, {
      model: 'missing-output-rate', provider: 'xai', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
    expect(calculateTokenStatsCost(catalog, {
      model: 'negative-rate', provider: 'xai', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
    expect(calculateTokenStatsCost(undefined, {
      model: 'gpt-4o-mini', provider: 'openai', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
  });

  test('refresh is nonblocking, uses injected fetch, and keeps the last good catalog after failure', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      if (calls > 1) throw new Error('offline fixture failure');
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => catalog,
        text: async () => JSON.stringify(catalog),
      };
    };
    const pricing = new TokenStatsPricing({ fetch, timeoutMs: 1_000, refreshMs: 60_000 });
    try {
      expect(pricing.start()).toBeUndefined();
      expect(pricing.estimate({ model: 'gpt-4o-mini', provider: 'openai', inputTokens: 10, outputTokens: 1 })).toBeNull();
      expect(await pricing.refresh()).toBe(true);
      expect(pricing.estimate({ model: 'gpt-4o-mini', provider: 'openai', inputTokens: 10, outputTokens: 1 })).toBeCloseTo(0.000012, 12);
      expect(await pricing.refresh()).toBe(false);
      expect(pricing.estimate({ model: 'gpt-4o-mini', provider: 'openai', inputTokens: 10, outputTokens: 1 })).toBeCloseTo(0.000012, 12);
      expect(calls).toBe(2);
    } finally {
      pricing.stop();
    }

    const slowFetch: FetchLike = async (_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      if (signal.aborted) reject(new Error('fixture timeout'));
      else signal.addEventListener('abort', () => reject(new Error('fixture timeout')), { once: true });
    });
    const timedPricing = new TokenStatsPricing({ fetch: slowFetch, timeoutMs: 5, refreshMs: 60_000 });
    expect(await timedPricing.refresh()).toBe(false);
    timedPricing.stop();
  });

  test('ready has a hard initial-load bound even when injected fetch ignores abort', async () => {
    const fetch: FetchLike = async () => new Promise<never>(() => {});
    const pricing = new TokenStatsPricing({ fetch, timeoutMs: 20, refreshMs: 60_000 });
    try {
      pricing.start();
      const started = performance.now();
      await pricing.ready();
      expect(performance.now() - started).toBeLessThan(500);
      const readyAgain = performance.now();
      await pricing.ready();
      expect(performance.now() - readyAgain).toBeLessThan(50);
    } finally {
      pricing.stop();
    }
  });
});
