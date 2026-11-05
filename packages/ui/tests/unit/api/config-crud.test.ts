import { serviceReference } from '../../helpers/service-references';
import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import { RouteStaleError, RoutesAPI } from '../../../src/api/routes';
import { ServicesAPI, ServiceStaleError } from '../../../src/api/services';
import { ManagedBindingError, toEditorRoute, toEditorService } from '../../../src/api/config-adapters';
import { ConfigurationStaleError, ConfigurationSubmissionUnknownError, ConfigurationValidationError } from '../../../src/api/config';
import { get } from 'svelte/store';
import { configurationWrite } from '../../../src/stores/configuration-write';

const aggregate: ConfigurationAggregate = {
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
      service_references: [serviceReference('service-id')],
      plugins: [{
        id: 'route-plugin-id', position: 5, name: 'route-plugin', enabled: true,
        options: { tag: 'original' },
      }],
    }],
  },
  plugin_activations: [{ plugin_name: 'service-plugin' }],
};

const originalFetch = globalThis.fetch;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockControlApi(requests: Request[], current = aggregate, gate?: Promise<void>): void {
  const responses = [
    Response.json({ config: current, revision: 4, content_hash: 'sha256:before' }),
    Response.json({
      operation_id: 'operation-id',
      revision: 5,
      operation: { expected_revision: 4, committed_revision: 5, state: 'committed', result_status: null, error_code: null },
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
      if (gate !== undefined && request.method === 'GET') await gate;
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected HTTP request');
      if (request.method === 'PUT') {
        const mutationId = (await request.clone().json()).mutation_id;
        const body = await response.json();
        return Response.json({ ...body, operation_id: mutationId,
          operation: { ...body.operation, mutation_id: mutationId, committed_revision: body.revision } }, { status: response.status });
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

  test.each(['name', 'endpoint', 'plugin', 'managedBy', 'header'] as const)('rejects a stale form after a persisted %s change without writing or mutating the draft', async (field) => {
    const service = aggregate.logical_configuration.services[0]!;
    const baseline = field === 'header'
      ? { ...service, endpoints: [{ ...service.endpoints[0]!, request: { headers: { add: { 'x-test': 'before' } } } }] }
      : service;
    const changed = structuredClone(baseline);
    const replacement = field === 'name' ? { ...changed, name: 'renamed-elsewhere' }
      : field === 'plugin' ? { ...changed, plugins: [{ ...changed.plugins[0]!, options: { sample: 1 } }] }
      : field === 'header' ? { ...changed, endpoints: [{ ...changed.endpoints[0]!, request: { headers: { add: { 'x-test': 'after' } } } }] }
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

  test.each(['direct', 'service'] as const)('persists and reloads %s route first-response limit through the v2 adapter', async (target) => {
    const base = aggregate.logical_configuration.routes[0]!;
    const configured = target === 'service'
      ? { ...base, timeouts: { request_ms: 600_000, first_response_ms: 500_000 } }
      : { id: base.id, position: base.position, path: base.path, plugins: base.plugins,
        endpoints: aggregate.logical_configuration.services[0]!.endpoints,
        timeouts: { request_ms: 600_000, first_response_ms: 500_000 } };
    const logical = { ...aggregate.logical_configuration, routes: [configured] };
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: logical });
    const draft = toEditorRoute(configured, logical.services);
    expect(draft.timeouts?.first_response_ms).toBe(500_000);
    draft.timeouts = { request_ms: 700_000, first_response_ms: 700_000 };
    await RoutesAPI.update('/alpha', draft, configured);
    const payload = await requests[1]!.json();
    const persisted = payload.aggregate.logical_configuration.routes[0];
    expect(persisted.timeouts).toEqual({ request_ms: 700_000, first_response_ms: 700_000 });
    mockControlApi([], payload.aggregate);
    const reloaded = await RoutesAPI.getForEdit('/alpha');
    expect(reloaded?.route.timeouts).toEqual(draft.timeouts);
  });

  test('editing a service removes obsolete transport timeouts from the saved service', async () => {
    const base = aggregate.logical_configuration.services[0]!;
    const configured = { ...base, timeouts: { connect_ms: 9000 } };
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [configured] } });
    const draft = toEditorService(configured);
    expect('timeouts' in draft).toBe(false);
    await ServicesAPI.update(base.name, { ...draft, name: 'renamed' }, configured);
    const payload = await requests[1]!.json();
    expect(payload.aggregate.logical_configuration.services[0].timeouts).toBeUndefined();
    mockControlApi([], payload.aggregate);
    expect((await ServicesAPI.getForEdit('renamed'))?.service).not.toHaveProperty('timeouts');
  });

  test('the service adapter strips timeout fields even from an unexpected draft', async () => {
    const baseline = aggregate.logical_configuration.services[0]!;
    const requests: Request[] = [];
    mockControlApi(requests);
    await ServicesAPI.update(baseline.name, {
      ...toEditorService(baseline), timeouts: { connect_ms: 9000 },
    } as ReturnType<typeof toEditorService>, baseline);
    const payload = await requests[1]!.json();
    expect(payload.aggregate.logical_configuration.services[0].timeouts).toBeUndefined();
  });

  test('returns the created stable service identity after durable commit without waiting for publication', async () => {
    const requests: Request[] = [];
    mockControlApi(requests);
    const saved = await ServicesAPI.create({ name: 'created-service', endpoints: [{ target: 'https://created.example.test', weight: 100, priority: 1 }] });
    const body = await requests[1]!.json();
    expect(saved.id).toBe(body.aggregate.logical_configuration.services.at(-1).id);
    expect(saved.name).toBe('created-service');
    expect(requests.map(request => request.method)).toEqual(['GET', 'PUT']);
  });

  test('route edits complete after the storage ACK even while old workers are draining', async () => {
    const requests: Request[] = [];
    let mutationId = '';
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://ui.test'), init);
        requests.push(request);
        if (request.method === 'GET') return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' });
        mutationId = (await request.json()).mutation_id;
        return Response.json({ operation_id: mutationId, revision: 5,
          operation: { mutation_id: mutationId, expected_revision: 4, committed_revision: 5, state: 'draining', result_status: null }, workers: [] }, { status: 202 });
      },
    });
    const baseline = aggregate.logical_configuration.routes[0]!;
    await RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/renamed' }, baseline);
    expect(mutationId).toBeString();
    expect(requests.map(request => request.method)).toEqual(['GET', 'PUT']);
  });

  test('a consecutive edit commits once without waiting for the prior publication', async () => {
    const requests: Request[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://ui.test'), init);
        requests.push(request);
        if (request.method === 'GET') return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' });
        const body = await request.clone().json();
        expect(body.expected_revision).toBe(4);
        return Response.json({ operation_id: body.mutation_id, revision: 5,
          operation: { mutation_id: body.mutation_id, expected_revision: 4, committed_revision: 5, state: 'committed', result_status: null }, workers: [] }, { status: 202 });
      },
    });
    const baseline = aggregate.logical_configuration.routes[0]!;
    const acked = await RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/renamed' }, baseline);
    expect(acked.id).toBe(baseline.id);
    // One baseline read and one write; no publication polling and no second write.
    expect(requests.map(request => request.method)).toEqual(['GET', 'PUT']);
    expect(requests[1]!.url).not.toContain('/operations/');
  });

  test('an unconfirmed entity save keeps the original identity and never writes twice', async () => {
    const requests: Request[] = [];
    let mutationId = '';
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://ui.test'), init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === '/api/config') return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' });
        if (request.method === 'PUT') {
          mutationId = (await request.clone().json()).mutation_id;
          return Response.json({ error: 'result_unknown' }, { status: 503 });
        }
        if (request.method === 'GET' && path === `/api/config/operations/${mutationId}`) {
          return Response.json({ error: 'operation_not_found' }, { status: 404 });
        }
        return Response.json({ error: 'unavailable' }, { status: 503 });
      },
    });
    try {
      const baseline = aggregate.logical_configuration.routes[0]!;
      await expect(RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/renamed' }, baseline))
        .rejects.toBeInstanceOf(ConfigurationSubmissionUnknownError);
      expect(requests.filter(request => request.method === 'PUT')).toHaveLength(1);
      expect(get(configurationWrite).pending).toEqual({ mutationId, accepted: false });
    } finally {
      configurationWrite.clear();
    }
  });

  test('a foreign ACK and a foreign lookup both keep the original identity', async () => {
    const requests: Request[] = [];
    let mutationId = '';
    const foreign = (id: string) => ({ mutation_id: id, expected_revision: 4, committed_revision: 5,
      state: 'committed', result_status: null, error_code: null, error_detail: null });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://ui.test'), init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === '/api/config') return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' });
        if (request.method === 'PUT') {
          mutationId = (await request.clone().json()).mutation_id;
          return Response.json({ operation_id: 'foreign', revision: 5, operation: foreign('foreign'), workers: [] }, { status: 202 });
        }
        if (request.method === 'GET' && path === `/api/config/operations/${mutationId}`) {
          return Response.json({ operation: foreign('foreign'), workers: [] });
        }
        return Response.json({ error: 'unavailable' }, { status: 503 });
      },
    });
    try {
      const baseline = aggregate.logical_configuration.routes[0]!;
      await expect(RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/renamed' }, baseline))
        .rejects.toBeInstanceOf(ConfigurationSubmissionUnknownError);
      expect(requests.filter(request => request.method === 'PUT')).toHaveLength(1);
      expect(get(configurationWrite).pending).toEqual({ mutationId, accepted: false });
    } finally {
      configurationWrite.clear();
    }
  });

  test('a definitive rejection releases the identity', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://ui.test'), init);
        if (request.method === 'GET' && new URL(request.url).pathname === '/api/config') {
          return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' });
        }
        if (request.method === 'PUT') return Response.json({ error: 'stale_revision' }, { status: 409 });
        return Response.json({ error: 'unavailable' }, { status: 503 });
      },
    });
    const baseline = aggregate.logical_configuration.routes[0]!;
    await expect(RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/renamed' }, baseline))
      .rejects.toBeInstanceOf(ConfigurationStaleError);
    expect(get(configurationWrite).pending).toBeNull();
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

  test('ignores editor-only fields and compares plugin option content independent of key order', async () => {
    const original = aggregate.logical_configuration.services[0]!;
    const baseline = { ...original, plugins: [{ ...original.plugins[0]!, options: { a: 1, b: 2 } }] };
    const decorated = { ...baseline, description: 'not persisted', _uid: 'ui-only',
      plugins: [{ ...baseline.plugins[0]!, options: { b: 2, a: 1 } }],
    };
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [decorated] } });
    await ServicesAPI.update('alpha', toEditorService(baseline), baseline);
    const body = await requests[1]!.json();
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

  test.each(['deleted', 'renamed', 'replaced'] as const)('rejects a stale route baseline after %s without writing', async (change) => {
    const baseline = aggregate.logical_configuration.routes[0]!;
    const current = change === 'deleted' ? [] : [change === 'renamed' ? { ...baseline, path: '/renamed-elsewhere' } : { ...baseline, id: 'replacement-id' }];
    const requests: Request[] = [];
    mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, routes: current } });
    await expect(RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/draft' }, baseline)).rejects.toBeInstanceOf(RouteStaleError);
    expect(requests.map(request => request.method)).toEqual(['GET']);
  });

  test('detects changes to the same route across revisions but does not reject an unrelated route change', async () => {
    const baseline = {
      ...aggregate.logical_configuration.routes[0]!,
      endpoints: [{
        id: 'route-endpoint',
        position: 0,
        target: 'https://alpha.example.com',
        weight: 100,
        priority: 1,
        is_disabled: false,
        plugins: [],
        request: { headers: { add: { 'x-test': 'before' } } },
      }],
    };
    const changedRoutes = [
      { ...baseline, plugins: [{ ...baseline.plugins[0]!, options: { tag: 'remote' } }] },
      { ...baseline, endpoints: [{ ...baseline.endpoints[0]!, request: { headers: { add: { 'x-test': 'after' } } } }] },
    ];
    for (const changedRoute of changedRoutes) {
      const staleRequests: Request[] = [];
      mockControlApi(staleRequests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration,
        routes: [changedRoute, { ...baseline, id: 'other-route', path: '/other', position: 1 }],
      } });
      await expect(RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/draft' }, baseline)).rejects.toMatchObject({ reason: 'changed' });
      expect(staleRequests.map(request => request.method)).toEqual(['GET']);
    }

    const unrelatedRequests: Request[] = [];
    mockControlApi(unrelatedRequests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration,
      routes: [baseline, { ...baseline, id: 'other-route', path: '/other', position: 1 }],
    } });
    await RoutesAPI.update('/alpha', { ...toEditorRoute(baseline, aggregate.logical_configuration.services), path: '/draft' }, baseline);
    expect((await unrelatedRequests[1]!.json()).aggregate.logical_configuration.routes[0].path).toBe('/draft');
  });

  test('getForEdit captures route baseline and update persists managed endpoint identity and binding', async () => {
    const managedRoute = { ...aggregate.logical_configuration.routes[0]!, service_references: undefined, endpoints: [{
      id: 'managed-endpoint', position: 0, target: 'https://managed.example.test', weight: 100, priority: 1, is_disabled: false,
      managedBy: { plugin: 'provider', contributionId: 'chatgpt', bindingId: 'managed-binding' },
      plugins: [{ id: 'managed-binding', position: 0, name: 'provider', enabled: true, options: { accountRef: 'account' } }],
    }] };
    const current = { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, routes: [managedRoute] } };
    const requests: Request[] = [];
    let submitted = false;
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(new URL(String(input), 'http://ui.test'), init);
      requests.push(request);
      if (request.method === 'PUT') {
        submitted = true;
        const mutationId = (await request.clone().json()).mutation_id;
        return Response.json({ operation_id: mutationId, revision: 5,
          operation: { state: 'committed', result_status: null, error_code: null, mutation_id: mutationId, expected_revision: 4, committed_revision: 5 }, workers: [],
        }, { status: 202 });
      }
      return submitted
        ? Response.json({ operation: { state: 'converged', result_status: 200, error_code: null }, workers: [] })
        : Response.json({ config: current, revision: 4, content_hash: 'sha256:before' });
    } });
    const loaded = await RoutesAPI.getForEdit('/alpha');
    expect(loaded).not.toBeNull();
    const editorRoute = { ...loaded!.route, path: '/renamed' };
    await RoutesAPI.update('/alpha', editorRoute, loaded!.baseline);
    const saved = (await requests.find(request => request.method === 'PUT')!.json()).aggregate.logical_configuration.routes[0];
    expect(saved).toMatchObject({ id: 'route-id', path: '/renamed' });
    expect(saved.endpoints[0]).toMatchObject({ id: 'managed-endpoint', managedBy: managedRoute.endpoints[0]!.managedBy });
    expect(saved.endpoints[0].plugins[0]).toMatchObject({ id: 'managed-binding', options: { accountRef: 'account' } });
  });

  test('ordinary CRUD does not depend on secure-context-only crypto.randomUUID', async () => {
    const configSource = await Bun.file(new URL('../../../src/api/config.ts', import.meta.url)).text();
    const adapterSource = await Bun.file(new URL('../../../src/api/config-adapters.ts', import.meta.url)).text();

    expect(configSource.slice(0, configSource.indexOf('export async function importConfig'))).not.toContain('crypto.randomUUID');
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
        request: { headers: { add: { 'x-test': 'yes' } } },
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
    expect(logical.services[0].endpoints[0].request.headers).toEqual({ add: { 'x-test': 'yes' } });
    expect(logical.services[0].plugins[0].id).toBe('service-plugin-id');
    expect(logical.services[0].plugins[0]).toMatchObject({ position: 4, options: { sample: 0.5 } });
    expect(logical.routes[0]).toMatchObject({ id: 'route-id', service_references: [{service_id: 'service-id'}] });
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
      service_references: [serviceReference('service-id')],
      request: { headers: { remove: ['x-remove'] } },
      plugins: [{ name: 'route-plugin' }],
    });

    // Then
    const body = await requests[1]?.json();
    const created = body.aggregate.logical_configuration.routes[1];
    expect(created.id).toBeString();
    expect(created.position).toBe(1);
    expect(created.service_references[0].service_id).toBe('service-id');
    expect('service' in created).toBe(false);
    expect(created.request.headers).toEqual({ remove: ['x-remove'] });
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

  test('route create snapshots a nested proxy draft and returns a baseline that can be updated', async () => {
    const pluginOptions = { tag: 'original' };
    const loadBalancing = { policy: 'round_robin' as 'round_robin' | 'least_requests' };
    const draft = {
      path: '/proxy-route',
      load_balancing: new Proxy(loadBalancing, {}),
      endpoints: [{
        target: 'https://proxy.example.com',
        request: { headers: { add: undefined, remove: undefined, replace: undefined, default: undefined } },
      }],
      plugins: [{ name: 'proxy-plugin', options: new Proxy(pluginOptions, {}) }],
    };
    const gate = deferred();
    const requests: Request[] = [];
    mockControlApi(requests, aggregate, gate.promise);
    const pending = RoutesAPI.create(draft);
    loadBalancing.policy = 'least_requests';
    pluginOptions.tag = 'mutated';
    gate.resolve();
    const created = await pending;
    const body = await requests[1]!.json();
    expect(body.aggregate.logical_configuration.routes.at(-1)).toMatchObject({
      path: '/proxy-route',
      load_balancing: { policy: 'round_robin' },
      plugins: [{ name: 'proxy-plugin', options: { tag: 'original' } }],
    });
    expect(created.load_balancing).toEqual({ policy: 'round_robin' });

    mockControlApi(requests, { ...aggregate, logical_configuration: {
      ...aggregate.logical_configuration, routes: [...aggregate.logical_configuration.routes, created],
    } });
    const updated = await RoutesAPI.update('/proxy-route', { path: '/proxy-route-renamed' }, created);
    expect(updated.id).toBe(created.id);
    expect((await requests[3]!.json()).aggregate.logical_configuration.routes.at(-1)).toMatchObject({
      id: created.id, path: '/proxy-route-renamed',
    });
  });

  test('route create keeps non-finite endpoint numbers as null and propagates validation rejection', async () => {
    const requests: Request[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://ui.test'), init);
        requests.push(request);
        if (request.method === 'GET') return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' });
        return Response.json({ error: 'invalid_configuration', errors: [{ path: 'routes', message: 'invalid number' }] }, { status: 422 });
      },
    });
    const draft = {
      path: '/non-finite',
      endpoints: [{ target: 'https://non-finite.example.test', weight: Number.NaN, priority: Number.POSITIVE_INFINITY }],
    };
    await expect(RoutesAPI.create(draft)).rejects.toBeInstanceOf(ConfigurationValidationError);
    expect(requests.map(request => request.method)).toEqual(['GET', 'PUT']);
    const wire = await requests[1]!.clone().json();
    expect(wire.aggregate.logical_configuration.routes.at(-1).endpoints[0]).toMatchObject({ weight: null, priority: null });
  });

  test('service create snapshots a nested proxy draft and returns a baseline that can be updated', async () => {
    const endpointPluginOptions = { mode: 'strict' };
    const servicePluginOptions = { sample: 0.5 };
    const draft = {
      name: 'proxy-service',
      endpoints: [{
        target: 'https://proxy.example.test', weight: 100, priority: 1,
        plugins: [{ name: 'endpoint-plugin', options: new Proxy(endpointPluginOptions, {}) }],
        request: new Proxy({ headers: { add: { 'x-test': 'yes' }, remove: undefined, replace: undefined, default: undefined } }, {}),
      }],
      plugins: [{ name: 'service-plugin', options: new Proxy(servicePluginOptions, {}) }],
    };
    const gate = deferred();
    const requests: Request[] = [];
    mockControlApi(requests, aggregate, gate.promise);
    const pending = ServicesAPI.create(draft);
    endpointPluginOptions.mode = 'mutated';
    servicePluginOptions.sample = 0.9;
    gate.resolve();
    const created = await pending;
    const body = await requests[1]!.json();
    expect(body.aggregate.logical_configuration.services.at(-1)).toMatchObject({
      name: 'proxy-service',
      endpoints: [{
        request: { headers: { add: { 'x-test': 'yes' } } },
        plugins: [{ name: 'endpoint-plugin', options: { mode: 'strict' } }],
      }],
      plugins: [{ name: 'service-plugin', options: { sample: 0.5 } }],
    });
    expect(created.plugins![0]).toMatchObject({ options: { sample: 0.5 } });

    mockControlApi(requests, { ...aggregate, logical_configuration: {
      ...aggregate.logical_configuration, services: [...aggregate.logical_configuration.services, created],
    } });
    const updated = await ServicesAPI.update('proxy-service', { name: 'proxy-service-renamed', endpoints: [] }, created);
    expect(updated.id).toBe(created.id);
    expect((await requests[3]!.json()).aggregate.logical_configuration.services.at(-1)).toMatchObject({
      id: created.id, name: 'proxy-service-renamed',
    });
  });

  test('route update snapshots nested draft and proxy baseline while the snapshot read is pending', async () => {
    const base = { ...aggregate.logical_configuration.routes[0]!, path_rewrite: { '/old': '/new' } };
    const current = { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, routes: [base] } };
    const baseline = structuredClone(base);
    baseline.path_rewrite = new Proxy(structuredClone(base.path_rewrite), {});
    const draft = toEditorRoute(base, current.logical_configuration.services);
    draft.path_rewrite = new Proxy({ '/old': '/new' }, {});
    const gate = deferred();
    const requests: Request[] = [];
    mockControlApi(requests, current, gate.promise);
    const pending = RoutesAPI.update('/alpha', draft, baseline);
    draft.path_rewrite!['/old'] = '/draft-mutated';
    baseline.path_rewrite!['/old'] = '/baseline-mutated';
    gate.resolve();
    const saved = await pending;
    const body = await requests[1]!.json();
    expect(body.aggregate.logical_configuration.routes[0].path_rewrite).toEqual({ '/old': '/new' });
    expect(saved.path_rewrite).toEqual({ '/old': '/new' });
    draft.path_rewrite!['/old'] = '/after-ack';
    expect(saved.path_rewrite).toEqual({ '/old': '/new' });
  });

  test('service update snapshots nested draft and proxy baseline while the snapshot read is pending', async () => {
    const base = structuredClone(aggregate.logical_configuration.services[0]!);
    base.endpoints[0]!.request = { headers: { add: { 'x-test': 'yes' } } };
    const current = { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [base] } };
    const baseline = structuredClone(base);
    baseline.endpoints[0]!.request = new Proxy(structuredClone(base.endpoints[0]!.request!), {});
    const draft = toEditorService(base);
    draft.endpoints[0]!.request = new Proxy({ headers: { add: { 'x-test': 'yes' } } }, {});
    const gate = deferred();
    const requests: Request[] = [];
    mockControlApi(requests, current, gate.promise);
    const pending = ServicesAPI.update('alpha', draft, baseline);
    draft.endpoints[0]!.request!.headers!.add!['x-test'] = 'draft-mutated';
    baseline.endpoints[0]!.request!.headers!.add!['x-test'] = 'baseline-mutated';
    gate.resolve();
    const saved = await pending;
    const body = await requests[1]!.json();
    expect(body.aggregate.logical_configuration.services[0].endpoints[0].request)
      .toEqual({ headers: { add: { 'x-test': 'yes' } } });
    expect(saved.endpoints[0]!.request).toEqual({ headers: { add: { 'x-test': 'yes' } } });
    draft.endpoints[0]!.request!.headers!.add!['x-test'] = 'after-ack';
    expect(saved.endpoints[0]!.request).toEqual({ headers: { add: { 'x-test': 'yes' } } });
  });
});

test('multi-service route saves and reloads reference IDs, weights and route pool policy', async () => {
  const base = aggregate.logical_configuration.services[0]!;
  const second = { ...base, id: 'second-service', name: 'second', position: 1, endpoints: [], plugins: [] };
  const current = { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [base, second] } };
  const requests: Request[] = [];
  mockControlApi(requests, current);
  const references = [serviceReference(base.id), serviceReference(second.id, {position: 1, priority: 2, weight: 25, is_disabled: true})];
  await RoutesAPI.create({path: '/pool', service_references: references, load_balancing: {policy: 'round_robin'}, failover: {enabled: true, retry_on: [503]}});
  const saved = (await requests[1]!.json()).aggregate;
  expect(saved.logical_configuration.routes.at(-1)).toMatchObject({service_references: references, load_balancing: {policy: 'round_robin'}, failover: {enabled: true, retry_on: [503]}});
  expect(saved.logical_configuration.routes.at(-1).endpoints).toBeUndefined();
  mockControlApi([], saved);
  expect((await RoutesAPI.get('/pool'))?.service_references).toEqual(references);
});

test('service deletion reports both direct Route and Service consumers before any write', async () => {
  const base = aggregate.logical_configuration.services[0]!;
  const pool = { ...base, id: 'pool', name: 'pool', position: 1, endpoints: [], plugins: [], service_references: [serviceReference(base.id)] };
  const requests: Request[] = [];
  mockControlApi(requests, { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [base, pool] } });
  await expect(ServicesAPI.delete(base.name)).rejects.toMatchObject({routePaths: ['/alpha'], serviceNames: ['pool']});
  expect(requests.map(request => request.method)).toEqual(['GET']);
});

test('mixed service save preserves endpoint plugins and ordering without expanding references', async () => {
  const base = aggregate.logical_configuration.services[0]!;
  const child = { ...base, id: 'child', name: 'child', position: 1, endpoints: [], plugins: [] };
  const requests: Request[] = [];
  mockControlApi(requests, { ...aggregate, logical_configuration: {...aggregate.logical_configuration, services: [base, child]} });
  const draft = toEditorService(base);
  draft.endpoints[0]!._position = 1;
  draft.service_references = [serviceReference('child', {position: 0, weight: 30})];
  await ServicesAPI.update(base.name, draft, base);
  const saved = (await requests[1]!.json()).aggregate.logical_configuration.services[0];
  expect(saved.endpoints[0]).toMatchObject({id: 'endpoint-id', position: 1, plugins: base.endpoints[0]!.plugins});
  expect(saved.service_references).toEqual(draft.service_references);
});
