import { afterEach, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { consumeRouteSourceHandoff, consumeSourceHandoff, prepareRouteSourceHandoff, prepareSourceHandoff, RouteSourceHandoffError, routeSourceHandoffUrl, sourceHandoffUrl, type RouteSourceHandoff, type SourceHandoff } from './source-handoff';
import { ServicesAPI, ServiceStaleError } from './services';
import { toEditorService } from './config-adapters';
import type { Plugin } from './plugins';

const id = 'e8765b5b-8d0a-4ed6-889b-3eae0ccf8bb5';
const handoff: SourceHandoff = { serviceId: id, sourcePlugin: 'test-provider', sourceId: 'source', accountRef: 'account', mode: 'existing' };
const plugin: Plugin = { name: handoff.sourcePlugin, enabled: true, metadata: { contributes: {
  upstreamSources: [{ id: 'source', label: '来源', listAccounts: 'accounts', createDraft: 'draft', credentialPolicy: { allowedOrigins: [], allowedRequests: [], allowedHeaderNames: [] } }],
  api: [{ path: '/accounts', methods: ['GET'], handler: 'accounts', execution: 'control' }, { path: '/draft', methods: ['POST'], handler: 'draft', execution: 'control' }],
} } };
const aggregate: ConfigurationAggregateV2 = { logical_configuration: {
  auth: { enabled: false, tokens: [] }, plugins: [], routes: [], services: [{ id, position: 0, name: 'existing', plugins: [],
    endpoints: [{ id: 'first', position: 0, target: 'https://manual.test', weight: 100, priority: 1, is_disabled: false,
      plugins: [{ id: 'conflicting', position: 0, name: 'test-provider', enabled: false, options: { accountRef: 'other' } }] }],
  }],
}, plugin_activations: [] };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockApi(options: { enabled?: boolean; available?: boolean; current?: ConfigurationAggregateV2; draftAccount?: string; sourceError?: boolean; accountError?: boolean; draftError?: boolean } = {}) {
  const requests: Request[] = [];
  let published: any;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(new URL(String(input), 'https://ui.test'), init); requests.push(request);
    const path = new URL(request.url).pathname;
    if ((path === '/api/plugins' && options.sourceError)
      || (path.endsWith('/control/accounts') && options.accountError)
      || (path.endsWith('/control/draft') && options.draftError)) throw new Error('secret upstream failure details');
    if (path === '/api/plugins') return Response.json([{ ...plugin, enabled: options.enabled ?? true }]);
    if (path.endsWith('/control/accounts')) return Response.json({ accounts: [{ id: 'account', label: '账号', available: options.available ?? true }] });
    if (path.endsWith('/control/draft')) return Response.json({ target: 'https://authoritative.test/responses', bindingOptions: { accountRef: options.draftAccount ?? 'account', compatibility: 'server-owned' } });
    if (request.method === 'PUT') {
      published = await request.json();
      return Response.json({ operation_id: published.mutation_id, revision: 5,
        operation: { state: 'converged', result_status: 200, error_code: null, mutation_id: published.mutation_id }, workers: [] }, { status: 202 });
    }
    return Response.json({ config: options.current ?? aggregate, revision: 4, content_hash: 'before' });
  }) as typeof fetch;
  return { requests, get published() { return published; } };
}

test('URL carries identifiers only and consumes once', () => {
  const url = sourceHandoffUrl(handoff, 'existing');
  expect(url.startsWith('/services/edit/existing?')).toBe(true);
  const result = consumeSourceHandoff(`${url.split('?')[1]}&section=endpoints`);
  expect(result.handoff).toEqual(handoff);
  expect(result.query).toBe('section=endpoints');
  expect(consumeSourceHandoff(result.query).handoff).toBeNull();
  expect(Object.keys(result.handoff!)).toEqual(['serviceId', 'sourcePlugin', 'sourceId', 'accountRef', 'mode']);
});

test('strict handoff allowlist rejects unknown or injected payloads instead of continuing', () => {
  const query = sourceHandoffUrl(handoff, 'existing').split('?')[1];
  for (const extra of ['target=https://evil.test', 'options=secret', 'plugins=evil', 'managedBy=evil', 'unknown=x', 'section=review', 'section=endpoints&section=endpoints']) {
    const result = consumeSourceHandoff(`${query}&${extra}`);
    expect(result.handoff).toBeNull(); expect(result.error).not.toBe(''); expect(result.query).toBe('');
  }
});

test('rejects duplicate, untrimmed, long, non-slug and non-UUID identifiers before loading', () => {
  const query = sourceHandoffUrl(handoff, 'existing').split('?')[1];
  for (const key of ['serviceId', 'sourcePlugin', 'sourceId', 'accountRef', 'mode']) {
    const result = consumeSourceHandoff(`${query}&${key}=evil`);
    expect(result.handoff).toBeNull(); expect(result.error).not.toBe(''); expect(result.query).toBe('');
  }
  for (const [key, value] of [['accountRef', ' account '], ['accountRef', 'a'.repeat(129)], ['sourcePlugin', '../evil'], ['sourceId', 'x'.repeat(129)], ['serviceId', 'not-a-uuid'], ['mode', 'overwrite'], ['accountRef', '\u0000']]) {
    const params = new URLSearchParams(query); params.set(key, value);
    expect(consumeSourceHandoff(params.toString()).handoff).toBeNull();
  }
  expect(consumeSourceHandoff(`${query}&extra=${'a'.repeat(1024)}`).handoff).toBeNull();
  expect(consumeSourceHandoff(`${query}?&accountRef=other`).handoff).toBeNull();
});

test('existing service handoff does not commit; explicit save creates exactly one managed endpoint and binding with CAS', async () => {
  const api = mockApi();
  const loaded = (await ServicesAPI.getForEdit('existing'))!;
  const original = structuredClone(loaded.service);
  const result = await prepareSourceHandoff(loaded.service, handoff);
  expect(loaded.service).toEqual(original);
  expect(result.service.endpoints).toHaveLength(2);
  expect(result.service.endpoints[0]).toEqual(original.endpoints[0]);
  expect(result.service.endpoints[1].target).toBe('https://authoritative.test/responses');
  expect(api.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
  expect(JSON.parse(await api.requests.find(request => request.url.endsWith('/control/draft'))!.clone().text())).toEqual({ accountRef: 'account' });
  await ServicesAPI.update('existing', result.service, loaded.baseline);
  expect(api.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  expect(api.published.expected_revision).toBe(4);
  const endpoints = api.published.aggregate.logical_configuration.services[0].endpoints;
  expect(endpoints.filter((endpoint: any) => endpoint.managedBy)).toHaveLength(1);
  const endpoint = endpoints[1];
  expect(endpoint.plugins).toHaveLength(1);
  expect(endpoint.plugins[0].id).toBe(endpoint.managedBy.bindingId);
  expect(endpoint.plugins[0].options).toEqual({ accountRef: 'account', compatibility: 'server-owned' });
});

test('duplicate account focuses existing index without appending, creating a draft or replacing another managed source', async () => {
  const api = mockApi();
  const original = toEditorService(aggregate.logical_configuration.services[0]);
  const first = await prepareSourceHandoff(original, handoff);
  const beforeRequests = api.requests.length;
  const duplicate = await prepareSourceHandoff(first.service, handoff);
  expect(duplicate.duplicate).toBe(true); expect(duplicate.index).toBe(1);
  expect(duplicate.service).toBe(first.service);
  expect(api.requests.slice(beforeRequests).every(request => request.method === 'GET')).toBe(true);
  const other = structuredClone(first.service);
  other.endpoints[1].managedBy = { ...other.endpoints[1].managedBy!, contributionId: 'another-source' };
  const result = await prepareSourceHandoff(other, handoff);
  expect(result.service.endpoints).toHaveLength(3);
  expect(result.service.endpoints[1]).toEqual(other.endpoints[1]);
});

test('new service reuses the initial empty endpoint, but not an occupied or conflicting endpoint', async () => {
  mockApi();
  const newHandoff = { ...handoff, serviceId: undefined, mode: 'new' as const };
  const empty = { name: '', endpoints: [{ _uid: 'initial', target: '', weight: 100, priority: 1 }] };
  const result = await prepareSourceHandoff(empty, newHandoff);
  expect(result.service.endpoints).toHaveLength(1); expect(result.service.endpoints[0]._uid).toBe('initial');
  const occupied = { ...empty, endpoints: [{ ...empty.endpoints[0], plugins: [{ name: 'test-provider', options: { accountRef: 'other' } }] }] };
  expect((await prepareSourceHandoff(occupied, newHandoff)).service.endpoints).toHaveLength(2);
});

test('disabled source, unavailable account, mismatched draft and stale service IDs never modify or commit', async () => {
  for (const options of [{ enabled: false }, { available: false }, { draftAccount: 'wrong' }]) {
    const api = mockApi(options);
    const service = toEditorService(aggregate.logical_configuration.services[0]), before = structuredClone(service);
    await expect(prepareSourceHandoff(service, handoff)).rejects.toThrow();
    expect(service).toEqual(before); expect(api.requests.some(request => request.method === 'PUT')).toBe(false);
  }
  const api = mockApi();
  await expect(prepareSourceHandoff({ name: 'replacement', _uid: 'replacement', endpoints: [] }, handoff)).rejects.toThrow();
  expect(api.requests).toHaveLength(0);
});

test('handoff retains baseline protection: later remote changes reject explicit save without overwrite', async () => {
  mockApi();
  const loaded = (await ServicesAPI.getForEdit('existing'))!;
  const result = await prepareSourceHandoff(loaded.service, handoff);
  const changed = structuredClone(aggregate);
  changed.logical_configuration.services[0].endpoints[0].target = 'https://changed.test';
  const api = mockApi({ current: changed });
  await expect(ServicesAPI.update('existing', result.service, loaded.baseline)).rejects.toBeInstanceOf(ServiceStaleError);
  expect(result.service.endpoints).toHaveLength(2);
  expect(api.requests.some(request => request.method === 'PUT')).toBe(false);
});

test('route handoff URL and query enforce the isolated route allowlist', () => {
  const routeHandoff: RouteSourceHandoff = { routeId: id, sourcePlugin: 'test-provider', sourceId: 'source', accountRef: 'account', mode: 'existing' };
  const url = routeSourceHandoffUrl(routeHandoff, '/v1/chat');
  expect(url.startsWith('/routes/edit/%2Fv1%2Fchat?')).toBe(true);
  const parsed = consumeRouteSourceHandoff(`${url.split('?')[1]}&section=target`);
  expect(parsed.handoff).toEqual(routeHandoff);
  expect(parsed.query).toBe('section=target');
  expect(consumeRouteSourceHandoff(parsed.query).handoff).toBeNull();
  for (const extra of ['serviceId=x', 'target=https://evil.test', 'section=endpoints', 'section=target&section=target']) {
    const rejected = consumeRouteSourceHandoff(`${url.split('?')[1]}&${extra}`);
    expect(rejected.handoff).toBeNull();
    expect(rejected.error).toBe('invalid_handoff');
    expect(rejected.query).toBe('');
  }
  expect(consumeRouteSourceHandoff('mode=new&sourcePlugin=test-provider&sourceId=source&accountRef=account').handoff)
    .toEqual({ sourcePlugin: 'test-provider', sourceId: 'source', accountRef: 'account', mode: 'new' });
  expect(() => routeSourceHandoffUrl({ ...routeHandoff, sourceId: '../evil' })).toThrow(RouteSourceHandoffError);
  try { routeSourceHandoffUrl({ ...routeHandoff, sourceId: '../evil' }); }
  catch (error) { expect(error).toMatchObject({ code: 'invalid_handoff' }); }
});

test('route handoff appends authoritative managed endpoint to unsaved draft and preserves existing bindings', async () => {
  const api = mockApi();
  const routeHandoff: RouteSourceHandoff = { routeId: id, sourcePlugin: 'test-provider', sourceId: 'source', accountRef: 'account', mode: 'existing' };
  const route: any = { path: '/custom', _uid: id, endpoints: [{ _uid: 'manual', target: 'https://manual.test', weight: 100, priority: 1,
    plugins: [{ _uid: 'keep', name: 'other-plugin', enabled: true, options: { retained: true } }] }] };
  const before = structuredClone(route);
  const result = await prepareRouteSourceHandoff(route, routeHandoff);
  expect(route).toEqual(before);
  expect(result.route.endpoints).toHaveLength(2);
  expect(result.route.endpoints![0]).toEqual(route.endpoints[0]);
  expect(result.route.endpoints![1].target).toBe('https://authoritative.test/responses');
  const managedEndpoint = result.route.endpoints![1]!;
  const managedBinding = managedEndpoint.plugins?.[0];
  if (!managedEndpoint.managedBy || typeof managedBinding === 'string' || !managedBinding?._uid) throw new Error('Expected managed endpoint binding');
  expect(managedEndpoint.managedBy.bindingId).toBe(managedBinding._uid);
  expect(managedBinding.options).toEqual({ accountRef: 'account', compatibility: 'server-owned' });
  expect(api.requests.some(request => request.method === 'PUT')).toBe(false);
});

test('route handoff rejects service-backed, direct-response, redirect and mismatched-id routes unchanged', async () => {
  const api = mockApi();
  const routeHandoff: RouteSourceHandoff = { routeId: id, sourcePlugin: 'test-provider', sourceId: 'source', accountRef: 'account', mode: 'existing' };
  for (const route of [
    { path: '/service', _uid: id, service: 'existing', endpoints: [] },
    { path: '/response', _uid: id, direct_response: { enabled: true, status: 200 }, endpoints: [] },
    { path: '/redirect', _uid: id, redirect: { enabled: true, url: 'https://example.test' }, endpoints: [] },
    { path: '/wrong-id', _uid: 'wrong-id', endpoints: [] },
  ]) {
    const before = structuredClone(route);
    await expect(prepareRouteSourceHandoff(route as any, routeHandoff)).rejects.toBeInstanceOf(RouteSourceHandoffError);
    expect(route).toEqual(before);
  }
  expect(api.requests).toHaveLength(0);
});

test('route handoff exposes stable safe codes for route/source/account and external API failures', async () => {
  const existingHandoff: RouteSourceHandoff = { routeId: id, sourcePlugin: 'test-provider', sourceId: 'source', accountRef: 'account', mode: 'existing' };
  const route: any = { path: '/custom', _uid: id, endpoints: [] };
  const assertCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toMatchObject({ name: 'RouteSourceHandoffError', code });
    try { await promise; } catch (error) { expect((error as Error).message).not.toContain('secret upstream failure details'); }
  };

  await assertCode(prepareRouteSourceHandoff(route, { ...existingHandoff, sourceId: '../bad' }), 'invalid_handoff');
  await assertCode(prepareRouteSourceHandoff({ ...route, _uid: 'changed' }, existingHandoff), 'route_changed');
  await assertCode(prepareRouteSourceHandoff({ ...route, service: 'bound' }, existingHandoff), 'unsupported_target');

  for (const options of [{ enabled: false }, { sourceError: true }, { draftError: true }]) {
    mockApi(options);
    await assertCode(prepareRouteSourceHandoff(route, existingHandoff), 'source_unavailable');
  }
  for (const options of [{ available: false }, { accountError: true }]) {
    mockApi(options);
    await assertCode(prepareRouteSourceHandoff(route, existingHandoff), 'account_unavailable');
  }
});

test('route handoff duplicate detection requires matching managed binding and reuses only a pristine new-route placeholder', async () => {
  mockApi();
  const newHandoff: RouteSourceHandoff = { sourcePlugin: 'test-provider', sourceId: 'source', accountRef: 'account', mode: 'new' };
  const route: any = { path: '/new', endpoints: [{ _uid: 'empty', target: '', weight: 100, priority: 1 }] };
  const applied = await prepareRouteSourceHandoff(route, newHandoff);
  expect(applied.route.endpoints).toHaveLength(1);
  expect(applied.route.endpoints![0]._uid).toBe('empty');
  const duplicate = await prepareRouteSourceHandoff(applied.route, newHandoff);
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.index).toBe(0);
  expect(duplicate.route).toBe(applied.route);
  const unrelatedManaged = structuredClone(applied.route);
  const originalEndpoint = unrelatedManaged.endpoints![0]!;
  unrelatedManaged.endpoints![0] = { ...originalEndpoint, managedBy: { ...originalEndpoint.managedBy!, contributionId: 'other-source' } };
  expect((await prepareRouteSourceHandoff(unrelatedManaged, newHandoff)).route.endpoints).toHaveLength(2);
});
