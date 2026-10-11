import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createWebSocketBridge, type WebSocketBridge, type WebSocketBridgeOptions } from '../../../src/websocket';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(5); }
}
function bridge(limits: WebSocketBridgeOptions = {}): WebSocketBridge {
  const value = createWebSocketBridge({ handshakeTimeoutMs: 200, closeTimeoutMs: 100, ...limits });
  cleanups.push(() => value.stop()); return value;
}
function upstream(onMessage: (socket: Bun.ServerWebSocket<unknown>, data: string | Buffer) => void, fetcher?: (request: Request) => Response | undefined) {
  const received: unknown[] = []; const headers: Headers[] = []; const closed: number[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      headers.push(new Headers(request.headers));
      const rejection = fetcher?.(request); if (rejection) return rejection;
      if (server.upgrade(request)) return;
      return new Response('upgrade required', { status: 400 });
    },
    websocket: { perMessageDeflate: false, idleTimeout: 0, close(_socket, code) { closed.push(code); }, message(socket, data) {
      received.push(JSON.parse(data.toString())); onMessage(socket, data);
    } },
  });
  cleanups.push(() => server.stop(true));
  return { url: new URL(`ws://127.0.0.1:${server.port}/v1/responses`), received, headers, closed };
}
function request(gate: WebSocketBridge, url: URL, controller = new AbortController(), body: Record<string, unknown> = { model: 'fixture', input: 'hello' }) {
  return gate.requestResponses({ url, headers: new Headers({ Authorization: 'Bearer fixture', 'OpenAI-Beta': 'responses_websockets=2026-02-06' }), body, signal: controller.signal });
}
const send = (socket: Bun.ServerWebSocket<unknown>, event: Record<string, unknown>) => socket.send(JSON.stringify(event));
const terminal = (type = 'response.completed') => ({ type, response: { id: 'resp_fixture', status: type.split('.')[1], usage: { input_tokens: 11, output_tokens: 4 } } });
const sse = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** Native TCP fixture lets tests violate the handshake/frame protocol deliberately. */
function rawUpstream(onHandshake: (socket: Bun.Socket<{ headers: string; upgraded: boolean }>, accept: string) => void) {
  const peers = new Set<Bun.Socket<{ headers: string; upgraded: boolean }>>();
  const listener = Bun.listen<{ headers: string; upgraded: boolean }>({
    hostname: '127.0.0.1', port: 0, socket: {
      open(socket) { socket.data = { headers: '', upgraded: false }; peers.add(socket); },
      data(socket, data) {
        if (socket.data.upgraded) return;
        socket.data.headers += data.toString();
        if (!socket.data.headers.includes('\r\n\r\n')) return;
        const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(socket.data.headers)?.[1];
        const accept = createHash('sha1').update(key! + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.data.upgraded = true; onHandshake(socket, accept);
      },
      close(socket) { peers.delete(socket); },
    },
  });
  cleanups.push(() => { for (const peer of peers) peer.terminate(); listener.stop(true); });
  return new URL(`ws://127.0.0.1:${listener.port}`);
}
const handshake = (accept: string, connection = 'Upgrade', extra = '') => `HTTP/1.1 101 Switching Protocols\r\nConnection: ${connection}\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`;

describe('native WebSocket Responses upstream as bounded SSE', () => {
  test('one response.create request preserves headers and JSON SSE events/terminal usage', async () => {
    const events = [{ type: 'response.created', response: { id: 'resp_fixture' } }, { type: 'response.output_text.delta', delta: '你好\nworld' }, terminal()];
    const up = upstream((socket) => { for (const event of events) send(socket, event); });
    const gate = bridge(); const response = await request(gate, up.url, undefined, { type: 'wrong', model: 'fixture', input: 'hello' });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(events.map(sse).join(''));
    expect(up.received).toEqual([{ type: 'response.create', model: 'fixture', input: 'hello' }]);
    expect(up.headers[0]?.get('authorization')).toBe('Bearer fixture');
    expect(up.headers[0]?.get('openai-beta')).toBe('responses_websockets=2026-02-06');
    await until(() => gate.stats.connections === 0);
    expect(gate.stats.handshakes).toBe(0); expect(gate.stats.processBufferedBytes).toBe(0);
  });

  test.each(['response.incomplete', 'response.failed'])('%s remains an explicit terminal event', async (type) => {
    const up = upstream((socket) => send(socket, terminal(type))); const gate = bridge();
    expect(await (await request(gate, up.url)).text()).toBe(sse(terminal(type)));
    await until(() => gate.stats.connections === 0);
  });

  test('non-101 refusals preserve status, safe headers and bounded body without redirects', async () => {
    const up = upstream(() => {}, () => new Response('denied', { status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'X-Bungee-Internal': 'secret' } }));
    const gate = bridge(); const response = await request(gate, up.url);
    expect(response.status).toBe(401); expect(await response.text()).toBe('denied');
    expect(response.headers.get('www-authenticate')).toBe('Bearer'); expect(response.headers.has('x-bungee-internal')).toBe(false);
    await until(() => gate.stats.connections === 0);
    const redirect = upstream(() => {}, () => new Response('redirect', { status: 302, headers: { Location: up.url.toString() } }));
    expect((await request(gate, redirect.url)).status).toBe(302); expect(redirect.headers.length).toBe(1);
    const large = upstream(() => {}, () => new Response('x'.repeat(65), { status: 429 }));
    const limited = bridge({ maxRejectedBodyBytes: 64 });
    expect((await request(limited, large.url)).status).toBe(502);
    await until(() => limited.stats.connections === 0); expect(limited.stats.processBufferedBytes).toBe(0);
  });

  test.each(['bad-accept', 'bad-connection', 'protocol', 'extension'])('invalid handshake %s fails before SSE response', async (kind) => {
    const url = rawUpstream((socket, accept) => socket.write(handshake(kind === 'bad-accept' ? 'invalid' : accept,
      kind === 'bad-connection' ? 'keep-alive' : 'Upgrade', kind === 'protocol' ? 'Sec-WebSocket-Protocol: unsolicited\r\n' : kind === 'extension' ? 'Sec-WebSocket-Extensions: permessage-deflate\r\n' : '')));
    const gate = bridge(); expect((await request(gate, url)).status).toBe(502);
    await until(() => gate.stats.connections === 0); expect(gate.stats.handshakes).toBe(0);
  });

  test.each(['binary', 'json', 'type', 'error', 'truncated', 'oversize'])('%s cannot become a completed generation', async (kind) => {
    const up = upstream((socket) => {
      if (kind === 'binary') socket.send(Buffer.from('{}'));
      else if (kind === 'json') socket.send('invalid JSON');
      else if (kind === 'type') socket.send('{"type":"injected\\nline"}');
      else if (kind === 'error') send(socket, { type: 'error', message: 'fixture rejected' });
      else if (kind === 'oversize') send(socket, { type: 'response.output_text.delta', delta: 'x'.repeat(1000) });
      else { send(socket, { type: 'response.created' }); socket.close(1000, 'premature'); }
    });
    const gate = bridge(kind === 'oversize' ? { maxMessageBytes: 512 } : {});
    const response = await request(gate, up.url); expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    await until(() => gate.stats.connections === 0); expect(gate.stats.processBufferedBytes).toBe(0);
  });

  test('upstream error JSON is observable as SSE and then the stream fails without completed', async () => {
    const event = { type: 'error', error: { code: 'fixture_error', message: 'provider refused' } };
    const up = upstream((socket) => { send(socket, event); send(socket, terminal()); }); const gate = bridge();
    const reader = (await request(gate, up.url)).body!.getReader();
    const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toBe(sse(event));
    await expect(reader.read()).rejects.toThrow('error event');
    await until(() => gate.stats.connections === 0); expect(gate.stats.processBufferedBytes).toBe(0);
  });

  test('fragment and invalid control frames are rejected by the shared real ws parser', async () => {
    for (const frames of [Buffer.from([0x01, 1, 0x7b, 0x00, 1, 0x20, 0x80, 1, 0x7d]), Buffer.from([0x09, 0])]) {
      const url = rawUpstream((socket, accept) => { socket.write(handshake(accept)); socket.write(frames); });
      const gate = bridge({ maxFragments: 2 }); const response = await request(gate, url);
      expect(response.status).toBe(200); await expect(response.text()).rejects.toThrow();
      await until(() => gate.stats.connections === 0);
    }
  });

  test('handshake deadline, abort and pending handshake capacity free only after native close', async () => {
    const url = rawUpstream(() => {}); const gate = bridge({ maxHandshakes: 1, handshakeTimeoutMs: 50 });
    const pending = request(gate, url); expect(gate.stats.handshakes).toBe(1);
    expect((await request(gate, url)).status).toBe(503);
    expect((await pending).status).toBe(504); await until(() => gate.stats.connections === 0);
    const controller = new AbortController(); const cancelled = request(gate, url, controller); controller.abort();
    expect((await cancelled).status).toBe(499); await until(() => gate.stats.connections === 0);
    expect(gate.stats.handshakes).toBe(0); expect(gate.stats.processBufferedBytes).toBe(0);
  });

  test.each(['stream', 'signal', 'stop'])('%s cancellation closes the native socket and releases all resources', async (kind) => {
    const up = upstream((socket) => { send(socket, { type: 'response.created' }); });
    const gate = bridge({ maxConnections: 1 }); const controller = new AbortController();
    const response = await request(gate, up.url, controller); const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await request(gate, up.url)).status).toBe(503);
    if (kind === 'stream') await reader.cancel();
    else if (kind === 'signal') { controller.abort(); await expect(reader.read()).rejects.toThrow('cancelled'); }
    else { const pending = reader.read().then(() => { throw new Error('Unexpected stream success'); }, (error: Error) => error); await gate.stop(); expect((await pending).message).toContain('restarting'); }
    await until(() => gate.stats.connections === 0 && up.closed.length === 1);
    expect(up.closed.length).toBe(1); expect(gate.stats.handshakes).toBe(0); expect(gate.stats.bufferedBytes).toBe(0); expect(gate.stats.processBufferedBytes).toBe(0);
  });

  test('unread SSE applies native pause, then pull resumes ordered frames without duplicates', async () => {
    const up = upstream((socket) => { for (let i = 0; i < 10; i++) send(socket, { type: 'response.output_text.delta', delta: 'x'.repeat(128 * 1024), index: i }); send(socket, terminal()); });
    const gate = bridge({ maxMessageBytes: 150 * 1024, maxBufferedBytes: 2 * 1024 * 1024, maxTotalBufferedBytes: 2 * 1024 * 1024 });
    const response = await request(gate, up.url); await until(() => up.received.length === 1); await delay(20);
    expect(gate.stats.bufferedBytes).toBe(0); // No pull: native receive is paused.
    const reader = response.body!.getReader(); const indexes: number[] = [];
    const first = await reader.read(); indexes.push(JSON.parse(new TextDecoder().decode(first.value).split('data: ')[1]!).index);
    await delay(20); expect(gate.stats.bufferedBytes).toBeLessThanOrEqual(gate.limits.maxBufferedBytes);
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; const event = JSON.parse(new TextDecoder().decode(chunk.value).split('data: ')[1]!); if (event.index !== undefined) indexes.push(event.index); }
    expect(indexes).toEqual(Array.from({ length: 10 }, (_, i) => i));
    await until(() => gate.stats.connections === 0); expect(gate.stats.processBufferedBytes).toBe(0);
  });

  test('already decoded same-packet frames obey SSE expansion and process receive budgets', async () => {
    const events = Array.from({ length: 3 }, () => ({ type: 'response.output_text.delta', delta: 'x'.repeat(320) }));
    const up = upstream((socket) => { for (const event of events) send(socket, event); });
    const gate = bridge({ maxMessageBytes: 512, maxBufferedBytes: 600, maxTotalBufferedBytes: 600 });
    const response = await request(gate, up.url); const reader = response.body!.getReader();
    await reader.read(); await delay(20);
    expect(gate.stats.bufferedBytes).toBeLessThanOrEqual(600);
    // The decoder may emit multiple messages from one native read after pause.
    await expect(reader.read()).rejects.toThrow('budget');
    await until(() => gate.stats.connections === 0); expect(gate.stats.processBufferedBytes).toBe(0);
  });
  test('pending request JSON shares the process send budget across bridges', async () => {
    let attempts = 0;
    const url = rawUpstream(() => { attempts++; });
    const limits = { maxMessageBytes: 64, maxBufferedBytes: 100, maxTotalBufferedBytes: 100 };
    const first = bridge(limits); const second = bridge(limits); const controller = new AbortController();
    const pending = request(first, url, controller, { model: 'x' });
    expect(first.stats.processBufferedBytes).toBeGreaterThan(50);
    const rejection = await request(second, url, undefined, { model: 'x' });
    expect(rejection.status).toBe(503); expect(second.stats.connections).toBe(0); expect(second.stats.handshakes).toBe(0);
    await until(() => attempts === 1);
    controller.abort(); expect((await pending).status).toBe(499);
    await until(() => first.stats.connections === 0); expect(first.stats.processBufferedBytes).toBe(0);
  });

  test('SSE receive queues share process budgets across bridge instances', async () => {
    const up = upstream((socket) => {
      send(socket, { type: 'response.output_text.delta', delta: 'x'.repeat(320) });
      send(socket, { type: 'response.output_text.delta', delta: 'x'.repeat(320) });
    });
    const limits = { maxMessageBytes: 512, maxBufferedBytes: 900, maxTotalBufferedBytes: 900 };
    const first = bridge(limits); const second = bridge(limits); const third = bridge(limits);
    const firstReader = (await request(first, up.url)).body!.getReader(); await firstReader.read();
    await until(() => first.stats.bufferedBytes > 300);
    const secondReader = (await request(second, up.url)).body!.getReader(); await secondReader.read();
    await until(() => second.stats.bufferedBytes > 300);
    expect(first.stats.processBufferedBytes).toBeGreaterThan(700);
    await expect((await request(third, up.url)).text()).rejects.toThrow('budget');
    await until(() => third.stats.connections === 0);
    await firstReader.cancel(); await secondReader.cancel();
    await until(() => first.stats.processBufferedBytes === 0);
  });

  test('stop cancels pending handshakes and terminates a peer that never acknowledges close', async () => {
    const stalled = rawUpstream(() => {}); const pendingBridge = bridge();
    const pending = request(pendingBridge, stalled); await pendingBridge.stop();
    expect((await pending).status).toBe(503); expect(pendingBridge.stats.connections).toBe(0);
    const unresponsive = rawUpstream((socket, accept) => { socket.write(handshake(accept)); socket.pause(); });
    const established = bridge({ closeTimeoutMs: 30 }); const response = await request(established, unresponsive);
    expect(response.status).toBe(200); await established.stop();
    await expect(response.text()).rejects.toThrow('restarting');
    expect(established.stats.connections).toBe(0); expect(established.stats.processBufferedBytes).toBe(0);
  });

  test('already aborted, invalid URL and oversized requests do not acquire connections', async () => {
    const gate = bridge({ maxMessageBytes: 128 }); const controller = new AbortController(); controller.abort();
    expect((await request(gate, new URL('ws://127.0.0.1:1'), controller)).status).toBe(499);
    expect((await request(gate, new URL('ftp://invalid'))).status).toBe(502);
    expect((await request(gate, new URL('ws://127.0.0.1:1'), undefined, { input: 'x'.repeat(128) })).status).toBe(413);
    expect(gate.stats.connections).toBe(0); expect(gate.stats.handshakes).toBe(0);
  });

});
