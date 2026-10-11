import { describe, expect, test } from 'bun:test';
import {
  collectSchemaFieldNames,
  displayConfigValue,
  displayModelBindings,
  hasDisplayValue,
  shouldRenderFallbackField,
  shouldShowField,
} from '../../../../../src/components/domain/plugin/plugin-config-display-utils';

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

test('structured plugin summaries show model bindings and translated target kinds without object coercion', () => {
  const binding = { source: 'client', provider: 'lab', model: 'org/model', target: { type: 'service', id: 'upstream', protocol: 'chat_completions' } };
  expect(displayModelBindings([binding], target => `服务: ${target.id}`, mode => mode === 'add' ? '新增模型' : '替换模型')).toBe('替换模型: client → lab/org/model · Chat Completions · 服务: upstream');
  expect(displayModelBindings([{ ...binding, source: undefined, alias: 'custom' }], target => `Service: ${target.id}`, mode => mode === 'add' ? 'Add model' : 'Replace model')).toContain('Replace model: custom →');
  expect(displayConfigValue([{ x: 1 }])).toBe('[{"x":1}]');
  expect(displayConfigValue({ x: 1 })).not.toContain('[object Object]');
});

test('model summaries delegate the complete target reference to the name resolver', () => {
  const references: unknown[] = [];
  const bindings = [
    { source: 'first', provider: 'lab', model: 'model', target: { type: 'route', id: 'shared', protocol: 'responses' } },
    { source: 'second', provider: 'lab', model: 'model', target: { type: 'service', id: 'shared', protocol: 'responses' } },
  ];
  const summary = displayModelBindings(bindings, target => {
    references.push(target);
    return target.type === 'route' ? 'Route: /relay' : 'Service: relay-service';
  }, mode => mode === 'add' ? 'Add model' : 'Replace model');
  expect(references).toEqual(bindings.map(binding => binding.target));
  expect(summary).toBe('Replace model: first → lab/model · Responses · Route: /relay\nReplace model: second → lab/model · Responses · Service: relay-service');
  expect(summary).not.toContain('shared');
});

test('equal source and target IDs summarize additions without a redundant arrow', () => {
  const added = { source: 'glm-5.3-flash', provider: 'zai', model: 'glm-5.3-flash', target: { type: 'service', id: 'glm', protocol: 'chat_completions' } };
  expect(displayModelBindings([added], () => '服务: GLM', mode => mode === 'add' ? '新增模型' : '替换模型'))
    .toBe('新增模型: zai/glm-5.3-flash · Chat Completions · 服务: GLM');
});
