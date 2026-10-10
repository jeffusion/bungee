import { expect, test } from 'bun:test';
import { formatCompactNumber } from '../../../src/utils/format-number';

test('compact numbers use the same decimal units for counts in every locale', () => {
  for (const [value, expected] of [
    [0, '0'], [42, '42'], [999, '999'], [1000, '1K'], [1024, '1.02K'], [1234, '1.23K'],
    [1_000_000, '1M'], [1_500_000, '1.5M'], [1_000_000_000, '1B'],
    [1_000_000_000_000, '1T'], [-1250, '-1.25K'], [-0, '0'],
  ] as const) expect(formatCompactNumber(value)).toBe(expected);
});

test('rounding promotes a count to the next unit without leaving 1000K or 1000M', () => {
  expect(formatCompactNumber(999_999)).toBe('1M');
  expect(formatCompactNumber(999_999_999)).toBe('1B');
  expect(formatCompactNumber(999_999_999_999)).toBe('1T');
});

test('missing or invalid counts remain unknown rather than appearing as zero', () => {
  for (const value of [null, undefined, '1000', NaN, Infinity, -Infinity]) {
    expect(formatCompactNumber(value)).toBe('—');
  }
});
