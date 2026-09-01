import { describe, expect, test } from 'bun:test';
import {
  type ConfigurationCompileOptions,
  parseNormalizeCompileAggregate,
} from '../../src/config-storage';

const BINDING_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const PLUGINS: ConfigurationCompileOptions = {
  pluginSchemas: new Map([
    ['bound-plugin', []],
    ['enabled-binding', []],
    ['activation-without-binding', []],
  ]),
  availablePlugins: new Set(['bound-plugin', 'enabled-binding', 'activation-without-binding']),
};

function summary(
  input: unknown,
  options?: ConfigurationCompileOptions,
): readonly { code: string; path: string }[] {
  const result = parseNormalizeCompileAggregate(input, options);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map(({ code, path }) => ({ code, path }));
}

describe('parseNormalizeCompileAggregate', () => {
  test('accepts only the aggregate shape and compiles an empty aggregate', () => {
    expect(parseNormalizeCompileAggregate({
      logical_configuration: {},
      plugin_activations: [],
    })).toEqual({
      ok: true,
      value: {
        logical_configuration: { services: [], routes: [], plugins: [] },
        plugin_activations: [],
      },
    });

    expect(summary({})).toEqual([
      { code: 'required', path: 'logical_configuration' },
      { code: 'required', path: 'plugin_activations' },
    ]);
    expect(summary({ services: [], routes: [], plugins: [] })).toEqual([
      { code: 'unknown_field', path: 'services' },
      { code: 'unknown_field', path: 'routes' },
      { code: 'unknown_field', path: 'plugins' },
      { code: 'required', path: 'logical_configuration' },
      { code: 'required', path: 'plugin_activations' },
    ]);
  });

  test('requires an array of exact plugin activation objects', () => {
    expect(summary({ logical_configuration: {}, plugin_activations: true })).toEqual([
      { code: 'invalid_type', path: 'plugin_activations' },
    ]);
    expect(summary({ logical_configuration: {}, plugin_activations: {
      'bound-plugin': true,
    } })).toEqual([
      { code: 'invalid_type', path: 'plugin_activations' },
    ]);
    expect(summary({
      logical_configuration: {},
      plugin_activations: [true, { plugin_name: 'bound-plugin', enabled: true }],
    })).toEqual([
      { code: 'invalid_type', path: 'plugin_activations[0]' },
      { code: 'unknown_field', path: 'plugin_activations[1].enabled' },
    ]);
    expect(summary({
      logical_configuration: {},
      plugin_activations: [{ plugin_name: 42 }],
      extra: true,
    })).toEqual([
      { code: 'unknown_field', path: 'extra' },
      { code: 'invalid_type', path: 'plugin_activations[0].plugin_name' },
    ]);
  });

  test('normalizes valid names, rejects invalid names, and rejects duplicates', () => {
    const result = parseNormalizeCompileAggregate({
      logical_configuration: {},
      plugin_activations: [
        { plugin_name: 'zeta-plugin' },
        { plugin_name: 'a-2' },
        { plugin_name: 'a-10' },
        { plugin_name: 'a' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        logical_configuration: { services: [], routes: [], plugins: [] },
        plugin_activations: [
          { plugin_name: 'a' },
          { plugin_name: 'a-10' },
          { plugin_name: 'a-2' },
          { plugin_name: 'zeta-plugin' },
        ],
      },
    });

    expect(summary({
      logical_configuration: {},
      plugin_activations: [
        {},
        { plugin_name: '   ' },
        { plugin_name: 'Uppercase' },
        { plugin_name: 'has space' },
        { plugin_name: 'has/slash' },
        { plugin_name: 'double--dash' },
        { plugin_name: 'alpha' },
        { plugin_name: ' alpha ' },
        { plugin_name: ' zeta-plugin ' },
      ],
    })).toEqual([
      { code: 'required', path: 'plugin_activations[0].plugin_name' },
      { code: 'invalid_value', path: 'plugin_activations[1].plugin_name' },
      { code: 'invalid_value', path: 'plugin_activations[2].plugin_name' },
      { code: 'invalid_value', path: 'plugin_activations[3].plugin_name' },
      { code: 'invalid_value', path: 'plugin_activations[4].plugin_name' },
      { code: 'invalid_value', path: 'plugin_activations[5].plugin_name' },
      { code: 'invalid_value', path: 'plugin_activations[7].plugin_name' },
      { code: 'invalid_value', path: 'plugin_activations[8].plugin_name' },
    ]);
  });

  test('keeps installation activation independent from scoped binding enabled state', () => {
    const result = parseNormalizeCompileAggregate({
      logical_configuration: {
        plugins: [
          { id: BINDING_ID, name: 'bound-plugin', enabled: false },
          {
            id: 'abcdefab-cdef-4abc-8def-abcdefabcdea',
            name: 'enabled-binding',
            enabled: true,
          },
        ],
      },
      plugin_activations: [
        { plugin_name: 'bound-plugin' },
        { plugin_name: 'activation-without-binding' },
      ],
    }, PLUGINS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.logical_configuration.plugins.map(({ name, enabled }) => ({ name, enabled })))
      .toEqual([
        { name: 'bound-plugin', enabled: false },
        { name: 'enabled-binding', enabled: true },
      ]);
    expect(result.value.plugin_activations).toEqual([
      { plugin_name: 'activation-without-binding' },
      { plugin_name: 'bound-plugin' },
    ]);
  });

  test('rejects unknown activations only when a catalog is supplied', () => {
    const aggregate = {
      logical_configuration: {},
      plugin_activations: [{ plugin_name: 'not-installed' }],
    };

    expect(summary(aggregate, PLUGINS)).toEqual([
      { code: 'unknown_plugin', path: 'plugin_activations[0].plugin_name' },
    ]);
    expect(parseNormalizeCompileAggregate(aggregate).ok).toBe(true);
    expect(parseNormalizeCompileAggregate({
      logical_configuration: {},
      plugin_activations: [{ plugin_name: 'bound-plugin' }],
    }, PLUGINS).ok).toBe(true);
  });

  test('prefixes logical compiler errors and does not mutate or reuse input objects', () => {
    const input = {
      logical_configuration: {
        plugins: [{ id: BINDING_ID, name: 'bound-plugin', enabled: false }],
      },
      plugin_activations: [{ plugin_name: 'bound-plugin' }],
    };
    const before = structuredClone(input);
    const result = parseNormalizeCompileAggregate(input, PLUGINS);

    expect(input).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(input);
    expect(result.value.logical_configuration).not.toBe(input.logical_configuration);
    expect(result.value.plugin_activations).not.toBe(input.plugin_activations);
    expect(result.value.plugin_activations[0]).not.toBe(input.plugin_activations[0]);

    expect(summary({
      logical_configuration: { mystery: true },
      plugin_activations: [],
    })).toEqual([
      { code: 'unknown_field', path: 'logical_configuration.mystery' },
    ]);
  });
});
