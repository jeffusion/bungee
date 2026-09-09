import { afterEach, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { consumeSourceHandoff, prepareSourceHandoff, sourceHandoffUrl, type SourceHandoff } from './source-handoff';
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

function mockApi(options: { enabled?: boolean; available?: boolean; current?: ConfigurationAggregateV2; draftAccount?: string } = {}) {
  const requests: Request[] = [];
  let published: any;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(new URL(String(input), 'https://ui.test'), init); requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/__ui/api/plugins') return Response.json([{ ...plugin, enabled: options.enabled ?? true }]);
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
