import { afterEach, expect, test } from 'bun:test';
import { sourceEndpoint, listSourceAccounts, createSourceDraft, applySourceDraft, accountReferences, type UpstreamSource } from './upstream-sources';
import { toEditorUpstream, toV2Service } from './config-adapters';
import { prefillRouteService } from './route-prefill';
import { allowedControlRequest, safeExternalUrl } from '../plugin-sdk/host-messages';

const source: UpstreamSource = {
  plugin: { name: 'generic-provider', enabled: true, metadata: { contributes: { api: [
    { path: '/identities/list', methods: ['GET'], handler: 'readIdentities', execution: 'control' },
    { path: '/endpoints/prepare', methods: ['POST'], handler: 'prepareEndpoint', execution: 'control' },
  ] } } },
  contribution: { id: 'source', label: '通用来源', listAccounts: 'readIdentities', createDraft: 'prepareEndpoint',
    credentialPolicy: { allowedOrigins: ['https://provider.test'], allowedRequests: [], allowedHeaderNames: [] } },
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('resolves handler names to declared control GET/POST paths, not provider-specific paths or RPC', async () => {
  const requests: { url: string; method?: string; body?: string }[] = [];
  globalThis.fetch = (async (url, options) => {
    requests.push({ url: String(url), method: options?.method, body: options?.body as string });
    return Response.json(options?.method === 'POST' ? { target: 'https://provider.test/v1', bindingOptions: { accountRef: 'acct', unknown: [1, 2] } }
      : { accounts: [{ id: 'acct', label: '账号', available: true }] });
  }) as typeof fetch;
  expect(await listSourceAccounts(source)).toHaveLength(1);
  const draft = await createSourceDraft(source, 'acct');
  expect(draft.bindingOptions.unknown).toEqual([1, 2]);
  expect(requests.map(item => [item.url, item.method])).toEqual([
    ['/api/plugins/generic-provider/control/identities/list', 'GET'],
    ['/api/plugins/generic-provider/control/endpoints/prepare', 'POST'],
  ]);
  expect(JSON.parse(requests[1].body!)).toEqual({ accountRef: 'acct' });
  const invalid = structuredClone(source); invalid.plugin.metadata!.contributes!.api![0].execution = 'worker';
  expect(() => sourceEndpoint(invalid, 'listAccounts')).toThrow();
});

test('atomically creates stable endpoint/binding marker IDs and preserves other plugins and original draft', () => {
  const original = { target: 'https://manual.test', plugins: [{ _uid: 'other', name: 'trace', enabled: false, options: { retain: true } }] };
  const before = structuredClone(original);
  const applied = applySourceDraft(original, source, { target: 'https://provider.test/v1', bindingOptions: { accountRef: 'acct', future: { nested: [1] } } });
  expect(original).toEqual(before);
  const saved = toV2Service({ name: 'service', endpoints: [applied] }, undefined, 0).endpoints[0];
  expect(saved.id).toBe(applied._uid!);
  expect(saved.managedBy!.bindingId).toBe(saved.plugins[1].id);
  expect(saved.plugins[0]).toMatchObject({ id: 'other', enabled: false, options: { retain: true } });
  expect(toEditorUpstream(saved).managedBy).toEqual(applied.managedBy);
});

test('failed draft and inactive source cannot clear an existing binding', async () => {
  globalThis.fetch = (async () => Response.json({ target: 'https://provider.test/v1', bindingOptions: { accountRef: 'wrong' } })) as unknown as typeof fetch;
  await expect(createSourceDraft(source, 'acct')).rejects.toThrow();
  await expect(listSourceAccounts({ ...source, plugin: { ...source.plugin, enabled: false } })).rejects.toThrow();
});

test('reference summary includes service consumers and direct routes, retaining runtime unknown', () => {
  const endpoint = { id: 'ep', position: 0, target: 'https://provider.test', weight: 100, priority: 1, is_disabled: true,
    plugins: [{ id: 'binding', position: 0, name: 'generic-provider', enabled: false, options: { accountRef: 'acct' } }] };
  const refs = accountReferences({ plugins: [], services: [{ id: 'service', position: 0, name: 'service', endpoints: [endpoint], plugins: [] }],
    routes: [{ id: 'consumer', position: 0, path: '/consumer', service_id: 'service', plugins: [] },
      { id: 'direct', position: 1, path: '/direct', endpoints: [endpoint], plugins: [] }] }, 'generic-provider', 'acct');
  expect(refs.services).toEqual([{ id: 'service', name: 'service' }]);
  expect(refs.routes.map(item => item.path)).toEqual(['/consumer', '/direct']);
  expect(refs.runtime).toBe('unknown');
});

test('reference lookup also preserves service, route and global scope references', () => {
  const binding = { id: 'binding', position: 0, name: 'generic-provider', enabled: false, options: { accountRef: 'acct' } };
  const refs = accountReferences({ plugins: [binding], services: [{ id: 'service', position: 0, name: 'service', endpoints: [], plugins: [binding] }],
    routes: [{ id: 'route', position: 0, path: '/route', endpoints: [], plugins: [binding] }] }, 'generic-provider', 'acct');
  expect(refs.global).toBe(true); expect(refs.services).toHaveLength(1); expect(refs.routes).toHaveLength(1);
  expect(refs.runtime).toBe('unknown');
});

test('host bridge cannot invoke undeclared, worker, external or traversal paths', () => {
  expect(allowedControlRequest(source.plugin, '/identities/list?sessionId=abc', 'GET')).toBe(true);
  for (const path of ['/config', '//evil.test', '/../../config', '/%2e%2e/config', 'https://evil.test', '/identities/list#fragment']) {
    expect(allowedControlRequest(source.plugin, path, 'GET')).toBe(false);
  }
  expect(allowedControlRequest(source.plugin, '/identities/list', 'POST')).toBe(false);
  for (const url of ['javascript:alert(1)', 'http://example.test', 'https://user:pass@example.test']) expect(safeExternalUrl(url)).toBeNull();
  expect(safeExternalUrl('https://auth.example.test/verify')).toBe('https://auth.example.test/verify');
});

test('actual host message handler rejects foreign frames and origins before any operation', async () => {
  const component = await Bun.file(new URL('../components/shell/PluginHost.svelte', import.meta.url)).text();
  const handler = component.match(/  async function handleMessage\([\s\S]*?\n  }/)![0];
  const invoke = new Function('iframe', 'pluginOrigin', 'event', new Bun.Transpiler({ loader: 'ts' }).transformSync(`${handler}; return handleMessage(event);`));
  const frame = {};
  for (const event of [
    { source: {}, origin: 'https://bungee.test' },
    { source: frame, origin: 'https://other.test' },
    { source: frame, origin: 'null' },
  ]) {
    await expect(invoke({ contentWindow: frame }, 'https://bungee.test', { ...event,
      data: { type: 'bungee:host-request', id: 'foreign', action: 'control', method: 'POST', path: '/accounts/delete' },
    })).resolves.toBeUndefined();
  }
});

test('route prefill resolves stable service ID without publishing or adding provider fields', () => {
  const route = { path: '', plugins: [] };
  expect(prefillRouteService(route, [{ _uid: 'stable', name: 'renamed', endpoints: [] }], 'stable'))
    .toEqual({ ...route, service: 'renamed', _serviceId: 'stable', endpoints: undefined });
  expect(route).toEqual({ path: '', plugins: [] });
  expect(() => prefillRouteService(route, [], 'deleted')).toThrow();
});
