import { afterEach, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER,
  INTERNAL_TRANSPORT_TOKEN_HEADER,
  restoreWorkerTransportRequest,
} from '../../src/config-worker/private-transport';
import {
  createPublicListener,
  PublicListenerLifecycleError,
  WorkerAdmissionRegistry,
} from '../../src/public-listener';
import { servingWorker } from '../fixtures/public-listener';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';

type Stoppable = { stop(closeActiveConnections?: boolean): Promise<void> | void };
const servers: Stoppable[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function privateServer(fetch: (request: Request) => Response | Promise<Response>): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const restored = restoreWorkerTransportRequest(request, TEST_WORKER_TRANSPORT_SECRET);
    if (!restored.ok) return new Response(null, { status: restored.status });
    return fetch(restored.request);
  } });
  servers.push(server);
  return server;
}

function serverPort(server: ReturnType<typeof Bun.serve>): number {
  if (server.port === undefined) throw new Error('server did not expose its port');
  return server.port;
}

function startPublic(registry: WorkerAdmissionRegistry): { readonly url: string; readonly stop: () => Promise<void> } {
  const listener = createPublicListener({
    admission: registry,
    transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    hostname: '127.0.0.1',
    port: 0,
  });
  listener.start();
  const port = listener.port;
  if (port === null) throw new Error('public listener did not expose its port');
  servers.push({ stop: () => listener.stop() });
  return { url: `http://127.0.0.1:${port}`, stop: () => listener.stop() };
}

describe('public listener protocol forwarding', () => {
  test('binds only on start, exposes the actual port, and cannot start twice', async () => {
    // Given
    const listener = createPublicListener({
      admission: new WorkerAdmissionRegistry(),
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      hostname: '127.0.0.1',
      port: 0,
    });

    // When / Then
    expect(listener.port).toBeNull();
    listener.start();
    expect(listener.port).toBeGreaterThan(0);
    expect(() => listener.start()).toThrow(PublicListenerLifecycleError);
    await listener.stop();
    expect(listener.port).toBeNull();
  });

  test('returns sanitized 503 without workers and 502 without retrying a refused worker', async () => {
    // Given
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([servingWorker(0, 41_000)]).commit();
    registry.clear();
    const publicServer = startPublic(registry);

    // When / Then
    const unavailable = await fetch(`${publicServer.url}/empty`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('1');
    expect(await unavailable.json()).toEqual({ error: 'service_unavailable' });

    const refused = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const refusedPort = serverPort(refused);
    await refused.stop(true);
    const healthy = privateServer(() => new Response('healthy'));
    registry.prepare([servingWorker(0, refusedPort), servingWorker(1, serverPort(healthy))]).commit();
    const failure = await fetch(`${publicServer.url}/once`);
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({ error: 'bad_gateway' });
    expect(await fetch(`${publicServer.url}/next`).then((response) => response.text())).toBe('healthy');
  });

  test('restores public URL and authority while stripping internal and hop-by-hop request headers', async () => {
    // Given
    const registry = new WorkerAdmissionRegistry();
    const worker = privateServer((request) => Response.json({
      url: request.url,
      host: request.headers.get('host'),
      authorization: request.headers.get('authorization'),
      nominated: request.headers.get('x-remove-me'),
      proxyAuthorization: request.headers.get('proxy-authorization'),
      token: request.headers.get(INTERNAL_TRANSPORT_TOKEN_HEADER),
      original: request.headers.get(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER),
    }));
    registry.prepare([servingWorker(0, serverPort(worker))]).commit();
    const publicServer = startPublic(registry);

    // When
    const response = await fetch(`${publicServer.url}/path?q=a%20b`, {
      headers: {
        host: 'public.example:8443',
        authorization: 'Bearer public',
        connection: 'x-remove-me, bad name',
        'x-remove-me': 'private',
        'proxy-authorization': 'private-proxy',
        [INTERNAL_TRANSPORT_TOKEN_HEADER]: 'client-value',
        [INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER]: 'https://evil.example/',
      },
    });

    // Then
    expect(await response.json()).toEqual({
      url: 'http://public.example:8443/path?q=a%20b',
      host: 'public.example:8443',
      authorization: 'Bearer public',
      nominated: null,
      proxyAuthorization: null,
      token: null,
      original: null,
    });
  });

  test('preserves redirects, gzip bytes, duplicate cookies, legal empty bodies, and response header policy', async () => {
    // Given
    const compressed = Uint8Array.from(gzipSync('compressed payload'));
    const registry = new WorkerAdmissionRegistry();
    const worker = privateServer((request) => {
      const path = new URL(request.url).pathname;
      if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/final' } });
      if (path === '/gzip') return new Response(compressed, { headers: {
        'content-encoding': 'gzip', 'content-length': String(compressed.byteLength),
      } });
      if (path === '/cookies') {
        const headers = new Headers();
        headers.append('set-cookie', 'a=1; Path=/');
        headers.append('set-cookie', 'b=2; Path=/');
        return new Response('cookies', { headers });
      }
      if (path === '/no-content') return new Response(null, { status: 204 });
      if (path === '/reset-content') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('must-not-arrive'));
        controller.close();
      } }), { status: 205 });
      if (path === '/not-modified') return new Response(null, { status: 304 });
      if (path === '/head') return new Response('must-not-arrive');
      return new Response('headers', { headers: {
        connection: 'x-response-secret, bad name',
        'x-response-secret': 'hidden',
        'proxy-authenticate': 'hidden-proxy-auth',
        'x-end-to-end': 'kept',
      } });
    });
    registry.prepare([servingWorker(0, serverPort(worker))]).commit();
    const publicServer = startPublic(registry);

    // When / Then
    const redirect = await fetch(`${publicServer.url}/redirect`, { redirect: 'manual' });
    expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/final']);
    const gzip = await fetch(`${publicServer.url}/gzip`, { decompress: false });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(gzip.headers.get('content-length')).toBe(String(compressed.byteLength));
    expect(new Uint8Array(await gzip.arrayBuffer())).toEqual(compressed);
    expect((await fetch(`${publicServer.url}/cookies`)).headers.getSetCookie()).toEqual([
      'a=1; Path=/', 'b=2; Path=/',
    ]);
    const headers = await fetch(`${publicServer.url}/headers`);
    expect(headers.status).toBe(200);
    expect(headers.headers.get('x-response-secret')).toBeNull();
    expect(headers.headers.get('connection')).toBeNull();
    expect(headers.headers.get('proxy-authenticate')).toBeNull();
    expect(headers.headers.get('x-end-to-end')).toBe('kept');
    expect(await fetch(`${publicServer.url}/no-content`).then(async (response) => [response.status, await response.text()])).toEqual([204, '']);
    expect(await fetch(`${publicServer.url}/reset-content`).then(async (response) => [response.status, await response.text()])).toEqual([205, '']);
    expect(await fetch(`${publicServer.url}/not-modified`).then(async (response) => [response.status, await response.text()])).toEqual([304, '']);
    expect(await fetch(`${publicServer.url}/head`, { method: 'HEAD' }).then((response) => response.text())).toBe('');
  });
});
