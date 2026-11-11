import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { restoreWorkerTransportRequest, generateWorkerTransportSecret } from '../../src/config-worker/private-transport';
import { createIngressPublicListener, createPublicRequestForwarder, WorkerAdmissionRegistry } from '../../src/public-listener';
import { startIngressProcess } from '../../src/ingress/runtime';
import { MasterIngressController } from '../../src/ingress/master-controller';
import { deriveSupervisionProcessKey } from '../../src/supervision';
import { localAdmissionSelector, servingWorker } from '../fixtures/public-listener';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
const LEGACY_NEXT_AUTHORIZATION_HEADER = 'x-bungee-next-authorization';

type Stoppable = { stop(closeActiveConnections?: boolean): Promise<void> | void };
const servers: Stoppable[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function privateServer(
  fetch: (request: Request) => Response | Promise<Response>,
  transportSecret = TEST_WORKER_TRANSPORT_SECRET,
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const restored = restoreWorkerTransportRequest(request, transportSecret);
    if (!restored.ok) return new Response(null, { status: restored.status });
    return fetch(restored.request);
  } });
  servers.push(server);
  return server;
}

function ingressWorker(slot: number, port: number, revision: number): import('../../src/config-publication').ServingConfigWorker {
  const base = servingWorker(slot, port);
  return {
    process: {
      slot,
      pid: 50_000 + revision,
      identity: {
        master_generation: '90000000-0000-4000-8000-000000000001',
        worker_instance_id: randomUUID(),
        worker_slot: slot,
      },
      send: async () => undefined,
      subscribeMessage: () => () => undefined,
      subscribeExit: () => () => undefined,
      terminate: async () => undefined,
    },
    boot_nonce: randomUUID(),
    revision,
    content_hash: revision === 1
      ? base.content_hash
      : `sha256:${'c'.repeat(64)}` as typeof base.content_hash,
    plugin_catalog_hash: base.plugin_catalog_hash,
    private_port: port,
    publication: null,
  };
}

function serverPort(server: ReturnType<typeof Bun.serve>): number {
  if (server.port === undefined) throw new Error('server did not expose its port');
  return server.port;
}

function startPublic(registry: WorkerAdmissionRegistry): { readonly url: string; readonly port: number } {
  const listener = createIngressPublicListener({ admission: localAdmissionSelector(() => registry.select()), transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    hostname: '127.0.0.1', port: 0 });
  listener.start();
  const port = listener.port;
  if (port === null) throw new Error('public listener did not expose its port');
  servers.push({ stop: () => listener.stop() });
  return { url: `http://127.0.0.1:${port}`, port };
}

describe('public listener streaming and admission snapshots', () => {
  test('releases the acquired admission exactly once after a private connection failure', async () => {
    const unused = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') });
    const privatePort = serverPort(unused);
    await unused.stop(true);
    let releaseCount = 0;
    const forward = createPublicRequestForwarder({
      admission: {
        acquire: () => ({ worker: { private_port: privatePort }, release: () => { releaseCount += 1; } }),
      },
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    });

    const response = await forward(new Request('http://public.example/private-failure'));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'bad_gateway' });
    expect(releaseCount).toBe(1);
  });

  test('real signed ingress cuts off pending headers and SSE at the retired admission deadline', async () => {
    const rootKey = new Uint8Array(32).fill(17);
    const instanceId = randomUUID();
    const processInstanceId = randomUUID();
    const bootNonce = randomUUID();
    const transportSecret = generateWorkerTransportSecret();
    const runtime = await startIngressProcess({
      instanceLockPath: 'test-ingress-handoff.lock',
      credential: deriveSupervisionProcessKey(rootKey, instanceId, 'ingress', processInstanceId, bootNonce),
      transportSecret,
      publicHost: '127.0.0.1',
      publicPort: 0,
      supervisionPort: 0,
      acquireLock: async () => ({ path: 'test-ingress-handoff.lock', release: async () => undefined }),
    });
    const replacementCommits: unknown[] = [];
    const controller = new MasterIngressController({
      rootKey,
      instanceId,
      controllerId: randomUUID(),
      controllerEpoch: 1,
      controlPort: runtime.supervisionPort!,
      publicHost: '127.0.0.1',
      publicPort: runtime.publicPort!,
      instanceLockPath: 'unused-by-adopted-ingress',
      transportSecret,
      executable: process.execPath,
      entry: 'unused-by-adopted-ingress',
      cwd: process.cwd(),
      leaseDurationMs: 30_000,
      fetch: async (input, init) => {
        if (new URL(input instanceof Request ? input.url : input).pathname === '/__supervision/command' && typeof init?.body === 'string') {
          const request = JSON.parse(init.body);
          if (request.message.path === '/commit' && request.body.admission?.revision === 2) {
            replacementCommits.push(request.body);
            if (replacementCommits.length === 1) throw new Error('commit transmission outcome unknown');
            if (replacementCommits.length === 2) {
              const response = await fetch(input, init);
              expect(response.ok).toBeTrue();
              await response.arrayBuffer();
              throw new Error('commit acknowledgement lost after apply');
            }
          }
        }
        return fetch(input, init);
      },
      spawn: (() => { throw new Error('existing ingress must be adopted, not spawned'); }) as never,
      processIdentity: {
        capture: async (pid, id) => ({ pid, startToken: 'test-start-token', executable: process.execPath, processInstanceId: id }),
        probe: async () => 'dead',
      },
    });

    const held = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const headersAborted = Promise.withResolvers<void>();
    const streamCancelled = Promise.withResolvers<void>();
    const oldBodies: string[] = [];
    const oldWorker = privateServer(async (request) => {
      oldBodies.push(await request.text());
      if (new URL(request.url).pathname === '/hold') {
        request.signal.addEventListener('abort', () => {
          headersAborted.resolve();
          released.resolve();
        }, { once: true });
        held.resolve();
        await released.promise;
        return new Response('late');
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { stream.enqueue(new TextEncoder().encode('data: old-start\n\n')); },
        cancel() { streamCancelled.resolve(); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }, transportSecret);
    let newRequestCount = 0;
    const newWorker = privateServer(() => {
      newRequestCount += 1;
      return new Response('data: new\n\nevent: done\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }, transportSecret);

    try {
      await controller.connect();
      const initial = await controller.prepare([ingressWorker(0, serverPort(oldWorker), 1)], undefined, 30_000);
      expect(await initial.handoffStatus?.()).toBeNull();
      await initial.commit({ plugins: [], routeRequirements: [] });
      const url = `http://127.0.0.1:${runtime.publicPort}`;
      const oldPost = fetch(`${url}/hold`, { method: 'POST', body: 'old-once' });
      const oldStream = await fetch(`${url}/events`, { method: 'POST', body: 'stream-once' });
      const reader = oldStream.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: old-start\n\n');
      await held.promise;

      const replacement = await controller.prepare([ingressWorker(0, serverPort(newWorker), 2)], undefined, 300);
      await replacement.commit({ plugins: [], routeRequirements: [] });
      expect(replacementCommits).toHaveLength(2);
      expect(replacementCommits[1]).toEqual(replacementCommits[0]);
      expect(await controller.queryRuntimeState()).toMatchObject({ version: 2 });
      const newResponse = await fetch(`${url}/new`, { method: 'POST', body: 'new-once' });
      expect(await newResponse.text()).toBe('data: new\n\nevent: done\ndata: [DONE]\n\n');
      const oldResponse = await oldPost;
      expect(oldResponse.status).toBe(503);
      expect(await oldResponse.json()).toEqual({ error: 'service_unavailable' });
      await expect(reader.read()).rejects.toBeInstanceOf(Error);
      await Promise.all([headersAborted.promise, streamCancelled.promise]);
      const expiredHandoff = await replacement.handoffStatus?.();
      expect(expiredHandoff).toMatchObject({ pending: 0, complete: true, remaining_ms: 0 });
      await controller.recover();
      expect(await replacement.handoffStatus?.()).toEqual(expiredHandoff);
      expect((await controller.status()).state).toBe('attached');
      expect(newRequestCount).toBe(1);
      expect(oldBodies.sort()).toEqual(['old-once', 'stream-once']);
    } finally {
      released.resolve();
      await controller.disconnect();
      await runtime.stop();
      await Promise.all(servers.splice(0).map((server) => server.stop(true)));
    }
  }, 40_000);

  test('strips the control next-authorization header from unmatched proxy requests', async () => {
    // Given
    let forwardedNextAuthorization: string | null = 'not-called';
    let forwardedInternal: string | null = 'not-called';
    const worker = privateServer((request) => {
      forwardedNextAuthorization = request.headers.get(LEGACY_NEXT_AUTHORIZATION_HEADER);
      forwardedInternal = request.headers.get('x-bungee-internal-forged');
      return Response.json({ forwarded: true });
    });
    const registry = new WorkerAdmissionRegistry();
    await (await registry.prepare([servingWorker(0, serverPort(worker))])).commit();
    const listener = createIngressPublicListener({
      admission: localAdmissionSelector(() => registry.select()),
      transportSecret: TEST_WORKER_TRANSPORT_SECRET,
      hostname: '127.0.0.1',
      port: 0,
    });
    listener.start();
    if (listener.port === null) throw new Error('public listener did not expose its port');
    servers.push({ stop: () => listener.stop() });

    // When
    const response = await fetch(`http://127.0.0.1:${listener.port}/not-control`, {
      headers: {
        [LEGACY_NEXT_AUTHORIZATION_HEADER]: 'Bearer must-not-forward',
        'x-bungee-internal-forged': 'must-not-forward',
      },
    });

    // Then
    expect(response.status).toBe(200);
    expect(forwardedNextAuthorization).toBeNull();
    expect(forwardedInternal).toBeNull();
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
    await (await registry.prepare([servingWorker(0, serverPort(worker))])).commit();
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

  test('keeps a real Bun SSE stream alive beyond ten seconds during graceful listener drain', async () => {
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
    await (await registry.prepare([servingWorker(0, serverPort(worker))])).commit();
    const publicServer = startPublic(registry);

    // When
    const response = await fetch(`${publicServer.url}/events`);
    const reader = response.body?.getReader();
    const first = await reader?.read();

    // Then
    expect(new TextDecoder().decode(first?.value)).toBe('data: first\n\n');
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const draining = worker.stop(false);
    releaseResponse?.();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('data: second\n\n');
    await draining;
    expect((await reader?.read())?.done).toBeTrue();
  }, 20_000);

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
    await (await registry.prepare([servingWorker(0, serverPort(worker))])).commit();
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
    await (await registry.prepare([servingWorker(0, serverPort(worker))])).commit();
    const publicServer = startPublic(registry);

    // When
    const forward = createPublicRequestForwarder({
      admission: localAdmissionSelector(() => registry.select()), transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    });
    const connectResponse = await forward(new Request('http://public.example/tunnel', { method: 'CONNECT' }));
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
    await (await registry.prepare([servingWorker(0, serverPort(oldWorker))])).commit();
    const publicServer = startPublic(registry);
    const inFlight = fetch(`${publicServer.url}/selected`);
    await started;

    // When
    await (await registry.prepare([servingWorker(0, serverPort(newWorker))])).commit();
    releaseOld?.();
    expect(await inFlight.then((response) => response.text())).toBe('old');
    const drain = oldWorker.stop(false);
    const later = await Promise.all([
      fetch(`${publicServer.url}/one`).then((response) => response.text()),
      fetch(`${publicServer.url}/two`).then((response) => response.text()),
    ]);

    // Then
    expect(later).toEqual(['new', 'new']);
    await drain;
  });

});
