import type { DispatchRequestInput } from '@jeffusion/bungee-core/plugin';
import {expect, test, spyOn} from 'bun:test';
import {createPluginHooks} from '../../../../packages/core/src/hooks';
import {catalogValidatorsRpc} from '../../contract';
import {CatalogValidators, catalogKeys} from '../../server/catalog-validators';
import {CodexRouterPlugin} from '../../server/index';
import {createControl} from '../../server/control';
import {conversionService} from '../../../llm-protocol-adapter/server/service';

const etag = `"${'a'.repeat(64)}"`, nextEtag = `"${'b'.repeat(64)}"`;
const key = (n: number) => n.toString(16).padStart(64, '0');
const validatorKey = (input: Parameters<typeof catalogKeys>[0], bindings: Parameters<typeof catalogKeys>[1]) => catalogKeys(input, bindings)?.validator ?? null;
function request(method = 'GET', version = '0.162.1') {
  const url = new URL(`http://local/codex/${method === 'GET' ? 'models' : 'responses'}`);
  if (method === 'GET') url.searchParams.set('client_version', version);
  const headers: Record<string, string> = {Authorization: 'Bearer private-token', 'ChatGPT-Account-Id': 'account', Version: version};
  const targets: DispatchRequestInput['targets'] = [];
  return {context: {method, originalUrl: new URL(url), url, routeId: '/codex/', requestId: crypto.randomUUID(), clientIP: 'local',
    headers, body: {model: 'native'}},
    targets, principal: {domain: 'data', keyId: 'key', credentialVersion: 1}, servingRevision: 7, signal: new AbortController().signal};
}

test('directory and generation partition by entry, revision, identity, original credentials, account, client and bindings', () => {
  const get = request(), post = request('POST');
  const base = validatorKey(get, []);
  expect(base).toMatch(/^[a-f0-9]{64}$/);
  expect(validatorKey(post, [])).toBe(base);
  for (const change of [
    (r: ReturnType<typeof request>) => {r.context.routeId = '/other/';},
    (r: ReturnType<typeof request>) => {r.servingRevision++;},
    (r: ReturnType<typeof request>) => {r.principal.domain = 'other';},
    (r: ReturnType<typeof request>) => {r.principal.keyId = 'other';},
    (r: ReturnType<typeof request>) => {r.principal.credentialVersion++;},
    (r: ReturnType<typeof request>) => {r.context.headers.Authorization = 'Bearer other';},
    (r: ReturnType<typeof request>) => {r.context.headers['ChatGPT-Account-Id'] = 'other';},
    (r: ReturnType<typeof request>) => {r.context.originalUrl.searchParams.set('client_version', '0.160.1');},
  ]) { const different = request(); change(different); expect(validatorKey(different, [])).not.toBe(base); }
  expect(validatorKey(get, [{provider: 'p', model: 'm', target: {type: 'service', id: 'target', protocol: 'responses'}}])).not.toBe(base);
  const anonymous = {...get, principal: undefined};
  expect(validatorKey(anonymous, [])).toBe(validatorKey({...post, principal: {domain: 'anonymous', keyId: '', credentialVersion: 0}}, []));
  for (const version of ['', ' ', 'two versions', 'x'.repeat(129)]) expect(validatorKey(request('POST', version), [])).toBeNull();
  get.context.originalUrl.searchParams.append('client_version', '0.162.1');
  expect(validatorKey(get, [])).toBeNull();
});

test('notification versions share release identity while snapshots keep exact upstream query versions', () => {
  const release = catalogKeys(request('GET', '0.162.0'), [])!;
  for (const version of ['0.162.0-alpha.17.2', '0.162.0-beta.1', '0.162.0-rc.2+build.3', '0.162.0+build.4']) {
    expect(catalogKeys(request('POST', version), [])!.validator).toBe(release.validator);
    const directory = catalogKeys(request('GET', version), [])!;
    expect(directory.validator).toBe(release.validator);
    expect(directory.snapshot).not.toBe(release.snapshot);
  }
  for (const version of ['0.162.1-alpha.1', '0.163.0', '1.162.0', 'custom-client', 'custom-other']) {
    expect(catalogKeys(request('POST', version), [])!.validator).not.toBe(release.validator);
  }
  expect(catalogKeys(request('POST', 'custom-client'), [])!.validator)
    .not.toBe(catalogKeys(request('POST', 'custom-other'), [])!.validator);
});

test('validator TTL starts at successful publication, reads do not extend it and publication replaces it', () => {
  let now = 0;
  const cache = new CatalogValidators(() => now);
  expect(cache.get(key(0))).toBeNull(); cache.put(key(0), etag);
  now = 599_999; expect(cache.get(key(0))).toBe(etag);
  now = 600_000; expect(cache.get(key(0))).toBeNull();
  cache.put(key(0), etag); now = 900_000; cache.put(key(0), nextEtag);
  now = 1_200_000; expect(cache.get(key(0))).toBe(nextEtag);
  now = 1_500_000; expect(cache.get(key(0))).toBeNull();
  expect(() => cache.put(key(0), 'invalid')).toThrow('invalid_catalog_validator');
});

test('512-entry LRU evicts the least recently used record and clearing/rebuilding loses all records', () => {
  const cache = new CatalogValidators();
  for (let i = 0; i < 512; i++) cache.put(key(i), etag);
  expect(cache.get(key(0))).toBe(etag);
  cache.put(key(512), nextEtag);
  expect(cache.get(key(1))).toBeNull(); expect(cache.get(key(0))).toBe(etag); expect(cache.get(key(512))).toBe(nextEtag);
  cache.clear(); expect(cache.get(key(0))).toBeNull();
  expect(new CatalogValidators().get(key(512))).toBeNull();
});

test('control owns transient validators and clears them at disposal and abort', async () => {
  const controller = new AbortController();
  let handlers: any, cleanup!: () => void;
  const control = createControl({signal: controller.signal, services: {
    rpc: {publish: (contract: unknown, methods: unknown) => {expect(contract).toBe(catalogValidatorsRpc); handlers = methods;}},
    onDispose: (dispose: () => void) => {cleanup = dispose;},
  }} as any);
  handlers.put({key: key(0), etag}); expect(handlers.get({key: key(0)})).toBe(etag);
  await control.dispose(); expect(handlers.get({key: key(0)})).toBeNull();
  handlers.put({key: key(0), etag}); controller.abort(); expect(handlers.get({key: key(0)})).toBeNull();
  cleanup();
  expect(catalogValidatorsRpc.methods.put.command.deduplication).toBe('none');
});

async function router(cache: CatalogValidators, failure?: 'get' | 'put' | 'consume') {
  const plugin = new CodexRouterPlugin();
  await plugin.init({scope: {type: 'route', routeId: '/codex/'}, services: {
    consume: () => ({resolveCapabilities: () => null}),
    rpc: {consume: (provider: string) => {
      if (provider !== 'codex-router') return {};
      if (failure === 'consume') throw new Error('unavailable');
      return {get: async ({key}: {key: string}) => {if (failure === 'get') throw new Error('unavailable'); return cache.get(key);},
        put: async ({key, etag}: {key: string; etag: string}) => {if (failure === 'put') throw new Error('unavailable'); return cache.put(key, etag);}};
    }},
  }} as any);
  const hooks = createPluginHooks(); plugin.register(hooks);
  return {plugin, hooks};
}

async function rawResponse(hooks: ReturnType<typeof createPluginHooks>, response: Response, post: ReturnType<typeof request>) {
  const raw = {response, completion: Promise.resolve({status: 'completed' as const})};
  const result = await hooks.onRawResponse.promise(raw, {...post.context, signal: post.signal, attemptId: post.context.requestId,
    bodyHandle: {json: async () => {throw new Error('generation body must not be read');}}} as any);
  expect(result).toBe(raw); expect(result.completion).toBe(raw.completion);
  return result.response;
}

test('hooks publish the actual body validator and rewrite metadata without reading generation JSON or SSE', async () => {
  const cache = new CatalogValidators(), {hooks} = await router(cache);
  const get = request(); await hooks.onDispatchRequest.promise(get);
  // Provider rewrites cannot change the captured client identity/version.
  get.context.headers.Authorization = 'Bearer provider-token'; get.context.headers.Version = 'provider-version';
  const native = {models: [{slug: 'native', label: '你好🙂'}]};
  const models = await hooks.onResponse.promise(Response.json(native), {...get.context, response: Response.json(native), latencyMs: 0,
    bodyHandle: {json: async () => native}} as any);
  const saved = models.headers.get('etag'); expect(saved).toMatch(/^"[a-f0-9]{64}"$/);
  expect(await models.json()).toEqual(native);
  for (const [type, body] of [['application/json', '{"status":"completed"}'], ['text/event-stream', 'data: {"type":"response.completed"}\n\n']]) {
    const post = request('POST'); await hooks.onDispatchRequest.promise(post);
    const response = new Response(body, {headers: {'content-type': type!, 'X-Models-Etag': 'upstream-unrelated', 'x-other': 'keep'}});
    const result = await rawResponse(hooks, response, post);
    expect(result).toBe(response); expect(result.headers.get('x-models-etag')).toBe(saved);
    expect(result.headers.get('x-other')).toBe('keep'); expect(await result.text()).toBe(body!);
    await hooks.onFinally.promise({...post.context, success: true, latencyMs: 0});
    const afterCleanup = new Response('body', {headers: {'x-models-etag': 'upstream'}});
    expect((await rawResponse(hooks, afterCleanup, post)).headers.has('x-models-etag')).toBe(false);
  }
});

test('missing, expired, unknown-client and unavailable notification state leave generation usable', async () => {
  for (const failure of [undefined, 'get', 'put', 'consume'] as const) {
    const cache = new CatalogValidators(), {hooks, plugin} = await router(cache, failure);
    const get = request(); await hooks.onDispatchRequest.promise(get);
    if (failure) await hooks.onResponse.promise(Response.json({models: []}), {...get.context, response: Response.json({}), latencyMs: 0,
      bodyHandle: {json: async () => ({models: []})}} as any);
    const post = request('POST'); await hooks.onDispatchRequest.promise(post);
    const response = new Response('unchanged', {headers: {'x-models-etag': 'upstream'}});
    const result = await rawResponse(hooks, response, post);
    expect(result.headers.has('x-models-etag')).toBe(false); expect(await result.text()).toBe('unchanged');
    plugin.reset();
  }
  let now = 0; const cache = new CatalogValidators(() => now), {hooks} = await router(cache);
  cache.put(validatorKey(request(), [])!, etag); now = 600_000;
  for (const post of [request('POST'), request('POST', '')]) {
    await hooks.onDispatchRequest.promise(post);
    const response = new Response('body', {headers: {'x-models-etag': 'upstream'}});
    expect((await rawResponse(hooks, response, post)).headers.has('x-models-etag')).toBe(false);
  }
});

test('route dispatch transfers notification ownership to its adapter before preparation or validation can fail', async () => {
  let queries = 0;
  const plugin = new CodexRouterPlugin({models: [{source: 'native', provider: 'p', model: 'm', target: {type: 'route', id: 'target', protocol: 'responses'}}]});
  const capabilities = {model: () => ({provider: 'p', model: 'm', name: 'm', contextWindow: 32000, outputLimit: 4096,
    toolCall: true, reasoning: false, inputModalities: ['text'], reasoningOptions: null, reasoningOptionsStatus: 'missing', catalogVersion: 1})};
  await plugin.init({scope: {type: 'route', routeId: '/codex/'}, services: {
    consume: () => conversionService(capabilities as any, true),
    rpc: {consume: (provider: string) => provider === 'codex-router' ? {get: async () => {queries++; return etag;}} : {}},
  }} as any);
  const hooks = createPluginHooks(); plugin.register(hooks);
  const controller = new AbortController();
  const post = {...request('POST'), signal: controller.signal, targets: [{type: 'route' as const, id: 'target'}]}; post.context.body = {model: 'native', input: 'hello'} as any;
  const decision = await hooks.onDispatchRequest.promise(post);
  expect(decision).toBeDefined();
  const entry = await rawResponse(hooks, new Response('entry', {headers: {'x-models-etag': 'upstream'}}), post);
  expect(entry.headers.has('x-models-etag')).toBe(false); expect(queries).toBe(0);
  const prepared = await decision!.prepareRequest!({...post, executeAuxiliary: async () => {throw new Error('unexpected auxiliary call');}});
  const adapterHooks = createPluginHooks(); prepared.adapter!.register(adapterHooks);
  const response = await rawResponse(adapterHooks, new Response('final target'), post);
  expect(response.headers.get('x-models-etag')).toBe(etag); expect(queries).toBe(1);
  const invalid = request('POST');
  await expect(hooks.onDispatchRequest.promise(invalid)).rejects.toThrow('target_unavailable');
  const invalidResponse = await rawResponse(hooks, new Response('failure'), invalid);
  expect(invalidResponse.headers.has('x-models-etag')).toBe(false); expect(queries).toBe(1);
  controller.abort();
  expect((await rawResponse(adapterHooks, new Response('cancelled metadata'), post)).headers.has('x-models-etag')).toBe(false);
});


test('model hooks reuse fresh snapshots, revalidate upstream ETags and renew a 304 for ten minutes', async () => {
  let now = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const {hooks} = await router(new CatalogValidators(() => now));
    // Nine synthetic models match the observed ~570 kB directory without production instructions.
    const native = {models: Array.from({length: 9}, (_, i) => ({slug: `native-${i}`, base_instructions: '中'.repeat(21_100)}))};
    const bytes = Buffer.byteLength(JSON.stringify(native), 'utf8');
    expect(bytes).toBeGreaterThan(568_000); expect(bytes).toBeLessThan(572_000);
    const directory = async () => {
      const input = request('GET', '0.162.0');
      input.context.headers.Version = '0.162.0-alpha.17.2';
      input.context.headers['If-None-Match'] = '"client-validator"';
      input.context.headers['If-Modified-Since'] = 'yesterday';
      await hooks.onDispatchRequest.promise(input);
      await hooks.onBeforeRequest.promise(input.context);
      return input;
    };
    const publish = async (input: ReturnType<typeof request>, response: Response, body = native) => hooks.onResponse.promise(response,
      {...input.context, response, latencyMs: 0, bodyHandle: {json: async () => body}} as any);
    const first = await directory();
    expect(first.context.headers['If-None-Match']).toBeUndefined();
    expect(first.context.headers['If-Modified-Since']).toBeUndefined();
    expect(await hooks.onInterceptRequest.promise(first.context)).toBeUndefined();
    const initial = await publish(first, Response.json(native, {headers: {etag: 'W/"upstream"'}}));
    const downstreamEtag = initial.headers.get('etag');
    expect(downstreamEtag).not.toBe('W/"upstream"');
    const post = request('POST', '0.162.0-alpha.17.2');
    await hooks.onDispatchRequest.promise(post);
    expect((await rawResponse(hooks, new Response('unchanged'), post)).headers.get('x-models-etag')).toBe(downstreamEtag);
    const otherVersion = request('GET', '0.162.0-alpha.17.2');
    await hooks.onDispatchRequest.promise(otherVersion); await hooks.onBeforeRequest.promise(otherVersion.context);
    expect(otherVersion.context.headers['if-none-match']).toBeUndefined();
    expect(await hooks.onInterceptRequest.promise(otherVersion.context)).toBeUndefined();
    now = 599_999;
    const fresh = await directory();
    const hit = await hooks.onInterceptRequest.promise(fresh.context);
    expect(hit?.action).toBe('respond');
    if (hit?.action !== 'respond') throw new Error('missing cache hit');
    expect(await hit.response.json()).toEqual(native);
    expect(hit.response.headers.get('etag')).toBe(downstreamEtag);
    now = 600_000;
    const stale = await directory();
    expect(stale.context.headers['if-none-match']).toBe('W/"upstream"');
    expect(await hooks.onInterceptRequest.promise(stale.context)).toBeUndefined();
    const completion = Promise.resolve({status: 'completed' as const});
    const restored = await hooks.onRawResponse.promise({response: new Response(null, {status: 304}), completion},
      {...stale.context, signal: stale.signal} as any);
    expect(restored.completion).toBe(completion); expect(restored.response.status).toBe(200);
    const final = await publish(stale, restored.response, await restored.response.json() as any);
    expect(final.headers.get('etag')).toBe(downstreamEtag);
    now = 1_199_999;
    expect((await hooks.onInterceptRequest.promise((await directory()).context))?.action).toBe('respond');
    now = 1_200_000;
    expect(await hooks.onInterceptRequest.promise((await directory()).context)).toBeUndefined();
  } finally { clock.mockRestore(); }
});

test('explicit revalidation uses only the upstream ETag, updates the snapshot, and auth failures invalidate it', async () => {
  const {hooks, plugin} = await router(new CatalogValidators());
  const native = {models: [{slug: 'before'}]};
  const directory = async (force = false, version = '0.162.1') => {
    const input = request('GET', version);
    if (force) input.context.headers['cache-control'] = 'no-cache';
    await hooks.onDispatchRequest.promise(input); await hooks.onBeforeRequest.promise(input.context);
    return input;
  };
  const publish = async (input: ReturnType<typeof request>, body: unknown, upstreamEtag?: string) => hooks.onResponse.promise(
    Response.json(body, {headers: upstreamEtag ? {etag: upstreamEtag} : {}}),
    {...input.context, latencyMs: 0, bodyHandle: {json: async () => body}} as any);
  const first = await directory(); await publish(first, native, '"upstream-before"');
  const force = await directory(true);
  expect(await hooks.onInterceptRequest.promise(force.context)).toBeUndefined();
  expect(force.context.headers['if-none-match']).toBe('"upstream-before"');
  await publish(force, {models: [{slug: 'after'}]}, '"upstream-after"');
  const hit = await hooks.onInterceptRequest.promise((await directory()).context);
  if (hit?.action !== 'respond') throw new Error('missing cache hit');
  expect(await hit.response.json()).toEqual({models: [{slug: 'after'}]});
  expect(await hooks.onInterceptRequest.promise((await directory(false, 'different-client')).context)).toBeUndefined();
  for (const status of [401, 403]) {
    const refresh = await directory(true);
    await hooks.onRawResponse.promise({response: new Response(null, {status}), completion: Promise.resolve({status: 'completed'})}, {...refresh.context, signal: refresh.signal} as any);
    const missing = await directory(); expect(missing.context.headers['if-none-match']).toBeUndefined();
    expect(await hooks.onInterceptRequest.promise(missing.context)).toBeUndefined();
    await publish(missing, native);
  }
  const withoutEtag = await directory(true);
  expect(withoutEtag.context.headers['if-none-match']).toBeUndefined();
  await expect(hooks.onRawResponse.promise({response: new Response(null, {status: 304}), completion: Promise.resolve({status: 'completed'})},
    {...withoutEtag.context, signal: withoutEtag.signal} as any)).rejects.toThrow('without_snapshot');
  plugin.reset();
  expect(await hooks.onInterceptRequest.promise((await directory()).context)).toBeUndefined();
});


test('oversized model directories remain deliverable, replace old snapshots and are not cached', async () => {
  const {hooks} = await router(new CatalogValidators());
  const load = async (native: unknown) => {
    const input = request();
    input.context.headers['cache-control'] = 'no-cache';
    await hooks.onDispatchRequest.promise(input); await hooks.onBeforeRequest.promise(input.context);
    const result = await hooks.onResponse.promise(Response.json(native, {headers: {etag: '"upstream"'}}),
      {...input.context, latencyMs: 0, bodyHandle: {json: async () => native}} as any);
    expect(result.status).toBe(200); expect(await result.json()).toEqual(native);
  };
  await load({models: []});
  await load({models: [{slug: 'large', description: 'x'.repeat(32 * 1024 * 1024)}]});
  const next = request(); await hooks.onDispatchRequest.promise(next); await hooks.onBeforeRequest.promise(next.context);
  expect(next.context.headers['if-none-match']).toBeUndefined();
  expect(await hooks.onInterceptRequest.promise(next.context)).toBeUndefined();
});

test('failed or cancelled refreshes do not publish a fresh model snapshot', async () => {
  let now = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const {hooks} = await router(new CatalogValidators(() => now));
    const directory = async (signal = new AbortController().signal) => {
      const input = {...request(), signal};
      await hooks.onDispatchRequest.promise(input); await hooks.onBeforeRequest.promise(input.context);
      return input;
    };
    const first = await directory();
    await hooks.onResponse.promise(Response.json({models: []}, {headers: {etag: '"upstream"'}}),
      {...first.context, latencyMs: 0, bodyHandle: {json: async () => ({models: []})}} as any);
    now = 600_000;
    const expired = await directory();
    const failed = new Response(null, {status: 500});
    expect(await hooks.onResponse.promise(failed, {...expired.context} as any)).toBe(failed);
    const retry = await directory();
    expect(retry.context.headers['if-none-match']).toBe('"upstream"');
    expect(await hooks.onInterceptRequest.promise(retry.context)).toBeUndefined();
    const controller = new AbortController(), cancelled = await directory(controller.signal);
    await hooks.onResponse.promise(Response.json({models: [{slug: 'cancelled'}]}),
      {...cancelled.context, latencyMs: 0, bodyHandle: {json: async () => {controller.abort(); return {models: [{slug: 'cancelled'}]};}}} as any);
    expect(await hooks.onInterceptRequest.promise((await directory()).context)).toBeUndefined();
  } finally { clock.mockRestore(); }
});
