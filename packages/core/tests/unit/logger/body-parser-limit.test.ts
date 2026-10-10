import { describe, expect, test } from 'bun:test';
import { parseBodyParserLimit } from '../../../src/config-storage/global-scalars';

describe('global body parser limit', () => {
  test('uses the advertised default and converts every supported unit', () => {
    expect(parseBodyParserLimit()).toBe(50 * 1024 * 1024);
    for (const [limit, bytes] of [['2b', 2], ['2kb', 2048], ['2mb', 2 * 1024 ** 2], ['2gb', 2 * 1024 ** 3]] as const) {
      expect(parseBodyParserLimit(limit)).toBe(bytes);
    }
    expect(parseBodyParserLimit('9007199254740991gb')).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('rejects values outside the existing configuration grammar', () => {
    for (const limit of ['', '0b', '01kb', '1.5mb', '50MB', '10', '-1kb', '9007199254740992b']) {
      expect(() => parseBodyParserLimit(limit)).toThrow('Invalid body parser limit');
    }
  });
});
