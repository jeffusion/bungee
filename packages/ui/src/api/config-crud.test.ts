import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { RoutesAPI } from './routes';
import { ServicesAPI, ServiceStaleError } from './services';
import { ManagedBindingError, toEditorService } from './config-adapters';
import { ConfigurationStaleError } from './config';
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

function mockControlApi(requests: Request[], current = aggregate): void {
  const responses = [
    Response.json({ config: current, revision: 4, content_hash: 'sha256:before' }),
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
  test('captures a persisted baseline independently of mutable editor options', async () => {
    const requests: Request[] = [];
    mockControlApi(requests);
    const loaded = (await ServicesAPI.getForEdit('alpha'))!;
    const plugin = loaded.service.plugins![0];
    if (typeof plugin === 'string' || !plugin?.options) throw new Error('Expected plugin options');
    plugin.options.sample = 1;
    loaded.service.endpoints[0]!.target = 'https://draft.example.com';
    expect(loaded.baseline).toEqual(aggregate.logical_configuration.services[0]!);
  });

  test.each(['name', 'endpoint', 'plugin', 'managedBy'] as const)('rejects a stale form after a persisted %s change without writing or mutating the draft', async (field) => {
    const baseline = aggregate.logical_configuration.services[0]!;
    const changed = structuredClone(baseline);
    const replacement = field === 'name' ? { ...changed, name: 'renamed-elsewhere' }
      : field === 'plugin' ? { ...changed, plugins: [{ ...changed.plugins[0]!, options: { sample: 1 } }] }
      : { ...changed, endpoints: [{ ...changed.endpoints[0]!, ...(field === 'endpoint'
        ? { target: 'https://other.example.com' }
        : { managedBy: { plugin: changed.endpoints[0]!.plugins[0]!.name, contributionId: 'upstream', bindingId: changed.endpoints[0]!.plugins[0]!.id } }) }] };
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [replacement] } });
    const draft = { ...toEditorService(baseline), name: 'my-draft' };
    const before = structuredClone(draft);
    await expect(ServicesAPI.update('alpha', draft, baseline)).rejects.toBeInstanceOf(ServiceStaleError);
    expect(draft).toEqual(before);
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });

  test.each([false, true])('rejects a deleted service even if its name is reused: %s', async (reuseName) => {
    const baseline = aggregate.logical_configuration.services[0]!;
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: {
      ...aggregate.logical_configuration, services: reuseName ? [{ ...baseline, id: 'new-service-id' }] : [],
    } });
    await expect(ServicesAPI.update('alpha', toEditorService(baseline), baseline)).rejects.toMatchObject({ reason: 'deleted' });
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });

  test.each(['remote', 'draft'] as const)('rejects an invalid %s management binding without writing or mutating the draft', async (source) => {
    const baseline = aggregate.logical_configuration.services[0]!;
    const invalidMarker = { plugin: 'missing-owner', contributionId: 'upstream', bindingId: 'missing-binding' };
    const current = source === 'remote'
      ? { ...baseline, endpoints: [{ ...baseline.endpoints[0]!, managedBy: invalidMarker }] }
      : baseline;
    const draft = toEditorService(baseline);
    if (source === 'draft') draft.endpoints[0]!.managedBy = invalidMarker;
    const before = structuredClone(draft);
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [current] } });
    await expect(ServicesAPI.update('alpha', draft, baseline)).rejects.toBeInstanceOf(ManagedBindingError);
    expect(draft).toEqual(before);
    expect(requests.map(request => request.method)).toEqual(['GET']);
  });

  test('preserves unrelated service changes and uses the latest snapshot CAS', async () => {
    const baseline = aggregate.logical_configuration.services[0]!;
    const unrelated = { ...baseline, id: 'other-id', name: 'other', position: 1 };
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [baseline, unrelated] } });
    await ServicesAPI.update('alpha', { ...toEditorService(baseline), name: 'draft' }, baseline);
    const body = await requests[1]!.json();
    expect(body.expected_revision).toBe(4);
    expect(body.aggregate.logical_configuration.services[1]).toEqual(unrelated);
    expect(body.aggregate.logical_configuration.services[0].name).toBe('draft');
  });

  test('returns the created stable service identity only after configuration convergence', async () => {
    const requests: Request[] = [];
    mockControlApi(requests);
    const saved = await ServicesAPI.create({ name: 'created-service', endpoints: [{ target: 'https://created.example.test', weight: 100, priority: 1 }] });
    const body = await requests[1]!.json();
    expect(saved.id).toBe(body.aggregate.logical_configuration.services.at(-1).id);
    expect(saved.name).toBe('created-service');
    expect(requests.map(request => request.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  test('leaves a save-time CAS conflict to the editor without an automatic overwrite or retry', async () => {
    const requests: Request[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://ui.test'), init);
        requests.push(request);
        return request.method === 'GET'
          ? Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' })
          : Response.json({ error: 'stale_revision' }, { status: 409 });
      },
    });
    const baseline = aggregate.logical_configuration.services[0]!;
    await expect(ServicesAPI.update('alpha', toEditorService(baseline), baseline)).rejects.toBeInstanceOf(ConfigurationStaleError);
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT']);
  });

  test('ignores editor-only fields and runtime health but compares plugin option content independent of key order', async () => {
    const original = aggregate.logical_configuration.services[0]!;
    const baseline = { ...original, plugins: [{ ...original.plugins[0]!, options: { a: 1, b: 2 } }] };
    const decorated = { ...baseline, description: 'not persisted', _uid: 'ui-only',
      plugins: [{ ...baseline.plugins[0]!, options: { b: 2, a: 1 } }],
      endpoints: [{ ...baseline.endpoints[0]!, status: 'UNHEALTHY', consecutive_failures: 9 }],
    };
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [decorated] } });
    await ServicesAPI.update('alpha', toEditorService(baseline), baseline);
    const body = await requests[1]!.json();
    expect(body.aggregate.logical_configuration.services[0].endpoints[0].status).toBeUndefined();
    expect(body.aggregate.logical_configuration.services[0].description).toBeUndefined();
  });

  test('reload follows the stable id after rename, never a replacement with the old name', async () => {
    const baseline = aggregate.logical_configuration.services[0]!;
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration,
      services: [{ ...baseline, id: 'replacement-id' }, { ...baseline, name: 'renamed' }],
    } });
    const loaded = (await ServicesAPI.getForEdit('alpha', baseline.id))!;
    expect(loaded.service.name).toBe('renamed');
    expect(loaded.baseline.id).toBe(baseline.id);
  });

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
    }, aggregate.logical_configuration.services[0]!);

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
    }, aggregate.logical_configuration.services[0]!);

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
