import {startAnonymousAdmission} from '../helpers/anonymous-admission';
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@jeffusion/bungee-types';
import { ensureDataPlaneSchema, dataPlaneBodyLogDir } from '../helpers/data-plane-runtime';
import { BodyStorageManager } from '../../src/logger/body-storage';
import { ScopedPluginRegistry, setScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { createIngressPublicListener } from '../../src/public-listener';
import { restoreWorkerTransportRequest } from '../../src/config-worker/private-transport';
import { CODEX_MAX_SSE_LINE_BYTES } from '../../../../plugins/chatgpt-oauth/server/codex-protocol';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
import { localAdmissionSelector } from '../fixtures/public-listener';

test('Codex large response and durable failure diagnostics survive with bounded independent body logging', async () => {
  await ensureDataPlaneSchema();
  const [{ handleRequest }, runtime, { accessLogWriter }, { fileLogWriter }] = await Promise.all([
    import('../../src/worker/request/handler'),
    import('../../src/worker/state/runtime-state'),
    import('../../src/logger/access-log-writer'),
    import('../../src/logger/file-log-writer'),
  ]);
  const originalFetch = global.fetch;
  const bodyStorage = new BodyStorageManager({ enabled: true, maxSize: 5 * 1024 * 1024 }, dataPlaneBodyLogDir);
  const routeId = '/codex/v1/responses';
  let upstreamRequests = 0;
  let eventSize = 20 * 1024 * 1024;
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    await req.arrayBuffer();
    upstreamRequests++;
    const bytes = new TextEncoder().encode([
      'data: {"type":"response.created","response":{"id":"replay"}}\n\n',
      eventSize > CODEX_MAX_SSE_LINE_BYTES ? ':'.repeat(eventSize) + '\n\n' : `data: ${JSON.stringify({ type: 'response.output_item.done', item: {
        type: 'reasoning', encrypted_content: 'x'.repeat(eventSize),
      } })}\n\n`,
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      'data: [DONE]\n\n',
    ].join(''));
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
      offset = Math.min(bytes.length, offset + 64 * 1024);
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  // Route the provider hostname to a local mock. Both transport hops still use HTTP.
  global.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return originalFetch(url.hostname === 'chatgpt.com' ? `http://127.0.0.1:${upstream.port}${url.pathname}` : input, init);
  }) as typeof fetch;
  const config: AppConfig = {
    body_parser_limit: '25mb',
    logging: { body: { enabled: true, max_size: 5 * 1024 * 1024, retention_days: 1 } },
    services: [{ name: 'response-replay', endpoints: [{ id: 'primary', target: 'https://chatgpt.com' }] }],
    routes: [{ path: routeId, service: 'response-replay', path_rewrite: { '^/codex': '' } }],
  };
  const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: Number.MAX_SAFE_INTEGER, fetch(req) {
    const restored = restoreWorkerTransportRequest(req, TEST_WORKER_TRANSPORT_SECRET);
    return restored.ok
      ? handleRequest(restored.request, config, { logging: { accessLogWriter, fileLogWriter, bodyStorage } })
      : new Response(null, { status: restored.status });
  } });
  const listener = createIngressPublicListener({
    admission: localAdmissionSelector(() => ({ private_port: worker.port! })),
    transportSecret: TEST_WORKER_TRANSPORT_SECRET, hostname: '127.0.0.1', port: 0,
  });
  const stopAdmission = await startAnonymousAdmission();
  listener.start();
  try {
    for (const limited of [false, true]) {
      const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../../', import.meta.url)));
      await registry.createInstance({ type: 'upstream', routeId, upstreamId: 'primary' }, {
        name: 'chatgpt-oauth', options: { accountRef: 'replay-account' },
      } as any);
      setScopedPluginRegistry(registry);
      runtime.initializeRuntimeState(config);
      eventSize = limited ? CODEX_MAX_SSE_LINE_BYTES + 1 : 20 * 1024 * 1024;
      try {
        const response = await originalFetch(`http://127.0.0.1:${listener.port}${routeId}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'codex', stream: true, input: limited ? 'hi' : 'x'.repeat(20 * 1024 * 1024) }),
        });
        expect(response.status).toBe(200);
        if (limited) {
          await expect(response.text()).rejects.toBeInstanceOf(Error);
        } else {
          const text = await response.text();
          expect(text.length).toBeGreaterThan(20 * 1024 * 1024);
          expect(text).toContain('response.completed');
        }
        await accessLogWriter.flush();
        const row = accessLogWriter.getDatabase().query('SELECT * FROM access_logs WHERE path=? ORDER BY id DESC LIMIT 1').get(routeId) as Record<string, any>;
        expect(row).toMatchObject({ status: 200, success: limited ? 0 : 1, protocol_outcome: limited ? 'failed' : 'completed' });
        expect(row.resp_body_id).toBeNull();
        expect(JSON.parse(row.processing_steps)).toContainEqual(expect.objectContaining({ step: 'body_logging_incomplete', detail: expect.objectContaining({ observer_incomplete: true }) }));
        if (limited) {
          expect(row.error_message).toBe('Response stream failed (body_limit)');
        } else {
          expect(row.original_req_body_id).toBeNull();
          expect(JSON.parse(row.processing_steps)).toContainEqual(expect.objectContaining({
            step: 'body_logging_incomplete', detail: expect.objectContaining({ direction: 'original-request', reason: 'size_limit' }),
          }));
        }
        expect(runtime.getActiveRequestCount('response-replay', 'primary')).toBe(0);
      } finally {
        runtime.runtimeState.clear();
        setScopedPluginRegistry(null);
        await registry.destroy();
      }
    }
    expect(upstreamRequests).toBe(2);
  } finally {
    await stopAdmission();
    global.fetch = originalFetch;
    await listener.stop();
    await worker.stop(true);
    await upstream.stop(true);
    await accessLogWriter.flush();
    accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE path=?').run(routeId);
  }
}, 30_000);
