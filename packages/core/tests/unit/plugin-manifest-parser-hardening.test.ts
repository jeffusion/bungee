import { describe, expect, test } from 'bun:test';
import { parsePluginManifestText } from '../../src/plugin-manifest-catalog';

function manifest(configSchema: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    name: 'hardening-plugin', version: '1.0.0', schemaVersion: 2,
    artifactKind: 'runtime-plugin', main: 'server/index.ts',
    capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none',
    engines: { bungee: '^4.2.0' }, configSchema,
  };
}

function rejects(configSchema: readonly Record<string, unknown>[], fragment: string): void {
  expect(() => parsePluginManifestText(JSON.stringify(manifest(configSchema)))).toThrow(fragment);
}

describe('strict config field hardening', () => {
  test('rejects inherited field names and type-invalid empty defaults', () => {
    rejects([{ name: 'toString', type: 'string', label: 'Bad' }], 'field name');
    for (const field of [
      { name: 'x', type: 'number', label: 'Bad', default: '' },
      { name: 'x', type: 'boolean', label: 'Bad', default: '' },
      { name: 'x', type: 'object', label: 'Bad', properties: [], default: '' },
      { name: 'x', type: 'array', label: 'Bad', required: true, items: { name: 'item', type: 'string', label: 'Item' }, default: [] },
      { name: 'x', type: 'multiselect', label: 'Bad', required: true, options: [{ label: 'A', value: 'a' }], default: [] },
      { name: 'x', type: 'model_mapping', label: 'Bad', required: true, default: [] },
      { name: 'x', type: 'model_mapping', label: 'Bad', default: [{ source: ' a', target: 'b ' }] },
    ]) rejects([field], 'default');
  });

  test('rejects transforms below the top-level schema', () => {
    const transform = {
      name: 'transform', type: 'select', label: 'Transform', options: [{ label: 'A-B', value: 'a-b' }],
      fieldTransform: { type: 'split', separator: '-', fields: ['from', 'to'] },
    };
    rejects([{ name: 'nested', type: 'object', label: 'Nested', properties: [transform] }], 'top-level');
    rejects([{ name: 'rows', type: 'array', label: 'Rows', items: transform }], 'top-level');
  });

  test('limits derived showIf symbols to reachable option parts', () => {
    rejects([
      { name: 'transform', type: 'select', label: 'Transform', options: [{ label: 'A-B', value: 'a-b' }],
        fieldTransform: { type: 'split', separator: '-', fields: ['from', 'to'] } },
      { name: 'mode', type: 'string', label: 'Mode', showIf: { field: 'from', value: 'impossible' } },
    ], 'reachable');
    const parsed = parsePluginManifestText(JSON.stringify(manifest([
      { name: 'transform', type: 'select', label: 'Transform', options: [{ label: 'A-B', value: 'a-b' }],
        fieldTransform: { type: 'split', separator: '-', fields: ['from', 'to'] } },
      { name: 'mode', type: 'string', label: 'Mode', showIf: { field: 'from', value: 'a' } },
    ])));
    expect(parsed.configSchema).toHaveLength(2);
  });
});
