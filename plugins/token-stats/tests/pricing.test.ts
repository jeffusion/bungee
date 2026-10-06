import { describe, expect, test } from 'bun:test';
import { calculateTokenStatsCost } from '../server/pricing';
import { rawCatalogService } from './support/catalog-service';

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
};

const service = rawCatalogService(catalog);

describe('token-stats cost estimate', () => {
  test('prices explicit providers, cached input, original labs and legacy context bands', () => {
    const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 1_000 };
    expect(calculateTokenStatsCost(service, { model: 'grok-4.7', provider: 'xai', ...usage })).toBeCloseTo(0.2585, 12);
    expect(calculateTokenStatsCost(service, { model: 'xai:grok-4.7', ...usage })).toBeCloseTo(0.2585, 12);
    expect(calculateTokenStatsCost(service, { model: 'grok-4.7', ...usage })).toBeCloseTo(0.2585, 12);
    expect(calculateTokenStatsCost(service, {
      model: 'xai-only-model', inputTokens: 100_000, outputTokens: 10_000,
    })).toBeCloseTo(0.26, 12);
    expect(calculateTokenStatsCost(service, {
      model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 1,
    })).toBeCloseTo(0.000012, 12);
    expect(calculateTokenStatsCost(service, {
      model: 'not-in-catalog', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
    expect(calculateTokenStatsCost(service, {
      model: 'grok-4.7', provider: 'openai', inputTokens: 100_000, outputTokens: 10_000,
    })).toBeCloseTo(12, 12);
    expect(calculateTokenStatsCost(service, { model: 'GROK-4.7', provider: 'xai', ...usage })).toBeCloseTo(0.2585, 12);
    expect(calculateTokenStatsCost(service, {
      model: 'grok-4.7', provider: 'xai', inputTokens: 199_999, outputTokens: 0,
    })).toBeCloseTo(0.399998, 12);
    expect(calculateTokenStatsCost(service, {
      model: 'grok-4.7', provider: 'xai', inputTokens: 200_000, outputTokens: 0,
    })).toBeCloseTo(0.4, 12);
    expect(calculateTokenStatsCost(service, {
      model: 'grok-4.7', provider: 'xai', inputTokens: 200_001, outputTokens: 0,
    })).toBeCloseTo(0.800004, 12);
  });

  test('returns zero only for known priced zero usage and refuses incomplete/invalid pricing inputs', () => {
    expect(calculateTokenStatsCost(service, {
      model: 'gpt-4o-mini', provider: 'openai', inputTokens: 0, outputTokens: 0,
    })).toBe(0);
    expect(calculateTokenStatsCost(service, {
      model: 'grok-4.7', provider: 'xai', inputTokens: 10, outputTokens: 1,
      cacheReadTokens: 1, cacheWriteTokens: 10,
    })).toBeNull();
    expect(calculateTokenStatsCost(service, {
      model: 'missing-cache-rate', provider: 'xai', inputTokens: 10, outputTokens: 1, cacheReadTokens: 1,
    })).toBeCloseTo(0.000026, 12);
    expect(calculateTokenStatsCost(service, {
      model: 'missing-output-rate', provider: 'xai', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
    expect(calculateTokenStatsCost(service, {
      model: 'negative-rate', provider: 'xai', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
    expect(calculateTokenStatsCost(null, {
      model: 'gpt-4o-mini', provider: 'openai', inputTokens: 10, outputTokens: 1,
    })).toBeNull();
  });
});
