import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { ensureDataPlaneSchema, dataPlaneBodyLogDir, dataPlaneFileLogDir } from '../helpers/data-plane-runtime';
import { BodyStorageManager } from '../../src/logger/body-storage';
import { ScopedPluginRegistry, setScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import { createIngressPublicListener } from '../../src/public-listener';
import { restoreWorkerTransportRequest } from '../../src/config-worker/private-transport';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';

test('OAuth HTTP and SSE diagnostics reach public clients, SQLite, file logs and body capture', async () => {
  await ensureDataPlaneSchema();
  const [{ handleRequest }, runtime, { accessLogWriter }, { fileLogWriter }] = await Promise.all([
    import('../../src/worker/request/handler'), import('../../src/worker/state/runtime-state'),
    import('../../src/logger/access-log-writer'), import('../../src/logger/file-log-writer'),
  ]);
  const originalFetch = global.fetch;
  const routeId = '/codex-diagnostics/v1/responses';
  const bodyStorage = new BodyStorageManager({ enabled: true, maxSize: 1024 * 1024 }, dataPlaneBodyLogDir);
  const config: AppConfig = {
    logging: { body: { enabled: true, max_size: 1024 * 1024, retention_days: 1 } },
    services: [{ name: 'diagnostics', failover: { enabled: true, retry_on: [503] },
      endpoints: [{ id: 'primary', target: 'https://chatgpt.com' }] }],
    routes: [{ path: routeId, service: 'diagnostics', path_rewrite: { '^/codex-diagnostics': '' } }],
  };
  let httpError = false;
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    await req.arrayBuffer();
    const error = { code: httpError ? 'usage_limit_reached' : 'server_error', type: 'upstream_error', message: 'Retry later; Bearer private-token' };
    return httpError
      ? new Response(JSON.stringify({ error, request: 'private-payload' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } })
      : new Response(`data: {"type":"response.created","response":{"id":"r1"}}\n\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error, output: 'private-payload' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  global.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return originalFetch(url.hostname === 'chatgpt.com' ? `http://127.0.0.1:${upstream.port}${url.pathname}` : input, init);
  }) as typeof fetch;
  const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../../', import.meta.url)));
  const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const restored = restoreWorkerTransportRequest(req, TEST_WORKER_TRANSPORT_SECRET);
    return restored.ok ? handleRequest(restored.request, config, { logging: { accessLogWriter, fileLogWriter, bodyStorage } })
      : new Response(null, { status: restored.status });
  } });
  const listener = createIngressPublicListener({ admission: { select: () => ({ private_port: worker.port! }) },
    transportSecret: TEST_WORKER_TRANSPORT_SECRET, hostname: '127.0.0.1', port: 0 });
  listener.start();
  try {
    await registry.createInstance({ type: 'upstream', routeId, upstreamId: 'primary' }, { name: 'chatgpt-oauth', options: { accountRef: 'diagnostic-account' } } as any);
    setScopedPluginRegistry(registry);
    for (const scenario of [
      { httpError: false, stream: true, failover: true },
      { httpError: false, stream: false, failover: true },
      { httpError: false, stream: false, failover: false },
      { httpError: true, stream: true, failover: true },
    ]) {
      httpError = scenario.httpError;
      config.services![0].failover!.enabled = scenario.failover;
      runtime.initializeRuntimeState(config);
      const response = await originalFetch(`http://127.0.0.1:${listener.port}${routeId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex', stream: scenario.stream, input: 'hi' }),
      });
      const text = await response.text();
      const code = httpError ? 'usage_limit_reached' : 'server_error';
      const expectedStatus = httpError ? 429 : scenario.stream ? 200 : 502;
      expect(response.status).toBe(expectedStatus);
      expect(text).toContain(code);
      expect(text).not.toContain('private-token');
      expect(text).not.toContain('private-payload');
      await accessLogWriter.flush();
      const row = accessLogWriter.getDatabase().query('SELECT * FROM access_logs WHERE path=? ORDER BY id DESC LIMIT 1').get(routeId) as Record<string, any>;
      expect(row).toMatchObject({ status: expectedStatus, success: 0, protocol_outcome: 'failed', protocol_code: httpError ? 'upstream_http_error' : 'failed' });
      expect(row.error_message).toContain(code);
      expect(row.error_message).toContain('Retry later');
      expect(row.error_message).not.toContain('private-token');
      expect(JSON.parse(row.processing_steps)).toContainEqual(expect.objectContaining({ step: 'response_error', detail: expect.objectContaining({ source: 'upstream', code }) }));
      const capture = await bodyStorage.load(row.resp_body_id);
      expect(JSON.stringify(capture)).toContain(code);
      expect(JSON.stringify(capture)).not.toContain('private-token');
      await fileLogWriter.flush();
      const lines = (await Bun.file(join(dataPlaneFileLogDir, `access-${new Date().toISOString().slice(0, 10)}.log`)).text()).trim().split('\n');
      const entry = lines.map(line => JSON.parse(line)).find(entry => entry.requestId === row.request_id);
      expect(entry).toMatchObject({ success: false, protocolOutcome: 'failed', errorMessage: row.error_message });
      expect(runtime.getActiveRequestCount('diagnostics', 'primary')).toBe(0);
    }
  } finally {
    global.fetch = originalFetch;
    await listener.stop(); await worker.stop(true); await upstream.stop(true);
    setScopedPluginRegistry(null); runtime.runtimeState.clear(); await registry.destroy();
    await accessLogWriter.flush();
    accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE path=?').run(routeId);
  }
}, 15_000);
