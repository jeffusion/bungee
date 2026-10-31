import { describe, expect, test } from 'bun:test';
import { generateWorkerTransportSecret } from '../../src/config-worker/private-transport';
import { admissionSetRetiredId, IngressAdmissionRegistry, AdmissionRegistryError, parseAdmissionSet, type AdmissionSet } from '../../src/ingress';
import { createIngressPublicListener } from '../../src/public-listener';
import { createWebSocketBridge } from '../../src/websocket';

const generation = '90000000-0000-4000-8000-000000000001';
const hash = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const catalog = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

function admission(sequence: number, revision = sequence): AdmissionSet {
  return {
    master_generation: generation,
    websocket_max_connections: 512, websocket_max_message_bytes: 16 * 1024 * 1024, admission_sequence: sequence,
    revision,
    content_hash: hash,
    plugin_catalog_hash: catalog,
    workers: [0, 1].map((slot) => ({
      master_generation: generation,
      worker_instance_id: `91000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`,
      boot_nonce: `92000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`,
      worker_slot: slot,
      private_port: 40_000 + slot,
    })),
  };
}

describe('ingress admission set and registry', () => {
  test('strictly parses, sorts, and deep freezes a complete set', () => {
    const parsed = parseAdmissionSet(admission(1));
    expect(Object.isFrozen(parsed)).toBeTrue();
    expect(Object.isFrozen(parsed.workers)).toBeTrue();
    expect(Object.isFrozen(parsed.workers[0])).toBeTrue();
    expect(parseAdmissionSet({ ...admission(1), websocket_max_connections: null }).websocket_max_connections).toBeNull();
    for (const value of [undefined, 0, -1, 1.5, 2147483648, '512', true]) {
      expect(() => parseAdmissionSet({ ...admission(1), websocket_max_connections: value })).toThrow();
    }
    for (const value of [undefined, null, 0, -1, 1.5, 2147483648, '16']) {
      expect(() => parseAdmissionSet({ ...admission(1), websocket_max_message_bytes: value })).toThrow();
    }
    expect(() => parseAdmissionSet({ ...admission(1), extra: true })).toThrow();
    expect(() => parseAdmissionSet({ ...admission(1), workers: [admission(1).workers[0], { ...admission(1).workers[1], worker_slot: 2 }] })).toThrow();
    expect(() => parseAdmissionSet({ ...admission(1), workers: [{ ...admission(1).workers[0], master_generation: '90000000-0000-4000-8000-000000000002' }, admission(1).workers[1]] })).toThrow();
  }, 30_000);

  test('prepare does not cut traffic, commit is exact and retires the old active set', () => {
    const registry = new IngressAdmissionRegistry();
    const first = admission(1);
    const second = admission(2);
    registry.prepare(first);
    expect(registry.select()).toBeNull();
    expect(registry.status().prepared?.admission_sequence).toBe(1);
    registry.prepare(second);
    expect(registry.status().prepared?.admission_sequence).toBe(2);
    expect(() => registry.prepare(first)).toThrow(AdmissionRegistryError);
    registry.abort(second);
    registry.prepare(first);
    registry.commit(first);
    expect(registry.select()?.private_port).toBe(40_000);
    registry.prepare(second);
    expect(registry.select()?.private_port).toBe(40_001);
    registry.commit(second);
    expect(registry.status().retired.map((set) => set.admission_sequence)).toEqual([1]);
    expect(registry.select()?.private_port).toBe(40_000);
  });

  test('supports exact prepare idempotency, abort, and rejects stale or mixed identity', () => {
    const registry = new IngressAdmissionRegistry();
    const first = admission(1);
    expect(registry.prepare(first)).toEqual(registry.prepare(first));
    registry.abort(first);
    expect(() => registry.abort(first)).not.toThrow();
    expect(registry.status().prepared).toBeNull();
    registry.prepare(first);
    expect(() => registry.prepare({ ...first, websocket_max_connections: 512, websocket_max_message_bytes: 16 * 1024 * 1024, admission_sequence: 1, revision: 2 })).toThrow(AdmissionRegistryError);
    registry.commit(first);
    expect(() => registry.commit(first)).not.toThrow();
    expect(() => registry.prepare(first)).toThrow(AdmissionRegistryError);
    const third = admission(3);
    const fourth = admission(4);
    const second = admission(2);
    registry.prepare(second);
    registry.commit(second);
    registry.prepare(third);
    registry.commit(third);
    registry.prepare(fourth);
    expect(() => registry.commit(fourth)).toThrow(AdmissionRegistryError);
    registry.releaseRetired(second);
    expect(() => registry.releaseRetired(second)).not.toThrow();
  });

  test('keeps commit retries idempotent across prepared, active, retired, and released history', () => {
    const registry = new IngressAdmissionRegistry();
    const first = admission(1);
    const second = admission(2);
    registry.prepare(first);
    registry.commit(first);
    registry.prepare(second);
    registry.commit(first);
    expect(registry.status().prepared?.admission_sequence).toBe(2);
    registry.commit(second);
    expect(() => registry.commit(first)).not.toThrow();
    registry.releaseRetired(first);
    expect(() => registry.commit(first)).not.toThrow();
    expect(registry.status().active?.admission_sequence).toBe(2);
  });

  test('keeps an old in-flight request on the old active worker during commit', async () => {
    const requestControl: { release?: () => void } = {};
    let requestStartedResolve!: () => void;
    const requestStarted = new Promise<void>((resolve) => { requestStartedResolve = resolve; });
    const releasePending = () => { requestControl.release?.(); };
    const worker = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => new Promise<Response>((resolve) => {
        requestControl.release = () => resolve(new Response('old'));
        requestStartedResolve();
      }),
    });
    let monotonicNow = 0;
    const registry = new IngressAdmissionRegistry(() => monotonicNow);
    let newRequests = 0;
    const newWorker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      newRequests += 1;
      return new Response('new');
    } });
    const first = admission(1);
    const second = admission(2);
    const firstWithPort = { ...first, workers: [{ ...first.workers[0]!, private_port: worker.port! }] };
    const secondWithPort = { ...second, workers: [{ ...second.workers[0]!, private_port: newWorker.port! }] };
    registry.prepare(firstWithPort);
    registry.commit(firstWithPort);
    const listener = createIngressPublicListener({
      admission: registry,
      transportSecret: generateWorkerTransportSecret(),
      hostname: '127.0.0.1', port: 0,
    });
    listener.start();
    try {
      const pending = fetch(`http://127.0.0.1:${listener.port}/health`);
      await requestStarted;
      const prepared = registry.prepare(secondWithPort, 5);
      expect(prepared.admission_sequence).toBe(2);
      registry.commit(secondWithPort);
      expect(registry.status().handoff).toMatchObject({
        retired_id: admissionSetRetiredId(firstWithPort), pending: 1, complete: false, remaining_ms: 5,
      });
      monotonicNow = 10;
      expect(registry.status().handoff).toMatchObject({ pending: 1, complete: false, remaining_ms: 0 });
      registry.commit(secondWithPort);
      expect(registry.status().handoff).toMatchObject({ pending: 1, complete: false, remaining_ms: 0 });
      expect(await (await fetch(`http://127.0.0.1:${listener.port}/health`)).text()).toBe('new');
      expect(newRequests).toBe(1);
      releasePending();
      expect(await (await pending).text()).toBe('old');
      expect(registry.status().handoff).toMatchObject({ pending: 0, complete: true, remaining_ms: 0 });
    } finally {
      releasePending();
      await listener.stop();
      await worker.stop(true);
      await newWorker.stop(true);
    }
  });
});

test('public WS admission defaults to 512 and applies committed count changes without evicting sockets', async () => {
  const { default: WebSocket } = await import('@bungee/ws-client');
  const worker = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('upgrade required', { status: 426 }); },
    websocket: { message(socket, message) { socket.send(message); } },
  });
  const registry = new IngressAdmissionRegistry();
  expect(registry.websocketMaxConnections).toBe(512);
  const first = { ...admission(1), workers: [{ ...admission(1).workers[0]!, private_port: worker.port! }] };
  registry.prepare(first); registry.commit(first);
  const listener = createIngressPublicListener({ hostname: '127.0.0.1', port: 0,
    transportSecret: generateWorkerTransportSecret(), admission: registry });
  const clients: InstanceType<typeof WebSocket>[] = [];
  listener.start();
  const connect = () => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/echo`);
    clients.push(socket); socket.on('error', () => {});
    socket.once('open', () => resolve(socket)); socket.once('error', reject);
  });
  const refused = () => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/echo`);
    clients.push(socket); socket.on('error', () => {});
    socket.once('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode!); socket.terminate(); });
    socket.once('open', () => reject(new Error('capacity unexpectedly admitted')));
  });
  const echo = (socket: InstanceType<typeof WebSocket>) => new Promise<void>((resolve, reject) => {
    socket.once('message', data => { try { expect(data.toString()).toBe('still-open'); resolve(); } catch (error) { reject(error); } });
    socket.send('still-open');
  });
  try {
    const open = await Promise.all(Array.from({ length: 512 }, connect));
    expect(await refused()).toBe(503);
    const lower = { ...first, admission_sequence: 2, revision: 2, websocket_max_connections: 1 };
    registry.prepare(lower);
    expect(registry.websocketMaxConnections).toBe(512);
    registry.commit(lower);
    expect(registry.websocketMaxConnections).toBe(1);
    await echo(open[0]!);
    expect(await refused()).toBe(503);
    const unlimited = { ...lower, admission_sequence: 3, revision: 3, websocket_max_connections: null };
    registry.prepare(unlimited); registry.commit(unlimited);
    await echo(await connect());
    // After native close callbacks, the same listener reuses its released capacity.
    await Promise.all(clients.map(socket => new Promise<void>(resolve => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', resolve); socket.close();
    })));
    registry.releaseRetired(first);
    const one = { ...lower, admission_sequence: 4, revision: 4 };
    registry.prepare(one); registry.commit(one);
    // A client close callback can precede ingress's corresponding native close callback.
    const deadline = Date.now() + 3000;
    let reopened: InstanceType<typeof WebSocket> | undefined;
    while (!reopened) {
      try { reopened = await connect(); } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    await echo(reopened);
    expect(await refused()).toBe(503);
  } finally {
    for (const socket of clients) socket.terminate();
    await listener.stop(); await worker.stop(true);
  }
}, 30_000);

test('published message limits reach the native listener and retain each live connection policy', async () => {
  const { default: WebSocket } = await import('@bungee/ws-client');
  const MiB = 1024 * 1024;
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = Bun.serve({ hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname === '/pending') { started(); await gate; }
      if (server.upgrade(request)) return;
      return new Response('upgrade required', { status: 426 });
    }, websocket: { maxPayloadLength: 40 * MiB, backpressureLimit: 80 * MiB,
      message(socket, message) { socket.send(message); } },
  });
  const registry = new IngressAdmissionRegistry();
  const first = { ...admission(1), websocket_max_message_bytes: MiB,
    workers: [{ ...admission(1).workers[0]!, private_port: worker.port! }] };
  registry.prepare(first); registry.commit(first);
  const listener = createIngressPublicListener({ hostname: '127.0.0.1', port: 0,
    transportSecret: generateWorkerTransportSecret(), admission: registry });
  const clients: InstanceType<typeof WebSocket>[] = [];
  listener.start();
  const connect = (path = '/echo') => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}${path}`, { maxPayload: 40 * MiB });
    clients.push(socket); socket.on('error', () => {});
    socket.once('open', () => resolve(socket)); socket.once('error', reject);
  });
  const echo = (socket: InstanceType<typeof WebSocket>, payload: string) => new Promise<void>((resolve, reject) => {
    socket.once('close', code => reject(new Error(`closed before echo: ${code}`)));
    socket.once('message', data => { try { expect(data.toString()).toBe(payload); resolve(); } catch (error) { reject(error); } });
    socket.send(payload);
  });
  const rejectLarge = (socket: InstanceType<typeof WebSocket>) => new Promise<number>(resolve => {
    socket.once('close', resolve); socket.send('x'.repeat(2 * MiB));
  });
  try {
    const old = await connect();
    const connecting = connect('/pending'); await pending;
    const larger = { ...first, admission_sequence: 2, revision: 2, websocket_max_message_bytes: 40 * MiB };
    registry.prepare(larger); registry.commit(larger);
    // Start a new handshake before resolving the old handshake.
    const fresh = await connect(); release(); const delayed = await connecting;
    expect([1006, 1009]).toContain(await rejectLarge(old));
    expect([1006, 1009]).toContain(await rejectLarge(delayed));
    await echo(fresh, 'large-'.repeat(6 * MiB));
    const lower = { ...first, admission_sequence: 3, revision: 3 };
    registry.prepare(lower); registry.commit(lower);
    const small = await connect();
    expect(await rejectLarge(small)).toBe(1009);
    await echo(fresh, 'still-'.repeat(MiB));
    await echo(fresh, 'continued');
  } finally {
    release(); for (const socket of clients) socket.terminate();
    await listener.stop(); await worker.stop(true);
  }
}, 30_000);


test('native policy failure keeps the prepared admission retryable without publishing or enlarging budgets', async () => {
  const registry = new IngressAdmissionRegistry();
  let nativeLimit = 16 * 1024 * 1024, calls = 0, fail = false;
  const bridge = createWebSocketBridge({ messageLimit: () => registry.websocketMaxMessageBytes,
    onNativeLimitsChanged() {
      calls++;
      if (fail) { fail = false; throw new Error('native reload failed'); }
      nativeLimit = bridge.websocket.maxPayloadLength!;
    },
  });
  const unsubscribe = registry.subscribeWebSocketMessagePolicy(limit => bridge.refreshMessagePolicy(limit));
  try {
    const first = { ...admission(1), websocket_max_message_bytes: 1024 * 1024 };
    registry.prepare(first); registry.commit(first);
    const beforeCalls = calls, beforeBudget = bridge.processBufferLimit;
    const larger = { ...admission(2), websocket_max_message_bytes: 128 * 1024 * 1024 };
    registry.prepare(larger); fail = true;
    expect(() => registry.commit(larger)).toThrow('native reload failed');
    expect(registry.status().active).toEqual(first);
    expect(registry.status().prepared).toEqual(larger);
    expect(nativeLimit).toBe(1024 * 1024);
    expect(bridge.websocket.maxPayloadLength).toBe(nativeLimit);
    expect(bridge.processBufferLimit).toBe(beforeBudget);
    registry.commit(larger);
    expect(calls).toBe(beforeCalls + 2);
    expect(registry.status().active).toEqual(larger);
    expect(registry.status().prepared).toBeNull();
    expect(nativeLimit).toBe(128 * 1024 * 1024);
    expect(bridge.processBufferLimit).toBeGreaterThan(beforeBudget);
  } finally { unsubscribe(); await bridge.stop(); }
});
