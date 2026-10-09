import { describe, test, expect } from 'bun:test';
import { createRequestSnapshot, readSnapshotJson, RequestBodyTooLargeError } from '../src/worker/request/snapshot';
import { createPluginHooks } from '../src/hooks';
import { getScopedPluginRegistry, setScopedPluginRegistry } from '../src/scoped-plugin-registry';
import { initializeRuntimeState, runtimeState } from '../src/worker/state/runtime-state';
import { handleRequest } from '../src/worker/request/handler';

const encoder = new TextEncoder();
describe('Request Snapshot', () => {
  test('创建元数据快照不读正文、不 clone，也不根据 Content-Type 解析', async () => {
    let reads = 0;
    const req = new Request('https://example.com/api', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token123' },
      body: new ReadableStream({ pull(controller) { reads++; controller.enqueue(encoder.encode('{invalid')); controller.close(); } }, { highWaterMark: 0 }),
    });
    req.clone = () => { throw new Error('snapshot must not clone'); };
    const snapshot = await createRequestSnapshot(req);
    try {
      expect(snapshot).toMatchObject({ method: 'POST', url: req.url, content_type: 'application/json', is_json_body: false });
      expect(snapshot.headers.authorization).toBe('Bearer token123');
      expect(snapshot.body).toBeUndefined();
      expect(req.bodyUsed).toBe(false);
      expect(reads).toBe(0);
      expect(await new Response(snapshot.bodySource!.take()).text()).toBe('{invalid');
      expect(reads).toBe(1);
    } finally { snapshot.bodySource!.dispose(); }
  });

  test('JSON 视图按需求读取一次，重复发送保留原始字节', async () => {
    const wire = '{ "model": "gpt-4", "nested": { "value": 42 } }';
    const req = new Request('https://example.com/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: wire });
    const snapshot = await createRequestSnapshot(req);
    try {
      const body = await readSnapshotJson(snapshot, 'test-json-read');
      expect(body).toEqual({ model: 'gpt-4', nested: { value: 42 } });
      expect(await readSnapshotJson(snapshot, 'second-read')).toBe(body);
      expect(snapshot.bodySource!.replayable).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) expect(await new Response(snapshot.bodySource!.take()).text()).toBe(wire);
    } finally { snapshot.bodySource!.dispose(); }
  });

  test('非 JSON 正文保留原始二进制字节', async () => {
    const bytes = new Uint8Array([0, 255, 128, 4]);
    const snapshot = await createRequestSnapshot(new Request('https://example.com/api', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes }));
    try {
      expect(snapshot.body).toBeUndefined();
      expect(snapshot.is_json_body).toBe(false);
      expect(new Uint8Array(await new Response(snapshot.bodySource!.take()).arrayBuffer())).toEqual(bytes);
    } finally { snapshot.bodySource!.dispose(); }
  });

  test('Content-Length 超限仍在读取前拒绝', async () => {
    const req = new Request('https://example.com/api', { method: 'POST', headers: { 'content-length': String(51 * 1024 * 1024) }, body: 'x' });
    await expect(createRequestSnapshot(req)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(req.bodyUsed).toBe(false);
  });

  test('无正文保持 undefined 和 empty 所有权', async () => {
    const snapshot = await createRequestSnapshot(new Request('https://example.com/api'));
    try { expect(snapshot.body).toBeUndefined(); expect(snapshot.bodySource!.mode).toBe('empty'); expect(snapshot.bodySource!.take()).toBeNull(); }
    finally { snapshot.bodySource!.dispose(); }
  });

  test('真实 failover 的每次尝试隔离可变 JSON，深层修改不污染下次尝试', async () => {
    const previousRegistry = getScopedPluginRegistry();
    const previousFetch = global.fetch;
    const initialValues: number[] = [];
    const sentBodies: unknown[] = [];
    const hooks = createPluginHooks();
    hooks.onBeforeRequest.tapPromise('mutate-attempt', async ctx => { initialValues.push(ctx.body.nested.value); ctx.body.nested.value++; return ctx; });
    const handler = { pluginName: 'mutate-attempt', config: {}, bodyRequirements() { return { request: 'json-write' as const }; }, register() {} };
    const phase = { handlers: [handler], hooks, hasInterceptCallbacks: false, hasResponseCallbacks: false, hasRawResponseCallbacks: false, hasStreamCallbacks: false, metadata: { createdAt: 0, pluginCount: 1, pluginNames: ['mutate-attempt'], scope: 'upstream' } };
    const empty = { ...phase, handlers: [], hooks: createPluginHooks(), metadata: { ...phase.metadata, pluginCount: 0, pluginNames: [] } };
    const inbound = { async onResponse(res: Response) { return res; }, async onRawResponse(result: any) { return result; }, async onStreamChunk(chunk: any) { return [chunk]; }, async onFlushStream(chunks: any[]) { return chunks; }, async onError() {} };
    setScopedPluginRegistry({ runWithRequestLeases<T>(_leases: ReadonlyMap<string, () => void>, run: () => T): T { return run(); }, async dispatchRequest() { return undefined; }, getPrecompiledHooks() { return { routePhase: empty, upstreamPhase: phase, servicePhase: null, globalPrecompiled: null, routePrecompiled: empty, inbound }; }, getGlobalAdmissionHandlers() { return []; }, getAttemptObservationOwners() { return []; } } as any);
    const config = { services: [{ name: 'snapshot-isolation', failover: { enabled: true, retry_on: [503] }, endpoints: [{ id: 'a', target: 'http://snapshot-a.test', priority: 1 }, { id: 'b', target: 'http://snapshot-b.test', priority: 2 }] }], routes: [{ path: '/snapshot-isolation', service: 'snapshot-isolation' }] };
    initializeRuntimeState(config);
    global.fetch = (async (_input: any, init: RequestInit) => { sentBodies.push(JSON.parse(init.body as string)); return new Response('ok', { status: sentBodies.length === 1 ? 503 : 200 }); }) as any;
    try {
      const response = await handleRequest(new Request('http://local/snapshot-isolation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nested":{"value":42}}' }), config, { logging: { accessLogWriter: { write() {}, updateResponseBodyId() {}, updateProtocolOutcome() {} }, fileLogWriter: { async write() {} } } });
      expect(response.status).toBe(200); await response.text();
      expect(initialValues).toEqual([42, 42]); expect(sentBodies).toEqual([{ nested: { value: 43 } }, { nested: { value: 43 } }]);
    } finally { global.fetch = previousFetch; setScopedPluginRegistry(previousRegistry); runtimeState.clear(); }
  });
});
