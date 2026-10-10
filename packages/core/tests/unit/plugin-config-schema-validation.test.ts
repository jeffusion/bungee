import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { parseNormalizeCompile } from '../../src/config-storage';
import { buildPluginManifestCatalog } from '../../src/plugin-manifest-catalog';

const BUILTINS = resolve(import.meta.dir, '../../../../plugins');
const BINDING_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

async function compileOptions() {
  return (await buildPluginManifestCatalog({ scanDirectories: [BUILTINS] })).toCompileOptions();
}

describe('catalog-backed plugin option validation', () => {
  test('accepts explicit adapter protocol fields and rejects missing or unsupported pairs', async () => {
    const options = await compileOptions();
    const valid = parseNormalizeCompile({ plugins: [{
      id: BINDING_ID, name: 'llm-protocol-adapter', options: { sourceProtocol: 'anthropic_messages', targetProtocol: 'chat_completions' },
    }] }, options);
    expect(valid.ok).toBe(true);

    for (const pluginOptions of [
      { sourceProtocol: 'responses', targetProtocol: 'gemini_generate_content' },
      { sourceProtocol: 'gemini_generate_content', targetProtocol: 'responses' },
      { sourceProtocol: 'anthropic_messages' },
    ]) {
      expect(parseNormalizeCompile({ plugins: [{
        id: BINDING_ID, name: 'llm-protocol-adapter', options: pluginOptions,
      }] }, options).ok).toBe(false);
    }
  });

  test('accepts only exact model mapping records', async () => {
    const options = await compileOptions();
    expect(parseNormalizeCompile({ plugins: [{
      id: BINDING_ID, name: 'model-mapping', options: { modelMappings: [{ source: 'a', target: 'b' }] },
    }] }, options).ok).toBe(true);

    for (const modelMappings of [
      {}, [{ source: 'a' }], [{ source: 'a', target: 'b', extra: true }],
      [{ source: '', target: 'b' }], [{ source: 'a', target: 1 }],
    ]) {
      expect(parseNormalizeCompile({ plugins: [{
        id: BINDING_ID, name: 'model-mapping', options: { modelMappings },
      }] }, options).ok).toBe(false);
    }
  });

  test('shares required, multiselect, finite-number, and nested exactness rules', () => {
    const pluginSchemas = new Map([['strict', [
      { name: 'requiredText', type: 'string', label: 'Text', required: true },
      { name: 'choices', type: 'multiselect', label: 'Choices', options: [{ label: 'A', value: 'a' }] },
      { name: 'nested', type: 'object', label: 'Nested', properties: [{ name: 'count', type: 'number', label: 'Count' }] },
    ] as const]]);
    const result = parseNormalizeCompile({ plugins: [{ id: BINDING_ID, name: 'strict', options: {
      requiredText: '', choices: ['a', 'a'], nested: { count: Number.POSITIVE_INFINITY, extra: true },
    } }] }, { pluginSchemas });
    expect(result.ok).toBe(false);
  });

  test('does not satisfy inherited required fields or wrong-type empty values', () => {
    const inheritedSchemas = new Map([['strict-inherited', [
      { name: 'toString', type: 'string', label: 'Inherited', required: true },
    ] as const]]);
    expect(parseNormalizeCompile({ plugins: [{ id: BINDING_ID, name: 'strict-inherited', options: {} }] }, {
      pluginSchemas: inheritedSchemas,
    }).ok).toBe(false);

    const pluginSchemas = new Map([['strict-empty', [
      { name: 'text', type: 'string', label: 'Text', required: true },
      { name: 'count', type: 'number', label: 'Count' },
      { name: 'enabled', type: 'boolean', label: 'Enabled' },
      { name: 'rows', type: 'array', label: 'Rows', required: true, items: { name: 'row', type: 'string', label: 'Row' } },
      { name: 'choices', type: 'multiselect', label: 'Choices', required: true, options: [{ label: 'A', value: 'a' }] },
      { name: 'mappings', type: 'model_mapping', label: 'Mappings', required: true },
    ] as const]]);
    expect(parseNormalizeCompile({ plugins: [{ id: BINDING_ID, name: 'strict-empty', options: {
      text: 'ok', count: '', enabled: '', rows: [], choices: [], mappings: [],
    } }] }, { pluginSchemas }).ok).toBe(false);
  });

  test('uses bounded duplicate-aware parsing for string JSON fields', () => {
    const pluginSchemas = new Map([['strict-json', [
      { name: 'payload', type: 'json', label: 'Payload' },
    ] as const]]);
    const compile = (payload: string) => parseNormalizeCompile({
      plugins: [{ id: BINDING_ID, name: 'strict-json', options: { payload } }],
    }, { pluginSchemas });

    expect(compile('{"nested":[1,true]}').ok).toBe(true);
    for (const invalid of [
      '{"a":1,"a":2}',
      '{"__proto__":1}',
      '"\\ud800"',
      '1e999',
      `${'['.repeat(40)}0${']'.repeat(40)}`,
      `"${'x'.repeat(262_144)}"`,
    ]) expect(compile(invalid).ok).toBe(false);
  });
});
