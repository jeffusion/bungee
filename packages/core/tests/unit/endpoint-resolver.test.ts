import { describe, expect, test } from 'bun:test';
import type { Endpoint, PluginConfig, Service } from '@jeffusion/bungee-types';
import {
  deepMergeEndpoint,
  extractModificationRules,
  mergePluginArrays,
  resolveEffectiveRouteEndpoints,
} from '../../src/utils/endpoint-resolver';

describe('mergePluginArrays', () => {
  test('lets same-name override plugins replace base plugins', () => {
    const base: PluginConfig[] = [{ name: 'auth', options: { token: 'base' } }];
    const override: PluginConfig[] = [{ name: 'auth', options: { token: 'override' }, enabled: false }];

    expect(mergePluginArrays(base, override)).toEqual(override);
  });

  test('stacks different plugin names in base-first order', () => {
    expect(mergePluginArrays(['auth'], ['metrics'])).toEqual(['auth', 'metrics']);
  });

  test('compares mixed string and object plugin configs by name while preserving override format', () => {
    expect(mergePluginArrays(['auth', { name: 'cache', options: { ttl: 30 } }], [{ name: 'auth', options: { token: 'override' } }, 'metrics'])).toEqual([
      { name: 'auth', options: { token: 'override' } },
      { name: 'cache', options: { ttl: 30 } },
      'metrics',
    ]);
  });

  test('handles empty and undefined plugin arrays', () => {
    expect(mergePluginArrays(undefined, undefined)).toBeUndefined();
    expect(mergePluginArrays([], [])).toEqual([]);
    expect(mergePluginArrays([], undefined)).toEqual([]);
    expect(mergePluginArrays(undefined, ['auth'])).toEqual(['auth']);
  });
});

describe('deepMergeEndpoint', () => {
  test('shallow-overrides scalar fields', () => {
    const merged = deepMergeEndpoint(
      {
        id: 'base',
        target: 'http://same',
        weight: 10,
        priority: 3,
        is_disabled: false,
        description: 'base endpoint',
        condition: '${base}',
      },
      {
        id: 'override',
        target: 'http://same',
        weight: 20,
        priority: 1,
        is_disabled: true,
        description: 'override endpoint',
        condition: '${override}',
      },
    );

    expect(merged).toMatchObject({
      id: 'override',
      target: 'http://same',
      weight: 20,
      priority: 1,
      is_disabled: true,
      description: 'override endpoint',
      condition: '${override}',
    });
  });

  test('deep-merges endpoint plugins independently of scalar fields', () => {
    const merged = deepMergeEndpoint(
      { target: 'http://same', plugins: ['auth', { name: 'cache', options: { ttl: 30 } }] },
      { target: 'http://same', plugins: [{ name: 'auth', options: { token: 'override' } }, 'metrics'] },
    );

    expect(merged.plugins).toEqual([
      { name: 'auth', options: { token: 'override' } },
      { name: 'cache', options: { ttl: 30 } },
      'metrics',
    ]);
  });

  test('deep-merges headers, body, and query modification rules independently', () => {
    const merged = deepMergeEndpoint(
      {
        target: 'http://same',
        request: { headers: { add: { 'x-base': '1' }, remove: ['x-remove-base'] },
        body: { add: { base: true }, remove: ['legacy'] },
        query: { default: { base: '1' }, remove: ['old'] }, },
      },
      {
        target: 'http://same',
        request: { headers: { replace: { 'x-override': '2' }, remove: ['x-remove-base', 'x-remove-override'] },
        body: { replace: { override: true }, remove: ['override-only'] },
        query: { add: { override: '2' }, remove: ['old', 'new'] }, },
      },
    );

    expect(merged.request?.headers).toEqual({
      add: { 'x-base': '1' },
      replace: { 'x-override': '2' },
      remove: ['x-remove-base', 'x-remove-override'],
    });
    expect(merged.request?.body).toEqual({
      add: { base: true },
      replace: { override: true },
      remove: ['legacy', 'override-only'],
    });
    expect(merged.request?.query).toEqual({
      default: { base: '1' },
      add: { override: '2' },
      remove: ['old', 'new'],
    });
  });
});

describe('resolveEffectiveRouteEndpoints', () => {
  test('keeps different endpoint IDs independent even when their targets match', () => {
    const serviceEndpoint: Endpoint = { id: 'free', target: 'https://chatgpt.com', plugins: [{ name: 'chatgpt-oauth', options: { accountRef: 'free' } }] };
    const routeEndpoint: Endpoint = { id: 'paid', target: 'https://chatgpt.com', plugins: [{ name: 'chatgpt-oauth', options: { accountRef: 'paid' } }] };

    expect(resolveEffectiveRouteEndpoints(
      { path: '/codex/', service: 'openai', endpoints: [routeEndpoint] },
      [{ name: 'openai', endpoints: [serviceEndpoint] }],
    )).toEqual([serviceEndpoint, routeEndpoint]);
  });

  test('matches overrides by endpoint ID even when the target changes', () => {
    const services: Service[] = [{ name: 'openai', endpoints: [
      { id: 'free', target: 'https://chatgpt.com', weight: 10, plugins: ['free-plugin'] },
      { id: 'paid', target: 'https://chatgpt.com', plugins: ['paid-plugin'] },
    ] }];
    const endpoints = resolveEffectiveRouteEndpoints(
      { path: '/codex/', service: 'openai', endpoints: [{ id: 'paid', target: 'https://other.test', weight: 20 }] },
      services,
    );

    expect(endpoints).toEqual([
      services[0].endpoints[0],
      { id: 'paid', target: 'https://other.test', weight: 20, plugins: ['paid-plugin'] },
    ]);
  });

  test('preserves same-target account identities when resolved endpoints are supplied again', () => {
    const services: Service[] = [{ name: 'openai', endpoints: [
      { id: 'free', target: 'https://chatgpt.com', plugins: [{ name: 'chatgpt-oauth', options: { accountRef: 'free' } }] },
      { id: 'paid', target: 'https://chatgpt.com', plugins: [{ name: 'chatgpt-oauth', options: { accountRef: 'paid' } }] },
    ] }];
    const endpoints = resolveEffectiveRouteEndpoints({ path: '/codex/', service: 'openai' }, services);

    for (const supplied of [endpoints, [...endpoints].reverse()]) {
      expect(resolveEffectiveRouteEndpoints(
        { path: '/codex/', service: 'openai', endpoints: supplied },
        services,
      )).toEqual(endpoints);
    }
  });

  test('does not apply ID-less URL overrides to identified account endpoints', () => {
    const endpoints: Endpoint[] = [
      { id: 'free', target: 'https://chatgpt.com' },
      { id: 'paid', target: 'https://chatgpt.com' },
    ];
    const routeEndpoint: Endpoint = { target: 'https://chatgpt.com', plugins: ['route-plugin'] };
    expect(resolveEffectiveRouteEndpoints(
      { path: '/codex/', service: 'openai', endpoints: [routeEndpoint] },
      [{ name: 'openai', endpoints }],
    )).toEqual([...endpoints, routeEndpoint]);
  });

  test('returns route endpoints when referenced service does not exist', () => {
    const routeEndpoint: Endpoint = { target: 'http://route-only' };

    expect(resolveEffectiveRouteEndpoints({ path: '/api', service: 'missing', endpoints: [routeEndpoint] }, [])).toEqual([routeEndpoint]);
  });

  test('deep-merges service endpoints with same-target route endpoint overrides', () => {
    const services: Service[] = [
      {
        name: 'api-service',
        endpoints: [
          {
            target: 'http://same',
            weight: 10,
            priority: 3,
            plugins: ['service-auth', { name: 'shared', options: { value: 'service' } }],
            request: { headers: { add: { 'x-service': '1' }, remove: ['x-old'] },
            body: { add: { service: true } }, },
          },
          { target: 'http://service-only', plugins: ['service-only'] },
        ],
      },
    ];

    const endpoints = resolveEffectiveRouteEndpoints(
      {
        path: '/api',
        service: 'api-service',
        endpoints: [
          {
            target: 'http://same',
            weight: 99,
            plugins: [{ name: 'shared', options: { value: 'route' } }, 'route-only'],
            request: { headers: { replace: { 'x-route': '2' }, remove: ['x-old', 'x-new'] },
            query: { add: { route: 'yes' } }, },
          },
          { target: 'http://route-only' },
        ],
      },
      services,
    );

    expect(endpoints).toEqual([
      {
        target: 'http://same',
        weight: 99,
        priority: 3,
        plugins: ['service-auth', { name: 'shared', options: { value: 'route' } }, 'route-only'],
        request: { headers: {
          add: { 'x-service': '1' },
          replace: { 'x-route': '2' },
          remove: ['x-old', 'x-new'],
        },
        body: { add: { service: true } },
        query: { add: { route: 'yes' } }, },
      },
      { target: 'http://service-only', plugins: ['service-only'] },
      { target: 'http://route-only' },
    ]);
  });
});

describe('extractModificationRules', () => {
  test('extracts only endpoint modification rule fields', () => {
    expect(extractModificationRules({
      target: 'http://same',
      plugins: ['auth'],
      request: { headers: { add: { 'x-test': '1' } },
      body: { add: { ok: true } },
      query: { add: { q: '1' } }, },
    })).toEqual({
      headers: { add: { 'x-test': '1' } },
      body: { add: { ok: true } },
      query: { add: { q: '1' } },
    });
  });
});

describe('Service plugins type', () => {
  test('accepts service-level plugins on the Service interface', () => {
    const service: Service = {
      name: 'api-service',
      plugins: ['service-auth', { name: 'service-metrics', options: { sample: true } }],
      endpoints: [{ target: 'http://upstream' }],
    };

    expect(service.plugins).toEqual(['service-auth', { name: 'service-metrics', options: { sample: true } }]);
  });
});
