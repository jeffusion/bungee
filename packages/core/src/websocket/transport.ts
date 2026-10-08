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
const PROCESS_SESSIONS = new Set<BridgeSession>();
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

export class WebSocketBridge {
  readonly limits: Readonly<Limits>;
  readonly websocket: Bun.WebSocketHandler<WebSocketBridgeData>;
  readonly #sessions = new Map<object, BridgeSession>();
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
  /** @internal */ confirmGone(session: BridgeSession): void {
    if (!this.#sessions.delete(session.token)) return;
    PROCESS_SESSIONS.delete(session);
    if (this.#sessions.size === 0) { for (const resolve of this.#waiters) resolve(); this.#waiters.clear(); }
  }

  #session(socket: Bun.ServerWebSocket<WebSocketBridgeData>): BridgeSession | undefined {
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
      // The npm alias is deliberate: Bun shims the bare "ws" module and that
      // client does not enforce ws's maxPayload/maxFragments or custom headers.
      const socket = this.#upstream = new WebSocket(this.#url, [], {
        headers: upstreamHeaders(this.#options.headers, this.#protocols),
        followRedirects: false,
        rejectUnauthorized: true,
        perMessageDeflate: false,
        maxPayload: this.#bridge.limits.maxMessageBytes,
        maxFragments: this.#bridge.limits.maxFragments,
        maxBufferedChunks: this.#bridge.limits.maxFragments,
        handshakeTimeout: this.#bridge.limits.handshakeTimeoutMs,
      });
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
    const connection = response.headers.connection;
    if (typeof connection !== 'string' || !connection.split(',').some((token) => token.trim().toLowerCase() === 'upgrade')
      || (protocol !== undefined && (typeof protocol !== 'string' || !this.#protocols.includes(protocol)))) {
      this.cancelHandshake(502, 'Invalid WebSocket upstream handshake');
      return;
    }
    this.#selectedProtocol = protocol;
    // RFC 6455 permits the server to select no protocol. ws insists on one if
    // its constructor's protocol set is non-empty, so the offer is sent as an
    // HTTP header and the optional response selection is validated here.
    // ws still validates Upgrade, the fresh key's Accept and all extensions.
    delete response.headers['sec-websocket-protocol'];
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
