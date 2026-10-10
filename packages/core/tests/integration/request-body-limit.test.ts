import {startAnonymousAdmission} from '../helpers/anonymous-admission';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { ensureDataPlaneSchema, dataPlaneTestRoot } from '../helpers/data-plane-runtime';
import { BodyStorageManager } from '../../src/logger/body-storage';
import { HeaderStorageManager } from '../../src/logger/header-storage';
import type { RequestLoggerDependencies } from '../../src/logger/request-logger';
import { loadProductionResources } from '../../src/config-worker/lifecycle';
import { createIngressPublicListener, type PublicListener } from '../../src/public-listener';
import { restoreWorkerTransportRequest } from '../../src/config-worker/private-transport';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
import { localAdmissionSelector } from '../fixtures/public-listener';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

let handleRequest: typeof import('../../src/worker/request/handler').handleRequest;
let accessLogWriter: typeof import('../../src/logger/access-log-writer').accessLogWriter;
let fileLogWriter: typeof import('../../src/logger/file-log-writer').fileLogWriter;
const servers: Array<{ stop(force?: boolean): Promise<void> | void }> = [];
const paths: string[] = [];
const bodyStorage = new BodyStorageManager({ enabled: true, maxSize: 16 }, join(dataPlaneTestRoot, 'limit-bodies'));
const headerStorage = new HeaderStorageManager({}, join(dataPlaneTestRoot, 'limit-headers'));

beforeAll(async () => {
  await ensureDataPlaneSchema();
  ({ handleRequest } = await import('../../src/worker/request/handler'));
  ({ accessLogWriter } = await import('../../src/logger/access-log-writer'));
  ({ fileLogWriter } = await import('../../src/logger/file-log-writer'));
}, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  await accessLogWriter.flush();
  for (const path of paths.splice(0)) accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE path=?').run(path);
}, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

function logging(): RequestLoggerDependencies {
  return { accessLogWriter, fileLogWriter, bodyStorage, headerStorage };
}

function uniquePath(): string {
  const path = `/body-limit-${crypto.randomUUID()}`;
  paths.push(path);
  return path;
}

describe('request body limits and error records', () => {
  test('returns one logged 413 with a saved response for declared and chunked oversized bodies', async () => {
    for (const declared of [true, false]) {
      const path = uniquePath();
      // A necessary rule reads the chunked body before upstream selection.
      const config: AppConfig = { body_parser_limit: '1kb', routes: [{ path, endpoints: [], request:{headers:{add:{'x-check':'{{body.checked}}'}}} }] };
      const body = JSON.stringify({ data: 'x'.repeat(1024) });
      const req = new Request(`http://localhost${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': String(body.length) } : {}) },
        body: declared ? body : new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(body)); controller.close();
        } }),
      });
      const response = await handleRequest(req, config, { logging: logging() });
      expect(response.status).toBe(413);
      const responseBody = await response.json();
      expect(responseBody).toMatchObject({ code: 'request_body_too_large', limit_bytes: 1024, received_bytes: body.length });
      await accessLogWriter.flush();
      const rows = accessLogWriter.getDatabase().query('SELECT * FROM access_logs WHERE path=?').all(path) as Record<string, any>[];
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({ status: 413, success: 0, upstream: null, request_type: 'final',
        protocol_outcome: 'failed', protocol_code: 'request_body_too_large', error_message: responseBody.message,
        original_req_body_id: null, req_body_id: null });
      expect(JSON.parse(row.processing_steps).at(-1).step).toBe('request_body_rejected');
      // Error responses are saved even when the independent log size limit is smaller.
      expect(await bodyStorage.load(row.resp_body_id)).toEqual(responseBody);
      const responseHeaders = await headerStorage.load(row.resp_header_id);
      expect(responseHeaders).not.toBeNull();
      expect(responseHeaders!['content-type']).toStartWith('application/json');
    }
  }, 15_000);

  test('forwards a 20MB JSON body through ingress and a production worker with a 25MB global limit', async () => {
    const path = uniquePath();
    let upstreamCalls = 0;
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      upstreamCalls += 1;
      const value = await req.json() as { data: string };
      return Response.json({ bytes: value.data.length });
    } });
    servers.push(upstream);
    const resources = await loadProductionResources();
    const config: AppConfig = { body_parser_limit: '25mb', logging: { body: { enabled: true, max_size: 16, retention_days: 1 } },
      routes: [{ path, endpoints: [{ target: `http://127.0.0.1:${upstream.port}` }] }] };
    const worker = resources.serve(async request => {
      const restored = restoreWorkerTransportRequest(request, TEST_WORKER_TRANSPORT_SECRET);
      if (!restored.ok) return new Response(null, { status: restored.status });
      return handleRequest(restored.request, config, { logging: logging() });
    });
    servers.push(worker);
    const listener: PublicListener = createIngressPublicListener({
      admission: localAdmissionSelector(() => ({ private_port: worker.port! })),
      transportSecret: TEST_WORKER_TRANSPORT_SECRET, hostname: '127.0.0.1', port: 0,
    });
    const stopAdmission = await startAnonymousAdmission();
    listener.start();
    servers.push(listener);
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 'x'.repeat(20 * 1024 * 1024) }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ bytes: 20 * 1024 * 1024 });
      expect(upstreamCalls).toBe(1);
      await accessLogWriter.flush();
      const row = accessLogWriter.getDatabase().query('SELECT status,req_body_id,original_req_body_id FROM access_logs WHERE path=?').get(path);
      expect(row).toEqual({ status: 200, req_body_id: null, original_req_body_id: null });

      // Lowering the global limit must return a logged 413 through the same
      // transport, including when the incoming upload has no Content-Length.
      config.body_parser_limit = '1kb';
      for (const chunked of [false, true]) {
        const rejected = await fetch(`http://127.0.0.1:${listener.port}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: chunked ? new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: 'x'.repeat(1200) })));
            controller.close();
          } }) : JSON.stringify({ data: 'x'.repeat(1200) }),
        });
        expect(rejected.status).toBe(413);
        expect(await rejected.json()).toMatchObject({ code: 'request_body_too_large', limit_bytes: 1024 });
      }
      // A declared body above Bun's default transport ceiling must still reach
      // the serving worker's early check and produce the same logged JSON error.
      const transportRejection = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest(`http://127.0.0.1:${listener.port}${path}`, {
          method: 'POST', signal: AbortSignal.timeout(3000),
          headers: { 'content-type': 'application/json', 'content-length': String(129 * 1024 * 1024) },
        }, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
          response.on('error', reject);
        });
        request.on('error', reject);
        request.end('x');
      });
      expect(transportRejection.status).toBe(413);
      expect(JSON.parse(transportRejection.body)).toMatchObject({
        code: 'request_body_too_large', limit_bytes: 1024, received_bytes: 129 * 1024 * 1024,
      });
      // Declared oversize is rejected before dispatch; chunked oversize can
      // reach the upstream before the streaming counter rejects its body.
      expect(upstreamCalls).toBe(2);
      const { flushBodyCaptures } = await import('../../src/logger/body-capture');
      await flushBodyCaptures();
      await accessLogWriter.flush();
      const failures = accessLogWriter.getDatabase().query('SELECT resp_body_id,error_message FROM access_logs WHERE path=? AND status=413').all(path) as Record<string, any>[];
      expect(failures).toHaveLength(3);
      for (const failure of failures) {
        expect(failure.error_message).toBe('request_body_too_large');
        expect(await bodyStorage.load(failure.resp_body_id)).toMatchObject({ code: 'request_body_too_large' });
      }
    } finally {
      await stopAdmission();
      await resources.closeAccessLog();
      await resources.closeFileLog();
    }
  }, 30_000);

  test('uses the current global limit on subsequent requests', async () => {
    const path = uniquePath();
    const req = () => new Request(`http://localhost${path}`, { method: 'POST', body: 'x'.repeat(1500) });
    const upstream = Bun.serve({port:0,hostname:'127.0.0.1',async fetch(request){await request.arrayBuffer();return new Response('ok');}});
    servers.push(upstream);
    const routes: AppConfig['routes'] = [{ path, endpoints: [{target:upstream.url.origin}] }];
    const accepted=await handleRequest(req(), { routes, body_parser_limit: '2kb' }, { logging: logging() });
    expect(accepted.status).toBe(200);await accepted.text();
    expect((await handleRequest(req(), { routes, body_parser_limit: '1kb' }, { logging: logging() })).status).toBe(413);
  });
});
