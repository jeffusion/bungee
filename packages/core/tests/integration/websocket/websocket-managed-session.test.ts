import { afterEach, describe, expect, test } from 'bun:test';
import WebSocket from '@bungee/ws-client';
import type { IncomingMessage } from 'node:http';
import type { WebSocketSessionMetrics } from '../../../src/gateway/websocket-contracts';
import {
  createWebSocketBridge, isWebSocketUpgradeRequest,
  type ManagedWebSocketSession, type ManagedWebSocketSessionOptions,
  type WebSocketBridgeData, type WebSocketBridgeOptions,
} from '../../../src/websocket';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(5); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function gateway(events: ManagedWebSocketSessionOptions, limits: WebSocketBridgeOptions = {}) {
  const bridge = createWebSocketBridge({ closeTimeoutMs: 100, ...limits });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, websocket: bridge.websocket,
    fetch: (request, server) => isWebSocketUpgradeRequest(request)
      ? bridge.upgradeSession(request, server, events) : new Response('HTTP route'),
  });
  cleanups.push(async () => { await bridge.stop(); await server.stop(true); });
  return { bridge, url: `ws://127.0.0.1:${server.port}` };
}
async function client(url: string, options: WebSocket.ClientOptions = {}, protocols: string[] = []) {
  const socket = new WebSocket(url, protocols, { perMessageDeflate: false, ...options });
  cleanups.push(() => socket.terminate());
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}
const closed = (socket: WebSocket) => new Promise<number>((resolve) => socket.once('close', resolve));
async function rejected(url: string, options: WebSocket.ClientOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options); cleanups.push(() => socket.terminate());
    socket.on('error', () => undefined);
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected upgrade')); });
    socket.once('unexpected-response', (_request, response) => {
      response.resume(); response.once('end', () => { resolve(response.statusCode!); socket.terminate(); });
    });
  });
}
function request(protocol?: string) {
  return new Request('http://localhost', { headers: {
    Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {}),
  } });
}
async function fixture(options: ManagedWebSocketSessionOptions, limits: WebSocketBridgeOptions = {}, status = 1) {
  const bridge = createWebSocketBridge({ closeTimeoutMs: 20, ...limits });
  const sent: string[] = []; const closes: number[] = [];
  let data!: WebSocketBridgeData;
  const server = { upgrade(_request: Request, input: { data: WebSocketBridgeData }) { data = input.data; return true; } } as Bun.Server<any>;
  await bridge.upgradeSession(request(), server, options);
  const socket = {
    data, readyState: 1, getBufferedAmount: () => 0,
    send(message: string) { sent.push(message); return status; }, close(code: number) { closes.push(code); }, terminate() {},
  } as unknown as Bun.ServerWebSocket<WebSocketBridgeData>;
  bridge.websocket.open!(socket);
  cleanups.push(async () => { bridge.websocket.close!(socket, 1000, 'fixture done'); await bridge.stop(); });
  return { bridge, socket, sent, closes };
}

describe('managed WebSocket sessions', () => {
  test('real native open, multiple JSON messages, empty sends and immutable metrics', async () => {
    let session: ManagedWebSocketSession | undefined; let metrics: WebSocketSessionMetrics | undefined;
    const gate = gateway({
      onOpen(value) { session = value; },
      async onMessage(value, message) {
        expect(message.kind).toBe('text'); expect(Object.isFrozen(message)).toBe(true);
        await value.send(JSON.stringify(message.json()));
      },
      onClose(_code, _reason, value) { metrics = value; },
    });
    const socket = await client(gate.url); const received: string[] = [];
    socket.on('message', (data) => received.push(data.toString()));
    socket.send('{"id":1}'); socket.send('{"id":2}'); socket.send('{"cancel":true}');
    await until(() => received.length === 3);
    expect(received).toEqual(['{"id":1}', '{"id":2}', '{"cancel":true}']);
    await session!.send(''); await until(() => received.length === 4); expect(received[3]).toBe('');
    const done = closed(socket); socket.close(1000, 'done'); expect(await done).toBe(1000);
    await until(() => metrics !== undefined);
    expect(metrics?.clientMessages).toBe(3); expect(metrics?.upstreamMessages).toBe(4);
    expect(Object.isFrozen(metrics)).toBe(true);
    expect(gate.bridge.stats.connections).toBe(0); expect(gate.bridge.stats.processBufferedBytes).toBe(0);
  });

  test('synchronous message entry admits cancel while an earlier job is active', async () => {
    const job = deferred(); const entered: unknown[] = []; let session: ManagedWebSocketSession | undefined;
    const gate = gateway({
      onMessage(value, message) { session = value; entered.push(message.json()); return entered.length === 1 ? job.promise : undefined; },
    });
    const socket = await client(gate.url); socket.send('"start"'); socket.send('"cancel"');
    await until(() => entered.length === 2);
    expect(entered).toEqual(['start', 'cancel']); expect(session!.signal.aborted).toBe(false);
    job.resolve(); await gate.bridge.stop();
    expect(session!.signal.aborted).toBe(true); expect(gate.bridge.stats.connections).toBe(0);
  });

  test('disconnect aborts immediately but close callback and connection release wait for jobs', async () => {
    const job = deferred(); let session: ManagedWebSocketSession | undefined; let calls = 0;
    const gate = gateway({ onMessage(value) { session = value; return job.promise; }, onClose() { calls++; } }, { maxConnections: 1 });
    const socket = await client(gate.url); socket.send('1'); await until(() => session !== undefined);
    socket.terminate(); await until(() => session!.signal.aborted);
    expect(calls).toBe(0); expect(gate.bridge.stats.connections).toBe(1);
    expect(await rejected(gate.url)).toBe(503);
    job.resolve(); await until(() => calls === 1);
    expect(gate.bridge.stats.connections).toBe(0); expect(gate.bridge.stats.processBufferedBytes).toBe(0);
  });

  test('stop cancels jobs and waits for cancellation cleanup before freeing resources', async () => {
    const cleanup = deferred(); let started = false; let wasAborted = false; let calls = 0;
    const gate = gateway({
      onMessage(session) {
        started = true;
        return new Promise<void>((resolve) => session.signal.addEventListener('abort', () => {
          wasAborted = true; void cleanup.promise.then(resolve);
        }, { once: true }));
      }, onClose() { calls++; },
    });
    const socket = await client(gate.url); socket.send('1'); await until(() => started);
    const wireClose = closed(socket); let stopped = false;
    const stop = gate.bridge.stop().then(() => { stopped = true; });
    await until(() => wasAborted); expect(await wireClose).toBe(1012);
    expect(stopped).toBe(false); expect(calls).toBe(0);
    cleanup.resolve(); await stop;
    expect(calls).toBe(1); expect(gate.bridge.stats.connections).toBe(0);
    expect(gate.bridge.stats.handshakes).toBe(0); expect(gate.bridge.stats.processBufferedBytes).toBe(0);
  });

  test('too many active jobs close with 1013 without queuing input', async () => {
    const job = deferred(); let calls = 0;
    const gate = gateway({ onMessage() { calls++; return job.promise; } }, { maxEarlyMessages: 2 });
    const socket = await client(gate.url); const done = closed(socket);
    socket.send('1'); socket.send('2'); socket.send('3');
    expect(await done).toBe(1013); expect(calls).toBe(2); expect(gate.bridge.stats.connections).toBe(1);
    job.resolve(); await until(() => gate.bridge.stats.connections === 0);
  });

  test('protocol offers are declined by default; explicit selection must be offered', async () => {
    const gate = gateway({ onMessage() {} });
    const socket = await client(gate.url, { headers: { 'Sec-WebSocket-Protocol': 'one, two' } });
    expect(socket.protocol).toBe('');
    const selected = gateway({ headers: new Headers({ 'Sec-WebSocket-Protocol': 'two', 'X-Handshake': 'managed' }), onMessage() {} });
    let response: IncomingMessage | undefined;
    const chosen = await client(selected.url, { finishRequest(request) {
      request.on('upgrade', (value) => { response = value; }); request.end();
    } }, ['one', 'two']);
    expect(chosen.protocol).toBe('two'); expect(response?.headers['x-handshake']).toBe('managed');
    expect(await rejected(selected.url, { headers: { 'Sec-WebSocket-Protocol': 'one' } })).toBe(502);
  });

  test('validates requests, admission and handshake-only cancellation', async () => {
    const bridge = createWebSocketBridge(); let upgrades = 0;
    const server = { upgrade() { upgrades++; return false; } } as unknown as Bun.Server<any>;
    expect(await bridge.upgradeSession(new Request('http://localhost'), server, { onMessage() {} })).toBeUndefined();
    const bad = request(); bad.headers.set('Sec-WebSocket-Version', '12');
    expect((await bridge.upgradeSession(bad, server, { onMessage() {} }))?.status).toBe(426);
    const controller = new AbortController(); controller.abort();
    expect((await bridge.upgradeSession(request(), server, { signal: controller.signal, onMessage() {} }))?.status).toBe(499);
    expect(upgrades).toBe(0);
    expect((await bridge.upgradeSession(request(), server, { onMessage() {} }))?.status).toBe(502);
    expect(bridge.stats.connections).toBe(0); expect(bridge.stats.handshakes).toBe(0);
    const signal = new AbortController(); let session: ManagedWebSocketSession | undefined;
    const gate = gateway({ signal: signal.signal, onOpen(value) { session = value; }, onMessage() {} }, { maxConnections: 1 });
    await client(gate.url); signal.abort(); expect(session!.signal.aborted).toBe(false);
    expect(await rejected(gate.url)).toBe(503); await gate.bridge.stop(); expect(await rejected(gate.url)).toBe(503);
  });

  test('queued -1 sends wait for drain and do not resend; closing rejects drain waiters', async () => {
    let session!: ManagedWebSocketSession;
    const fake = await fixture({ onOpen(value) { session = value; }, onMessage() {} }, {}, -1);
    let finished = false; const send = session.send('first').then(() => { finished = true; });
    await delay(0); expect(finished).toBe(false); expect(fake.sent).toEqual(['first']);
    fake.bridge.websocket.drain!(fake.socket); await send;
    expect(fake.sent).toEqual(['first']); expect(fake.bridge.stats.downstreamBackpressureEvents).toBe(1);
    const pending = session.send('second'); session.close(1000, 'done');
    expect(session.signal.aborted).toBe(true); await expect(pending).rejects.toThrow('closed');
    expect(fake.bridge.stats.connections).toBe(1); // Requested close is not confirmation.
    fake.bridge.websocket.close!(fake.socket, 1000, 'done');
    expect(fake.bridge.stats.connections).toBe(0);
  });

  test('pending native commit reserves handshake capacity and rechecks abort or stop', async () => {
    let upgrades = 0;
    const server = { upgrade() { upgrades++; return true; } } as unknown as Bun.Server<any>;
    const bridge = createWebSocketBridge({ maxHandshakes: 1 });
    const controller = new AbortController();
    const pending = bridge.upgradeSession(request(), server, { signal: controller.signal, onMessage() {} });
    expect(bridge.stats.handshakes).toBe(1);
    expect((await bridge.upgradeSession(request(), server, { onMessage() {} }))?.status).toBe(503);
    controller.abort(); expect((await pending)?.status).toBe(499);
    expect(upgrades).toBe(0); expect(bridge.stats.handshakes).toBe(0); expect(bridge.stats.connections).toBe(0);
    const stopping = bridge.upgradeSession(request(), server, { onMessage() {} });
    bridge.stopAccepting(); expect((await stopping)?.status).toBe(503); await bridge.stop();
    expect(upgrades).toBe(0); expect(bridge.stats.processBufferedBytes).toBe(0);
  });

  test('forced stop retains ownership if native close confirmation is absent', async () => {
    let session!: ManagedWebSocketSession; let closeCalls = 0;
    const fake = await fixture({ onOpen(value) { session = value; }, onMessage() {}, onClose() { closeCalls++; } });
    await expect(fake.bridge.forceStop()).rejects.toThrow('native socket close callback missing');
    expect(session.signal.aborted).toBe(true); expect(fake.bridge.stats.connections).toBe(1); expect(closeCalls).toBe(0);
    fake.bridge.websocket.close!(fake.socket, 1006, 'terminated');
    expect(closeCalls).toBe(1); expect(fake.bridge.stats.connections).toBe(0);
  });

  test('pending sends and message sizes are bounded', async () => {
    let session!: ManagedWebSocketSession;
    const fake = await fixture({ onOpen(value) { session = value; }, onMessage() {} }, { maxEarlyMessages: 2, maxMessageBytes: 32 }, -1);
    const first = session.send('first').catch((error: Error) => error);
    const second = session.send('second').catch((error: Error) => error);
    await expect(session.send('third')).rejects.toThrow('budget');
    expect((await first as Error).message).toContain('closed'); expect((await second as Error).message).toContain('closed');
    expect(fake.sent).toEqual(['first']); expect(fake.closes[0]).toBe(1013);
    let other!: ManagedWebSocketSession;
    const large = await fixture({ onOpen(value) { other = value; }, onMessage() {} }, { maxMessageBytes: 32 });
    await expect(other.send('x'.repeat(33))).rejects.toThrow('too large'); expect(large.closes[0]).toBe(1009);
  });

  test('active message memory shares session and process budgets across bridges', async () => {
    const job = deferred(); const limits = { maxMessageBytes: 64, maxBufferedBytes: 156, maxTotalBufferedBytes: 156 };
    const first = await fixture({ onMessage() { return job.promise; } }, limits);
    const second = await fixture({ onMessage() { return job.promise; } }, limits);
    first.bridge.websocket.message!(first.socket, 'x'.repeat(64));
    second.bridge.websocket.message!(second.socket, 'x'.repeat(64));
    expect(first.bridge.stats.processBufferedBytes).toBe(156);
    first.bridge.websocket.message!(first.socket, '1'); expect(first.closes[0]).toBe(1013);
    job.resolve(); await until(() => first.bridge.stats.processBufferedBytes === 0);
  });

  test('real slow downstream drains an ordered producer with no duplicates', async () => {
    let session!: ManagedWebSocketSession;
    const gate = gateway({ onOpen(value) { session = value; }, onMessage() {} });
    const socket = await client(gate.url); socket.pause(); const received: number[] = [];
    socket.on('message', (data) => received.push(Number(data.toString().slice(0, 2))));
    let produced = 0;
    const producer = (async () => {
      for (let index = 0; index < 12; index++) { await session.send(String(index).padStart(2, '0') + 'x'.repeat(1024 * 1024)); produced++; }
    })();
    await until(() => gate.bridge.stats.downstreamBackpressureEvents > 0);
    expect(produced).toBeLessThan(12); expect(gate.bridge.stats.bufferedBytes).toBeLessThanOrEqual(gate.bridge.limits.maxBufferedBytes);
    socket.resume(); await producer; await until(() => received.length === 12, 5000);
    expect(received).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(gate.bridge.stats.downstreamDrainEvents).toBeGreaterThan(0);
    await gate.bridge.stop(); expect(gate.bridge.stats.processBufferedBytes).toBe(0);
  }, 10_000);

  test('handler failures close sessions; binary views remain read-only', async () => {
    let kind: string | undefined; let calls = 0;
    const gate = gateway({ onMessage(_session, view) {
      kind = view.kind; expect(view.json()).toBeUndefined(); throw new Error('application error');
    }, onClose() { calls++; } });
    const socket = await client(gate.url); const done = closed(socket); socket.send(Buffer.from('{}'));
    expect(await done).toBe(1011); await until(() => calls === 1); expect(kind).toBe('binary');
    expect(gate.bridge.stats.connections).toBe(0);
  });
});
