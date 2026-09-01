import { describe, expect, test } from 'bun:test';
import {
  ConfigurationHashError,
  type ConfigurationCompileOptions,
  canonicalJson,
  parseNormalizeCompile,
} from '../../src/config-storage';

const catalog: ConfigurationCompileOptions = {
  pluginSchemas: new Map([['json-data', [
    { name: 'safe', type: 'json', label: 'Safe' },
    { name: 'date', type: 'json', label: 'Date' },
    { name: 'map', type: 'json', label: 'Map' },
    { name: 'regex', type: 'json', label: 'Regex' },
    { name: 'custom', type: 'json', label: 'Custom' },
    { name: 'nested', type: 'json', label: 'Nested' },
  ]]]),
};

const binding = {
  id: 'abcdefab-cdef-4abc-8def-abcdefabc001',
  name: 'json-data',
};

describe('configuration JSON object security', () => {
  test('canonicalJson rejects accessors without invoking them and observes only plain JSON snapshots', () => {
    // Given
    let reads = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() { reads += 1; return reads === 1 ? 'safe' : '\ud800'; },
    });
    const proxy = new Proxy({ value: 'safe' }, { get: () => '\ud800' });
    const revoked = Proxy.revocable({ value: 'safe' }, {});
    revoked.revoke();

    // When / Then
    for (const value of [accessor, proxy, revoked.proxy]) {
      expect(() => canonicalJson(value)).toThrow(ConfigurationHashError);
    }
    expect(reads).toBe(0);
    expect(canonicalJson({ valid: ['😀', { value: true }] })).toBe('{"valid":["😀",{"value":true}]}');
  });

  test('canonicalJson rejects symbols, exotic prototypes, sparse arrays, cycles, and invalid scalar values', () => {
    // Given
    const symbolValue = { safe: true, [Symbol('hidden')]: true };
    const sparse = Array.from({ length: 2 });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    // When / Then
    for (const value of [symbolValue, new Date(), sparse, cyclic, { value: undefined }, { value: 1n }, { value: Number.NaN }]) {
      expect(() => canonicalJson(value)).toThrow(ConfigurationHashError);
    }
  });

  test('rejects non-plain object values at their exact paths', () => {
    class CustomValue { readonly value = 'custom'; }
    const result = parseNormalizeCompile({
      plugins: [{
        ...binding,
        options: {
          date: new Date('2026-01-01T00:00:00Z'),
          map: new Map([['key', 'value']]),
          regex: /value/,
          custom: new CustomValue(),
        },
      }],
    }, catalog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ code, path }) => ({ code: String(code), path }))).toEqual([
        { code: 'non_json_value', path: 'plugins[0].options.date' },
        { code: 'non_json_value', path: 'plugins[0].options.map' },
        { code: 'non_json_value', path: 'plugins[0].options.regex' },
        { code: 'non_json_value', path: 'plugins[0].options.custom' },
      ]);
    }
  });

  test('rejects forbidden keys recursively without prototype pollution', () => {
    const polluted = JSON.parse(
      '{"safe":true,"nested":{"__proto__":{"polluted":"yes"}},"constructor":{"prototype":{"bad":true}}}',
    ) as unknown;
    const result = parseNormalizeCompile({
      plugins: [{ ...binding, options: polluted }],
    }, catalog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ code, path }) => ({ code: String(code), path }))).toEqual([
        { code: 'forbidden_key', path: 'plugins[0].options.constructor' },
        { code: 'forbidden_key', path: 'plugins[0].options.nested.__proto__' },
        { code: 'forbidden_key', path: 'plugins[0].options.constructor.prototype' },
      ]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
  });

  test('normalizes null-prototype JSON objects into unpolluted normal objects', () => {
    const safe = Object.create(null) as Record<string, unknown>;
    safe.value = { nested: true };
    const result = parseNormalizeCompile({
      plugins: [{ ...binding, options: { safe } }],
    }, catalog);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const options = result.value.plugins[0]?.options;
    expect(Object.getPrototypeOf(options)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(options?.safe)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('rejects lone UTF-16 surrogates in property keys and string values with stable paths', () => {
    // Given / When
    const result = parseNormalizeCompile({
      plugins: [{
        ...binding,
        options: {
          safe: { valid: '😀', normal: '中文', high: '\ud800', low: '\udc00', ['bad\ud800key']: true },
        },
      }],
    }, catalog);

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ path }) => path)).toEqual([
        'plugins[0].options.safe.bad\ud800key',
        'plugins[0].options.safe.high',
        'plugins[0].options.safe.low',
      ]);
    }
    expect(canonicalJson({ valid: '😀', normal: '中文' })).toBe('{"normal":"中文","valid":"😀"}');
    expect(() => canonicalJson({ broken: '\ud800' })).toThrow(ConfigurationHashError);
    expect(() => canonicalJson({ ['broken\udc00']: true })).toThrow(ConfigurationHashError);
  });
});
