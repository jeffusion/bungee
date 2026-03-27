import { describe, expect, test } from 'bun:test';
import {
  buildRowOptions,
  buildProviderOptions,
  canonicalizeProviderFilter,
  filterOptionsByProvider,
  resolveOptionProvider,
  type ModelOption,
  type RowProviderFilter
} from '../../../ui/src/lib/components/model-mapping/filtering';

const SAMPLE_OPTIONS: ModelOption[] = [
  {
    value: 'k2p5',
    label: 'Kimi K2.5',
    description: 'kimi-for-coding · ctx 262144',
    provider: 'kimi-for-coding'
  },
  {
    value: 'kimi-k2-thinking',
    label: 'Kimi K2 Thinking',
    description: 'kimi-for-coding · ctx 262144',
    provider: 'kimi-for-coding'
  },
  {
    value: 'gemini-embedding-2',
    label: 'Gemini Embedding 2',
    description: 'vercel · ctx 2000000',
    provider: 'vercel'
  }
];

describe('model-mapping provider filtering', () => {
  test('buildProviderOptions deduplicates and sorts providers', () => {
    const options = [
      ...SAMPLE_OPTIONS,
      { value: 'dup', label: 'Dup', description: 'vercel · ctx 1', provider: 'vercel' }
    ];

    expect(buildProviderOptions(options)).toEqual(['kimi-for-coding', 'vercel']);
  });

  test('canonicalizeProviderFilter preserves unknown provider instead of falling back to all', () => {
    const providers = buildProviderOptions(SAMPLE_OPTIONS);
    expect(canonicalizeProviderFilter('unknown-provider', providers)).toBe('unknown-provider');
  });

  test('canonicalizeProviderFilter performs case-insensitive exact normalization', () => {
    const providers = buildProviderOptions(SAMPLE_OPTIONS);
    expect(canonicalizeProviderFilter('KIMI-FOR-CODING', providers)).toBe('kimi-for-coding');
  });

  test('filterOptionsByProvider only returns options for selected provider', () => {
    const filtered = filterOptionsByProvider(SAMPLE_OPTIONS, 'kimi-for-coding');
    expect(filtered.length).toBe(2);
    expect(filtered.every((option) => option.provider === 'kimi-for-coding')).toBe(true);
  });

  test('filterOptionsByProvider does not leak unrelated providers', () => {
    const filtered = filterOptionsByProvider(SAMPLE_OPTIONS, 'kimi-for-coding');
    expect(filtered.some((option) => option.provider === 'vercel')).toBe(false);
  });

  test('filterOptionsByProvider returns empty list for unknown provider', () => {
    const filtered = filterOptionsByProvider(SAMPLE_OPTIONS, 'non-existent-provider');
    expect(filtered).toHaveLength(0);
  });

  test('resolveOptionProvider falls back to description when provider field missing', () => {
    const option: ModelOption = {
      value: 'example',
      label: 'Example',
      description: 'vercel · ctx 128000'
    };

    expect(resolveOptionProvider(option)).toBe('vercel');
  });

  test('buildRowOptions enforces per-row provider isolation', () => {
    const rowFilters: RowProviderFilter[] = [
      { source: 'kimi-for-coding', target: 'vercel' },
      { source: 'vercel', target: 'kimi-for-coding' }
    ];

    const rowOptions = buildRowOptions(SAMPLE_OPTIONS, rowFilters, 2);
    expect(rowOptions).toHaveLength(2);
    expect(rowOptions[0].source.every((option) => option.provider === 'kimi-for-coding')).toBe(true);
    expect(rowOptions[0].target.every((option) => option.provider === 'vercel')).toBe(true);
    expect(rowOptions[1].source.every((option) => option.provider === 'vercel')).toBe(true);
    expect(rowOptions[1].target.every((option) => option.provider === 'kimi-for-coding')).toBe(true);
  });

  test('buildRowOptions updates results after provider filter changes', () => {
    const rowFilters: RowProviderFilter[] = [{ source: '', target: '' }];
    const before = buildRowOptions(SAMPLE_OPTIONS, rowFilters, 1);
    expect(before[0].source).toHaveLength(3);

    rowFilters[0] = { source: 'kimi-for-coding', target: '' };
    const after = buildRowOptions(SAMPLE_OPTIONS, rowFilters, 1);
    expect(after[0].source).toHaveLength(2);
    expect(after[0].source.some((option) => option.provider === 'vercel')).toBe(false);
  });
});
