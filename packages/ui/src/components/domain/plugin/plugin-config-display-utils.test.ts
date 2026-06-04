import { describe, expect, test } from 'bun:test';
import {
  collectSchemaFieldNames,
  hasDisplayValue,
  shouldRenderFallbackField,
  shouldShowField,
} from './plugin-config-display-utils';

describe('plugin-config-display-utils', () => {
  test('shouldShowField: showIf 匹配时显示，不匹配时隐藏', () => {
    const config = { betaMode: 'allowlist' };

    expect(shouldShowField({ name: 'betaAllowlist' }, config)).toBe(true);
    expect(
      shouldShowField({ name: 'betaAllowlist', showIf: { field: 'betaMode', value: 'allowlist' } }, config)
    ).toBe(true);
    expect(
      shouldShowField({ name: 'betaAllowlist', showIf: { field: 'betaMode', value: 'strip' } }, config)
    ).toBe(false);
  });

  test('hasDisplayValue: 空值过滤正确，false/0 仍可显示', () => {
    expect(hasDisplayValue(undefined)).toBe(false);
    expect(hasDisplayValue(null)).toBe(false);
    expect(hasDisplayValue('')).toBe(false);
    expect(hasDisplayValue('   ')).toBe(false);
    expect(hasDisplayValue([])).toBe(false);

    expect(hasDisplayValue(false)).toBe(true);
    expect(hasDisplayValue(0)).toBe(true);
    expect(hasDisplayValue('none')).toBe(true);
    expect(hasDisplayValue({})).toBe(true);
  });

  test('collectSchemaFieldNames: 只收集合法字段名', () => {
    const names = collectSchemaFieldNames([
      { name: 'sanitizeMode' },
      { name: 'betaMode' },
      { name: '' },
      { name: 123 },
      {},
    ]);

    expect(names.has('sanitizeMode')).toBe(true);
    expect(names.has('betaMode')).toBe(true);
    expect(names.has('')).toBe(false);
    expect(names.size).toBe(2);
  });

  test('shouldRenderFallbackField: schema 定义字段即使未处理也不应回退显示', () => {
    const processed = new Set<string>();
    const schemaFieldNames = new Set<string>(['betaAllowlist', 'betaMode']);

    expect(
      shouldRenderFallbackField('betaAllowlist', 'claude-code-20250219', processed, schemaFieldNames)
    ).toBe(false);
    expect(
      shouldRenderFallbackField('betaMode', '', processed, schemaFieldNames)
    ).toBe(false);
    expect(
      shouldRenderFallbackField('unknownKey', 'value', processed, schemaFieldNames)
    ).toBe(true);
    expect(
      shouldRenderFallbackField('unknownEmpty', '', processed, schemaFieldNames)
    ).toBe(false);
  });
});
