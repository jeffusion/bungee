/// <reference path="./vendor.d.ts" />
import WebSocket from '@bungee/ws-client';
import type { IncomingMessage } from 'node:http';
import type { WebSocketMessageView, WebSocketSessionMetrics } from '../gateway/websocket-contracts';
import { downstreamHeaders, isWebSocketUpgradeRequest, offeredProtocols, upstreamHeaders, validateWebSocketRequest } from './headers';
import { createWebSocketMessageView } from './message';

export const WEBSOCKET_BRIDGE_DEFAULTS = Object.freeze({
  maxMessageBytes: 2 * 1024 * 1024,
  maxConnections: 64,
  maxHandshakes: 16,
  handshakeTimeoutMs: 10_000,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxTotalBufferedBytes: 64 * 1024 * 1024,
  maxEarlyMessages: 16,
  maxFragments: 1024,
  maxRejectedBodyBytes: 64 * 1024,
  closeTimeoutMs: 1000,
});

type Limits = { [K in keyof typeof WEBSOCKET_BRIDGE_DEFAULTS]: number };
export type WebSocketBridgeOptions = Partial<Limits>;

/** Opaque token prevents callbacks from taking ownership of another bridge's session. */
export interface WebSocketBridgeData { readonly connection: object }

export interface WebSocketUpgradeOptions {
  readonly url: URL | string;
  readonly headers: Headers;
  /** Handshake cancellation only. Removed before committing the downstream upgrade. */
  readonly signal?: AbortSignal;
  readonly onOpen?: () => unknown;
  readonly onMessage?: (direction: 'client' | 'upstream', message: WebSocketMessageView) => unknown;
  /** Runs once after both native close callbacks, for committed sessions only. */
  readonly onClose?: (code: number, reason: string, metrics: WebSocketSessionMetrics) => unknown;
}

/** Application-owned messages, independent of the HTTP handshake lifetime. */
export interface ManagedWebSocketSession {
  readonly signal: AbortSignal;
  /** Resolves after native drain when Bun has queued the frame. Never resends it. */
  send(message: string): Promise<void>;
  close(code: number, reason: string): void;
}

export interface ManagedWebSocketSessionOptions {
  readonly headers?: Headers;
  /** Handshake cancellation only; the session owns its established lifetime. */
  readonly signal?: AbortSignal;
  readonly onOpen?: (session: ManagedWebSocketSession) => void | Promise<void>;
  /** Invoked synchronously; returned jobs retain admission until they settle. */
  readonly onMessage: (session: ManagedWebSocketSession, message: WebSocketMessageView) => void | Promise<void>;
  readonly onClose?: (code: number, reason: string, metrics: WebSocketSessionMetrics) => unknown;
}

export interface WebSocketResponsesRequestOptions {
  readonly url: URL;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export interface WebSocketBridgeStats {
  readonly accepting: boolean;
  readonly connections: number;
  readonly handshakes: number;
  readonly bufferedBytes: number;
  readonly processBufferedBytes: number;
  readonly downstreamBackpressureEvents: number;
  readonly downstreamDrainEvents: number;
}

// Shared across bridge instances in one process. This accounts for bridge-held
// early messages and sampled native send queues; parser/TLS/kernel memory is
// separately bounded by message size and connection admission, not this counter.
interface TransportSession {
  readonly token: object;
  readonly bufferedBytes: number;
  readonly processLimit: number;
  refreshBuffered(): void;
  cancelHandshake(status: number, reason: string): void;
  downstreamOpen(socket: Bun.ServerWebSocket<WebSocketBridgeData>): void;
  fromClient(message: Message): void;
  downstreamDrain(): void;
  downstreamClose(code: number, reason: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}
const PROCESS_SESSIONS = new Set<TransportSession>();
let processBufferedBytes = 0;

function observe(callback: (() => unknown) | undefined): void {
  if (!callback) return;
  try { void Promise.resolve(callback()).catch(() => undefined); } catch { /* observers never own transport */ }
}

function wireCloseCode(code: number): number {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999) ? code : 1011;
}

function closeReason(reason: string): string {
  if (Buffer.byteLength(reason) <= 123) return reason;
  // A close reason is UTF-8, and the wire limit is bytes rather than characters.
  let result = '';
  for (const character of reason) {
    if (Buffer.byteLength(result) + Buffer.byteLength(character) > 123) break;
    result += character;
  }
  return result;
}

function resolveLimits(options: WebSocketBridgeOptions): Limits {
  const limits = { ...WEBSOCKET_BRIDGE_DEFAULTS, ...options } as Limits;
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
      throw new TypeError(`Invalid WebSocket bridge limit: ${name}`);
    }
  }
  if (limits.maxBufferedBytes < limits.maxMessageBytes + 14
    || limits.maxTotalBufferedBytes < limits.maxBufferedBytes) {
    throw new TypeError('WebSocket buffer budgets must accommodate one maximum-sized message and framing');
  }
  return Object.freeze(limits);
}

/** Both transparent and Responses sessions use the real ws parser and TLS checks. */
function createUpstream(url: URL, headers: Headers, protocols: readonly string[], limits: Readonly<Limits>): WebSocket {
  // The alias avoids Bun's bare-ws shim, which ignores parser limits and headers.
  return new WebSocket(url, [], {
    headers: upstreamHeaders(headers, protocols), followRedirects: false,
    rejectUnauthorized: true, perMessageDeflate: false,
    maxPayload: limits.maxMessageBytes, maxFragments: limits.maxFragments,
    maxBufferedChunks: limits.maxFragments, handshakeTimeout: limits.handshakeTimeoutMs,
  });
}

function validateUpstreamHandshake(response: IncomingMessage, protocols: readonly string[]): boolean {
  const connection = response.headers.connection;
  const protocol = response.headers['sec-websocket-protocol'];
  if (typeof connection !== 'string' || !connection.split(',').some((token) => token.trim().toLowerCase() === 'upgrade')
    || (protocol !== undefined && (typeof protocol !== 'string' || !protocols.includes(protocol)))) return false;
  // ws validates Upgrade, fresh-key Accept and extensions; a selected protocol
  // is optional because the offer is sent in the header rather than constructor.
  delete response.headers['sec-websocket-protocol'];
  return true;
}

export class WebSocketBridge {
  readonly limits: Readonly<Limits>;
  readonly websocket: Bun.WebSocketHandler<WebSocketBridgeData>;
  readonly #sessions = new Map<object, TransportSession>();
  readonly #waiters = new Set<() => void>();
  #accepting = true;
  #handshakes = 0;
  #stopPromise: Promise<void> | undefined;
  #backpressureEvents = 0;
  #drainEvents = 0;

  constructor(options: WebSocketBridgeOptions = {}) {
    this.limits = resolveLimits(options);
    this.websocket = {
      data: {} as WebSocketBridgeData,
      perMessageDeflate: false,
      maxPayloadLength: this.limits.maxMessageBytes,
      backpressureLimit: this.limits.maxBufferedBytes,
      closeOnBackpressureLimit: false,
      // Sessions own their lifecycle; the HTTP timeout and AbortSignal do not.
      idleTimeout: 0,
      sendPings: true,
      open: (socket) => { this.#session(socket)?.downstreamOpen(socket); },
      message: (socket, message) => { this.#session(socket)?.fromClient(message); },
      drain: (socket) => {
        const session = this.#session(socket);
        if (session) { this.#drainEvents++; session.downstreamDrain(); }
      },
      close: (socket, code, reason) => { this.#session(socket)?.downstreamClose(code, reason); },
    };
  }

  get stats(): WebSocketBridgeStats {
    let bufferedBytes = 0;
    for (const session of PROCESS_SESSIONS) session.refreshBuffered();
    for (const session of this.#sessions.values()) bufferedBytes += session.bufferedBytes;
    return Object.freeze({
      accepting: this.#accepting, connections: this.#sessions.size, handshakes: this.#handshakes,
      bufferedBytes, processBufferedBytes,
      downstreamBackpressureEvents: this.#backpressureEvents, downstreamDrainEvents: this.#drainEvents,
    });
  }

  /** Call only for upgrade candidates; ordinary HTTP returns undefined without taking ownership. */
  upgrade(request: Request, server: Bun.Server<any>, options: WebSocketUpgradeOptions): Promise<Response | undefined> {
    if (!isWebSocketUpgradeRequest(request)) return Promise.resolve(undefined);
    const invalid = validateWebSocketRequest(request);
    if (invalid) return Promise.resolve(invalid);
    if (!this.#accepting) return Promise.resolve(new Response('WebSocket bridge is stopping', { status: 503 }));
    if (this.#sessions.size >= this.limits.maxConnections || this.#handshakes >= this.limits.maxHandshakes) {
      return Promise.resolve(new Response('WebSocket bridge capacity exceeded', { status: 503 }));
    }
    if (options.signal?.aborted) return Promise.resolve(new Response('WebSocket handshake cancelled', { status: 499 }));
    let url: URL;
    try {
      url = new URL(options.url);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Invalid protocol');
      if (url.hash) throw new Error('WebSocket URL cannot contain a fragment');
    } catch { return Promise.resolve(new Response('Invalid WebSocket upstream URL', { status: 502 })); }
    const session = new BridgeSession(this, request, server, options, url);
    this.#sessions.set(session.token, session);
    PROCESS_SESSIONS.add(session);
    this.#handshakes++;
    session.start();
    return session.response;
  }

  /** Uses the same native handler and admission budgets without an upstream socket. */
  upgradeSession(request: Request, server: Bun.Server<any>, options: ManagedWebSocketSessionOptions): Promise<Response | undefined> {
    if (!isWebSocketUpgradeRequest(request)) return Promise.resolve(undefined);
    const invalid = validateWebSocketRequest(request);
    if (invalid) return Promise.resolve(invalid);
    if (!this.#accepting) return Promise.resolve(new Response('WebSocket bridge is stopping', { status: 503 }));
    if (this.#sessions.size >= this.limits.maxConnections || this.#handshakes >= this.limits.maxHandshakes) {
      return Promise.resolve(new Response('WebSocket bridge capacity exceeded', { status: 503 }));
    }
    if (options.signal?.aborted) return Promise.resolve(new Response('WebSocket handshake cancelled', { status: 499 }));
    const headers = new Headers(options.headers);
    const protocol = headers.get('sec-websocket-protocol');
    if (protocol !== null && !offeredProtocols(request).includes(protocol)) {
      return Promise.resolve(new Response('Invalid WebSocket selected protocol', { status: 502 }));
    }
    const denied: string[] = [];
    headers.forEach((_value, name) => {
      if (name.startsWith('sec-websocket-') && name !== 'sec-websocket-protocol') denied.push(name);
    });
    for (const name of denied) headers.delete(name);
    const session = new ManagedSession(this, options);
    this.#sessions.set(session.token, session);
    PROCESS_SESSIONS.add(session);
    this.#handshakes++;
    // Bun 1.4.2 caches native offer headers while the fetch callback (including
    // its microtasks) is running. Commit in the next turn so deleting the offer
    // prevents Bun from silently selecting its first protocol or appending it.
    return new Promise((resolve) => { setTimeout(() => resolve(session.upgrade(request, server, headers)), 0); });
  }

  /** One native Responses generation, exposed to the normal HTTP body pipeline as SSE. */
  requestResponses(options: WebSocketResponsesRequestOptions): Promise<Response> {
    if (!this.#accepting) return Promise.resolve(new Response('WebSocket bridge is stopping', { status: 503 }));
    if (this.#sessions.size >= this.limits.maxConnections || this.#handshakes >= this.limits.maxHandshakes) {
      return Promise.resolve(new Response('WebSocket bridge capacity exceeded', { status: 503 }));
    }
    if (options.signal.aborted) return Promise.resolve(new Response('WebSocket request cancelled', { status: 499 }));
    let url: URL;
    let message: string;
    try {
      url = new URL(options.url);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (!['ws:', 'wss:'].includes(url.protocol) || url.hash) throw new Error('Invalid URL');
      message = JSON.stringify({ ...options.body, type: 'response.create' });
    } catch { return Promise.resolve(new Response('Invalid WebSocket Responses request', { status: 502 })); }
    if (Buffer.byteLength(message) > this.limits.maxMessageBytes) {
      return Promise.resolve(new Response('WebSocket Responses request too large', { status: 413 }));
    }
    const session = new ResponsesSession(this, options, url, message);
    this.#sessions.set(session.token, session); PROCESS_SESSIONS.add(session); this.#handshakes++;
    session.start();
    return session.response;
  }

  stopAccepting(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    for (const session of this.#sessions.values()) session.cancelHandshake(503, 'WebSocket bridge is stopping');
  }

  /** 1012 close, bounded grace, then terminate, and require actual native close confirmation. */
  stop(): Promise<void> {
    return this.#stopPromise ??= this.#stop();
  }

  async #stop(): Promise<void> {
    this.stopAccepting();
    for (const session of this.#sessions.values()) session.close(1012, 'Service restarting');
    if (await this.#waitForClose(this.limits.closeTimeoutMs)) return;
    await this.forceStop();
  }

  async forceStop(): Promise<void> {
    this.stopAccepting();
    for (const session of this.#sessions.values()) session.terminate();
    if (!await this.#waitForClose(this.limits.closeTimeoutMs)) {
      throw new Error('WebSocket bridge stop unconfirmed: native socket close callback missing');
    }
  }

  get accepting(): boolean { return this.#accepting; }

  /** @internal */ endHandshake(): void { this.#handshakes--; }
  /** @internal */ backpressure(): void { this.#backpressureEvents++; }
  /** @internal */ confirmGone(session: TransportSession): void {
    if (!this.#sessions.delete(session.token)) return;
    PROCESS_SESSIONS.delete(session);
    if (this.#sessions.size === 0) { for (const resolve of this.#waiters) resolve(); this.#waiters.clear(); }
  }

  #session(socket: Bun.ServerWebSocket<WebSocketBridgeData>): TransportSession | undefined {
    return this.#sessions.get(socket.data?.connection);
  }

  #waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.#sessions.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (): void => { clearTimeout(timer); this.#waiters.delete(finish); resolve(true); };
      const timer = setTimeout(() => { this.#waiters.delete(finish); resolve(false); }, timeoutMs);
      timer.unref?.();
      this.#waiters.add(finish);
    });
  }
}

type Message = string | Buffer;

class ResponsesSession implements TransportSession {
  readonly token = Object.freeze({});
  readonly response: Promise<Response>;
  readonly #bridge: WebSocketBridge;
  readonly #options: Pick<WebSocketResponsesRequestOptions, 'headers' | 'signal'>;
  readonly #url: URL;
  #message: string | undefined;
  #pendingBytes: number;
  readonly #queue: Uint8Array[] = [];
  #queueBytes = 0;
  #rejectionBytes = 0;
  #bufferedBytes = 0;
  #socket: WebSocket | undefined;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #resolve!: (response: Response) => void;
  #handshakeFinished = false;
  #streamDone = true;
  #demand = false;
  #terminal = false;
  #terminalError = false;
  #closing = false;
  #gone = true;
  #finished = false;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #abort: () => void;

  constructor(bridge: WebSocketBridge, options: WebSocketResponsesRequestOptions, url: URL, message: string) {
    this.#bridge = bridge; this.#options = { headers: new Headers(options.headers), signal: options.signal };
    this.#url = url; this.#message = message; this.#pendingBytes = Buffer.byteLength(message) + 14;
    this.response = new Promise((resolve) => { this.#resolve = resolve; });
    this.#abort = () => {
      if (!this.#handshakeFinished) this.cancelHandshake(499, 'WebSocket request cancelled');
      else this.#fail('WebSocket request cancelled');
    };
  }

  get bufferedBytes(): number { return this.#bufferedBytes; }
  get processLimit(): number { return this.#bridge.limits.maxTotalBufferedBytes; }

  start(): void {
    this.refreshBuffered();
    if (!this.#canBuffer(0)) { this.cancelHandshake(503, 'WebSocket send budget exceeded'); return; }
    if (this.#options.signal.aborted) { this.cancelHandshake(499, 'WebSocket request cancelled'); return; }
    this.#handshakeTimer = setTimeout(() => this.cancelHandshake(504, 'WebSocket upstream handshake timed out'), this.#bridge.limits.handshakeTimeoutMs);
    this.#handshakeTimer.unref?.();
    this.#options.signal.addEventListener('abort', this.#abort, { once: true });
    try {
      const socket = this.#socket = createUpstream(this.#url, this.#options.headers, [], this.#bridge.limits);
      this.#gone = false;
      socket.on('upgrade', (response) => {
        if (!this.#handshakeFinished && !validateUpstreamHandshake(response, [])) {
          this.cancelHandshake(502, 'Invalid WebSocket upstream handshake');
        }
      });
      socket.on('unexpected-response', (_request, response) => this.#rejected(response));
      socket.on('open', () => this.#open());
      socket.on('message', (data, binary) => {
        if (this.#closing) return;
        if (binary) { this.#fail('Binary WebSocket Responses message'); return; }
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.#messageReceived(buffer);
      });
      socket.on('error', () => {
        if (!this.#handshakeFinished) this.cancelHandshake(502, 'WebSocket upstream handshake failed');
        else this.#fail('WebSocket Responses upstream failed');
      });
      socket.on('close', () => {
        this.#gone = true;
        if (!this.#handshakeFinished) this.cancelHandshake(502, 'WebSocket upstream closed before upgrade');
        else if (!this.#terminal && !this.#streamDone) this.#fail('WebSocket Responses stream truncated before terminal event');
        this.refreshBuffered(); this.#maybeFinish();
      });
      if (this.#options.signal.aborted) this.#abort();
    } catch {
      this.#gone = true;
      this.cancelHandshake(502, 'WebSocket upstream handshake failed');
      this.#maybeFinish();
    }
  }

  #open(): void {
    if (this.#handshakeFinished) return;
    if (this.#options.signal.aborted) { this.#abort(); return; }
    if (!this.#bridge.accepting) { this.cancelHandshake(503, 'WebSocket bridge is stopping'); return; }
    const socket = this.#socket!;
    socket.pause();
    if (!this.#canBuffer(0)) { this.cancelHandshake(503, 'WebSocket send budget exceeded'); return; }
    try {
      // Exactly one request; send callbacks report completion, never retry.
      const message = this.#message!;
      this.#message = undefined; this.#pendingBytes = 0;
      socket.send(message, { binary: false, compress: false }, (error) => {
        this.refreshBuffered();
        if (error) this.#fail('WebSocket Responses request send failed');
      });
      this.refreshBuffered();
      if (!this.#canBuffer(0)) { this.cancelHandshake(503, 'WebSocket send budget exceeded'); return; }
    } catch { this.cancelHandshake(502, 'WebSocket Responses request send failed'); return; }
    if (this.#handshakeFinished) return;
    this.#streamDone = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => { this.#controller = controller; },
      pull: () => this.#pull(),
      cancel: () => { this.#streamDone = true; this.#discard(); this.#beginClose(1000, 'Response consumer cancelled'); this.#maybeFinish(); },
    }, { highWaterMark: 0 });
    this.#finishHandshake(new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } }));
  }

  #messageReceived(buffer: Buffer): void {
    if (buffer.byteLength > this.#bridge.limits.maxMessageBytes) { this.#fail('WebSocket Responses message too large'); return; }
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(buffer.toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid event');
      event = value as Record<string, unknown>;
      if (typeof event.type !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(event.type)) throw new Error('Invalid type');
    } catch { this.#fail('Invalid JSON WebSocket Responses event'); return; }
    const chunk = new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    // Account for SSE expansion, not just the incoming JSON payload. pause()
    // cannot retract other frames already decoded from the same native chunk.
    if (this.#queue.length >= this.#bridge.limits.maxEarlyMessages || !this.#canBuffer(chunk.byteLength)) {
      this.#fail('WebSocket Responses receive budget exceeded'); return;
    }
    this.#queue.push(chunk); this.#queueBytes += chunk.byteLength; this.refreshBuffered();
    this.#socket?.pause();
    this.#terminalError = event.type === 'error';
    this.#terminal = this.#terminalError || ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type as string);
    if (this.#demand) this.#pull();
    if (this.#terminal) this.#beginClose(this.#terminalError ? 1011 : 1000, 'Response terminal event');
  }

  #pull(): void {
    if (this.#streamDone) return;
    if (this.#queue.length > 0) {
      const chunk = this.#queue.shift()!;
      this.#queueBytes -= chunk.byteLength; this.refreshBuffered(); this.#demand = false;
      this.#controller!.enqueue(chunk);
      if (this.#terminal && this.#queue.length === 0) {
        this.#streamDone = true;
        if (this.#terminalError) this.#controller!.error(new Error('WebSocket Responses upstream error event'));
        else this.#controller!.close();
        this.#maybeFinish();
      }
      return;
    }
    this.#demand = true;
    if (!this.#closing) this.#socket?.resume();
  }

  #rejected(response: IncomingMessage): void {
    if (this.#handshakeFinished) { response.destroy(); return; }
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      if (this.#handshakeFinished) return;
      if (this.#rejectionBytes + chunk.byteLength > this.#bridge.limits.maxRejectedBodyBytes || !this.#canBuffer(chunk.byteLength)) {
        response.destroy(); this.cancelHandshake(502, 'WebSocket upstream rejection body exceeded limit'); return;
      }
      chunks.push(chunk); this.#rejectionBytes += chunk.byteLength; this.refreshBuffered();
    });
    response.on('error', () => this.cancelHandshake(502, 'WebSocket upstream rejection failed'));
    response.on('aborted', () => this.cancelHandshake(502, 'WebSocket upstream rejection aborted'));
    response.on('end', () => {
      if (this.#handshakeFinished) return;
      const candidate = response.statusCode ?? 502;
      const status = candidate >= 200 && candidate <= 599 ? candidate : 502;
      const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
      this.#rejectionBytes = 0; this.refreshBuffered();
      this.#finishHandshake(new Response(body, { status, headers: downstreamHeaders(response, true) }));
      this.#beginClose(1011, 'Upstream rejected upgrade');
    });
  }

  cancelHandshake(status: number, reason: string): void {
    if (this.#handshakeFinished) return;
    this.#rejectionBytes = 0; this.#message = undefined; this.#pendingBytes = 0; this.refreshBuffered();
    this.#finishHandshake(new Response(reason, { status })); this.#beginClose(1011, reason);
  }

  #finishHandshake(response: Response): void {
    if (this.#handshakeFinished) return;
    this.#handshakeFinished = true;
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#bridge.endHandshake(); this.#resolve(response);
  }

  #canBuffer(bytes: number): boolean {
    let processLimit = this.processLimit;
    for (const session of PROCESS_SESSIONS) { session.refreshBuffered(); processLimit = Math.min(processLimit, session.processLimit); }
    return this.#bufferedBytes + bytes <= this.#bridge.limits.maxBufferedBytes && processBufferedBytes + bytes <= processLimit;
  }

  refreshBuffered(): void {
    const native = !this.#gone ? this.#socket?.bufferedAmount ?? 0 : 0;
    const bytes = native + this.#queueBytes + this.#rejectionBytes + this.#pendingBytes;
    processBufferedBytes += bytes - this.#bufferedBytes; this.#bufferedBytes = bytes;
  }

  #discard(): void { this.#queue.length = 0; this.#queueBytes = 0; this.#rejectionBytes = 0; this.#pendingBytes = 0; this.#message = undefined; this.refreshBuffered(); }

  #fail(reason: string, code = 1011): void {
    if (!this.#handshakeFinished) { this.cancelHandshake(502, reason); return; }
    if (!this.#streamDone) { this.#streamDone = true; this.#controller?.error(new Error(reason)); }
    this.#discard(); this.#beginClose(code, reason); this.#maybeFinish();
  }

  #beginClose(code: number, reason: string): void {
    if (this.#closing || this.#finished) return;
    this.#closing = true;
    this.#closeTimer = setTimeout(() => this.#terminateNative(), this.#bridge.limits.closeTimeoutMs);
    this.#closeTimer.unref?.();
    try {
      if (this.#socket?.readyState === WebSocket.CONNECTING) this.#socket.terminate();
      else if (this.#socket?.readyState === WebSocket.OPEN) { this.#socket.resume(); this.#socket.close(wireCloseCode(code), closeReason(reason)); }
    } catch { this.#terminateNative(); }
    this.refreshBuffered(); this.#maybeFinish();
  }

  close(code: number, reason: string): void {
    if (!this.#handshakeFinished) this.cancelHandshake(503, reason);
    else this.#fail(reason || 'WebSocket Responses session closed', code);
  }

  terminate(): void { this.close(1012, 'WebSocket bridge is stopping'); this.#terminateNative(); }
  #terminateNative(): void { try { this.#socket?.terminate(); } catch { /* admission waits for native close */ } }
  downstreamOpen(socket: Bun.ServerWebSocket<WebSocketBridgeData>): void { socket.terminate(); }
  fromClient(_message: Message): void {}
  downstreamDrain(): void {}
  downstreamClose(_code: number, _reason: string): void {}

  #maybeFinish(): void {
    if (this.#finished || !this.#handshakeFinished || !this.#gone || !this.#streamDone) return;
    this.#finished = true;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#options.signal.removeEventListener('abort', this.#abort);
    this.#discard(); this.#bridge.confirmGone(this);
  }
}

class ManagedSession implements TransportSession {
  readonly token = Object.freeze({});
  readonly #bridge: WebSocketBridge;
  readonly #options: ManagedWebSocketSessionOptions;
  readonly #controller = new AbortController();
  readonly #session: ManagedWebSocketSession;
  readonly #drainWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  #socket: Bun.ServerWebSocket<WebSocketBridgeData> | undefined;
  #committed = false;
  #handshakeFinished = false;
  #handshakeRejection: Response | undefined;
  #gone = true;
  #closing = false;
  #finished = false;
  #blocked = false;
  #jobs = 0;
  #activeBytes = 0;
  #pendingSends = 0;
  #pendingBytes = 0;
  #bufferedBytes = 0;
  #openedAt: number | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #code = 1006;
  #reason = '';
  #clientMessages = 0;
  #clientBytes = 0;
  #sentMessages = 0;
  #sentBytes = 0;

  constructor(bridge: WebSocketBridge, options: ManagedWebSocketSessionOptions) {
    this.#bridge = bridge; this.#options = options;
    this.#session = Object.freeze({
      signal: this.#controller.signal,
      send: (message: string) => this.#send(message),
      close: (code: number, reason: string) => this.close(code, reason),
    });
  }

  get bufferedBytes(): number { return this.#bufferedBytes; }
  get processLimit(): number { return this.#bridge.limits.maxTotalBufferedBytes; }

  upgrade(request: Request, server: Bun.Server<any>, headers: Headers): Response | undefined {
    if (this.#options.signal?.aborted) this.cancelHandshake(499, 'WebSocket handshake cancelled');
    if (!this.#bridge.accepting) this.cancelHandshake(503, 'WebSocket bridge is stopping');
    if (this.#handshakeRejection) {
      this.#handshakeFinished = true; this.#bridge.endHandshake(); this.#maybeFinish();
      return this.#handshakeRejection;
    }
    // Bun echoes the client's offer unless it is removed from the native request.
    request.headers.delete('sec-websocket-protocol');
    this.#committed = true; this.#gone = false;
    let upgraded = false;
    try { upgraded = server.upgrade(request, { data: { connection: this.token }, headers }); } catch { /* reject below */ }
    this.#handshakeFinished = true;
    this.#bridge.endHandshake();
    if (!upgraded) {
      this.#committed = false; this.#gone = true;
      this.close(1011, 'Downstream upgrade failed');
      this.#maybeFinish();
      return new Response('WebSocket downstream upgrade failed', { status: 502 });
    }
    this.#maybeFinish();
    return undefined;
  }

  cancelHandshake(status: number, reason: string): void {
    if (!this.#handshakeFinished && !this.#handshakeRejection) {
      this.#handshakeRejection = new Response(reason, { status }); this.close(1011, reason);
    }
  }

  downstreamOpen(socket: Bun.ServerWebSocket<WebSocketBridgeData>): void {
    if (this.#socket || this.#finished) { socket.terminate(); return; }
    this.#socket = socket;
    if (this.#closing) { socket.close(wireCloseCode(this.#code), this.#reason); return; }
    if (!this.#bridge.accepting) { this.close(1012, 'Service restarting'); return; }
    this.#openedAt = performance.now();
    if (this.#options.onOpen) this.#run(() => this.#options.onOpen!(this.#session), 0);
  }

  fromClient(message: Message): void {
    if (this.#closing || !this.#socket) return;
    const bytes = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
    if (bytes > this.#bridge.limits.maxMessageBytes) { this.close(1009, 'Message too large'); return; }
    if (this.#jobs >= this.#bridge.limits.maxEarlyMessages || !this.#canBuffer(bytes + 14)) {
      this.close(1013, 'WebSocket message-job budget exceeded'); return;
    }
    this.#clientMessages++; this.#clientBytes += bytes;
    const view = createWebSocketMessageView(message);
    // No promise chain or input queue: busy/cancel commands enter immediately.
    this.#run(() => this.#options.onMessage(this.#session, view), bytes + 14);
  }

  #run(callback: () => void | Promise<void>, bytes: number): void {
    this.#jobs++; this.#activeBytes += bytes; this.refreshBuffered();
    const finish = (): void => {
      this.#jobs--; this.#activeBytes -= bytes; this.refreshBuffered(); this.#maybeFinish();
    };
    try {
      const job = callback();
      if (job === undefined) finish();
      else void Promise.resolve(job).catch(() => this.close(1011, 'WebSocket message handler failed')).finally(finish);
    } catch { this.close(1011, 'WebSocket message handler failed'); finish(); }
  }

  async #send(message: string): Promise<void> {
    if (this.#closing || !this.#socket || this.#socket.readyState !== 1) throw new Error('WebSocket session closed');
    if (typeof message !== 'string') throw new TypeError('Managed WebSocket messages must be strings');
    const bytes = Buffer.byteLength(message);
    if (bytes > this.#bridge.limits.maxMessageBytes) {
      this.close(1009, 'Message too large'); throw new Error('WebSocket message too large');
    }
    if (this.#pendingSends >= this.#bridge.limits.maxEarlyMessages || !this.#canBuffer(bytes + 14)) {
      this.close(1013, 'WebSocket send budget exceeded'); throw new Error('WebSocket send budget exceeded');
    }
    let reserved = bytes + 14;
    this.#pendingSends++; this.#pendingBytes += reserved; this.refreshBuffered();
    try {
      while (this.#blocked) await this.#waitForDrain();
      if (this.#closing || this.#socket.readyState !== 1) throw new Error('WebSocket session closed');
      // Transfer the reservation to Bun's native queue, never retaining an
      // application send queue alongside the native one.
      this.#pendingBytes -= reserved; reserved = 0;
      const status = this.#socket.send(message, false);
      this.refreshBuffered();
      if (status === 0 && bytes !== 0) throw new Error('WebSocket downstream send failed');
      this.#sentMessages++; this.#sentBytes += bytes;
      if (!this.#canBuffer(0)) {
        this.close(1013, 'WebSocket send budget exceeded'); throw new Error('WebSocket send budget exceeded');
      }
      if (status === -1) {
        this.#blocked = true; this.#bridge.backpressure();
        await this.#waitForDrain();
      }
    } catch (error) {
      if (!this.#closing) this.close(1011, 'WebSocket downstream send failed');
      throw error;
    } finally {
      this.#pendingSends--; this.#pendingBytes -= reserved;
      this.refreshBuffered(); this.#maybeFinish();
    }
  }

  #waitForDrain(): Promise<void> {
    if (this.#closing) return Promise.reject(new Error('WebSocket session closed'));
    return new Promise((resolve, reject) => { this.#drainWaiters.add({ resolve, reject }); });
  }

  downstreamDrain(): void {
    this.refreshBuffered();
    if (this.#closing) return;
    this.#blocked = false;
    const waiters = [...this.#drainWaiters]; this.#drainWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  #canBuffer(bytes: number): boolean {
    let processLimit = this.processLimit;
    for (const session of PROCESS_SESSIONS) {
      session.refreshBuffered(); processLimit = Math.min(processLimit, session.processLimit);
    }
    return this.#bufferedBytes + bytes <= this.#bridge.limits.maxBufferedBytes
      && processBufferedBytes + bytes <= processLimit;
  }

  refreshBuffered(): void {
    let native = 0;
    if (!this.#gone && this.#socket) {
      try { native = this.#socket.getBufferedAmount(); } catch { /* real close confirms release */ }
    }
    const bytes = native + this.#activeBytes + this.#pendingBytes;
    processBufferedBytes += bytes - this.#bufferedBytes; this.#bufferedBytes = bytes;
  }

  close(code: number, reason: string): void {
    if (this.#closing || this.#finished) return;
    this.#closing = true; this.#code = code; this.#reason = closeReason(reason);
    const error = new Error('WebSocket session closed');
    this.#controller.abort(error);
    for (const waiter of this.#drainWaiters) waiter.reject(error);
    this.#drainWaiters.clear();
    this.#closeTimer = setTimeout(() => this.terminate(), this.#bridge.limits.closeTimeoutMs);
    this.#closeTimer.unref?.();
    try { this.#socket?.close(wireCloseCode(code), this.#reason); } catch { this.#socket?.terminate(); }
    this.refreshBuffered();
  }

  terminate(): void {
    if (this.#finished) return;
    this.close(1012, 'Service restarting');
    try { this.#socket?.terminate(); } catch { /* retain admission until native close */ }
  }

  downstreamClose(code: number, reason: string): void {
    this.close(code, reason);
    this.#gone = true; this.#code = code; this.#reason = reason;
    this.refreshBuffered(); this.#maybeFinish();
  }

  #maybeFinish(): void {
    if (this.#finished || !this.#handshakeFinished || !this.#gone || this.#jobs > 0 || this.#pendingSends > 0) return;
    this.#finished = true;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.refreshBuffered(); this.#bridge.confirmGone(this);
    if (this.#committed) {
      const metrics = Object.freeze({
        durationMs: this.#openedAt === undefined ? 0 : Math.max(0, performance.now() - this.#openedAt),
        clientMessages: this.#clientMessages, clientBytes: this.#clientBytes,
        upstreamMessages: this.#sentMessages, upstreamBytes: this.#sentBytes,
      });
      observe(this.#options.onClose ? () => this.#options.onClose!(this.#code, this.#reason, metrics) : undefined);
    }
  }
}

class BridgeSession {
  readonly token = Object.freeze({});
  readonly response: Promise<Response | undefined>;
  readonly #bridge: WebSocketBridge;
  readonly #request: Request;
  readonly #server: Bun.Server<any>;
  readonly #options: WebSocketUpgradeOptions;
  readonly #url: URL;
  readonly #protocols: string[];
  readonly #early: Message[] = [];
  #earlyBytes = 0;
  #bufferedBytes = 0;
  #upstream: WebSocket | undefined;
  #downstream: Bun.ServerWebSocket<WebSocketBridgeData> | undefined;
  #upstreamGone = false;
  #downstreamGone = true;
  #committed = false;
  #openedAt: number | undefined;
  #handshakeFinished = false;
  #closing = false;
  #finished = false;
  #blocked = false;
  #responseHeaders = new Headers();
  #selectedProtocol: string | undefined;
  #resolveResponse!: (response: Response | undefined) => void;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #abort: (() => void) | undefined;
  #code = 1006;
  #reason = '';
  #clientMessages = 0;
  #upstreamMessages = 0;
  #clientBytes = 0;
  #upstreamBytes = 0;

  constructor(bridge: WebSocketBridge, request: Request, server: Bun.Server<any>, options: WebSocketUpgradeOptions, url: URL) {
    this.#bridge = bridge; this.#request = request; this.#server = server; this.#options = options; this.#url = url;
    this.#protocols = offeredProtocols(request);
    this.response = new Promise((resolve) => { this.#resolveResponse = resolve; });
  }

  get bufferedBytes(): number { return this.#bufferedBytes; }
  get processLimit(): number { return this.#bridge.limits.maxTotalBufferedBytes; }

  start(): void {
    this.#handshakeTimer = setTimeout(() => this.cancelHandshake(504, 'WebSocket upstream handshake timed out'), this.#bridge.limits.handshakeTimeoutMs);
    this.#handshakeTimer.unref?.();
    this.#abort = () => this.cancelHandshake(499, 'WebSocket handshake cancelled');
    this.#options.signal?.addEventListener('abort', this.#abort, { once: true });
    try {
      const socket = this.#upstream = createUpstream(this.#url, this.#options.headers, this.#protocols, this.#bridge.limits);
      socket.on('upgrade', (response) => this.#upgraded(response));
      socket.on('unexpected-response', (_request, response) => this.#rejected(response));
      socket.on('open', () => this.#upstreamOpen());
      socket.on('message', (data, binary) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.#fromUpstream(binary ? buffer : buffer.toString('utf8'));
      });
      socket.on('error', (error: Error & { code?: string }) => {
        if (!this.#handshakeFinished) this.cancelHandshake(502, 'WebSocket upstream handshake failed');
        else this.close(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 1009
          : error.code === 'WS_ERR_TOO_MANY_BUFFERED_PARTS' ? 1008 : 1011, 'WebSocket upstream failed');
      });
      socket.on('close', (code, reason) => this.#upstreamClose(code, reason.toString('utf8')));
      // Abort may have happened while constructing the socket.
      if (this.#options.signal?.aborted) this.cancelHandshake(499, 'WebSocket handshake cancelled');
    } catch {
      this.#upstreamGone = true;
      this.#finishHandshake(new Response('WebSocket upstream handshake failed', { status: 502 }));
      this.#maybeFinish();
    }
  }

  #upgraded(response: IncomingMessage): void {
    if (this.#handshakeFinished) return;
    this.#responseHeaders = downstreamHeaders(response);
    const protocol = response.headers['sec-websocket-protocol'];
    if (!validateUpstreamHandshake(response, this.#protocols)) {
      this.cancelHandshake(502, 'Invalid WebSocket upstream handshake');
      return;
    }
    this.#selectedProtocol = protocol;
  }

  #upstreamOpen(): void {
    if (this.#handshakeFinished || !this.#bridge.accepting || this.#options.signal?.aborted) {
      this.cancelHandshake(this.#options.signal?.aborted ? 499 : 503, 'WebSocket handshake cancelled');
      this.close(1012, 'Service restarting');
      return;
    }
    if (this.#selectedProtocol) this.#responseHeaders.set('Sec-WebSocket-Protocol', this.#selectedProtocol);
    // Bun otherwise echoes the original offer as its selected protocol. The
    // native request object must remain the upgrade owner, but its copied
    // Headers can be sanitized before committing the hop-specific response.
    this.#request.headers.delete('sec-websocket-protocol');
    this.#committed = true;
    this.#downstreamGone = false;
    // No await between checking admission and native upgrade: stopAccepting
    // cannot race a successful commit in this event-loop turn.
    let upgraded = false;
    try {
      upgraded = this.#server.upgrade(this.#request, { data: { connection: this.token }, headers: this.#responseHeaders });
    } catch { /* response below; the upstream is always closed */ }
    if (!upgraded) {
      this.#committed = false;
      this.#downstreamGone = true;
      this.#finishHandshake(new Response('WebSocket downstream upgrade failed', { status: 502 }));
      this.close(1011, 'Downstream upgrade failed');
      return;
    }
    this.#finishHandshake(undefined);
  }

  #rejected(response: IncomingMessage): void {
    if (this.#handshakeFinished) { response.destroy(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > this.#bridge.limits.maxRejectedBodyBytes) {
        response.destroy();
        this.cancelHandshake(502, 'WebSocket upstream rejection body exceeded limit');
      } else chunks.push(chunk);
    });
    response.on('error', () => this.cancelHandshake(502, 'WebSocket upstream rejection failed'));
    response.on('aborted', () => this.cancelHandshake(502, 'WebSocket upstream rejection aborted'));
    response.on('end', () => {
      if (this.#handshakeFinished) return;
      const status = response.statusCode ?? 502;
      this.#finishHandshake(new Response(status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks), {
        status, headers: downstreamHeaders(response, true),
      }));
      // A handled unexpected-response leaves ws CONNECTING. terminate aborts
      // its HTTP request and produces the real close event used for admission.
      this.close(1011, 'Upstream rejected upgrade');
    });
  }

  cancelHandshake(status: number, reason: string): void {
    if (this.#handshakeFinished) return;
    this.#finishHandshake(new Response(reason, { status }));
    this.close(1011, reason);
  }

  #finishHandshake(response: Response | undefined): void {
    if (this.#handshakeFinished) return;
    this.#handshakeFinished = true;
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    if (this.#abort) this.#options.signal?.removeEventListener('abort', this.#abort);
    this.#handshakeTimer = undefined; this.#abort = undefined;
    this.#bridge.endHandshake();
    this.#resolveResponse(response);
  }

  downstreamOpen(socket: Bun.ServerWebSocket<WebSocketBridgeData>): void {
    this.#downstream = socket;
    if (this.#closing) { socket.close(wireCloseCode(this.#code), this.#reason); return; }
    if (!this.#bridge.accepting) { this.close(1012, 'Service restarting'); return; }
    this.#openedAt = performance.now();
    observe(this.#options.onOpen);
    // Preserve observation order: open precedes buffered early upstream messages.
    while (this.#early.length > 0 && !this.#closing) {
      const message = this.#early.shift()!;
      this.#earlyBytes -= this.#messageBytes(message) + 14;
      this.refreshBuffered();
      const view = createWebSocketMessageView(message);
      observe(this.#options.onMessage ? () => this.#options.onMessage!('upstream', view) : undefined);
      this.#sendDownstream(message);
    }
    if (!this.#blocked && !this.#closing) this.#upstream?.resume();
  }

  fromClient(message: Message): void {
    if (this.#closing) return;
    const bytes = this.#messageBytes(message);
    if (bytes > this.#bridge.limits.maxMessageBytes) { this.close(1009, 'Message too large'); return; }
    this.#clientMessages++; this.#clientBytes += bytes;
    const view = createWebSocketMessageView(message);
    observe(this.#options.onMessage ? () => this.#options.onMessage!('client', view) : undefined);
    const upstream = this.#upstream;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) { this.close(1011, 'Upstream unavailable'); return; }
    // Bun exposes no receive pause. A slow upstream cannot grow an unlimited
    // send queue: refuse this session with 1013 before enqueueing excess bytes.
    if (!this.#canBuffer(bytes + 14)) { this.close(1013, 'WebSocket send budget exceeded'); return; }
    try {
      upstream.send(message, { binary: typeof message !== 'string', compress: false }, (error) => {
        this.refreshBuffered();
        if (error) this.close(1011, 'WebSocket upstream send failed');
      });
      this.refreshBuffered();
    } catch { this.close(1011, 'WebSocket upstream send failed'); }
  }

  #fromUpstream(message: Message): void {
    if (this.#closing) return;
    const bytes = this.#messageBytes(message);
    if (bytes > this.#bridge.limits.maxMessageBytes) { this.close(1009, 'Message too large'); return; }
    this.#upstreamMessages++; this.#upstreamBytes += bytes;
    if (!this.#downstream) {
      if (this.#early.length >= this.#bridge.limits.maxEarlyMessages || !this.#canBuffer(bytes + 14)) {
        this.close(1013, 'WebSocket early-message budget exceeded'); return;
      }
      this.#early.push(message); this.#earlyBytes += bytes + 14;
      this.refreshBuffered();
      this.#upstream?.pause();
      return;
    }
    const view = createWebSocketMessageView(message);
    observe(this.#options.onMessage ? () => this.#options.onMessage!('upstream', view) : undefined);
    this.#sendDownstream(message);
  }

  #sendDownstream(message: Message): void {
    const socket = this.#downstream;
    if (!socket || socket.readyState !== 1) { this.close(1011, 'Downstream unavailable'); return; }
    if (!this.#canBuffer(this.#messageBytes(message) + 14)) { this.close(1013, 'WebSocket send budget exceeded'); return; }
    try {
      const status = socket.send(message, false);
      this.refreshBuffered();
      if (status === -1) {
        // -1 means queued, not refused: never resend this message on drain.
        this.#blocked = true; this.#bridge.backpressure(); this.#upstream?.pause();
      } else if (status === 0 && this.#messageBytes(message) !== 0) {
        // Bun 1.4.2 returns the payload length for an immediately sent frame;
        // zero is therefore also the successful status of an empty message.
        this.close(1011, 'WebSocket downstream send failed');
      }
    } catch { this.close(1011, 'WebSocket downstream send failed'); }
  }

  downstreamDrain(): void {
    this.refreshBuffered();
    if (this.#closing) return;
    this.#blocked = false;
    this.#upstream?.resume();
  }

  #canBuffer(bytes: number): boolean {
    let processLimit = this.processLimit;
    for (const session of PROCESS_SESSIONS) {
      session.refreshBuffered();
      processLimit = Math.min(processLimit, session.processLimit);
    }
    return this.#bufferedBytes + bytes <= this.#bridge.limits.maxBufferedBytes
      && processBufferedBytes + bytes <= processLimit;
  }

  refreshBuffered(): void {
    const upstream = !this.#upstreamGone ? this.#upstream?.bufferedAmount ?? 0 : 0;
    let downstream = 0;
    if (!this.#downstreamGone && this.#downstream) {
      try { downstream = this.#downstream.getBufferedAmount(); } catch { /* close confirmation owns release */ }
    }
    const bytes = this.#earlyBytes + upstream + downstream;
    processBufferedBytes += bytes - this.#bufferedBytes;
    this.#bufferedBytes = bytes;
  }

  #messageBytes(message: Message): number { return typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength; }

  close(code: number, reason: string): void {
    if (this.#finished || this.#closing) return;
    this.#closing = true; this.#code = code; this.#reason = closeReason(reason);
    this.#early.length = 0; this.#earlyBytes = 0;
    this.#closeTimer = setTimeout(() => this.terminate(), this.#bridge.limits.closeTimeoutMs);
    this.#closeTimer.unref?.();
    const upstream = this.#upstream;
    try {
      if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
      else if (upstream?.readyState === WebSocket.OPEN) { upstream.resume(); upstream.close(wireCloseCode(code), this.#reason); }
    } catch { upstream?.terminate(); }
    try { this.#downstream?.close(wireCloseCode(code), this.#reason); } catch { this.#downstream?.terminate(); }
    this.refreshBuffered();
    this.#maybeFinish();
  }

  terminate(): void {
    if (this.#finished) return;
    if (!this.#handshakeFinished) this.cancelHandshake(503, 'WebSocket bridge is stopping');
    this.#closing = true;
    try { this.#upstream?.terminate(); } catch { /* retain slot until real close */ }
    try { this.#downstream?.terminate(); } catch { /* retain slot until real close */ }
  }

  #upstreamClose(code: number, reason: string): void {
    this.#upstreamGone = true;
    if (!this.#handshakeFinished) this.cancelHandshake(502, 'WebSocket upstream closed before upgrade');
    this.close(code, reason);
    this.refreshBuffered(); this.#maybeFinish();
  }

  downstreamClose(code: number, reason: string): void {
    this.#downstreamGone = true;
    this.close(code, reason);
    // Report the actual downstream native close, including 1006 after a forced
    // termination; a requested close frame alone is not confirmation.
    this.#code = code; this.#reason = reason;
    this.refreshBuffered(); this.#maybeFinish();
  }

  #maybeFinish(): void {
    if (this.#finished || !this.#upstreamGone || !this.#downstreamGone) return;
    this.#finished = true;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#early.length = 0; this.#earlyBytes = 0;
    this.refreshBuffered();
    this.#bridge.confirmGone(this);
    if (this.#committed) {
      const metrics = Object.freeze({
        durationMs: this.#openedAt === undefined ? 0 : Math.max(0, performance.now() - this.#openedAt),
        clientMessages: this.#clientMessages, upstreamMessages: this.#upstreamMessages,
        clientBytes: this.#clientBytes, upstreamBytes: this.#upstreamBytes,
      });
      observe(this.#options.onClose ? () => this.#options.onClose!(this.#code, this.#reason, metrics) : undefined);
    }
  }
}

export function createWebSocketBridge(options: WebSocketBridgeOptions = {}): WebSocketBridge {
  return new WebSocketBridge(options);
}
