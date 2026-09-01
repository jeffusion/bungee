import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { RoutesAPI } from './routes';
import { ServicesAPI } from './services';
import type { EditorRoute, EditorUpstream } from './config-adapters';

const aggregate: ConfigurationAggregateV2 = {
  logical_configuration: {
    auth: { enabled: false, tokens: [] },
    plugins: [],
    services: [{
      id: 'service-id',
      position: 0,
      name: 'alpha',
      endpoints: [{
        id: 'endpoint-id',
        position: 0,
        target: 'https://alpha.example.com',
        weight: 100,
        priority: 1,
        is_disabled: false,
        plugins: [{
          id: 'endpoint-plugin-id', position: 3, name: 'endpoint-plugin', enabled: true,
          options: { mode: 'strict' },
        }],
      }],
      plugins: [{
        id: 'service-plugin-id', position: 4, name: 'service-plugin', enabled: true,
        options: { sample: 0.5 },
      }],
    }],
    routes: [{
      id: 'route-id',
      position: 0,
      path: '/alpha',
      service_id: 'service-id',
      plugins: [{
        id: 'route-plugin-id', position: 5, name: 'route-plugin', enabled: true,
        options: { tag: 'original' },
      }],
    }],
  },
  plugin_activations: [{ plugin_name: 'service-plugin' }],
};

const originalFetch = globalThis.fetch;

function mockControlApi(requests: Request[]): void {
  const responses = [
    Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' }),
    Response.json({
      operation_id: 'operation-id',
      revision: 5,
      operation: { state: 'committed', result_status: null, error_code: null },
      workers: [],
    }, { status: 202 }),
    Response.json({
      operation: { state: 'converged', result_status: 200, error_code: null },
      workers: [],
    }),
  ];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(new URL(String(input), 'http://ui.test'), init);
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected HTTP request');
      if (request.method === 'PUT') {
        const mutationId = (await request.clone().json()).mutation_id;
        const body = await response.json();
        return Response.json({ ...body, operation_id: mutationId,
          operation: { ...body.operation, mutation_id: mutationId } }, { status: response.status });
      }
      return response;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
});

describe('v2 route and service CRUD adapters', () => {
  test('does not depend on secure-context-only crypto.randomUUID', async () => {
    const configSource = await Bun.file(new URL('./config.ts', import.meta.url)).text();
    const adapterSource = await Bun.file(new URL('./config-adapters.ts', import.meta.url)).text();

    expect(configSource).not.toContain('crypto.randomUUID');
    expect(adapterSource).not.toContain('crypto.randomUUID');
    expect(configSource).toContain("from 'uuid'");
    expect(adapterSource).toContain("from 'uuid'");
  });

  test('renames a service without changing route, endpoint, or plugin identities', async () => {
    // Given
    const requests: Request[] = [];
    mockControlApi(requests);

    // When
    await ServicesAPI.update('alpha', {
      name: 'renamed',
      endpoints: [{
        target: 'https://alpha.example.com',
        weight: 100,
        priority: 1,
        headers: {
          add: { 'x-test': 'yes' },
          default: { legacy: 'must-not-persist' },
        } as unknown as NonNullable<EditorUpstream['headers']>,
        plugins: [{ name: 'endpoint-plugin', enabled: true }],
      }],
      plugins: [{ name: 'service-plugin', enabled: true }],
    });

    // Then
    const body = await requests[1]?.json();
    const logical = body.aggregate.logical_configuration;
    expect(logical.services[0]).toMatchObject({ id: 'service-id', name: 'renamed' });
    expect(logical.services[0].endpoints[0].id).toBe('endpoint-id');
    expect(logical.services[0].endpoints[0].position).toBe(0);
    expect(logical.services[0].endpoints[0].plugins[0].id).toBe('endpoint-plugin-id');
    expect(logical.services[0].endpoints[0].plugins[0]).toMatchObject({ position: 3, options: { mode: 'strict' } });
    expect(logical.services[0].endpoints[0].headers).toEqual({ add: { 'x-test': 'yes' } });
    expect(logical.services[0].plugins[0].id).toBe('service-plugin-id');
    expect(logical.services[0].plugins[0]).toMatchObject({ position: 4, options: { sample: 0.5 } });
    expect(logical.routes[0]).toMatchObject({ id: 'route-id', service_id: 'service-id' });
    expect(logical.routes[0].plugins[0]).toMatchObject({
      id: 'route-plugin-id', position: 5, options: { tag: 'original' },
    });
  });

  test('creates a service-backed route with durable v2 ids and no service-name alias', async () => {
    // Given
    const requests: Request[] = [];
    mockControlApi(requests);

    // When
    await RoutesAPI.create({
      path: '/new',
      service: 'alpha',
      headers: {
        remove: ['x-remove'],
        default: { legacy: 'must-not-persist' },
      } as unknown as NonNullable<EditorRoute['headers']>,
      plugins: [{ name: 'route-plugin' }],
    });

    // Then
    const body = await requests[1]?.json();
    const created = body.aggregate.logical_configuration.routes[1];
    expect(created.id).toBeString();
    expect(created.position).toBe(1);
    expect(created.service_id).toBe('service-id');
    expect('service' in created).toBe(false);
    expect(created.headers).toEqual({ remove: ['x-remove'] });
    expect(created.plugins[0]).toMatchObject({ position: 0, name: 'route-plugin', enabled: true });
    expect(created.plugins[0].id).toBeString();
  });

  test('changes an endpoint target without changing its v2 or nested plugin identity', async () => {
    // Given
    const requests: Request[] = [];
    mockControlApi(requests);

    // When
    await ServicesAPI.update('alpha', {
      name: 'alpha',
      endpoints: [{
        _uid: 'endpoint-id',
        _position: 0,
        target: 'https://changed.example.com',
        weight: 100,
        priority: 1,
        plugins: [{ _uid: 'endpoint-plugin-id', _position: 3, name: 'endpoint-plugin', enabled: true }],
      }],
      plugins: [{ _uid: 'service-plugin-id', _position: 4, name: 'service-plugin', enabled: true }],
    });

    // Then
    const body = await requests[1]?.json();
    const endpoint = body.aggregate.logical_configuration.services[0].endpoints[0];
    expect(endpoint).toMatchObject({
      id: 'endpoint-id',
      position: 0,
      target: 'https://changed.example.com',
    });
    expect(endpoint.plugins[0]).toMatchObject({ id: 'endpoint-plugin-id', position: 3 });
  });
});
