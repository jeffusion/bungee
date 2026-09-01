import { describe, expect, test } from 'bun:test';
import {
  type ConfigurationCompileOptions,
  hashConfigurationContent,
  parseNormalizeCompile,
  parseNormalizeCompileAggregate,
} from '../../src/config-storage';

const catalog: ConfigurationCompileOptions = {
  pluginSchemas: new Map([['audit', []]]),
};

const plugin = (id: string, position?: number) => ({ id, name: 'audit', ...(position === undefined ? {} : { position }) });
const endpoint = (id: string, position?: number, plugins?: readonly unknown[]) => ({
  id,
  target: 'https://example.com',
  ...(position === undefined ? {} : { position }),
  ...(plugins ? { plugins } : {}),
});

describe('configuration collection positions', () => {
  test('rejects later duplicate explicit positions in every owner-scoped collection', () => {
    const result = parseNormalizeCompile({
      plugins: [
        plugin('abcdefab-cdef-4abc-8def-abcdefabc010', 4),
        plugin('abcdefab-cdef-4abc-8def-abcdefabc011', 4),
      ],
      services: [{
        id: '10000000-0000-4000-8000-000000000030', position: 2, name: 'one',
        plugins: [
          plugin('abcdefab-cdef-4abc-8def-abcdefabc012', 3),
          plugin('abcdefab-cdef-4abc-8def-abcdefabc013', 3),
        ],
        endpoints: [
          endpoint('30000000-0000-4000-8000-000000000030', 1, [
            plugin('abcdefab-cdef-4abc-8def-abcdefabc014', 5),
            plugin('abcdefab-cdef-4abc-8def-abcdefabc015', 5),
          ]),
          endpoint('30000000-0000-4000-8000-000000000031', 1),
        ],
      }, {
        id: '10000000-0000-4000-8000-000000000031', position: 2, name: 'two',
        endpoints: [endpoint('30000000-0000-4000-8000-000000000032', 1)],
      }],
      routes: [{
        id: '20000000-0000-4000-8000-000000000030', position: 7, path: '/one',
        plugins: [
          plugin('abcdefab-cdef-4abc-8def-abcdefabc016', 6),
          plugin('abcdefab-cdef-4abc-8def-abcdefabc017', 6),
        ],
        endpoints: [
          endpoint('30000000-0000-4000-8000-000000000033', 8),
          endpoint('30000000-0000-4000-8000-000000000034', 8),
        ],
      }, {
        id: '20000000-0000-4000-8000-000000000031', position: 7, path: '/two',
        direct_response: { enabled: true, status: 200 },
      }],
    }, catalog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.filter(({ code }) => String(code) === 'duplicate_position').map(({ path }) => path)).toEqual([
        'plugins[1].position',
        'services[1].position',
        'services[0].endpoints[1].position',
        'services[0].endpoints[0].plugins[1].position',
        'services[0].plugins[1].position',
        'routes[1].position',
        'routes[0].plugins[1].position',
        'routes[0].endpoints[1].position',
      ]);
    }
  });

  test('allows positions to repeat across owners and generates unique omitted positions', () => {
    const result = parseNormalizeCompile({
      services: [{
        id: '10000000-0000-4000-8000-000000000040', position: 1, name: 'one',
        endpoints: [
          endpoint('30000000-0000-4000-8000-000000000040', 1),
          endpoint('30000000-0000-4000-8000-000000000041'),
          endpoint('30000000-0000-4000-8000-000000000042'),
        ],
      }, {
        id: '10000000-0000-4000-8000-000000000041', name: 'two',
        endpoints: [endpoint('30000000-0000-4000-8000-000000000043', 1)],
      }],
      routes: [{
        id: '20000000-0000-4000-8000-000000000040', position: 1, path: '/one',
        direct_response: { enabled: true, status: 200 },
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.services.map(({ position }) => position)).toEqual([0, 1]);
    expect(result.value.services[0]?.endpoints[0]?.position).toBe(1);
    expect(result.value.services[1]?.endpoints.map(({ position }) => position)).toEqual([0, 1, 2]);
    expect(result.value.routes[0]?.position).toBe(1);
  });

  test('canonically sorts every entity and binding scope without renumbering or mutating input', () => {
    // Given
    const first = {
      plugins: [
        plugin('40000000-0000-4000-8000-000000000002', 8),
        plugin('40000000-0000-4000-8000-000000000001', 2),
      ],
      services: [{
        id: '10000000-0000-4000-8000-000000000002', position: 9, name: 'later',
        endpoints: [endpoint('30000000-0000-4000-8000-000000000002', 7)],
        plugins: [],
      }, {
        id: '10000000-0000-4000-8000-000000000001', position: 1, name: 'first',
        endpoints: [
          endpoint('30000000-0000-4000-8000-000000000004', 6),
          endpoint('30000000-0000-4000-8000-000000000003', 3, [
            plugin('40000000-0000-4000-8000-000000000004', 5),
            plugin('40000000-0000-4000-8000-000000000003', 1),
          ]),
        ],
        plugins: [
          plugin('40000000-0000-4000-8000-000000000006', 6),
          plugin('40000000-0000-4000-8000-000000000005', 4),
        ],
      }],
      routes: [{
        id: '20000000-0000-4000-8000-000000000002', position: 8, path: '/later',
        direct_response: { enabled: true, status: 200 }, plugins: [],
      }, {
        id: '20000000-0000-4000-8000-000000000001', position: 2, path: '/first',
        endpoints: [
          endpoint('30000000-0000-4000-8000-000000000006', 9),
          endpoint('30000000-0000-4000-8000-000000000005', 2),
        ],
        plugins: [
          plugin('40000000-0000-4000-8000-000000000008', 7),
          plugin('40000000-0000-4000-8000-000000000007', 3),
        ],
      }],
    };
    const before = structuredClone(first);
    const second = {
      ...first,
      plugins: [...first.plugins].reverse(),
      services: [...first.services].reverse().map((service) => ({
        ...service,
        endpoints: [...service.endpoints].reverse().map((upstream) => ({
          ...upstream,
          ...(upstream.plugins ? { plugins: [...upstream.plugins].reverse() } : {}),
        })),
        plugins: [...service.plugins].reverse(),
      })),
      routes: [...first.routes].reverse().map((route) => ({
        ...route,
        ...(route.endpoints ? { endpoints: [...route.endpoints].reverse() } : {}),
        plugins: [...route.plugins].reverse(),
      })),
    };

    // When
    const left = parseNormalizeCompile(first, catalog);
    const right = parseNormalizeCompile(second, catalog);

    // Then
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.value).toEqual(right.value);
    expect(hashConfigurationContent(left.value)).toBe(hashConfigurationContent(right.value));
    const leftAggregate = parseNormalizeCompileAggregate({ logical_configuration: first, plugin_activations: [] }, catalog);
    const rightAggregate = parseNormalizeCompileAggregate({ logical_configuration: second, plugin_activations: [] }, catalog);
    expect(leftAggregate.ok).toBe(true);
    expect(rightAggregate.ok).toBe(true);
    if (leftAggregate.ok && rightAggregate.ok) {
      expect(hashConfigurationContent(leftAggregate.value)).toBe(hashConfigurationContent(rightAggregate.value));
    }
    expect(first).toEqual(before);
    expect(left.value.services.map(({ position }) => position)).toEqual([1, 9]);
    expect(left.value.routes.map(({ position }) => position)).toEqual([2, 8]);
    expect(left.value.plugins.map(({ position }) => position)).toEqual([2, 8]);
    expect(left.value.services[0]?.endpoints.map(({ position }) => position)).toEqual([3, 6]);
    expect(left.value.services[0]?.plugins.map(({ position }) => position)).toEqual([4, 6]);
    expect(left.value.services[0]?.endpoints[0]?.plugins.map(({ position }) => position)).toEqual([1, 5]);
    expect(left.value.routes[0]?.endpoints?.map(({ position }) => position)).toEqual([2, 9]);
    expect(left.value.routes[0]?.plugins.map(({ position }) => position)).toEqual([3, 7]);
  });

  test('rejects explicit positions outside the JavaScript safe integer range', () => {
    // Given / When
    const result = parseNormalizeCompile({
      services: [{
        id: '10000000-0000-4000-8000-000000000050',
        position: Number.MAX_SAFE_INTEGER + 1,
        name: 'unsafe',
        endpoints: [],
      }],
      routes: [],
    });

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map(({ path }) => path)).toContain('services[0].position');
  });
});
