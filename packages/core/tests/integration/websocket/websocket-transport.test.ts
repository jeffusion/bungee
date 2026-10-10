import { afterEach, describe, expect, test } from 'bun:test';
import WebSocket, { WebSocketServer } from '@bungee/ws-client';
import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { WebSocketMessageView, WebSocketSessionMetrics } from '../../../src/gateway/websocket-contracts';
import {
  createWebSocketBridge, createWebSocketMessageView, isWebSocketUpgradeRequest, validateWebSocketRequest,
  type WebSocketBridge, type WebSocketBridgeOptions, type WebSocketUpgradeOptions,
} from '../../../src/websocket';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(5); }
}

async function upstream(options: {
  connected?: (socket: WebSocket, request: IncomingMessage) => void;
  upgrade?: (request: IncomingMessage, socket: Socket) => boolean;
  handleProtocols?: (protocols: Set<string>) => string | false;
  responseHeaders?: readonly string[];
} = {}): Promise<{ url: string; sockets: Set<WebSocket> }> {
  const server = createServer((_request, response) => { response.writeHead(200); response.end('ordinary HTTP'); });
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: options.handleProtocols });
  if (options.responseHeaders) wss.on('headers', (headers) => headers.push(...options.responseHeaders!));
  server.on('upgrade', (request, socket, head) => {
    if (options.upgrade?.(request, socket as Socket) === false) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws); ws.on('error', () => undefined); ws.on('close', () => sockets.delete(ws));
      if (options.connected) options.connected(ws, request);
      else ws.on('message', (message, binary) => ws.send(message, { binary }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing upstream port');
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wss.close();
  });
  return { url: `ws://127.0.0.1:${address.port}`, sockets };
}

/** A native paused TCP reader imposes real network backpressure on the bridge. */
function slowUpstream(): string {
  const peers = new Set<Bun.Socket<{ headers: string; upgraded: boolean }>>();
  const listener = Bun.listen<{ headers: string; upgraded: boolean }>({
    hostname: '127.0.0.1', port: 0,
    socket: {
      open(socket) { socket.data = { headers: '', upgraded: false }; peers.add(socket); },
      data(socket, bytes) {
        if (socket.data.upgraded) return;
        socket.data.headers += bytes.toString();
        if (!socket.data.headers.includes('\r\n\r\n')) return;
        const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(socket.data.headers)?.[1];
        const accept = createHash('sha1').update(key! + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.data.upgraded = true; socket.pause();
      },
      close(socket) { peers.delete(socket); },
    },
  });
  cleanups.push(() => { for (const peer of peers) peer.terminate(); listener.stop(true); });
  return `ws://127.0.0.1:${listener.port}`;
}

function gateway(url: string, options: WebSocketBridgeOptions = {}, events: Partial<WebSocketUpgradeOptions> = {}): {
  bridge: WebSocketBridge; url: string;
} {
  const bridge = createWebSocketBridge({ closeTimeoutMs: 200, handshakeTimeoutMs: 1000, ...options });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request, server) => isWebSocketUpgradeRequest(request)
      ? bridge.upgrade(request, server, { url: `${url}${new URL(request.url).pathname}`, headers: request.headers, ...events })
      : new Response('HTTP route'),
    websocket: bridge.websocket,
  });
  cleanups.push(async () => { await bridge.stop(); await server.stop(true); });
  return { bridge, url: `ws://127.0.0.1:${server.port}` };
}

async function client(url: string, options: WebSocket.ClientOptions = {}, protocols: string[] = []): Promise<WebSocket> {
  const socket = new WebSocket(url, protocols, { perMessageDeflate: false, ...options });
  cleanups.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('error', () => undefined);
  return socket;
}

function nextMessage(socket: WebSocket): Promise<{ data: Buffer; binary: boolean }> {
  return new Promise((resolve) => socket.once('message', (data, binary) => {
    resolve({ data: Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data), binary });
  }));
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

async function rejected(url: string, options: WebSocket.ClientOptions = {}): Promise<{ status: number; headers: IncomingMessage['headers']; rawHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    cleanups.push(() => socket.terminate());
    socket.on('error', () => undefined);
    socket.on('open', () => { socket.terminate(); reject(new Error('Unexpected successful upgrade')); });
    socket.on('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = [];
      response.on('data', (data) => chunks.push(data));
      response.on('end', () => {
        resolve({ status: response.statusCode!, headers: response.headers, rawHeaders: response.rawHeaders, body: Buffer.concat(chunks).toString() });
        socket.terminate();
      });
    });
  });
}

describe('bounded WebSocket bridge with the real npm ws client', () => {
  test('validates upgrade tokens, method, version, key and protocols without taking ordinary HTTP', async () => {
    const base = new Headers({ Connection: 'keep-alive, Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' });
    expect(validateWebSocketRequest(new Request('http://localhost', { headers: base }))).toBeUndefined();
    for (const [name, value, status] of [
      ['Connection', 'keep-alive', 400], ['Upgrade', 'websocket, h2c', 400],
      ['Sec-WebSocket-Version', '12', 426], ['Sec-WebSocket-Key', 'bad', 400],
      ['Sec-WebSocket-Protocol', 'same, same', 400], ['Sec-WebSocket-Protocol', 'bad protocol', 400],
    ] as const) {
      const headers = new Headers(base); headers.set(name, value);
      expect(validateWebSocketRequest(new Request('http://localhost', { headers }))?.status).toBe(status);
    }
    expect(validateWebSocketRequest(new Request('http://localhost', { method: 'POST', headers: base }))?.status).toBe(400);
    const up = await upstream(); const gate = gateway(up.url);
    expect(await (await fetch(gate.url.replace('ws:', 'http:'))).text()).toBe('HTTP route');
    expect(gate.bridge.stats.connections).toBe(0);
  });

  test('101 preserves Origin/auth/custom headers, rebuilds hop headers and negotiates the upstream-selected protocol', async () => {
    let request: IncomingMessage | undefined;
    let downstreamKey: string | undefined;
    const up = await upstream({
      handleProtocols: (protocols) => protocols.has('second') ? 'second' : false,
      responseHeaders: ['Set-Cookie: first=1', 'Set-Cookie: second=2', 'X-Handshake: retained', 'X-Bungee-Internal: hidden'],
      connected: (socket, incoming) => { request = incoming; socket.on('message', (data, binary) => socket.send(data, { binary })); },
    });
    const gate = gateway(up.url);
    let upgradeResponse: IncomingMessage | undefined;
    const socket = new WebSocket(gate.url, ['first', 'second'], { headers: {
      Origin: 'https://client.example', Authorization: 'Bearer test-token', 'X-Custom': 'custom-value',
      Connection: 'upgrade, X-Remove-Me', 'X-Remove-Me': 'secret', 'X-Bungee-Internal': 'secret',
    }, finishRequest(request) {
      downstreamKey = request.getHeader('sec-websocket-key') as string;
      request.setHeader('Connection', 'upgrade, X-Remove-Me'); request.end();
    } });
    cleanups.push(() => socket.terminate()); socket.on('error', () => undefined);
    socket.on('upgrade', (response) => { upgradeResponse = response; });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    expect(socket.protocol).toBe('second'); expect(upgradeResponse?.statusCode).toBe(101);
    expect(upgradeResponse?.headers['set-cookie']).toEqual(['first=1', 'second=2']);
    expect(upgradeResponse?.headers['x-handshake']).toBe('retained');
    expect(upgradeResponse?.headers['x-bungee-internal']).toBeUndefined();
    expect(request?.headers.origin).toBe('https://client.example');
    expect(request?.headers.authorization).toBe('Bearer test-token');
    expect(request?.headers['x-custom']).toBe('custom-value');
    expect(request?.headers['x-remove-me']).toBeUndefined();
    // The caller owns private-hop authentication; the bridge must preserve its
    // explicitly supplied headers while stripping internal response headers.
    expect(request?.headers['x-bungee-internal']).toBe('secret');
    expect(request?.headers['sec-websocket-key']).not.toBe(downstreamKey);
    expect(upgradeResponse?.headers['sec-websocket-accept']).toBe(createHash('sha1')
      .update(downstreamKey! + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'));
    expect(request?.headers['sec-websocket-extensions']).toBeUndefined();
    const message = nextMessage(socket); socket.send('hello'); expect((await message).data.toString()).toBe('hello');
  });

  test('upstream may decline all offered subprotocols, and unoffered selections fail before downstream upgrade', async () => {
    const up = await upstream({ handleProtocols: () => false }); const gate = gateway(up.url);
    // ws itself requires a selection for constructor protocols; a header-only
    // offer allows us to exercise RFC's optional selection with a real peer.
    const socket = await client(gate.url, { headers: { 'Sec-WebSocket-Protocol': 'optional' } });
    expect(socket.protocol).toBe('');
    const bad = await upstream({ upgrade: (request, socket) => {
      const accept = createHash('sha1').update(request.headers['sec-websocket-key']! + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: unoffered\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      return false;
    } });
    const badGate = gateway(bad.url);
    expect((await rejected(badGate.url, { headers: { 'Sec-WebSocket-Protocol': 'offered' } })).status).toBe(502);
  });

  test('401/302 retain status, safe headers, repeated Set-Cookie and body without following redirects', async () => {
    let attempts = 0;
    const up = await upstream({ upgrade: (request, socket) => {
      attempts++;
      const redirect = request.url === '/redirect';
      socket.end(`HTTP/1.1 ${redirect ? '302 Found' : '401 Unauthorized'}\r\nConnection: close, X-Hop\r\nX-Hop: secret\r\nX-Bungee-Internal: secret\r\nSet-Cookie: first=1\r\nSet-Cookie: second=2\r\nWWW-Authenticate: Bearer realm="realtime"\r\nLocation: /target\r\nContent-Type: text/plain\r\nContent-Length: 6\r\n\r\ndenied`);
      return false;
    } });
    const gate = gateway(up.url);
    for (const [path, status] of [['/unauthorized', 401], ['/redirect', 302]] as const) {
      const rejection = await rejected(`${gate.url}${path}`);
      expect(rejection.status).toBe(status); expect(rejection.body).toBe('denied');
      expect(rejection.headers['set-cookie']).toEqual(['first=1', 'second=2']);
      expect(rejection.headers['www-authenticate']).toBe('Bearer realm="realtime"');
      expect(rejection.headers['x-hop']).toBeUndefined(); expect(rejection.headers['x-bungee-internal']).toBeUndefined();
    }
    expect(attempts).toBe(2);
    await until(() => gate.bridge.stats.connections === 0);
  });

  test('text/binary message types, order and message boundaries survive both directions; observer errors are isolated', async () => {
    const observed: { direction: string; view: WebSocketMessageView }[] = [];
    let metrics: WebSocketSessionMetrics | undefined;
    const up = await upstream(); const gate = gateway(up.url, {}, {
      onMessage(direction, view) { observed.push({ direction, view }); if (direction === 'client') throw new Error('observer only'); },
      onClose(_code, _reason, value) { metrics = value; },
    });
    const socket = await client(gate.url);
    const received: { text: string; binary: boolean }[] = [];
    socket.on('message', (data, binary) => received.push({ text: data.toString(), binary }));
    socket.send('{"nested":{"value":1}}'); socket.send(Buffer.from([0, 1, 2])); socket.send('last');
    socket.send(''); socket.send(Buffer.alloc(0));
    await until(() => received.length === 5);
    expect(received).toEqual([
      { text: '{"nested":{"value":1}}', binary: false }, { text: '\0\x01\x02', binary: true }, { text: 'last', binary: false },
      { text: '', binary: false }, { text: '', binary: true },
    ]);
    expect(observed.filter((item) => item.direction === 'client').map((item) => item.view.kind)).toEqual(['text', 'binary', 'text', 'text', 'binary']);
    const json = observed[0]!.view.json() as { nested: { value: number } };
    expect(observed[0]!.view.json()).toBe(json); expect(Object.isFrozen(json.nested)).toBe(true);
    expect(observed[1]!.view.json()).toBeUndefined();
    const done = closed(socket); socket.close(1000, 'finished'); expect((await done).code).toBe(1000);
    await until(() => metrics !== undefined);
    expect(metrics?.clientMessages).toBe(5); expect(metrics?.upstreamMessages).toBe(5);
    expect(metrics?.clientBytes).toBe(Buffer.byteLength('{"nested":{"value":1}}') + 3 + 4);
  });

  test('a message sent immediately with upstream 101 is retained for the downstream open', async () => {
    const up = await upstream({ connected: (socket) => { socket.send('first'); socket.send(Buffer.from([8, 9])); } });
    const gate = gateway(up.url);
    const socket = new WebSocket(gate.url); cleanups.push(() => socket.terminate()); socket.on('error', () => undefined);
    const messages: { data: string; binary: boolean }[] = [];
    socket.on('message', (data, binary) => messages.push({ data: data.toString(), binary }));
    await until(() => messages.length === 2);
    expect(messages).toEqual([{ data: 'first', binary: false }, { data: '\x08\t', binary: true }]);
  });

  test('handshake cancellation and timeout close upstream; the signal has no effect after upgrade', async () => {
    const stalled = new Set<Socket>();
    const up = await upstream({ upgrade: (_request, socket) => {
      stalled.add(socket); socket.on('close', () => stalled.delete(socket)); socket.on('end', () => socket.destroy()); socket.resume(); return false;
    } });
    // Stalled TCP peers are outside wss's client tracking.
    cleanups.push(() => { for (const socket of stalled) socket.destroy(); });
    const controller = new AbortController(); const gate = gateway(up.url, {}, { signal: controller.signal });
    const pending = rejected(gate.url); await until(() => stalled.size === 1); controller.abort();
    expect((await pending).status).toBe(499);
    await until(() => gate.bridge.stats.connections === 0 && stalled.size === 0);
    const timeoutGate = gateway(up.url, { handshakeTimeoutMs: 30 });
    expect((await rejected(timeoutGate.url)).status).toBe(504);
    await until(() => timeoutGate.bridge.stats.connections === 0);
    const normal = await upstream(); const signal = new AbortController(); const normalGate = gateway(normal.url, {}, { signal: signal.signal });
    const socket = await client(normalGate.url); signal.abort();
    const echo = nextMessage(socket); socket.send('still open'); expect((await echo).data.toString()).toBe('still open');
  });

  test('message caps: real ws upstream reports 1009; Bun native downstream rejects before callback with 1006', async () => {
    const up = await upstream({ connected: (socket, request) => {
      if (request.url === '/upstream-large') setTimeout(() => socket.send('x'.repeat(1025)), 10);
      else socket.on('message', (data, binary) => socket.send(data, { binary }));
    } });
    const gate = gateway(up.url, { maxMessageBytes: 1024 });
    const incoming = await client(`${gate.url}/client-large`); const incomingClose = closed(incoming);
    // Bun 1.4.2 aborts the socket before invoking message, so no bridge code can
    // replace this native wire behavior with a graceful 1009 close frame.
    incoming.send('x'.repeat(1025)); expect((await incomingClose).code).toBe(1006);
    const outgoing = await client(`${gate.url}/upstream-large`); expect((await closed(outgoing)).code).toBe(1009);
    await until(() => gate.bridge.stats.connections === 0);
  });

  test('abnormal 1006 closures are observed locally and translated to legal 1011 wire codes', async () => {
    let upstreamCloseCode: number | undefined;
    const up = await upstream({ connected: (socket, request) => {
      if (request.url === '/abrupt-upstream') setTimeout(() => socket.terminate(), 10);
      else socket.on('close', (code) => { upstreamCloseCode = code; });
    } });
    const gate = gateway(up.url);
    const first = await client(`${gate.url}/abrupt-upstream`); expect((await closed(first)).code).toBe(1011);
    const second = await client(`${gate.url}/abrupt-client`); second.terminate();
    await until(() => upstreamCloseCode !== undefined);
    expect(upstreamCloseCode).toBe(1011);
    await until(() => gate.bridge.stats.connections === 0);
  });

  test('upstream fragmented receive count is bounded independently of payload bytes', async () => {
    const up = await upstream({ connected: (socket) => {
      setTimeout(() => { socket.send('a', { fin: false }); socket.send('b', { fin: false }); socket.send('c', { fin: true }); }, 10);
    } });
    const gate = gateway(up.url, { maxFragments: 2 }); const socket = await client(gate.url);
    expect((await closed(socket)).code).toBe(1008);
  });

  test('admission bounds sockets and handshakes; stopAccepting cancels pending and rejects late commits', async () => {
    const stalled = new Set<Socket>();
    const up = await upstream({ upgrade: (_request, socket) => { stalled.add(socket); socket.on('close', () => stalled.delete(socket)); return false; } });
    cleanups.push(() => { for (const socket of stalled) socket.destroy(); });
    const gate = gateway(up.url, { maxHandshakes: 1, maxConnections: 2 });
    const first = rejected(gate.url); await until(() => gate.bridge.stats.handshakes === 1);
    expect((await rejected(gate.url)).status).toBe(503);
    gate.bridge.stopAccepting(); expect((await first).status).toBe(503);
    expect((await rejected(gate.url)).status).toBe(503);
    await gate.bridge.stop(); expect(gate.bridge.stats.connections).toBe(0);
    const normal = await upstream(); const socketGate = gateway(normal.url, { maxConnections: 1, maxHandshakes: 2 });
    await client(socketGate.url); expect((await rejected(socketGate.url)).status).toBe(503);
  });

  test('rejection bodies are bounded and handshake refusal does not leave a socket slot', async () => {
    const up = await upstream({ upgrade: (_request, socket) => {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 2048\r\nConnection: close\r\n\r\n' + 'x'.repeat(2048)); return false;
    } });
    const gate = gateway(up.url, { maxRejectedBodyBytes: 1024 });
    expect((await rejected(gate.url)).status).toBe(502);
    await until(() => gate.bridge.stats.connections === 0);
  });

  test('stop closes committed sessions with 1012 and frees capacity only after native close confirmation', async () => {
    const up = await upstream(); const gate = gateway(up.url); const socket = await client(gate.url);
    const close = closed(socket); await gate.bridge.stop(); expect((await close).code).toBe(1012);
    expect(gate.bridge.stats.connections).toBe(0); expect(gate.bridge.stats.processBufferedBytes).toBe(0);
  });

  test('8 concurrent loopback sessions preserve 2MiB messages at the default baseline', async () => {
    const up = await upstream(); const gate = gateway(up.url); const message = Buffer.alloc(2 * 1024 * 1024, 71);
    const sockets = await Promise.all(Array.from({ length: 8 }, () => client(gate.url)));
    const started = performance.now();
    await Promise.all(sockets.map(async (socket) => {
      const result = nextMessage(socket); socket.send(message); const echo = await result;
      expect(echo.binary).toBe(true); expect(echo.data.equals(message)).toBe(true);
    }));
    console.info(`WebSocket baseline: 8 x 2MiB round trips in ${(performance.now() - started).toFixed(1)}ms; RSS=${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MiB`);
    expect(gate.bridge.stats.connections).toBe(8);
  }, 10_000);

  test('slow downstream pauses upstream and resumes on native drain without resending -1 queued messages', async () => {
    let producer: WebSocket | undefined;
    const up = await upstream({ connected: (socket) => { producer = socket; } });
    const gate = gateway(up.url); const socket = await client(gate.url);
    const received: number[] = [];
    socket.on('message', (data) => received.push(Buffer.from(data as Buffer).readUInt32BE(0)));
    socket.pause();
    await until(() => producer !== undefined);
    const payload = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < 8; index++) {
      payload.writeUInt32BE(index, 0); producer!.send(Buffer.from(payload));
    }
    await until(() => gate.bridge.stats.downstreamBackpressureEvents > 0);
    expect(gate.bridge.stats.bufferedBytes).toBeLessThanOrEqual(gate.bridge.limits.maxBufferedBytes);
    socket.resume(); await until(() => received.length === 8, 5000);
    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gate.bridge.stats.downstreamDrainEvents).toBeGreaterThan(0);
  }, 10_000);

  test('a slow upstream cannot pause Bun input: excess queued client messages close with 1013', async () => {
    // Use native TCP pause. Bun's Node-compatible HTTP server's paused readable
    // can continue buffering network input, so ws.pause on that server would
    // not be a reliable slow-network fixture.
    const gate = gateway(slowUpstream(), { maxMessageBytes: 512 * 1024, maxBufferedBytes: 1024 * 1024, maxTotalBufferedBytes: 2 * 1024 * 1024 });
    const socket = await client(gate.url); const done = closed(socket);
    const payload = Buffer.alloc(512 * 1024);
    let peakBufferedBytes = 0;
    for (let index = 0; index < 128 && socket.readyState === WebSocket.OPEN; index++) {
      socket.send(payload); await delay(1); peakBufferedBytes = Math.max(peakBufferedBytes, gate.bridge.stats.bufferedBytes);
    }
    expect((await done).code).toBe(1013);
    expect(peakBufferedBytes).toBeLessThanOrEqual(gate.bridge.limits.maxBufferedBytes);
    await until(() => gate.bridge.stats.connections === 0);
    expect(gate.bridge.stats.bufferedBytes).toBe(0);
  }, 5000);

  test('forced stop is bounded for a peer that does not consume or acknowledge close frames', async () => {
    let recordedCode: number | undefined;
    const gate = gateway(slowUpstream(), {}, { onClose(code) { recordedCode = code; } });
    const socket = await client(gate.url); socket.pause();
    const started = performance.now(); await gate.bridge.stop();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    expect(gate.bridge.stats.connections).toBe(0);
    // Bun confirms native close immediately with its locally sent code even
    // if the remote peer is paused; this is native closure, not a peer ack.
    expect(recordedCode).toBe(1012);
  }, 3000);

  test('multiple bridge instances share the process send budget instead of multiplying it', async () => {
    const url = slowUpstream();
    const limits = { maxMessageBytes: 512 * 1024, maxBufferedBytes: 4 * 1024 * 1024, maxTotalBufferedBytes: 4 * 1024 * 1024 };
    const first = gateway(url, limits); const second = gateway(url, limits);
    const sockets = await Promise.all([client(first.url), client(second.url)]);
    let outcome: { code: number; reason: string } | undefined;
    for (const socket of sockets) void closed(socket).then((value) => { outcome ??= value; });
    const payload = Buffer.alloc(512 * 1024);
    let peak = 0;
    for (let index = 0; index < 128 && !outcome; index++) {
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      await delay(1); peak = Math.max(peak, first.bridge.stats.processBufferedBytes);
    }
    await until(() => outcome !== undefined);
    expect(outcome?.code).toBe(1013);
    expect(peak).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(limits.maxTotalBufferedBytes);
    await Promise.all([first.bridge.stop(), second.bridge.stop()]);
    expect(first.bridge.stats.processBufferedBytes).toBe(0);
  }, 5000);
});

test('JSON view is shared, deeply frozen, binary/invalid JSON is undefined, and byte length is UTF-8', () => {
  const view = createWebSocketMessageView('{"中文":{"value":[1,2]}}');
  expect(view.byteLength).toBe(Buffer.byteLength('{"中文":{"value":[1,2]}}'));
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen((view.json() as Record<string, unknown>)['中文'])).toBe(true);
  expect(view.json()).toBe(view.json());
  expect(createWebSocketMessageView('invalid').json()).toBeUndefined();
  expect(createWebSocketMessageView(Buffer.from('{}')).json()).toBeUndefined();
});
