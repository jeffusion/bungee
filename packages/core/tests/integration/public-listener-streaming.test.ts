import { afterEach, describe, expect, test } from 'bun:test';
import { restoreWorkerTransportRequest } from '../../src/config-worker/private-transport';
import { createPublicListener, forwardPublicRequest, WorkerAdmissionRegistry } from '../../src/public-listener';
import { servingWorker } from '../fixtures/public-listener';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
import { NEXT_AUTHORIZATION_HEADER } from '../../src/master-runtime/control-api-auth';

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

function startPublic(registry: WorkerAdmissionRegistry): { readonly url: string; readonly port: number } {
  const listener = createPublicListener({ admission: registry, transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    hostname: '127.0.0.1', port: 0 });
  listener.start();
  const port = listener.port;
  if (port === null) throw new Error('public listener did not expose its port');
  servers.push({ stop: () => listener.stop() });
  return { url: `http://127.0.0.1:${port}`, port };
}

describe('public listener streaming and admission snapshots', () => {
  test('strips the control next-authorization header from unmatched proxy requests', async () => {
    // Given
    let forwardedNextAuthorization: string | null = 'not-called';
    const worker = privateServer((request) => {
      forwardedNextAuthorization = request.headers.get(NEXT_AUTHORIZATION_HEADER);
      return Response.json({ forwarded: true });
    });
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([servingWorker(0, serverPort(worker))]).commit();
    const listener = createPublicListener({
      admission: registry,
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      hostname: '127.0.0.1',
      port: 0,
      controlApi: { async handle() { return null; } },
    });
    listener.start();
    if (listener.port === null) throw new Error('public listener did not expose its port');
    servers.push({ stop: () => listener.stop() });

    // When
    const response = await fetch(`http://127.0.0.1:${listener.port}/not-control`, {
      headers: { [NEXT_AUTHORIZATION_HEADER]: 'Bearer must-not-forward' },
    });

    // Then
    expect(response.status).toBe(200);
    expect(forwardedNextAuthorization).toBeNull();
  });

  test('streams a large chunked request incrementally without buffering', async () => {
    // Given
    let firstRequestChunk: (() => void) | undefined;
    const requestChunkSeen = new Promise<void>((resolve) => { firstRequestChunk = resolve; });
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const worker = privateServer(async (request) => {
      const reader = request.body?.getReader();
      const first = await reader?.read();
      firstRequestChunk?.();
      await requestGate;
      let received = first?.value?.byteLength ?? 0;
      for (;;) {
        const next = await reader?.read();
        if (next === undefined || next.done) break;
        received += next.value.byteLength;
      }
      return new Response(String(received));
    });
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([servingWorker(0, serverPort(worker))]).commit();
    const publicServer = startPublic(registry);
    let sendSecondChunk: (() => void) | undefined;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024).fill(1));
      sendSecondChunk = () => {
        controller.enqueue(new Uint8Array(256 * 1024).fill(2));
        controller.close();
      };
    } });

    // When
    const pending = fetch(`${publicServer.url}/stream`, { method: 'POST', body });
    await requestChunkSeen;
    sendSecondChunk?.();
    releaseRequest?.();
    const response = await pending;

    // Then
    expect(await response.text()).toBe(String(512 * 1024));
  });

  test('streams SSE response chunks incrementally', async () => {
    // Given
    let releaseResponse: (() => void) | undefined;
    const worker = privateServer(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      releaseResponse = () => {
        controller.enqueue(new TextEncoder().encode('data: second\n\n'));
        controller.close();
      };
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([servingWorker(0, serverPort(worker))]).commit();
    const publicServer = startPublic(registry);

    // When
    const response = await fetch(`${publicServer.url}/events`);
    const reader = response.body?.getReader();
    const first = await reader?.read();

    // Then
    expect(new TextDecoder().decode(first?.value)).toBe('data: first\n\n');
    releaseResponse?.();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('data: second\n\n');
  });

  test('propagates client abort to the selected private request', async () => {
    // Given
    let privateStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { privateStarted = resolve; });
    let privateAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => { privateAborted = resolve; });
    const worker = privateServer(async (request) => {
      privateStarted?.();
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => {
        privateAborted?.();
        resolve();
      }, { once: true }));
      return new Response(null, { status: 499 });
    });
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([servingWorker(0, serverPort(worker))]).commit();
    const publicServer = startPublic(registry);
    const controller = new AbortController();
    const pending = fetch(`${publicServer.url}/abort`, { signal: controller.signal });

    // When
    await started;
    controller.abort();

    // Then
    let rejection: unknown;
    try {
      await pending;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    await aborted;
  });

  test('rejects CONNECT and websocket upgrade without contacting a worker', async () => {
    // Given
    let backendRequests = 0;
    const worker = privateServer(() => { backendRequests += 1; return new Response('unexpected'); });
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([servingWorker(0, serverPort(worker))]).commit();
    const publicServer = startPublic(registry);

    // When
    const connectResponse = await forwardPublicRequest(new Request('http://public.example/tunnel', { method: 'CONNECT' }), {
      admission: registry, transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    });
    const upgradeResponse = await Bun.fetch(`${publicServer.url}/socket`, {
      headers: { connection: 'Upgrade', upgrade: 'websocket' },
    });

    // Then
    expect(connectResponse.status).toBe(405);
    expect(upgradeResponse.status).toBe(426);
    expect(upgradeResponse.headers.get('upgrade')).toBe('websocket');
    expect(backendRequests).toBe(0);
  });

  test('lets an old selected request finish while new admissions receive all later requests', async () => {
    // Given
    let oldStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { oldStarted = resolve; });
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oldWorker = privateServer(async () => { oldStarted?.(); await oldGate; return new Response('old'); });
    const newWorker = privateServer(() => new Response('new'));
    const registry = new WorkerAdmissionRegistry();
    registry.prepare([servingWorker(0, serverPort(oldWorker))]).commit();
    const publicServer = startPublic(registry);
    const inFlight = fetch(`${publicServer.url}/selected`);
    await started;

    // When
    registry.prepare([servingWorker(0, serverPort(newWorker))]).commit();
    const drain = oldWorker.stop(false);
    const later = await Promise.all([
      fetch(`${publicServer.url}/one`).then((response) => response.text()),
      fetch(`${publicServer.url}/two`).then((response) => response.text()),
    ]);
    releaseOld?.();

    // Then
    expect(later).toEqual(['new', 'new']);
    expect(await inFlight.then((response) => response.text())).toBe('old');
    await drain;
  });
});
