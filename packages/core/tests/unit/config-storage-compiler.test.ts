import { describe, expect, test } from 'bun:test';
import {
  type ConfigurationCompileOptions,
  parseNormalizeCompile,
} from '../../src/config-storage';

declare global {
  var __configCompilerProbe: number;
}

const IDS = {
  service: '10000000-0000-4000-8000-000000000001',
  route: '20000000-0000-4000-8000-000000000001',
  upstream: '30000000-0000-4000-8000-000000000001',
  binding: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
} as const;

const PLUGINS: ConfigurationCompileOptions = {
  pluginSchemas: new Map([
    ['audit', [{ name: 'level', type: 'select', label: 'Level', required: true, options: [
      { label: 'Info', value: 'info' },
      { label: 'Debug', value: 'debug' },
    ] }]],
    ['endpoint-plugin', []],
  ]),
};

function errorSummary(
  input: unknown,
  options?: ConfigurationCompileOptions,
): Array<{ code: string; path: string }> {
  const result = parseNormalizeCompile(input, options);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map(({ code, path }) => ({ code, path }));
}

describe('parseNormalizeCompile', () => {
  test('accepts exact global scalar domains and rejects aliases or malformed limits', () => {
    // Given / When / Then
    for (const logLevel of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(parseNormalizeCompile({ log_level: logLevel }).ok).toBe(true);
    }
    for (const bodyParserLimit of ['1b', '2kb', '50mb', '1gb']) {
      expect(parseNormalizeCompile({ body_parser_limit: bodyParserLimit }).ok).toBe(true);
    }
    for (const logLevel of ['INFO', ' info', 'info ']) {
      expect(errorSummary({ log_level: logLevel })).toContainEqual({ code: 'invalid_value', path: 'log_level' });
    }
    for (const bodyParserLimit of [
      '', '0b', '01kb', '1KB', ' 1kb', '1kb ', '1.5mb', 'kb', `${Number.MAX_SAFE_INTEGER + 1}b`,
    ]) {
      expect(errorSummary({ body_parser_limit: bodyParserLimit })).toContainEqual({
        code: 'invalid_value', path: 'body_parser_limit',
      });
    }
  });

  test('compiles a legal empty configuration', () => {
    expect(parseNormalizeCompile({})).toEqual({
      ok: true,
      value: { services: [], routes: [], plugins: [] },
    });
  });

  test('normalizes defaults and positions deterministically while preserving explicit positions', () => {
    const result = parseNormalizeCompile({
      services: [{
        id: IDS.service,
        position: 7,
        name: 'primary',
        endpoints: [{
          id: IDS.upstream,
          target: 'https://example.com',
          plugins: [{ id: IDS.binding, name: 'audit', options: { level: 'info' } }],
        }],
      }],
      routes: [{ id: IDS.route, path: '/v1', service_id: IDS.service }],
    }, PLUGINS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.services[0]?.position).toBe(7);
    expect(result.value.services[0]?.endpoints[0]).toMatchObject({
      position: 0,
      weight: 100,
      priority: 1,
      is_disabled: false,
    });
    expect(result.value.services[0]?.endpoints[0]?.plugins[0]).toMatchObject({
      position: 0,
      enabled: true,
    });
    expect(result.value.routes[0]?.position).toBe(0);
  });

  test('rejects missing, malformed, and uppercase IDs with stable paths', () => {
    expect(errorSummary({
      services: [{ name: 'missing', endpoints: [] }],
      routes: [{ id: 'not-a-uuid', path: '/bad' }],
      plugins: [{ id: IDS.binding.toUpperCase(), name: 'audit' }],
    }, PLUGINS)).toEqual([
      { code: 'invalid_uuid', path: 'plugins[0].id' },
      { code: 'invalid_plugin_option', path: 'plugins[0].options.level' },
      { code: 'required', path: 'services[0].id' },
      { code: 'empty_service', path: 'services[0].endpoints' },
      { code: 'invalid_uuid', path: 'routes[0].id' },
      { code: 'missing_route_target', path: 'routes[0]' },
    ]);
  });

  test('returns all duplicate identity, name, and path errors', () => {
    expect(errorSummary({
      services: [
        { id: IDS.service, name: 'same', endpoints: [] },
        { id: IDS.service, name: 'same', endpoints: [] },
      ],
      routes: [
        { id: IDS.route, path: '/same' },
        { id: IDS.route, path: '/same' },
      ],
    })).toEqual([
      { code: 'empty_service', path: 'services[0].endpoints' },
      { code: 'duplicate_id', path: 'services[1].id' },
      { code: 'duplicate_name', path: 'services[1].name' },
      { code: 'empty_service', path: 'services[1].endpoints' },
      { code: 'missing_route_target', path: 'routes[0]' },
      { code: 'duplicate_id', path: 'routes[1].id' },
      { code: 'duplicate_path', path: 'routes[1].path' },
      { code: 'missing_route_target', path: 'routes[1]' },
    ]);
  });

  test('rejects broken service references and conflicting upstream ownership', () => {
    const unknownService = '10000000-0000-4000-8000-000000000099';
    expect(errorSummary({
      routes: [
        { id: IDS.route, path: '/missing', service_id: unknownService },
        {
          id: '20000000-0000-4000-8000-000000000002',
          path: '/owned-twice',
          service_id: IDS.service,
          endpoints: [{ id: IDS.upstream, target: 'https://example.com' }],
        },
      ],
      services: [{ id: IDS.service, name: 'primary', endpoints: [] }],
    }, PLUGINS)).toEqual([
      { code: 'empty_service', path: 'services[0].endpoints' },
      { code: 'unknown_service', path: 'routes[0].service_id' },
      { code: 'conflicting_owner', path: 'routes[1].endpoints' },
    ]);
  });

  test('rejects legacy route service names and explicit upstream owner fields', () => {
    expect(errorSummary({
      routes: [{
        id: IDS.route,
        path: '/legacy',
        service: 'primary',
        endpoints: [{
          id: IDS.upstream,
          target: 'https://example.com',
          route_id: IDS.route,
        }],
      }],
    }, PLUGINS)).toEqual([
      { code: 'invalid_value', path: 'routes[0].service' },
      { code: 'conflicting_owner', path: 'routes[0].endpoints[0].route_id' },
    ]);
  });

  test('rejects plugin paths and string shorthand at every scope', () => {
    expect(errorSummary({
      plugins: ['global-short'],
      services: [{
        id: IDS.service,
        name: 'primary',
        endpoints: [{
          id: IDS.upstream,
          target: 'https://example.com',
          plugins: [{ id: IDS.binding, name: 'endpoint-plugin', path: './plugin.ts' }],
        }],
        plugins: ['service-short'],
      }],
      routes: [{ id: IDS.route, path: '/v1', plugins: ['route-short'] }],
    }, PLUGINS)).toEqual([
      { code: 'invalid_type', path: 'plugins[0]' },
      { code: 'plugin_path_forbidden', path: 'services[0].endpoints[0].plugins[0].path' },
      { code: 'invalid_type', path: 'services[0].plugins[0]' },
      { code: 'missing_route_target', path: 'routes[0]' },
      { code: 'invalid_type', path: 'routes[0].plugins[0]' },
    ]);
  });

  test('reports non-JSON values in copied policies and plugin options instead of dropping them', () => {
    expect(errorSummary({
      auth: { enabled: false, extra: undefined },
      services: [{
        id: IDS.service,
        name: 'primary',
        health_check: { enabled: false, headers: { bad: 1n } },
        endpoints: [{
          id: IDS.upstream,
          target: 'https://example.com',
          headers: { add: { bad: Symbol('bad') } },
          plugins: [{ id: IDS.binding, name: 'audit', options: { level: () => 'info' } }],
        }],
      }],
      routes: [{
        id: IDS.route,
        path: '/v1',
        service_id: IDS.service,
        body: { add: { bad: Number.NaN } },
      }],
    }, PLUGINS)).toEqual([
      { code: 'non_json_value', path: 'auth.extra' },
      { code: 'non_json_value', path: 'services[0].health_check.headers.bad' },
      { code: 'non_json_value', path: 'services[0].endpoints[0].headers.add.bad' },
      { code: 'non_json_value', path: 'services[0].endpoints[0].plugins[0].options.level' },
      { code: 'non_json_value', path: 'routes[0].body.add.bad' },
    ]);
  });

  test('validates endpoint, service, route, path, auth, and positive numeric contracts', () => {
    expect(errorSummary({
      auth: { enabled: true, tokens: ['', 42] },
      services: [{
        id: IDS.service,
        name: 'primary',
        endpoints: [],
        timeouts: { connect_ms: 0, send_ms: -1, read_ms: 0 },
        health_check: { enabled: true, interval_ms: 0, timeout_ms: -1 },
        failover: { enabled: true, recovery: { backoff_base_ms: 0, probe_timeout_ms: -1 } },
      }],
      routes: [{
        id: IDS.route,
        path: 'missing-slash',
        endpoints: [{
          id: IDS.upstream,
          target: 'ftp://example.com',
          weight: 0,
          priority: 0,
        }],
        auth: 'enabled',
        timeouts: { request_ms: 0 },
      }, {
        id: '20000000-0000-4000-8000-000000000002',
        path: '/empty',
        direct_response: { enabled: false, status: 200 },
        redirect: { enabled: false, url: '/next' },
        response_rules: [{ enabled: false, path: '/', type: 'direct_response' }],
      }],
    })).toEqual([
      { code: 'invalid_auth', path: 'auth.tokens[0]' },
      { code: 'invalid_auth', path: 'auth.tokens[1]' },
      { code: 'empty_service', path: 'services[0].endpoints' },
      { code: 'invalid_positive_number', path: 'services[0].timeouts.connect_ms' },
      { code: 'invalid_positive_number', path: 'services[0].timeouts.send_ms' },
      { code: 'invalid_positive_number', path: 'services[0].timeouts.read_ms' },
      { code: 'invalid_positive_number', path: 'services[0].health_check.interval_ms' },
      { code: 'invalid_positive_number', path: 'services[0].health_check.timeout_ms' },
      { code: 'invalid_positive_number', path: 'services[0].failover.recovery.backoff_base_ms' },
      { code: 'invalid_positive_number', path: 'services[0].failover.recovery.probe_timeout_ms' },
      { code: 'invalid_path', path: 'routes[0].path' },
      { code: 'invalid_type', path: 'routes[0].auth' },
      { code: 'invalid_positive_number', path: 'routes[0].timeouts.request_ms' },
      { code: 'invalid_url', path: 'routes[0].endpoints[0].target' },
      { code: 'invalid_positive_number', path: 'routes[0].endpoints[0].weight' },
      { code: 'invalid_positive_number', path: 'routes[0].endpoints[0].priority' },
      { code: 'missing_route_target', path: 'routes[1]' },
    ]);
  });

  test('accepts every legal direct route bypass', () => {
    const routes = [
      { direct_response: { enabled: true, status: 200 } },
      { redirect: { enabled: true, url: 'https://example.com' } },
      { response_rules: [{ enabled: true, path: '/', type: 'direct_response', status: 200 }] },
    ].map((policy, index) => ({
      id: `20000000-0000-4000-8000-00000000000${index + 1}`,
      path: `/route-${index}`,
      ...policy,
    }));
    expect(parseNormalizeCompile({ routes }).ok).toBe(true);
  });

  test('validates load balancing and parses expression syntax without executing it', () => {
    globalThis.__configCompilerProbe = 0;
    expect(errorSummary({
      services: [{
        id: IDS.service,
        name: 'primary',
        endpoints: [{
          id: IDS.upstream,
          target: 'https://example.com',
          condition: '{{ body.model === }}',
        }],
        load_balancing: {
          policy: 'consistent_hash',
          hash_policy: { expression: '{{ globalThis.__configCompilerProbe = 1 }}' },
        },
      }, {
        id: '10000000-0000-4000-8000-000000000002',
        name: 'bad-policy',
        endpoints: [{
          id: '30000000-0000-4000-8000-000000000002',
          target: 'https://example.com',
        }],
        load_balancing: { policy: 'random' },
      }],
      routes: [{
        id: IDS.route,
        path: '/rate',
        service_id: IDS.service,
        rate_limit: { enabled: true, key_expression: '{{ headers[ }}' },
      }],
    })).toEqual([
      { code: 'invalid_expression', path: 'services[0].load_balancing.hash_policy.expression' },
      { code: 'invalid_expression', path: 'services[0].endpoints[0].condition' },
      { code: 'invalid_load_balancing', path: 'services[1].load_balancing.policy' },
      { code: 'invalid_expression', path: 'routes[0].rate_limit.key_expression' },
    ]);
    expect(globalThis.__configCompilerProbe).toBe(0);
  });

  test('requires consistent hash input and validates plugin catalog schemas', () => {
    expect(errorSummary({
      plugins: [
        { id: IDS.binding, name: '' },
        { id: 'abcdefab-cdef-4abc-8def-abcdefabcdea', name: 'missing' },
        {
          id: 'abcdefab-cdef-4abc-8def-abcdefabcdeb',
          name: 'audit',
          options: { level: 'verbose', extra: true },
        },
      ],
      services: [{
        id: IDS.service,
        name: 'primary',
        endpoints: [{ id: IDS.upstream, target: 'https://example.com' }],
        load_balancing: { policy: 'consistent_hash', hash_policy: { header: '' } },
      }],
    }, PLUGINS)).toEqual([
      { code: 'invalid_value', path: 'plugins[0].name' },
      { code: 'unknown_plugin', path: 'plugins[0].name' },
      { code: 'unknown_plugin', path: 'plugins[1].name' },
      { code: 'invalid_plugin_option', path: 'plugins[2].options.level' },
      { code: 'unknown_field', path: 'plugins[2].options.extra' },
      { code: 'invalid_load_balancing', path: 'services[0].load_balancing.hash_policy' },
    ]);
  });

  test('rejects binding names outside the activation grammar even when catalogued', () => {
    // Given / When
    const result = parseNormalizeCompile({
      plugins: [{ id: IDS.binding, name: 'Bad Name' }],
    }, { pluginSchemas: new Map([['Bad Name', []]]) });

    // Then
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ code, path }) => ({ code: String(code), path }))).toContainEqual({
        code: 'invalid_value', path: 'plugins[0].name',
      });
    }
  });

  test('uses available plugin names for logical bindings when supplied', () => {
    expect(errorSummary({
      plugins: [{ id: IDS.binding, name: 'schema-only' }],
    }, {
      pluginSchemas: new Map([['schema-only', []], ['installed-empty', []]]),
      availablePlugins: new Set(['installed-empty']),
    })).toEqual([{ code: 'unknown_plugin', path: 'plugins[0].name' }]);

    expect(parseNormalizeCompile({
      plugins: [{ id: IDS.binding, name: 'installed-empty' }],
    }, {
      pluginSchemas: new Map([['installed-empty', []]]),
      availablePlugins: new Set(['installed-empty']),
    }).ok).toBe(true);
  });

  test('rejects unknown fields on known v2 structures', () => {
    expect(errorSummary({
      mystery: true,
      routes: [{
        id: IDS.route,
        path: '/direct',
        direct_response: { enabled: true, status: 200 },
        mystery: true,
      }],
    })).toEqual([
      { code: 'unknown_field', path: 'mystery' },
      { code: 'unknown_field', path: 'routes[0].mystery' },
    ]);
  });

  test('rejects explicit undefined and malformed known nested policy fields', () => {
    expect(errorSummary({
      auth: { enabled: false, tokens: [42], mystery: true },
      services: [{
        id: IDS.service,
        name: 'primary',
        endpoints: [{ id: IDS.upstream, target: 'https://example.com' }],
        health_check: { enabled: 'yes', mystery: true },
        failover: { enabled: 'yes', recovery: 'soon' },
        load_balancing: 'round_robin',
      }],
      routes: [{
        id: IDS.route,
        path: '/direct',
        direct_response: { enabled: true, status: 200, mystery: true },
        retry: { enabled: true, max_retries: 'three' },
      }],
    })).toEqual([
      { code: 'unknown_field', path: 'auth.mystery' },
      { code: 'invalid_auth', path: 'auth.tokens[0]' },
      { code: 'unknown_field', path: 'services[0].health_check.mystery' },
      { code: 'invalid_type', path: 'services[0].health_check.enabled' },
      { code: 'invalid_type', path: 'services[0].failover.enabled' },
      { code: 'invalid_type', path: 'services[0].failover.recovery' },
      { code: 'invalid_type', path: 'services[0].load_balancing' },
      { code: 'unknown_field', path: 'routes[0].direct_response.mystery' },
      { code: 'invalid_type', path: 'routes[0].retry.max_retries' },
    ]);
  });

  test('uses a syntax parser for expressions and validates JSON plugin fields', () => {
    const catalog: ConfigurationCompileOptions = {
      pluginSchemas: new Map([
        ['json-plugin', [{ name: 'payload', type: 'json', label: 'Payload', required: true }]],
      ]),
    };
    expect(errorSummary({
      plugins: [{
        id: IDS.binding,
        name: 'json-plugin',
        options: { payload: '{broken' },
      }],
      services: [{
        id: IDS.service,
        name: 'primary',
        endpoints: [{
          id: IDS.upstream,
          target: 'https://example.com',
          condition: '{{ body..model === "gpt" }}',
        }],
        load_balancing: {
          policy: 'consistent_hash',
          hash_policy: { expression: '{{ headers["x-id"] ? headers["x-id"] : }}' },
        },
      }],
    }, catalog)).toEqual([
      { code: 'invalid_plugin_option', path: 'plugins[0].options.payload' },
      { code: 'invalid_expression', path: 'services[0].load_balancing.hash_policy.expression' },
      { code: 'invalid_expression', path: 'services[0].endpoints[0].condition' },
    ]);
  });

  test('does not mutate or reuse mutable input objects', () => {
    const input = {
      services: [{
        id: IDS.service,
        name: 'primary',
        endpoints: [{ id: IDS.upstream, target: 'https://example.com' }],
      }],
      routes: [] as unknown[],
    };
    const before = structuredClone(input);
    const result = parseNormalizeCompile(input);

    expect(input).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(input);
    expect(result.value.services).not.toBe(input.services);
    expect(result.value.services[0]).not.toBe(input.services[0]);
  });
});
