import { describe, expect, test } from 'bun:test';
import { parseReasoningOptions } from '../server/reasoning';

describe('models.dev reasoning_options validation', () => {
  test('distinguishes missing, invalid, and valid empty metadata', () => {
    expect(parseReasoningOptions(undefined)).toEqual({ reasoningOptions: null, reasoningOptionsStatus: 'missing' });
    expect(parseReasoningOptions(null)).toEqual({ reasoningOptions: null, reasoningOptionsStatus: 'invalid' });
    expect(parseReasoningOptions([])).toEqual({ reasoningOptions: [], reasoningOptionsStatus: 'known' });
    expect(parseReasoningOptions([{ type: 'effort', values: [] }])).toEqual({
      reasoningOptions: [{ type: 'effort', values: [] }], reasoningOptionsStatus: 'known',
    });
  });

  test('preserves effort values, order, duplicates, and null/default control semantics', () => {
    const values = [null, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default', 'low'] as const;
    expect(parseReasoningOptions([{ type: 'effort', values }])).toEqual({
      reasoningOptions: [{ type: 'effort', values }], reasoningOptionsStatus: 'known',
    });
    expect(parseReasoningOptions([{ type: 'effort', values: ['null', 'default'] }]).reasoningOptions)
      .toEqual([{ type: 'effort', values: [null, 'default'] }]);
  });

  test('preserves toggle and optional budget bounds without inventing effort levels', () => {
    const options = [{ type: 'toggle' }, { type: 'budget_tokens', min: -1, max: 0 },
      { type: 'budget_tokens' }, { type: 'budget_tokens', min: 0 }, { type: 'budget_tokens', max: 1000 },
      { type: 'budget_tokens', min: 0.5, max: 1.5 }] as const;
    expect(parseReasoningOptions(options)).toEqual({ reasoningOptions: options, reasoningOptionsStatus: 'known' });
  });

  test('rejects wrong discriminants, fields, values, and budget ranges as a whole', () => {
    const invalid: unknown[] = [{}, 'high', false, 1,
      [null], ['effort'], [{}], [{ type: 'unknown' }], [{ type: 'toggle', values: ['high'] }],
      [{ type: 'effort' }], [{ type: 'effort', values: 'high' }], [{ type: 'effort', values: ['HIGH'] }],
      [{ type: 'effort', values: [false] }], [{ type: 'effort', values: [0] }],
      [{ type: 'effort', values: ['high'], extra: true }],
      [{ type: 'budget_tokens', min: -2 }], [{ type: 'budget_tokens', max: -1 }],
      [{ type: 'budget_tokens', min: 2, max: 1 }], [{ type: 'budget_tokens', min: '1' }],
      [{ type: 'budget_tokens', max: null }], [{ type: 'budget_tokens', min: NaN }],
      [{ type: 'budget_tokens', max: Infinity }], [{ type: 'budget_tokens', extra: true }],
      [{ type: 'toggle' }, { type: 'effort', values: ['untrusted body or credential'] }]];
    for (const value of invalid) expect(parseReasoningOptions(value)).toEqual({
      reasoningOptions: null, reasoningOptionsStatus: 'invalid',
    });
  });

  test('copies and deeply freezes validated controls', () => {
    const raw = [{ type: 'effort', values: ['high'] }];
    const parsed = parseReasoningOptions(raw);
    raw[0]!.values.push('low'); raw.push({ type: 'toggle', values: [] });
    expect(parsed.reasoningOptions).toEqual([{ type: 'effort', values: ['high'] }]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.reasoningOptions)).toBe(true);
    expect(Object.isFrozen(parsed.reasoningOptions![0])).toBe(true);
    const option = parsed.reasoningOptions![0]!;
    if (option.type === 'effort') expect(Object.isFrozen(option.values)).toBe(true);
  });
});
