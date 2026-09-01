import { describe, expect, test } from 'bun:test';
import type {
  CommittedConfigurationSnapshotV2,
  RouteV2,
  ServiceRouteV2,
} from '@jeffusion/bungee-types';
import type { RepositorySnapshot } from '../../src/config-storage';
import {
  compileRuntimeConfigSnapshot,
  parseNormalizeCompileAggregate,
  RuntimeConfigCompileError,
} from '../../src/config-storage';

const ID = {
  service: '10000000-0000-4000-8000-000000000001',
  routeService: '20000000-0000-4000-8000-000000000001', routeDirect: '20000000-0000-4000-8000-000000000002',
  upstreamA: '30000000-0000-4000-8000-000000000001', upstreamB: '30000000-0000-4000-8000-000000000002',
  directUpstream: '30000000-0000-4000-8000-000000000003',
  globalBinding: '40000000-0000-4000-8000-000000000001', serviceBinding: '40000000-0000-4000-8000-000000000002',
  routeBinding: '40000000-0000-4000-8000-000000000003', upstreamBindingA: '40000000-0000-4000-8000-000000000004',
  upstreamBindingB: '40000000-0000-4000-8000-000000000005',
  inactiveBinding: '40000000-0000-4000-8000-000000000006',
} as const;

function snapshot(input: unknown, revision = 17): CommittedConfigurationSnapshotV2 {
  const result = parseNormalizeCompileAggregate(input);
  if (!result.ok) throw new Error(`invalid test fixture: ${result.errors[0]?.path ?? 'unknown'}`);
  return { revision, content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    aggregate: result.value };
}

function fullSnapshot(): CommittedConfigurationSnapshotV2 {
  return snapshot({
    logical_configuration: {
      log_level: 'warn',
      body_parser_limit: '3mb',
      auth: { enabled: true, tokens: ['secret'] },
      logging: { body: { enabled: true, max_size: 2048, retention_days: 9 } },
      plugins: [
        { id: ID.inactiveBinding, position: 9, name: 'inactive-plugin', enabled: true },
        { id: ID.globalBinding, position: 2, name: 'active-plugin', options: { scope: 'global' }, enabled: true },
      ],
      services: [{ id: '10000000-0000-4000-8000-000000000002', position: 1, name: 'auxiliary',
        endpoints: [{ id: '30000000-0000-4000-8000-000000000004', target: 'https://aux.example' }] }, {
        id: ID.service,
        position: 7,
        name: 'primary',
        health_check: { enabled: true, interval_ms: 1000, expected_status: [200, 204] },
        failover: { enabled: true, retry_on: [429, '5xx'], passive_health: { consecutive_failures: 2 } },
        load_balancing: { policy: 'consistent_hash', hash_policy: { header: 'x-key' } },
        timeouts: { connect_ms: 10, send_ms: 20, read_ms: 30 },
        plugins: [{ id: ID.serviceBinding, position: 3, name: 'active-plugin', options: { scope: 'service' }, enabled: false }],
        endpoints: [
          {
            id: ID.upstreamB,
            position: 8,
            target: 'https://same.example',
            weight: 20,
            priority: 2,
            is_disabled: true,
            description: 'secondary',
            condition: '{{ true }}',
            headers: { add: { 'x-upstream': 'b' } },
            body: { default: { model: 'b' } },
            query: { remove: ['debug'] },
            plugins: [{ id: ID.upstreamBindingB, position: 4, name: 'active-plugin', enabled: true }],
          },
          {
            id: ID.upstreamA,
            position: 1,
            target: 'https://same.example',
            weight: 80,
            priority: 1,
            is_disabled: false,
            plugins: [{ id: ID.upstreamBindingA, position: 5, name: 'active-plugin', options: { nested: { value: 1 } }, enabled: false }],
          },
        ],
      }],
      routes: [
        {
          id: ID.routeDirect,
          position: 6,
          path: '/direct',
          headers: { replace: { host: 'direct' } },
          body: { add: { stream: true } },
          query: { default: { version: '2' } },
          auth: { enabled: false, tokens: [] },
          timeouts: { request_ms: 900 },
          rate_limit: { enabled: true, requests_per_second: 4, burst: 8 },
          cors: { enabled: true, allowed_origins: ['https://client.example'] },
          response_rules: [{ enabled: true, path: '/cached', type: 'direct_response', status: 200 }],
          direct_response: { enabled: false, status: 200 },
          redirect: { enabled: false, url: 'https://redirect.example' },
          retry: { enabled: true, max_retries: 2, retry_on: [500] },
          plugins: [],
          endpoints: [{ id: ID.directUpstream, target: 'https://direct.example', plugins: [] }],
        },
        {
          id: ID.routeService,
          position: 2,
          path: '/service',
          service_id: ID.service,
          path_rewrite: { '^/service': '/v1' },
          plugins: [{ id: ID.routeBinding, position: 1, name: 'active-plugin', options: { scope: 'route' }, enabled: true }],
        },
      ],
    },
    plugin_activations: [{ plugin_name: 'installed-only' }, { plugin_name: 'active-plugin' }],
  });
}

function isServiceRoute(route: RouteV2): route is ServiceRouteV2 {
  return route.service_id !== undefined;
}

describe('compileRuntimeConfigSnapshot', () => {
  test('accepts the committed snapshot contract and creates the minimal V4 config', () => {
    const input = snapshot({ logical_configuration: {}, plugin_activations: [] }, 1);
    const output = compileRuntimeConfigSnapshot(input);

    expect(output).toEqual({
      revision: 1,
      content_hash: input.content_hash,
      config: { config_version: 4, routes: [] },
    });
    expect(output.config.auth).toBeUndefined(); expect(output.config.plugins).toBeUndefined();
    expect(output.config.services).toBeUndefined();
  });

  test('remains structurally compatible with repository snapshots', () => {
    const committed = snapshot({ logical_configuration: {}, plugin_activations: [] }, 2);
    const repository: RepositorySnapshot = committed;

    const output = compileRuntimeConfigSnapshot(repository);

    expect(output).toEqual({
      revision: 2,
      content_hash: repository.content_hash,
      config: { config_version: 4, routes: [] },
    });
  });

  test('maps ordered services, routes, upstream identity, and every policy without persistence fields', () => {
    const output = compileRuntimeConfigSnapshot(fullSnapshot());
    const service = output.config.services?.find(({ name }) => name === 'primary');
    const serviceRoute = output.config.routes[0];
    const directRoute = output.config.routes[1];

    expect(service?.name).toBe('primary');
    expect(output.config.services?.map(({ name }) => name)).toEqual(['auxiliary', 'primary']);
    expect(output.config).toMatchObject({
      config_version: 4,
      log_level: 'warn',
      body_parser_limit: '3mb',
      auth: { enabled: true, tokens: ['secret'] },
      logging: { body: { enabled: true, max_size: 2048, retention_days: 9 } },
    });
    expect(service?.endpoints.map(({ id }) => id)).toEqual([ID.upstreamA, ID.upstreamB]);
    expect(service?.endpoints.map(({ target }) => target)).toEqual(['https://same.example', 'https://same.example']);
    expect(service?.endpoints[1]).toMatchObject({
      id: ID.upstreamB, weight: 20, priority: 2, is_disabled: true,
      description: 'secondary', condition: '{{ true }}',
      headers: { add: { 'x-upstream': 'b' } }, body: { default: { model: 'b' } }, query: { remove: ['debug'] },
    });
    expect(service).toMatchObject({
      health_check: { enabled: true, interval_ms: 1000, expected_status: [200, 204] },
      failover: { enabled: true, retry_on: [429, '5xx'], passive_health: { consecutive_failures: 2 } },
      load_balancing: { policy: 'consistent_hash', hash_policy: { header: 'x-key' } },
      timeouts: { connect_ms: 10, send_ms: 20, read_ms: 30 },
    });
    expect(serviceRoute).toMatchObject({ path: '/service', service: 'primary', path_rewrite: { '^/service': '/v1' } });
    expect(directRoute).toMatchObject({
      path: '/direct', endpoints: [{ id: ID.directUpstream, target: 'https://direct.example' }],
      headers: { replace: { host: 'direct' } }, body: { add: { stream: true } },
      query: { default: { version: '2' } }, auth: { enabled: false, tokens: [] },
      timeouts: { request_ms: 900 }, rate_limit: { enabled: true, requests_per_second: 4, burst: 8 },
      cors: { enabled: true, allowed_origins: ['https://client.example'] },
      response_rules: [{ enabled: true, path: '/cached', type: 'direct_response', status: 200 }],
      direct_response: { enabled: false, status: 200 }, redirect: { enabled: false, url: 'https://redirect.example' },
      retry: { enabled: true, max_retries: 2, retry_on: [500] },
    });
    expect(JSON.stringify(output.config)).not.toMatch(/service_id|position|plugin_activations/);
    expect(Object.keys(service ?? {})).not.toContain('id');
  });

  test('filters bindings by activation while preserving scope order, enabled overrides, and owned options', () => {
    const input = fullSnapshot();
    const before = structuredClone(input);
    const output = compileRuntimeConfigSnapshot(input);
    const service = output.config.services?.find(({ name }) => name === 'primary');

    expect(input).toEqual(before);
    expect(structuredClone(output)).toEqual(output);
    expect(Object.getPrototypeOf(output.config)).toBe(Object.prototype);
    expect(output.config.plugins).toEqual([{ name: 'active-plugin', options: { scope: 'global' }, enabled: true }]);
    expect(service?.plugins).toEqual([{ name: 'active-plugin', options: { scope: 'service' }, enabled: false }]);
    expect(output.config.routes[0]?.plugins).toEqual([{ name: 'active-plugin', options: { scope: 'route' }, enabled: true }]);
    expect(service?.endpoints[0]?.plugins).toEqual([
      { name: 'active-plugin', options: { nested: { value: 1 } }, enabled: false },
    ]);
    expect(service?.endpoints[1]?.plugins).toEqual([{ name: 'active-plugin', enabled: true }]);
    expect(JSON.stringify(output.config)).not.toContain('inactive-plugin');
    expect(JSON.stringify(output.config)).not.toContain('installed-only');

    output.config.auth?.tokens.push('output-only');
    const outputOptions = output.config.plugins?.[0];
    if (typeof outputOptions !== 'string' && outputOptions?.options) outputOptions.options.scope = 'changed';
    expect(input.aggregate.logical_configuration.auth?.tokens).toEqual(['secret']);
    expect(input.aggregate.logical_configuration.plugins[0]?.options).toEqual({ scope: 'global' });

    input.aggregate.logical_configuration.auth?.tokens.push('input-only');
    const inputOptions = input.aggregate.logical_configuration.plugins[0]?.options;
    if (inputOptions) inputOptions.scope = 'input-changed';
    expect(output.config.auth?.tokens).toEqual(['secret', 'output-only']);
    expect(output.config.plugins).toEqual([{ name: 'active-plugin', options: { scope: 'changed' }, enabled: true }]);
  });

  test('orders emitted bindings by canonical position independently of activation order', () => {
    const input = snapshot({
      logical_configuration: {
        plugins: [
          { id: ID.globalBinding, position: 9, name: 'active-plugin', enabled: true },
          { id: ID.inactiveBinding, position: 1, name: 'installed-only', enabled: false },
        ],
      },
      plugin_activations: [{ plugin_name: 'active-plugin' }, { plugin_name: 'installed-only' }],
    });

    expect(compileRuntimeConfigSnapshot(input).config.plugins).toEqual([
      { name: 'installed-only', enabled: false },
      { name: 'active-plugin', enabled: true },
    ]);
  });

  test('rejects inconsistent direct snapshots with typed errors', () => {
    const valid = fullSnapshot();
    const duplicateActivation: CommittedConfigurationSnapshotV2 = {
      ...valid,
      aggregate: {
        ...valid.aggregate,
        plugin_activations: [...valid.aggregate.plugin_activations, { plugin_name: 'active-plugin' }],
      },
    };
    expect(() => compileRuntimeConfigSnapshot(duplicateActivation)).toThrow(RuntimeConfigCompileError);
    expect(() => compileRuntimeConfigSnapshot(duplicateActivation)).toThrow('duplicate plugin activation');

    const serviceRoute = valid.aggregate.logical_configuration.routes.find(isServiceRoute);
    if (!serviceRoute) throw new Error('missing service route fixture');
    const unknownService: CommittedConfigurationSnapshotV2 = {
      ...valid,
      aggregate: {
        ...valid.aggregate,
        logical_configuration: {
          ...valid.aggregate.logical_configuration,
          routes: [{
            ...serviceRoute,
            service_id: '90000000-0000-4000-8000-000000000009',
          }],
        },
      },
    };
    expect(() => compileRuntimeConfigSnapshot(unknownService)).toThrow(RuntimeConfigCompileError);
    expect(() => compileRuntimeConfigSnapshot(unknownService)).toThrow('unknown service');
  });
});
