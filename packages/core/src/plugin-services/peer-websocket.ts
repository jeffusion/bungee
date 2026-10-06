/**
 * P4 plugin peer WebSocket transport (host side): bounded BPC1 frames over the
 * existing master-control management listener.
 *
 * This module is a *transport only*. It owns at most one WebSocket per
 * authenticated peer link, strictly validates the upgrade request, asks the
 * host-owned {@link PluginPeerWebSocketAuthorize} callback for the existing
 * {@link PluginPeerRpcLink}, and then hands every inbound binary message
 * straight to `PluginPeerRpcLink.receive`. It never authenticates a peer by
 * itself, never mints a credential, never inspects a Cookie, and never decides
 * caller authority or broker policy — `authorize` is the only admission
 * decision and it is required.
 *
 * Guarantees:
 * - Fixed private path {@link PLUGIN_PEER_WS_PATH}; the management listener
 *   installs this adapter on the loopback `master-control` profile only. A
 *   transport is never consulted (nor stopped) on a profile that does not own it.
 * - Path, empty query, `GET`, the optional Origin allowlist, and
 *   `Upgrade: websocket` are validated before any authorization work. A request
 *   that carries an `Origin` header is rejected unless the host explicitly
 *   allows it, so a cross-origin browser page can never reach the peer channel.
 * - The handshake bound applies to the *real* authorizations, not to the HTTP
 *   wait: a timed-out or aborted authorization keeps its slot until the
 *   callback promise actually settles, so a hung callback can never be used to
 *   pile up unbounded concurrent admissions. The HTTP wait itself always ends
 *   promptly, and a late result can never upgrade after `stopAccepting()`.
 * - Socket bookkeeping stays exact. A connection is tracked from its
 *   reservation until Bun reports the *real* close of its socket; the token
 *   mapping lives just as long. A logical admission release only detaches the
 *   link transport and frees the per-link slot, so a still-closing socket keeps
 *   counting against `maxSockets` and a late close can only ever clean up its
 *   own object.
 * - Socket close only detaches the transport (`PluginPeerRpcLink.disconnect`).
 *   It never calls `confirmRemoteStopped`, never forges a terminal, and never
 *   revokes the link's other work. Bun's server WebSocket handler has no
 *   `error` callback: a socket fault surfaces as `close`, which is handled
 *   exactly the same way. The client binding ignores `error` for the same reason.
 * - Shutdown never claims an unconfirmed close: unresponsive peers are
 *   hard-terminated and only a real Bun close callback releases the tracking.
 *   If that still cannot be confirmed, `stop()` rejects and the caller's own
 *   bounded forced-shutdown path (which owns the instance lock gate) decides.
 * - `send` returns `false` whenever the frame provably did not enter the
 *   transport: a closed socket, a buffered-byte budget, a Bun `send` status of
 *   `0` (dropped) or a negative status (the socket's own backpressure limit was
 *   reached and the message was NOT queued). Only a positive byte count means
 *   the frame entered the transport. Treating `-1` as delivered would silently
 *   drop frames, which is exactly what breaks a credit/backpressure window. A
 *   thrown `send` is never converted to `false`: an unknown transport outcome
 *   stays unknown so the link keeps its caller lease.
 */

import { PEER_FRAME_MAX_BYTES } from './peer-frame';
import { PluginPeerRpcLink, type PluginPeerRpcSendAdapter } from './peer-rpc-link';

/** Fixed private upgrade path served on the `master-control` listener only. */
export const PLUGIN_PEER_WS_PATH = '/__bungee/internal/plugin-peer/v1' as const;

// Ownership spans every server adapter and client binding in this process.
// A logical detach releases only its exact token, never another transport.
const LINK_OWNERS = new WeakMap<PluginPeerRpcLink, object>();

export const PEER_WS_DEFAULT_MAX_HANDSHAKES = 8;
export const PEER_WS_DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const PEER_WS_DEFAULT_MAX_SOCKETS = 32;
export const PEER_WS_DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
export const PEER_WS_DEFAULT_CONTROL_RESERVE_BYTES = 16 * 1024;
export const PEER_WS_DEFAULT_SOCKET_CLOSE_TIMEOUT_MS = 1_000;

const PEER_WS_HARD_MAX_HANDSHAKES = 64;
const PEER_WS_HARD_MAX_SOCKETS = 256;
const PEER_WS_HARD_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const PEER_WS_HARD_MAX_HANDSHAKE_TIMEOUT_MS = 60_000;
const PEER_WS_HARD_MAX_SOCKET_CLOSE_TIMEOUT_MS = 60_000;
const PEER_WS_MIN_TIMEOUT_MS = 10;
const PEER_WS_MIN_BUFFERED_BYTES = 64;

/** WebSocket ready state `OPEN`. */
const SOCKET_OPEN = 1;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_MESSAGE_TOO_BIG = 1009;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_TRY_AGAIN_LATER = 1013;

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
} as const;

/**
 * Opaque Bun WebSocket data attached by this module. It deliberately exposes no
 * peer identity, caller, authority, credential, URL, or key material: all state
 * lives in a module-private WeakMap keyed by {@link PluginPeerConnectionData.connection}.
 */
export interface PluginPeerConnectionData {
  readonly connection: object;
}

/** Trusted host admission: returns the existing link, or an explicit `null`. */
export type PluginPeerWebSocketAuthorize = (
  request: Request,
  signal: AbortSignal,
) => PluginPeerRpcLink | null | Promise<PluginPeerRpcLink | null>;

export interface PluginPeerWebSocketLimits {
  /** Concurrent *real* authorizations; a timed-out callback still holds its slot. */
  readonly maxHandshakes?: number;
  /** Absolute bound on one HTTP handshake wait (and, once, on the admission signal). */
  readonly handshakeTimeoutMs?: number;
  /**
   * Admitted connections, counting a still-closing socket until Bun reports its
   * real close. This bounds reservations + live + closing sockets together.
   */
  readonly maxSockets?: number;
  /** Largest accepted inbound binary message; defaults to a full BPC1 frame. */
  readonly maxMessageBytes?: number;
  /** Buffered outbound bytes before a send is refused as backpressure. */
  readonly maxBufferedBytes?: number;
  /** Buffered bytes reserved so control frames can still be written under data pressure. */
  readonly controlReserveBytes?: number;
  /** Bound on one graceful close attempt and on one handshake drain during `stop()`. */
  readonly socketCloseTimeoutMs?: number;
}

export interface PluginPeerWebSocketOptions {
  /** REQUIRED trusted admission. Never defaults to allow. */
  readonly authorize: PluginPeerWebSocketAuthorize;
  /** Allowed `Origin` values. Empty means any request carrying `Origin` is rejected. */
  readonly allowedOrigins?: readonly string[];
  readonly limits?: PluginPeerWebSocketLimits;
}

export interface PluginPeerWebSocketStatus {
  readonly accepting: boolean;
  /** In-flight real authorizations (the thing `maxHandshakes` bounds). */
  readonly handshakes: number;
  /** Admitted connections from reservation until a confirmed physical close. */
  readonly sockets: number;
}

export type PluginPeerWebSocketErrorCode =
  | 'invalid_options'
  | 'binding_conflict'
  | 'stop_unconfirmed';

/** Fixed-code configuration/lifecycle error. It never carries a cause, URL, or secret. */
export class PluginPeerWebSocketError extends Error {
  readonly name = 'PluginPeerWebSocketError';

  constructor(
    readonly code: PluginPeerWebSocketErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Host adapter handed to the management listener. `handle` returns `undefined`
 * only for a successful upgrade — the caller MUST then return `undefined` to
 * Bun rather than constructing a 101 Response — `null` when the request is not
 * the peer path, and a fixed `Response` for every rejection.
 */
export interface PluginPeerWebSocketServer {
  handle(request: Request, server: Bun.Server<PluginPeerConnectionData>, signal?: AbortSignal): Promise<Response | undefined | null>;
  /**
   * Synchronously closes handshake admission. Established transports and their
   * in-flight RPC keep running; only new upgrades (and any still-waiting
   * authorization) are cut.
   */
  stopAccepting(): void;
  /**
   * Stops new upgrades, ends handshake waits, closes transports, and resolves
   * only once every socket close is really confirmed. It rejects with
   * `stop_unconfirmed` rather than claiming an unconfirmed close.
   */
  stop(): Promise<void>;
  readonly websocket: Bun.WebSocketHandler<PluginPeerConnectionData>;
  /** Counts only; it never exposes a peer identity, caller, or credential. */
  status(): PluginPeerWebSocketStatus;
}

interface SocketLimits {
  readonly maxMessageBytes: number;
  readonly maxBufferedBytes: number;
  readonly dataBudgetBytes: number;
}

/** One in-flight real authorization. It lives until the callback promise settles. */
interface AuthorizationSlot {
  readonly controller: AbortController;
  settled: boolean;
}

function fail(status: number, error: string, extra?: Readonly<Record<string, string>>): Response {
  return Response.json({ error }, { status, headers: extra === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...extra } });
}

function closeSocket(socket: Bun.ServerWebSocket<PluginPeerConnectionData>, code: number, reason: string): void {
  try { socket.close(code, reason); } catch { /* the socket is already gone */ }
}

function terminateSocket(socket: Bun.ServerWebSocket<PluginPeerConnectionData>): void {
  try { socket.terminate(); } catch { /* the socket is already gone */ }
}

function resolveLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PluginPeerWebSocketError('invalid_options', `plugin peer WebSocket ${label} is out of range`);
  }
  return value;
}

/** Combines abort signals without assuming `AbortSignal.any` exists. */
function combineSignals(signals: readonly AbortSignal[]): { readonly signal: AbortSignal; dispose(): void } {
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([...signals]), dispose() {} };
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() { for (const signal of signals) signal.removeEventListener('abort', abort); },
  };
}

/** A never-resolving-on-success abort wait whose listener is always disposable. */
function waitForAbort(signal: AbortSignal): { readonly promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(PEER_HANDSHAKE_ABORTED); return; }
    listener = () => reject(PEER_HANDSHAKE_ABORTED);
    signal.addEventListener('abort', listener, { once: true });
  });
  void promise.catch(() => undefined);
  return {
    promise,
    dispose() { if (listener !== undefined) signal.removeEventListener('abort', listener); },
  };
}

const PEER_HANDSHAKE_ABORTED = new Error('plugin peer handshake aborted');

/**
 * One admitted connection. It is tracked from the reservation until Bun reports
 * the real close of its socket; a logical release (which may happen while the
 * socket is still closing) only detaches the link transport and frees the
 * per-link admission slot.
 */
class PeerSocketConnection {
  readonly token: object = {};
  readonly link: PluginPeerRpcLink;

  readonly #core: PluginPeerWebSocketTransport;
  readonly #limits: SocketLimits;
  readonly #send: PluginPeerRpcSendAdapter;
  #socket: Bun.ServerWebSocket<PluginPeerConnectionData> | null = null;
  #opened = false;
  #admissionReleased = false;
  #attached = false;
  #backpressured = false;

  constructor(core: PluginPeerWebSocketTransport, link: PluginPeerRpcLink, limits: SocketLimits) {
    this.#core = core;
    this.link = link;
    this.#limits = limits;
    this.#send = (frame, priority) => this.#write(frame, priority);
  }

  get socket(): Bun.ServerWebSocket<PluginPeerConnectionData> | null { return this.#socket; }

  onOpen(socket: Bun.ServerWebSocket<PluginPeerConnectionData>): void {
    // A released reservation (e.g. the transport stopped between upgrade and
    // open) owns no socket, and one connection never owns two sockets.
    if (this.#admissionReleased || this.#socket !== null) { terminateSocket(socket); return; }
    this.#socket = socket;
    this.#opened = true;
    // Ownership is recorded BEFORE attach: a reentrant stop() during attach must
    // be able to detach exactly this transport instead of leaving an orphan.
    this.#attached = true;
    try {
      // A repeat attach is the link's own reconnect path: it re-inspects pending
      // calls and resends retained ACKs, and never resends a CALL.
      this.link.attach(this.#send);
    } catch {
      // attach threw: whether or not it installed the adapter, this exact
      // connection must not leave an orphan transport behind.
      this.#detachOwnership();
      this.close(CLOSE_INTERNAL_ERROR, 'plugin peer transport attach failed');
      return;
    }
    if (this.#admissionReleased) this.#detachOwnership();
  }

  onMessage(message: unknown): void {
    if (!this.#opened || this.#admissionReleased) return;
    let bytes: Uint8Array;
    if (typeof message === 'string') {
      this.close(CLOSE_UNSUPPORTED_DATA, 'plugin peer frames must be binary');
      return;
    }
    if (message instanceof Uint8Array) bytes = message;
    else if (message instanceof ArrayBuffer) bytes = new Uint8Array(message);
    else {
      this.close(CLOSE_PROTOCOL_ERROR, 'plugin peer frame is not binary');
      return;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > this.#limits.maxMessageBytes) {
      this.close(CLOSE_MESSAGE_TOO_BIG, 'plugin peer frame size is invalid');
      return;
    }
    try {
      // Structure, MAC, direction, authority, replay window and the RPC wrapper
      // are all verified by the real link. Nothing is swallowed here.
      this.link.receive(bytes);
    } catch {
      this.close(CLOSE_PROTOCOL_ERROR, 'plugin peer frame was rejected');
    }
  }

  onDrain(): void {
    if (!this.#opened || this.#admissionReleased || !this.#backpressured) return;
    this.#backpressured = false;
    try {
      // Re-attaching with the same adapter triggers only the link's existing
      // ACK/INSPECT recovery; it never queues or resends a CALL.
      this.link.attach(this.#send);
    } catch {
      // A rejected recovery has no terminal state on its own, so the transport
      // fails closed for this socket instead of retrying forever.
      this.close(CLOSE_INTERNAL_ERROR, 'plugin peer transport recovery failed');
    }
  }

  onClose(socket: Bun.ServerWebSocket<PluginPeerConnectionData>): void {
    // A late/foreign close must never touch the connection that owns the socket now.
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#opened = false;
    this.#detachOwnership();
    this.#core.confirmGone(this);
  }

  /**
   * Logical release: detach exactly this connection's transport and free its
   * per-link admission. A socket that is still closing stays tracked (and
   * therefore keeps counting against the socket bound) until its real close.
   */
  releaseAdmission(): void {
    if (this.#admissionReleased) return;
    this.#admissionReleased = true;
    this.#detachOwnership();
    this.#core.dropAdmission(this);
    if (this.#socket === null) this.#core.confirmGone(this);
  }

  /** Graceful close plus admission release. */
  close(code: number, reason: string): void {
    const socket = this.#socket;
    this.releaseAdmission();
    if (socket !== null) closeSocket(socket, code, reason);
  }

  /** Hard close plus admission release (used only after a graceful-close bound). */
  terminate(): void {
    const socket = this.#socket;
    this.releaseAdmission();
    if (socket !== null) terminateSocket(socket);
  }

  /**
   * Detaches only if this exact connection installed the transport, and never
   * more than once. A stale object can therefore never detach a newer transport.
   */
  #detachOwnership(): void {
    if (this.#attached) {
      this.#attached = false;
      if (LINK_OWNERS.get(this.link) === this) {
        try { this.link.disconnect(); } catch { /* transport detach is best-effort */ }
      }
    }
    if (LINK_OWNERS.get(this.link) === this) LINK_OWNERS.delete(this.link);
  }

  #write(frame: Uint8Array, priority: 'data' | 'control'): boolean {
    const socket = this.#socket;
    if (!this.#opened || this.#admissionReleased || socket === null) return false;
    if (socket.readyState !== SOCKET_OPEN) return false;
    const buffered = socket.getBufferedAmount();
    const budget = priority === 'data' ? this.#limits.dataBudgetBytes : this.#limits.maxBufferedBytes;
    if (buffered + frame.byteLength > budget) {
      this.#backpressured = true;
      return false;
    }
    // A throw here is an unknown transport outcome and must propagate: it is
    // never converted into the "provably not queued" `false`.
    const status = socket.send(frame);
    if (status === 0) {
      // Only zero proves that Bun dropped the frame. Minus one means the frame
      // was already enqueued: claiming otherwise can repeat chunks or discard
      // a CALL whose provider may already be executing it.
      this.#backpressured = true;
      return false;
    }
    if (status < 0) this.#backpressured = true;
    return true;
  }
}

class PluginPeerWebSocketTransport implements PluginPeerWebSocketServer {
  readonly #authorize: PluginPeerWebSocketAuthorize;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #maxHandshakes: number;
  readonly #handshakeTimeoutMs: number;
  readonly #maxSockets: number;
  readonly #socketCloseTimeoutMs: number;
  readonly #limits: SocketLimits;
  /** Current admission per link; at most one entry per link. */
  readonly #admissions = new Map<PluginPeerRpcLink, PeerSocketConnection>();
  /** Every admitted connection, reservation through confirmed physical close. */
  readonly #tracked = new Set<PeerSocketConnection>();
  readonly #tokens = new WeakMap<object, PeerSocketConnection>();
  /** Real in-flight authorizations; the bound applies to this set. */
  readonly #authorizations = new Set<AuthorizationSlot>();
  readonly #handshakeWaiters = new Set<() => void>();
  readonly #socketWaiters = new Set<() => void>();
  readonly websocket: Bun.WebSocketHandler<PluginPeerConnectionData>;
  #handshakeWaits = 0;
  #accepting = true;
  #stopPromise: Promise<void> | null = null;

  constructor(options: PluginPeerWebSocketOptions) {
    if (options === null || typeof options !== 'object' || typeof options.authorize !== 'function') {
      throw new PluginPeerWebSocketError('invalid_options', 'plugin peer WebSocket requires an authorize callback');
    }
    this.#authorize = options.authorize;
    const allowed = options.allowedOrigins ?? [];
    if (!Array.isArray(allowed) || allowed.some((origin) => typeof origin !== 'string' || origin.length === 0 || origin === '*')) {
      throw new PluginPeerWebSocketError('invalid_options', 'plugin peer WebSocket allowed origins are invalid');
    }
    this.#allowedOrigins = new Set(allowed);
    const limits = options.limits ?? {};
    this.#maxHandshakes = resolveLimit(limits.maxHandshakes, PEER_WS_DEFAULT_MAX_HANDSHAKES, 1, PEER_WS_HARD_MAX_HANDSHAKES, 'handshake limit');
    this.#handshakeTimeoutMs = resolveLimit(limits.handshakeTimeoutMs, PEER_WS_DEFAULT_HANDSHAKE_TIMEOUT_MS, PEER_WS_MIN_TIMEOUT_MS, PEER_WS_HARD_MAX_HANDSHAKE_TIMEOUT_MS, 'handshake timeout');
    this.#maxSockets = resolveLimit(limits.maxSockets, PEER_WS_DEFAULT_MAX_SOCKETS, 1, PEER_WS_HARD_MAX_SOCKETS, 'socket limit');
    this.#socketCloseTimeoutMs = resolveLimit(limits.socketCloseTimeoutMs, PEER_WS_DEFAULT_SOCKET_CLOSE_TIMEOUT_MS, PEER_WS_MIN_TIMEOUT_MS, PEER_WS_HARD_MAX_SOCKET_CLOSE_TIMEOUT_MS, 'socket close timeout');
    const maxMessageBytes = resolveLimit(limits.maxMessageBytes, PEER_FRAME_MAX_BYTES, 12, PEER_FRAME_MAX_BYTES, 'message limit');
    const maxBufferedBytes = resolveLimit(limits.maxBufferedBytes, PEER_WS_DEFAULT_MAX_BUFFERED_BYTES, PEER_WS_MIN_BUFFERED_BYTES, PEER_WS_HARD_MAX_BUFFERED_BYTES, 'buffer limit');
    const controlReserveBytes = resolveLimit(
      limits.controlReserveBytes,
      Math.min(PEER_WS_DEFAULT_CONTROL_RESERVE_BYTES, maxBufferedBytes >> 1),
      0,
      maxBufferedBytes - 1,
      'control reserve',
    );
    this.#limits = Object.freeze({
      maxMessageBytes,
      maxBufferedBytes,
      dataBudgetBytes: maxBufferedBytes - controlReserveBytes,
    });
    this.websocket = {
      data: {} as PluginPeerConnectionData,
      maxPayloadLength: maxMessageBytes,
      backpressureLimit: maxBufferedBytes,
      closeOnBackpressureLimit: false,
      perMessageDeflate: false,
      open: (socket) => {
        const connection = this.#connectionFor(socket);
        if (connection === null) { terminateSocket(socket); return; }
        connection.onOpen(socket);
      },
      message: (socket, message) => {
        try {
          const connection = this.#connectionFor(socket);
          if (connection === null) { closeSocket(socket, CLOSE_PROTOCOL_ERROR, 'unknown peer connection'); return; }
          connection.onMessage(message);
        } catch {
          closeSocket(socket, CLOSE_INTERNAL_ERROR, 'plugin peer handler failed');
        }
      },
      close: (socket) => {
        const connection = this.#connectionFor(socket);
        if (connection !== null) connection.onClose(socket);
      },
      drain: (socket) => {
        const connection = this.#connectionFor(socket);
        if (connection !== null) connection.onDrain();
      },
    };
  }

  status(): PluginPeerWebSocketStatus {
    return Object.freeze({
      accepting: this.#accepting,
      handshakes: this.#authorizations.size,
      sockets: this.#tracked.size,
    });
  }

  async handle(
    request: Request,
    server: Bun.Server<PluginPeerConnectionData>,
    lifetime?: AbortSignal,
  ): Promise<Response | undefined | null> {
    let url: URL;
    try { url = new URL(request.url); } catch { return fail(400, 'invalid_peer_request'); }
    // Not the peer path: let the caller fall through to its other routes.
    if (url.pathname !== PLUGIN_PEER_WS_PATH) return null;
    if (!this.#accepting) return fail(503, 'service_unavailable');
    // A query is never part of the frozen private path.
    if (url.search.length !== 0) return fail(400, 'invalid_peer_request');
    if (request.method !== 'GET') return fail(405, 'method_not_allowed', { allow: 'GET' });
    // A browser page carries an Origin; a native supervised peer does not. Any
    // present Origin must be explicitly allowed, and no Cookie is ever consulted.
    const origin = request.headers.get('origin');
    if (origin !== null && !this.#allowedOrigins.has(origin)) return fail(403, 'origin_not_allowed');
    const upgrade = request.headers.get('upgrade');
    if (upgrade === null || upgrade.toLowerCase() !== 'websocket') return fail(426, 'upgrade_required');
    if (this.#authorizations.size >= this.#maxHandshakes) return fail(503, 'peer_handshake_capacity');
    if (this.#tracked.size >= this.#maxSockets) return fail(503, 'peer_socket_capacity');

    const slot: AuthorizationSlot = { controller: new AbortController(), settled: false };
    this.#authorizations.add(slot);
    this.#handshakeWaits += 1;
    const combined = combineSignals(lifetime
      ? [request.signal, slot.controller.signal, lifetime]
      : [request.signal, slot.controller.signal]);
    const abortWait = waitForAbort(combined.signal);
    const observed = this.#observeAuthorization(request, combined.signal, slot);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let decided: unknown = null;
    try {
      timer = setTimeout(() => { try { slot.controller.abort(); } catch { /* already aborted */ } }, this.#handshakeTimeoutMs);
      timer.unref?.();
      decided = await Promise.race([observed, abortWait.promise]);
    } catch {
      decided = null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abortWait.dispose();
      combined.dispose();
      this.#handshakeWaits -= 1;
      if (this.#handshakeWaits === 0) this.#resolveWaiters(this.#handshakeWaiters);
    }
    // A stopped transport is unavailable; a missing/undefined/invalid return, a
    // thrown callback, and an aborted or timed-out handshake are all a rejection.
    // A late authorization result can never upgrade once admission is closed.
    if (!this.#accepting) return fail(503, 'service_unavailable');
    if (combined.signal.aborted) return fail(401, 'peer_unauthorized');
    if (!(decided instanceof PluginPeerRpcLink)) return fail(401, 'peer_unauthorized');
    if (LINK_OWNERS.has(decided)) return fail(409, 'peer_already_connected');
    if (this.#tracked.size >= this.#maxSockets) return fail(503, 'peer_socket_capacity');

    const connection = new PeerSocketConnection(this, decided, this.#limits);
    LINK_OWNERS.set(decided, connection);
    this.#admissions.set(decided, connection);
    this.#tracked.add(connection);
    this.#tokens.set(connection.token, connection);
    let upgraded = false;
    try {
      // Only after authentication, and only the exact Bun request object: a
      // cloned Request would not upgrade. `undefined` is returned to Bun, never a
      // hand-built 101 Response.
      upgraded = server.upgrade(request, { data: { connection: connection.token } });
    } catch {
      upgraded = false;
    }
    if (!upgraded) {
      connection.releaseAdmission(); // a refused/failed upgrade must reclaim its reservation
      return fail(400, 'upgrade_failed');
    }
    return undefined;
  }

  stopAccepting(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    for (const slot of [...this.#authorizations]) {
      try { slot.controller.abort(); } catch { /* already aborted */ }
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#stopPromise = this.#runStop();
    // A direct caller may never observe the rejection; the returned promise
    // still rejects so the listener's bounded shutdown can take its forced path.
    void this.#stopPromise.catch(() => undefined);
    return this.#stopPromise;
  }

  async #runStop(): Promise<void> {
    this.stopAccepting();
    // Only the HTTP-facing waits are awaited: a hung `authorize` keeps its
    // bounded slot but can never block shutdown.
    await this.#waitUntil(() => this.#handshakeWaits === 0, this.#handshakeWaiters, this.#socketCloseTimeoutMs);
    for (const connection of [...this.#tracked]) {
      connection.close(CLOSE_TRY_AGAIN_LATER, 'plugin peer transport is stopping');
    }
    if (await this.#waitUntil(() => this.#tracked.size === 0, this.#socketWaiters, this.#socketCloseTimeoutMs)) return;
    // A peer that never answers the close frame must not keep the HTTP server
    // (and with it the instance lock) alive: hard-terminate, then wait again for
    // the real close callback.
    for (const connection of [...this.#tracked]) connection.terminate();
    if (await this.#waitUntil(() => this.#tracked.size === 0, this.#socketWaiters, this.#socketCloseTimeoutMs)) return;
    // Never claim an unconfirmed close: the caller's bounded forced-shutdown
    // path owns the instance-lock gate.
    throw new PluginPeerWebSocketError('stop_unconfirmed', 'plugin peer WebSocket did not confirm socket closure');
  }

  /** Frees the per-link admission slot for a released connection. */
  dropAdmission(connection: PeerSocketConnection): void {
    if (this.#admissions.get(connection.link) === connection) this.#admissions.delete(connection.link);
  }

  /**
   * The only place a connection stops counting against the socket bound: Bun
   * reported the real close (or the reservation never produced a socket).
   */
  confirmGone(connection: PeerSocketConnection): void {
    if (!this.#tracked.delete(connection)) return;
    this.#tokens.delete(connection.token);
    this.dropAdmission(connection);
    if (this.#tracked.size === 0) this.#resolveWaiters(this.#socketWaiters);
  }

  /** Observes the real authorization exactly once; the slot ends only on settle. */
  #observeAuthorization(request: Request, signal: AbortSignal, slot: AuthorizationSlot): Promise<unknown> {
    const observed = Promise.resolve().then(() => {
      if (!this.#accepting || signal.aborted) throw PEER_HANDSHAKE_ABORTED;
      return this.#authorize(request, signal);
    });
    const tracked = observed.then(
      (value) => { this.#endAuthorization(slot); return value; },
      (error) => { this.#endAuthorization(slot); throw error; },
    );
    // The HTTP wait may already be over; this handler makes an abandoned
    // rejection/fulfilment harmless and keeps the slot accounting exact.
    void tracked.catch(() => undefined);
    return tracked;
  }

  #endAuthorization(slot: AuthorizationSlot): void {
    if (slot.settled) return;
    slot.settled = true;
    this.#authorizations.delete(slot);
  }

  #connectionFor(socket: Bun.ServerWebSocket<PluginPeerConnectionData>): PeerSocketConnection | null {
    const data = socket.data as PluginPeerConnectionData | undefined;
    if (data === undefined || data === null) return null;
    const token: unknown = data.connection;
    if (token === null || typeof token !== 'object') return null;
    return this.#tokens.get(token) ?? null;
  }

  #resolveWaiters(waiters: Set<() => void>): void {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  #waitUntil(predicate: () => boolean, waiters: Set<() => void>, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      const waiter = (): void => finish(true);
      timer = setTimeout(() => { waiters.delete(waiter); finish(false); }, timeoutMs);
      timer.unref?.();
      waiters.add(waiter);
    });
  }
}

export function createPluginPeerWebSocketServer(options: PluginPeerWebSocketOptions): PluginPeerWebSocketServer {
  return new PluginPeerWebSocketTransport(options);
}

/* -------------------------------------------------------------------------- */
/* Client side: bind a host-created WebSocket to an existing link              */
/* -------------------------------------------------------------------------- */

export interface PluginPeerClientSocketOptions {
  readonly maxBufferedBytes?: number;
  readonly controlReserveBytes?: number;
}

export interface PluginPeerClientSocketBinding {
  /** True while this exact binding owns the link and its socket is open. */
  readonly attached: boolean;
  /** True once this binding has closed (explicitly, or because its socket closed). */
  readonly closed: boolean;
  close(code?: number, reason?: string): void;
}

/** Module-private ownership: at most one live binding per link. */
const CLIENT_BINDINGS = new WeakMap<PluginPeerRpcLink, PeerClientSocketBinding>();

/**
 * Binds one already-created WebSocket (the host owns the URL, protocols, TLS,
 * and any HTTP authorization headers) to an existing peer link. It never
 * connects, reconnects, or retries by itself: a closed socket only detaches the
 * link, and the host decides whether and how to reconnect.
 *
 * Ownership is exact: this binding may only detach the link while it is the
 * registered owner, so a late callback from a dead socket can never cut a newer
 * connection. A second live binding for the same link is rejected.
 */
class PeerClientSocketBinding implements PluginPeerClientSocketBinding {
  readonly #link: PluginPeerRpcLink;
  readonly #socket: WebSocket;
  readonly #send: PluginPeerRpcSendAdapter;
  readonly #onOpen: () => void;
  readonly #onMessage: (event: MessageEvent) => void;
  readonly #onClose: () => void;
  readonly #onError: () => void;
  #closed = false;
  #attached = false;

  constructor(link: PluginPeerRpcLink, socket: WebSocket, dataBudgetBytes: number, maxBufferedBytes: number) {
    this.#link = link;
    this.#socket = socket;
    this.#send = (frame, priority) => {
      if (!this.#owns()) return false;
      if (this.#socket.readyState !== WebSocket.OPEN) return false;
      const budget = priority === 'data' ? dataBudgetBytes : maxBufferedBytes;
      if (this.#socket.bufferedAmount + frame.byteLength > budget) return false;
      // The DOM client has no send status and no drain event, so a refused data
      // frame is only recovered when the host reconnects the socket (the link's
      // own reconnect/inspect path); this module never adds a retry timer. A
      // thrown send still propagates as an unknown transport outcome.
      this.#socket.send(frame);
      return true;
    };
    this.#onOpen = () => { this.#attach(); };
    this.#onMessage = (event) => { this.#receive(event.data); };
    this.#onClose = () => { this.#finish(); };
    this.#onError = () => { /* the close event that follows carries the outcome */ };
  }

  get attached(): boolean {
    return !this.#closed && this.#attached && this.#owns() && this.#socket.readyState === WebSocket.OPEN;
  }

  get closed(): boolean { return this.#closed; }

  /** True once the underlying socket can never carry a frame again. */
  get stale(): boolean { return this.#socket.readyState === WebSocket.CLOSED; }

  /** Installs listeners and attaches immediately when the socket is already open. */
  start(): void {
    this.#socket.binaryType = 'arraybuffer';
    this.#socket.addEventListener('open', this.#onOpen);
    this.#socket.addEventListener('message', this.#onMessage);
    this.#socket.addEventListener('close', this.#onClose);
    this.#socket.addEventListener('error', this.#onError);
    if (this.#socket.readyState === WebSocket.OPEN) this.#attach();
  }

  close(code?: number, reason?: string): void {
    if (this.#closed) return;
    const socket = this.#socket;
    this.#finish();
    try { socket.close(code, reason); } catch { /* already gone */ }
  }

  #owns(): boolean {
    return !this.#closed && CLIENT_BINDINGS.get(this.#link) === this
      && LINK_OWNERS.get(this.#link) === this;
  }

  #attach(): void {
    if (!this.#owns()) return;
    // Ownership first: a reentrant detach during attach must undo this exact binding.
    this.#attached = true;
    try {
      this.#link.attach(this.#send);
    } catch {
      // attach threw: this exact binding must not leave an orphan transport.
      this.#detach();
      this.#fail(CLOSE_INTERNAL_ERROR, 'plugin peer client attach failed');
      return;
    }
    if (this.#closed) this.#detach();
  }

  #receive(raw: unknown): void {
    if (!this.#owns()) return;
    let bytes: Uint8Array;
    if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (raw instanceof Uint8Array) bytes = raw;
    else { this.#fail(CLOSE_UNSUPPORTED_DATA, 'plugin peer frames must be binary'); return; }
    try { this.#link.receive(bytes); }
    catch { this.#fail(CLOSE_PROTOCOL_ERROR, 'plugin peer frame was rejected'); }
  }

  /** Detaches only if this exact binding installed the transport. */
  #detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    if (LINK_OWNERS.get(this.#link) !== this) return;
    try { this.#link.disconnect(); } catch { /* transport detach is best-effort */ }
  }

  /**
   * Ends this binding: detach, drop listeners, and release the ownership slot.
   * The link's own logical task lease is left untouched — the host decides
   * whether and how to reconnect.
   */
  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#removeListeners();
    if (CLIENT_BINDINGS.get(this.#link) === this) CLIENT_BINDINGS.delete(this.#link);
    if (LINK_OWNERS.get(this.#link) === this) LINK_OWNERS.delete(this.#link);
  }

  #removeListeners(): void {
    this.#socket.removeEventListener('open', this.#onOpen);
    this.#socket.removeEventListener('message', this.#onMessage);
    this.#socket.removeEventListener('close', this.#onClose);
    this.#socket.removeEventListener('error', this.#onError);
  }

  #fail(code: number, reason: string): void {
    const socket = this.#socket;
    this.#finish();
    try { socket.close(code, reason); } catch { /* already gone */ }
  }
}

export function bindPluginPeerClientSocket(
  link: PluginPeerRpcLink,
  socket: WebSocket,
  options: PluginPeerClientSocketOptions = {},
): PluginPeerClientSocketBinding {
  if (!(link instanceof PluginPeerRpcLink)) {
    throw new PluginPeerWebSocketError('invalid_options', 'plugin peer client socket requires a peer RPC link');
  }
  if (socket === null || typeof socket !== 'object'
    || typeof socket.send !== 'function' || typeof socket.addEventListener !== 'function') {
    throw new PluginPeerWebSocketError('invalid_options', 'plugin peer client socket requires a WebSocket');
  }
  if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) {
    throw new PluginPeerWebSocketError('invalid_options', 'plugin peer client socket must be connecting or open');
  }
  const existing = CLIENT_BINDINGS.get(link);
  if (existing?.stale && !existing.closed) existing.close();
  if (LINK_OWNERS.has(link)) {
    throw new PluginPeerWebSocketError('binding_conflict', 'plugin peer link already has a live socket binding');
  }
  const maxBufferedBytes = resolveLimit(options.maxBufferedBytes, PEER_WS_DEFAULT_MAX_BUFFERED_BYTES, PEER_WS_MIN_BUFFERED_BYTES, PEER_WS_HARD_MAX_BUFFERED_BYTES, 'buffer limit');
  const controlReserveBytes = resolveLimit(
    options.controlReserveBytes,
    Math.min(PEER_WS_DEFAULT_CONTROL_RESERVE_BYTES, maxBufferedBytes >> 1),
    0,
    maxBufferedBytes - 1,
    'control reserve',
  );
  const binding = new PeerClientSocketBinding(link, socket, maxBufferedBytes - controlReserveBytes, maxBufferedBytes);
  CLIENT_BINDINGS.set(link, binding);
  LINK_OWNERS.set(link, binding);
  binding.start();
  return binding;
}
