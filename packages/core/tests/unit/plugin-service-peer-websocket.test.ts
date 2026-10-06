import { describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { DAEMON_SHUTDOWN_PATH } from '../../src/daemon-control';
import {
  createManagementListener,
  type ListenerRouteProfile,
  type ManagementListener,
  type ManagementListenerOptions,
} from '../../src/management-listener';
import {
  PLUGIN_PEER_WS_PATH,
  PluginPeerWebSocketError,
  bindPluginPeerClientSocket,
  createPluginPeerWebSocketServer,
  type PluginPeerWebSocketAuthorize,
  type PluginPeerWebSocketLimits,
  type PluginPeerWebSocketServer,
  type PluginPeerConnectionData,
  type PluginPeerClientSocketBinding,
} from '../../src/plugin-services/peer-websocket';
import {
  PluginPeerRpcLink,
  PluginPeerRpcLinkError,
  type PluginPeerRpcInboundCall,
  type PluginPeerRpcRequestHandler,
} from '../../src/plugin-services/peer-rpc-link';
import {
  PluginPeerReplayWindow,
  createPluginPeerCredential,
  decodePluginPeerHeader,
  encodePluginPeerHeader,
  signPluginPeerPacket,
  verifyPluginPeerPacket,
  type PluginPeerAuthority,
  type PluginPeerCredential,
} from '../../src/plugin-services/peer-protocol';
import { deriveSupervisionProcessKey } from '../../src/supervision';
import { encodePluginPeerFrame } from '../../src/plugin-services/peer-frame';
import { RpcServiceRuntime, type RpcEndpointHandle } from '../../src/plugin-services/rpc-runtime';
import { createPluginPeerRpcProxy, createPluginPeerRpcRequestHandler } from '../../src/plugin-services/peer-rpc-mapping';
import { defineRpcService, type RpcJson } from '../../src/plugin-services/wire-contract';

/**
 * Protocol-test fixtures only. A fixed root key derives real supervision keys,
 * which mint real peer credentials; every handshake and every frame is really
 * signed and really verified. None of this is a production Broker, key, or
 * business payload.
 */
const ROOT_KEY = new Uint8Array(32).fill(41);
const INSTANCE = '10000000-0000-4000-8000-0000000000c1';
const WORKER_ID = '20000000-0000-4000-8000-0000000000c1';
const FOREIGN_ID = '20000000-0000-4000-8000-0000000000c2';
const BOOT = '30000000-0000-4000-8000-0000000000c1';
const FOREIGN_BOOT = '30000000-0000-4000-8000-0000000000c2';
const CONTROLLER = '40000000-0000-4000-8000-0000000000c1';

const CREDENTIAL: PluginPeerCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'worker', WORKER_ID, BOOT),
);
const FOREIGN_CREDENTIAL: PluginPeerCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'ingress', FOREIGN_ID, FOREIGN_BOOT),
);
const AUTHORITY: PluginPeerAuthority = Object.freeze({ controller_epoch: 5, controller_id: CONTROLLER });

/**
 * The receiver's real published identity. A caller-side proxy endpoint must
 * advertise this exact provider/binding, because the native mapping compiles it
 * into the call metadata and the real receiver validates it against its own
 * endpoint. Only the caller role stays 'consumer'.
 */
const RECEIVER_BINDING = Object.freeze({
  endpoint: 'receiver.endpoint',
  process: 'control',
  instance: 'receiver-instance',
  generation: 1,
  catalog: 'unit-catalog',
  scope: 'global',
  subject: 'provider',
} as const);

/** Test-only HTTP header carrying a real signed peer packet header. */
const PEER_HANDSHAKE_HEADER = 'x-bungee-peer-handshake';
const SOCKET_TIMEOUT_MS = 6_000;
const TEST_TIMEOUT_MS = 20_000;
const EMPTY = new Uint8Array(0);

let handshakeSequence = 0;

function handshakeHeader(credential: PluginPeerCredential = CREDENTIAL): string {
  handshakeSequence += 1;
  const packet = signPluginPeerPacket({
    direction: 'peer-to-control',
    authority: AUTHORITY,
    sequence: handshakeSequence,
    request_id: randomUUID(),
    lane: 'rpc',
    kind: 'notification',
    deadline_at: Date.now() + 60_000,
    context: { op: 'handshake' },
  }, EMPTY, credential);
  return encodePluginPeerHeader(packet.header);
}

/** Required-callback fixture: a real MAC + identity check plus a persistent replay window. */
function createAuthorize(link: PluginPeerRpcLink): PluginPeerWebSocketAuthorize {
  const replay = new PluginPeerReplayWindow({ capacity: 64 });
  return (request: Request): PluginPeerRpcLink | null => {
    const encoded = request.headers.get(PEER_HANDSHAKE_HEADER);
    if (encoded === null) return null;
    try {
      const header = decodePluginPeerHeader(encoded);
      verifyPluginPeerPacket(header, EMPTY, CREDENTIAL, { direction: 'peer-to-control', authority: AUTHORITY });
      replay.accept(header.sequence);
    } catch {
      return null;
    }
    return link;
  };
}

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function idleHandler(): PluginPeerRpcRequestHandler {
  return () => ({ result: Promise.resolve(EMPTY), terminal: Promise.resolve() });
}

function immediateHandler(bytes: Uint8Array = new Uint8Array([7])): PluginPeerRpcRequestHandler {
  return () => ({ result: Promise.resolve(new Uint8Array(bytes)), terminal: Promise.resolve() });
}

function makeServerLink(onRequest: PluginPeerRpcRequestHandler): PluginPeerRpcLink {
  return new PluginPeerRpcLink({
    credential: CREDENTIAL,
    authority: AUTHORITY,
    outgoingDirection: 'control-to-peer',
    onRequest,
  });
}

function makeClientLink(onRequest: PluginPeerRpcRequestHandler = idleHandler()): PluginPeerRpcLink {
  return new PluginPeerRpcLink({
    credential: CREDENTIAL,
    authority: AUTHORITY,
    outgoingDirection: 'peer-to-control',
    onRequest,
  });
}

function cleanup(...links: Array<PluginPeerRpcLink | undefined>): void {
  for (const link of links) {
    if (link === undefined) continue;
    try { link.confirmRemoteStopped(); } catch { /* host-only release is best-effort */ }
    try { link.dispose(); } catch { /* idempotent */ }
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<PluginPeerRpcLinkError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PluginPeerRpcLinkError);
    return error as PluginPeerRpcLinkError;
  }
  throw new Error('expected a peer RPC rejection');
}

function bounded<T>(promise: Promise<T>, label: string, timeoutMs = SOCKET_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** Bounded wait for a real state transition; the clock is a genuine gate, never a fake delay. */
async function awaitCondition(predicate: () => boolean, label: string, timeoutMs = SOCKET_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await nextMacrotask();
  }
}

async function getAvailablePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop(true);
  if (port === undefined) throw new Error('temporary listener did not bind');
  return port;
}

/**
 * The project's `lib: ["dom"]` hides Bun's `WebSocket(url, options)` overload, so
 * tests that need HTTP authorization headers use the documented Bun-native
 * constructor shape through one local alias.
 */
type BunClientSocketConstructor = new (
  url: string | URL,
  options?: { readonly headers?: Record<string, string> },
) => WebSocket;

function connectPeerSocket(port: number, headers: Record<string, string>): WebSocket {
  const Constructor = WebSocket as unknown as BunClientSocketConstructor;
  return new Constructor(`ws://127.0.0.1:${port}${PLUGIN_PEER_WS_PATH}`, { headers });
}

function openSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return bounded(new Promise<void>((resolve, reject) => {
    const onOpen = (): void => { cleanup(); resolve(); };
    const onError = (): void => { cleanup(); reject(new Error('peer socket failed to open')); };
    const onClose = (): void => { cleanup(); reject(new Error('peer socket closed before opening')); };
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  }), 'peer socket open');
}

function socketRejected(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return bounded(new Promise<void>((resolve, reject) => {
    const onError = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); resolve(); };
    const onOpen = (): void => { cleanup(); reject(new Error('peer socket unexpectedly opened')); };
    const cleanup = (): void => {
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('open', onOpen);
    };
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    socket.addEventListener('open', onOpen, { once: true });
  }), 'peer socket rejection');
}

function socketClosed(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(0);
  return bounded(new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true });
  }), 'peer socket close');
}

/** Real raw HTTP over a real socket, used to force a genuine failed upgrade. */
function rawHttpStatus(port: number, lines: readonly string[]): Promise<number> {
  const request = `${lines.join('\r\n')}\r\n\r\n`;
  return bounded(new Promise<number>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.write(request); });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const match = /^HTTP\/1\.1 (\d{3})/.exec(buffer.slice(0, end));
      socket.end();
      if (match === null) reject(new Error(`unexpected status line: ${buffer.slice(0, end)}`));
      else resolve(Number(match[1]));
    });
    socket.on('error', reject);
  }), 'raw http status');
}

/**
 * A real TCP peer that completes a WebSocket handshake and then goes silent: it
 * never answers a close frame. Tests can pause its real TCP reads to exercise
 * buffering, or suppress graceful close on the real server socket to exercise
 * native hard termination (Bun otherwise closes silent peers immediately).
 */
function openRawPeerSocket(port: number, headers: Record<string, string>): Promise<Socket> {
  const lines = [
    `GET ${PLUGIN_PEER_WS_PATH} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  const request = `${lines.join('\r\n')}\r\n\r\n`;
  return bounded(new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.write(request); });
    let buffer = '';
    const onData = (chunk: unknown): void => {
      buffer += String(chunk);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const status = /^HTTP\/1\.1 (\d{3})/.exec(buffer);
      if (status === null || status[1] !== '101') {
        socket.destroy();
        reject(new Error(`raw peer upgrade failed with ${status === null ? 'no status' : status[1]}`));
        return;
      }
      resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', reject);
  }), 'raw peer upgrade');
}

interface HarnessOptions {
  readonly onNativeOpen?: (socket: Bun.ServerWebSocket<PluginPeerConnectionData>) => void;
  readonly onNativeServer?: (server: Bun.Server<PluginPeerConnectionData>) => void;
  readonly shutdownTimeoutMs?: number;
  readonly link: PluginPeerRpcLink;
  readonly authorize?: PluginPeerWebSocketAuthorize;
  readonly limits?: PluginPeerWebSocketLimits;
  readonly allowedOrigins?: readonly string[];
  readonly profile?: ListenerRouteProfile;
  readonly ready?: boolean;
  readonly controlApi?: ManagementListenerOptions['controlApi'];
  readonly daemonControl?: ManagementListenerOptions['daemonControl'];
}

interface Harness {
  readonly listener: ManagementListener;
  readonly adapter: PluginPeerWebSocketServer;
  readonly port: number;
  url(path: string): string;
  stop(): Promise<void>;
}

async function startHarness(options: HarnessOptions): Promise<Harness> {
  const adapter = createPluginPeerWebSocketServer({
    authorize: options.authorize ?? createAuthorize(options.link),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const profile = options.profile ?? 'master-control';
  if (options.onNativeOpen) {
    const originalOpen = adapter.websocket.open!;
    adapter.websocket.open = socket => { options.onNativeOpen!(socket); originalOpen(socket); };
  }
  if (options.onNativeServer) {
    const originalHandle = adapter.handle.bind(adapter);
    adapter.handle = (request, server, signal) => {
      options.onNativeServer!(server);
      return originalHandle(request, server, signal);
    };
  }
  const port = profile === 'master-control' ? await getAvailablePort() : 0;
  const listener = createManagementListener({
    profile,
    hostname: '127.0.0.1',
    port,
    controlApi: options.controlApi ?? { async handle() { return null; } },
    ...(options.daemonControl === undefined ? {} : { daemonControl: options.daemonControl }),
    internalPluginPeer: adapter,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
  listener.start();
  if (options.ready !== false) listener.ready();
  const boundPort = listener.port;
  if (boundPort === null) throw new Error('listener did not bind');
  return {
    listener,
    adapter,
    port: boundPort,
    url: (path: string) => `http://127.0.0.1:${boundPort}${path}`,
    stop: async () => {
      await listener.stop();
      // The listener only stops a transport it owns (master-control); stopping
      // the adapter here too keeps a test from leaking its own object.
      await adapter.stop().catch(() => undefined);
    },
  };
}

describe('P4 plugin peer WebSocket transport', () => {
  test('observes native queued and dropped send statuses on a real TCP socket', async () => {
    const link = makeServerLink(idleHandler());
    let nativeSocket: Bun.ServerWebSocket<PluginPeerConnectionData> | undefined;
    const harness = await startHarness({ link, onNativeOpen(socket) { nativeSocket = socket; } });
    let raw: Socket | undefined;
    // Transport-only signed BPC1 data, not a service invocation or business data.
    const frame = encodePluginPeerFrame(signPluginPeerPacket({
      direction: 'control-to-peer', authority: AUTHORITY, sequence: 1,
      request_id: randomUUID(), lane: 'rpc', kind: 'notification',
      deadline_at: Date.now() + 60_000, context: { op: 'buffer-probe' },
    }, new Uint8Array(65_536), CREDENTIAL));
    try {
      raw = await openRawPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      raw.pause();
      await awaitCondition(() => nativeSocket !== undefined && link.status().attached, 'native send probe open');
      let queued = false;
      // Finite upper bound: stop at the FIRST queued write, never fill an
      // unbounded app queue. The raw TCP peer really does not read these bytes.
      for (let index = 0; index < 512; index += 1) {
        const status = nativeSocket!.send(frame);
        if (status === -1) { queued = true; break; }
        expect(status).toBeGreaterThan(0);
      }
      expect(queued).toBe(true);
      expect(nativeSocket!.getBufferedAmount()).toBeGreaterThan(0);
      raw.destroy();
      await awaitCondition(() => harness.adapter.status().sockets === 0, 'native send probe physical close');
      expect(nativeSocket!.send(frame)).toBe(0);
    } finally {
      raw?.destroy(); await harness.stop(); cleanup(link);
    }
  }, TEST_TIMEOUT_MS);

  test('a queued (-1) native send is not turned into an unsent frame by the real adapter', async () => {
    const deliveries: number[] = [];
    const link = makeServerLink(() => {
      deliveries.push(1);
      return { result: Promise.resolve(new Uint8Array([7])), terminal: Promise.resolve() };
    });
    const client = makeClientLink();
    const harness = await startHarness({ link });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, socket);
      await openSocket(socket);
      const nativeSend = socket.send.bind(socket);
      let queuedOnce = false;
      // Bun returns -1 when the frame is ALREADY queued: the adapter must keep the
      // call (never a false "not dispatched"), and the peer must execute it once.
      socket.send = data => {
        const status = nativeSend(data);
        if (!queuedOnce) { queuedOnce = true; return -1; }
        return status;
      };
      const call = client.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 30_000 });
      const result = await bounded(call.result, 'queued-send call result');
      expect(new Uint8Array(result)).toEqual(new Uint8Array([7]));
      await bounded(call.terminal, 'queued-send call terminal');
      expect(queuedOnce).toBe(true);
      expect(deliveries).toHaveLength(1);
    } finally {
      try { socket?.close(); } catch { /* already closed */ }
      await harness.stop();
      cleanup(link);
      cleanup(client);
    }
  }, TEST_TIMEOUT_MS);

  test('keeps terminal pending when native client send throws after sending the frame', async () => {
    const started = gate<void>();
    const done = gate<void>();
    const link = makeServerLink(() => {
      started.resolve();
      return { result: Promise.resolve(new Uint8Array([9])), terminal: done.promise };
    });
    const client = makeClientLink();
    const harness = await startHarness({ link });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, socket);
      await openSocket(socket);
      const nativeSend = socket.send.bind(socket);
      let injected = false;
      socket.send = data => {
        nativeSend(data);
        if (!injected) { injected = true; throw new Error('SEND_SECRET_AFTER_NATIVE_WRITE'); }
      };
      const call = client.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 30_000 });
      let terminalSettled = false;
      void call.terminal.then(() => { terminalSettled = true; });
      const failed = await rejectionOf(call.result);
      expect(failed.code).toBe('unknown');
      expect(failed.message).not.toContain('SEND_SECRET');
      await bounded(started.promise, 'real receiver executed after send threw');
      expect(terminalSettled).toBe(false);
      done.resolve();
      await bounded(call.terminal, 'real terminal after ambiguous native write');
      expect(terminalSettled).toBe(true);
    } finally {
      done.resolve(); socket?.close(); await harness.stop(); cleanup(client, link);
    }
  }, TEST_TIMEOUT_MS);
  test('shares exact link ownership across server adapters and client bindings', async () => {
    const link = makeServerLink(idleHandler());
    const first = await startHarness({ link });
    const second = await startHarness({ link });
    let owner: WebSocket | undefined;
    try {
      owner = connectPeerSocket(first.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(owner);
      const refused = connectPeerSocket(second.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(refused);
      expect(second.adapter.status().sockets).toBe(0);
      expect(() => bindPluginPeerClientSocket(link, owner!)).toThrow(PluginPeerWebSocketError);
      await second.stop();
      expect(link.status().attached).toBe(true);
      owner.close();
      await socketClosed(owner);
      await awaitCondition(() => first.adapter.status().sockets === 0, 'exact global ownership release');
    } finally {
      owner?.close();
      await first.stop(); await second.stop(); cleanup(link);
    }
  }, TEST_TIMEOUT_MS);

  test('rejects server admission while a client binding owns that link', async () => {
    const remote = makeServerLink(idleHandler());
    const client = makeClientLink();
    const remoteHarness = await startHarness({ link: remote });
    const conflicting = await startHarness({ link: client });
    let owner: WebSocket | undefined;
    try {
      owner = connectPeerSocket(remoteHarness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      const binding = bindPluginPeerClientSocket(client, owner);
      await openSocket(owner);
      const refused = connectPeerSocket(conflicting.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(refused);
      expect(conflicting.adapter.status().sockets).toBe(0);
      await conflicting.stop();
      expect(binding.attached).toBe(true);
    } finally {
      owner?.close(); await remoteHarness.stop(); await conflicting.stop(); cleanup(remote, client);
    }
  }, TEST_TIMEOUT_MS);

  test('never reserves link ownership for an already closed client socket', async () => {
    const link = makeServerLink(idleHandler());
    const harness = await startHarness({ link });
    let first: WebSocket | undefined, replacement: WebSocket | undefined;
    try {
      first = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(first);
      first.close(); await socketClosed(first);
      await awaitCondition(() => harness.adapter.status().sockets === 0, 'closed input physical close');
      expect(() => bindPluginPeerClientSocket(link, first!)).toThrow(PluginPeerWebSocketError);
      replacement = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(replacement);
      await awaitCondition(() => link.status().attached, 'server admission after closed input');
      expect(harness.adapter.status().sockets).toBe(1);
    } finally {
      first?.close(); replacement?.close(); await harness.stop(); cleanup(link);
    }
  }, TEST_TIMEOUT_MS);

  test('never starts a queued authorization after admission closes or the request aborts', async () => {
    for (const cancelledRequest of [false, true]) {
      let authorizations = 0;
      const link = makeServerLink(idleHandler());
      const adapter = createPluginPeerWebSocketServer({ authorize: () => { authorizations += 1; return link; } });
      const abort = new AbortController();
      if (cancelledRequest) abort.abort();
      const request = new Request(`http://127.0.0.1${PLUGIN_PEER_WS_PATH}`, { headers: { upgrade: 'websocket' }, signal: abort.signal });
      // Admission-only unit check: no server method may be reached in this path.
      const server = { upgrade() { throw new Error('cancelled admission reached upgrade'); } } as unknown as Bun.Server<PluginPeerConnectionData>;
      const pending = adapter.handle(request, server);
      if (!cancelledRequest) adapter.stopAccepting();
      expect((await pending)?.status).toBe(cancelledRequest ? 401 : 503);
      expect(authorizations).toBe(0);
      expect(adapter.status().handshakes).toBe(0);
      await adapter.stop(); cleanup(link);
    }
  }, TEST_TIMEOUT_MS);

  test('forces a real Bun listener stop when graceful server settlement hangs', async () => {
    const link = makeServerLink(idleHandler());
    let graceful = 0, forced = 0, decorated = false;
    const harness = await startHarness({
      link, shutdownTimeoutMs: 80,
      onNativeServer(server) {
        if (decorated) return;
        decorated = true;
        const nativeStop = server.stop.bind(server);
        server.stop = force => {
          if (!force) { graceful += 1; return new Promise<void>(() => {}); }
          forced += 1; return nativeStop(true);
        };
      },
    });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(socket);
      await bounded(harness.stop(), 'bounded real forced listener stop');
      expect(graceful).toBe(1); expect(forced).toBe(1);
      expect(harness.adapter.status().sockets).toBe(0);
      await expect(fetch(harness.url('/health'))).rejects.toThrow();
    } finally {
      socket?.close(); await harness.stop(); cleanup(link);
    }
  }, TEST_TIMEOUT_MS);
  test('validates the upgrade route strictly before any authorization', async () => {
    const harness = await startHarness({ link: makeServerLink(idleHandler()) });
    try {
      const other = await fetch(harness.url('/__bungee/internal/plugin-peer/other'));
      expect(other.status).toBe(404);

      const query = await fetch(harness.url(`${PLUGIN_PEER_WS_PATH}?peer=1`));
      expect(query.status).toBe(400);

      const method = await fetch(harness.url(PLUGIN_PEER_WS_PATH), { method: 'POST' });
      expect(method.status).toBe(405);

      // Raw HTTP keeps full control of the Origin header (a fetch client may
      // rewrite it), and the origin gate runs before the upgrade check.
      const forbiddenOrigin = await rawHttpStatus(harness.port, [
        `GET ${PLUGIN_PEER_WS_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
        'Origin: http://evil.test',
        `${PEER_HANDSHAKE_HEADER}: ${handshakeHeader()}`,
      ]);
      expect(forbiddenOrigin).toBe(403);

      const noUpgrade = await fetch(harness.url(PLUGIN_PEER_WS_PATH), {
        headers: { [PEER_HANDSHAKE_HEADER]: handshakeHeader() },
      });
      expect(noUpgrade.status).toBe(426);
      expect(harness.adapter.status().sockets).toBe(0);
    } finally {
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('allows only an explicitly allowed Origin', async () => {
    const harness = await startHarness({
      link: makeServerLink(idleHandler()),
      allowedOrigins: ['http://allowed.test'],
    });
    try {
      const allowed = await rawHttpStatus(harness.port, [
        `GET ${PLUGIN_PEER_WS_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
        'Origin: http://allowed.test',
        `${PEER_HANDSHAKE_HEADER}: ${handshakeHeader()}`,
      ]);
      // The allowlisted origin passes the origin gate and fails only on the
      // missing WebSocket upgrade, proving the allowlist admits it.
      expect(allowed).toBe(426);

      const denied = await rawHttpStatus(harness.port, [
        `GET ${PLUGIN_PEER_WS_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
        'Origin: http://denied.test',
        `${PEER_HANDSHAKE_HEADER}: ${handshakeHeader()}`,
      ]);
      expect(denied).toBe(403);
    } finally {
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('rejects missing, tampered, foreign-credential, and replayed handshake evidence', async () => {
    const harness = await startHarness({ link: makeServerLink(idleHandler()) });
    const acceptedHeader = handshakeHeader();
    try {
      const missing = connectPeerSocket(harness.port, {});
      await socketRejected(missing);

      const tamperedHeader = handshakeHeader();
      const flipped = `${tamperedHeader.slice(0, -1)}${tamperedHeader.endsWith('A') ? 'B' : 'A'}`;
      const tampered = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: flipped });
      await socketRejected(tampered);

      const foreign = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader(FOREIGN_CREDENTIAL) });
      await socketRejected(foreign);

      const accepted = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: acceptedHeader });
      await openSocket(accepted);
      expect(harness.adapter.status().sockets).toBe(1);
      accepted.close();
      await socketClosed(accepted);
      await awaitCondition(() => harness.adapter.status().sockets === 0, 'accepted socket release');

      // The exact same signed evidence replayed against the persistent window:
      // the link is free, so only the replay window can reject this handshake.
      const replayed = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: acceptedHeader });
      await socketRejected(replayed);
    } finally {
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('rejects null, thrown, invalid, and hanging authorizations', async () => {
    const link = makeServerLink(idleHandler());
    const nullHarness = await startHarness({ link, authorize: () => null });
    const throwingHarness = await startHarness({ link, authorize: () => { throw new Error('authorize failed'); } });
    const invalidHarness = await startHarness({ link, authorize: () => ({ not: 'a link' }) as unknown as PluginPeerRpcLink });
    let releaseHanging: ((value: PluginPeerRpcLink | null) => void) | undefined;
    const hangingHarness = await startHarness({
      link,
      authorize: () => new Promise<PluginPeerRpcLink | null>((resolve) => { releaseHanging = resolve; }),
      limits: { handshakeTimeoutMs: 60 },
    });
    try {
      for (const harness of [nullHarness, throwingHarness, invalidHarness]) {
        const socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
        await socketRejected(socket);
        expect(harness.adapter.status().sockets).toBe(0);
        await harness.stop();
      }

      const hanging = connectPeerSocket(hangingHarness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(hanging);
      // A handshake that never settles must not be able to block the listener.
      await bounded(hangingHarness.stop(), 'listener stop with a hanging authorize');
      releaseHanging?.(null);
    } finally {
      await nullHarness.stop();
      await throwingHarness.stop();
      await invalidHarness.stop();
      await hangingHarness.stop();
      cleanup(link);
    }
  }, TEST_TIMEOUT_MS);

  test('rejects a second socket for the same link and recovers after the first closes', async () => {
    const link = makeServerLink(immediateHandler(new Uint8Array([7])));
    const client = makeClientLink();
    const harness = await startHarness({ link });
    let first: WebSocket | undefined;
    let third: WebSocket | undefined;
    try {
      first = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      const firstBinding = bindPluginPeerClientSocket(client, first);
      await openSocket(first);
      expect(firstBinding.attached).toBe(true);

      const second = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(second);
      expect(harness.adapter.status().sockets).toBe(1);

      first.close();
      await socketClosed(first);
      await awaitCondition(() => harness.adapter.status().sockets === 0, 'socket reservation release');
      expect(client.status().attached).toBe(false);

      third = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, third);
      await openSocket(third);
      const call = client.request({ target: 'echo' }, new Uint8Array([1, 2, 3]), { deadlineAt: Date.now() + 30_000 });
      expect(Array.from(await bounded(call.result, 'reconnected result'))).toEqual([7]);
      await bounded(call.terminal, 'reconnected terminal');
    } finally {
      first?.close();
      third?.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('enforces small handshake and socket quotas', async () => {
    let releasePending: ((value: PluginPeerRpcLink | null) => void) | undefined;
    let calls = 0;
    const pendingLink = makeServerLink(idleHandler());
    const pendingHarness = await startHarness({
      link: pendingLink,
      authorize: () => {
        calls += 1;
        if (calls === 1) return new Promise<PluginPeerRpcLink | null>((resolve) => { releasePending = resolve; });
        return pendingLink;
      },
      limits: { maxHandshakes: 1, handshakeTimeoutMs: 2_000 },
    });
    let pendingSocket: WebSocket | undefined;
    try {
      pendingSocket = connectPeerSocket(pendingHarness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await awaitCondition(() => calls === 1, 'pending handshake');
      const refused = connectPeerSocket(pendingHarness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(refused);
      // The concurrent handshake was refused before admission, so `authorize`
      // was never entered a second time.
      expect(calls).toBe(1);
      releasePending?.(pendingLink);
      await openSocket(pendingSocket);
      expect(pendingHarness.adapter.status().sockets).toBe(1);
    } finally {
      pendingSocket?.close();
      releasePending?.(null);
      await pendingHarness.stop();
    }

    const firstLink = makeServerLink(idleHandler());
    const secondLink = makeServerLink(idleHandler());
    let current = firstLink;
    const socketHarness = await startHarness({
      link: firstLink,
      authorize: () => current,
      limits: { maxSockets: 1 },
    });
    let liveSocket: WebSocket | undefined;
    try {
      liveSocket = connectPeerSocket(socketHarness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(liveSocket);
      expect(socketHarness.adapter.status().sockets).toBe(1);
      current = secondLink;
      const refused = connectPeerSocket(socketHarness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(refused);
      expect(socketHarness.adapter.status().sockets).toBe(1);
    } finally {
      liveSocket?.close();
      cleanup(firstLink, secondLink);
      await socketHarness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('round-trips a real BPC1 call with the result before the terminal', async () => {
    const resultGate = gate<Uint8Array>();
    const terminalGate = gate<void>();
    const arrived = gate<PluginPeerRpcInboundCall>();
    const link = makeServerLink((call) => {
      arrived.resolve(call);
      return { result: resultGate.promise, terminal: terminalGate.promise };
    });
    const client = makeClientLink();
    const harness = await startHarness({ link });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, socket);
      await openSocket(socket);

      const call = client.request({ target: 'echo' }, new Uint8Array([4, 5, 6]), { deadlineAt: Date.now() + 30_000 });
      const received = await bounded(arrived.promise, 'inbound call');
      expect(Array.from(received.body)).toEqual([4, 5, 6]);
      expect(received.metadata).toEqual({ target: 'echo' });

      let resultSettled = false;
      let terminalSettled = false;
      void call.result.then(() => { resultSettled = true; });
      void call.terminal.then(() => { terminalSettled = true; });

      resultGate.resolve(new Uint8Array([9, 9]));
      expect(Array.from(await bounded(call.result, 'call result'))).toEqual([9, 9]);
      expect(resultSettled).toBe(true);
      expect(terminalSettled).toBe(false);

      terminalGate.resolve();
      await bounded(call.terminal, 'call terminal');
      expect(terminalSettled).toBe(true);
      // The ACK cycle is bidirectional: the caller's ACK must reach the peer and
      // the peer's ack-confirmed must come back before both sides are clean.
      await awaitCondition(
        () => link.status().inboundReceipts === 0 && client.status().ackOutbox === 0,
        'bidirectional receipt drain',
      );
    } finally {
      resultGate.resolve(EMPTY);
      terminalGate.resolve();
      socket?.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('holds the real endpoint lease across a disconnect and recovers it by inspect', async () => {
    const contract = defineRpcService({
      id: 'ws.echo',
      version: 1,
      methods: {
        echo: {
          kind: 'query',
          input: { type: 'string' },
          output: { type: 'string' },
          purposes: ['bootstrap', 'background', 'management', 'request', 'attempt'],
        },
      },
    });
    const work = gate<string>();
    let receiverEndpoint!: RpcEndpointHandle;
    let receiverReleases = 0;
    let callerEndpoint!: RpcEndpointHandle;
    let callerReleases = 0;
    const receiverRuntime = new RpcServiceRuntime({
      admit: () => ({ endpoint: receiverEndpoint, callee: null, release: () => { receiverReleases += 1; } }),
    });
    const callerRuntime = new RpcServiceRuntime({
      admit: () => ({ endpoint: callerEndpoint, callee: null, release: () => { callerReleases += 1; } }),
    });
    const link = makeServerLink(createPluginPeerRpcRequestHandler((metadata, request) => {
      const tracked = receiverRuntime.invokeTracked({
        target: metadata.target,
        caller: { subject: 'remote-peer', scope: 'global' },
        purpose: request.purpose,
        input: request.input,
        operationId: request.operationId ?? undefined,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        commandAction: request.commandAction,
      });
      return { result: tracked.result, terminal: tracked.terminal };
    }));
    const client = makeClientLink();
    const harness = await startHarness({ link });
    let first: WebSocket | undefined;
    let second: WebSocket | undefined;
    try {
      receiverEndpoint = receiverRuntime.register({
        provider: 'provider',
        contract,
        binding: RECEIVER_BINDING,
        handler: { echo: (input: string) => work.promise.then(() => input) },
      });
      receiverRuntime.markReady(receiverEndpoint);
      // The proxy endpoint advertises the remote receiver's published identity;
      // the consumer role lives on the invocation below, not in this binding.
      callerEndpoint = callerRuntime.registerProxy({
        provider: 'provider',
        contract,
        binding: RECEIVER_BINDING,
        execute: createPluginPeerRpcProxy('provider', client, () => ({}) as RpcJson),
      });
      callerRuntime.markReady(callerEndpoint);

      first = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, first);
      await openSocket(first);
      await awaitCondition(() => client.status().attached, 'client attachment');

      const tracked = callerRuntime.invokeTracked({
        target: { provider: 'provider', service: contract.id, major: 1, method: 'echo' },
        caller: { subject: 'consumer', scope: 'global' },
        purpose: 'request',
        input: 'hello',
        deadlineAt: Date.now() + 30_000,
      });
      await awaitCondition(() => receiverRuntime.status().active === 1, 'receiver activation');
      expect(callerReleases).toBe(0);
      expect(receiverReleases).toBe(0);

      // The socket drops mid-flight: the transport detaches but the real lease stays held.
      first.close();
      await socketClosed(first);
      await awaitCondition(() => !client.status().attached, 'client detachment');
      expect(callerReleases).toBe(0);
      expect(receiverReleases).toBe(0);

      // The real task finishes while no transport is attached: both the result and
      // the terminal are retained, never delivered and never forged.
      work.resolve('hello');
      await awaitCondition(() => link.status().inboundReceipts === 1, 'retained receipt');
      let resultSettled = false;
      void tracked.result.then(() => { resultSettled = true; });
      await nextMacrotask();
      expect(resultSettled).toBe(false);

      // Reconnect: the link's own reconnect path inspects and the real terminal arrives.
      second = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, second);
      await openSocket(second);
      expect(await bounded(tracked.result, 'recovered result')).toBe('hello');
      await bounded(tracked.terminal, 'recovered terminal');
      await awaitCondition(() => callerRuntime.status().active === 0, 'caller lease release');
      expect(callerReleases).toBe(1);
      expect(receiverReleases).toBe(1);
    } finally {
      work.resolve('hello');
      first?.close();
      second?.close();
      await callerRuntime.dispose().catch(() => undefined);
      await receiverRuntime.dispose().catch(() => undefined);
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('closes the socket on a text frame instead of swallowing it', async () => {
    const harness = await startHarness({ link: makeServerLink(idleHandler()) });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(socket);
      const closed = socketClosed(socket);
      socket.send('not a BPC1 frame');
      expect(await closed).toBe(1003);
    } finally {
      socket?.close();
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('rejects an oversized message and keeps serving new connections', async () => {
    const harness = await startHarness({
      link: makeServerLink(idleHandler()),
      limits: { maxMessageBytes: 64 },
    });
    let oversized: WebSocket | undefined;
    let healthy: WebSocket | undefined;
    try {
      oversized = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(oversized);
      const closed = socketClosed(oversized);
      oversized.send(new Uint8Array(256));
      // An oversized message terminates the connection abnormally; it is never
      // silently parsed or ignored.
      expect([1006, 1009]).toContain(await closed);
      await awaitCondition(() => harness.adapter.status().sockets === 0, 'oversized socket release');

      healthy = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(healthy);
      expect(harness.adapter.status().sockets).toBe(1);
    } finally {
      oversized?.close();
      healthy?.close();
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('refuses a data frame beyond the budget while control frames still pass', async () => {
    const arrived = gate<void>();
    const link = makeServerLink(() => {
      arrived.resolve();
      return { result: Promise.resolve(new Uint8Array(4096)), terminal: Promise.resolve() };
    });
    const client = makeClientLink();
    const harness = await startHarness({
      link,
      limits: { maxBufferedBytes: 900, controlReserveBytes: 100 },
    });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, socket);
      await openSocket(socket);

      const call = client.request({ target: 'big' }, new Uint8Array([1]), { deadlineAt: Date.now() + 30_000 });
      await bounded(arrived.promise, 'inbound big call');
      let resultSettled = false;
      void call.result.then(() => { resultSettled = true; }, () => { resultSettled = true; });

      // The oversized data result is refused before it ever enters the transport,
      // and is retained for a later inspect rather than dropped silently.
      await bounded(call.terminal, 'control terminal under data pressure');
      await nextMacrotask();
      expect(resultSettled).toBe(false);
      expect(link.status().inboundReceipts).toBe(1);
      expect(client.status().attached).toBe(true);
      // The refused data frame provably never entered the transport, so the caller
      // keeps a real pending call; only an explicit host proof settles it.
      expect(client.status().outboundPending).toBe(1);
      client.confirmRemoteStopped();
      expect((await rejectionOf(call.result)).code).toBe('unknown');
    } finally {
      socket?.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('keeps the peer path at 404 and never takes over the transport on the management profile', async () => {
    const link = makeServerLink(idleHandler());
    const adapter = createPluginPeerWebSocketServer({ authorize: createAuthorize(link) });
    const listener = createManagementListener({
      profile: 'management',
      hostname: '127.0.0.1',
      port: 0,
      controlApi: { async handle() { return null; } },
      internalPluginPeer: adapter,
    });
    let socket: WebSocket | undefined;
    try {
      listener.start();
      listener.ready();
      const port = listener.port;
      if (port === null) throw new Error('management listener did not bind');

      const response = await fetch(`http://127.0.0.1:${port}${PLUGIN_PEER_WS_PATH}`, {
        headers: { [PEER_HANDSHAKE_HEADER]: handshakeHeader() },
      });
      expect(response.status).toBe(404);

      socket = connectPeerSocket(port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(socket);
      expect(adapter.status().sockets).toBe(0);

      await listener.stop();
      // A profile that does not own the transport must never install websockets
      // for it nor stop it.
      expect(adapter.status().accepting).toBe(true);
    } finally {
      socket?.close();
      await listener.stop();
      await adapter.stop().catch(() => undefined);
      cleanup(link);
    }
  }, TEST_TIMEOUT_MS);

  test('private peer bootstrap works before management readiness and closes on shutdown', async () => {
    const harness = await startHarness({ link: makeServerLink(idleHandler()), ready: false });
    let socket: WebSocket | undefined;
    try {
      const beforeReady = await fetch(harness.url(PLUGIN_PEER_WS_PATH), {
        headers: { [PEER_HANDSHAKE_HEADER]: handshakeHeader() },
      });
      expect(beforeReady.status).toBe(426);
      expect((await fetch(harness.url('/health'))).status).toBe(503);

      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(socket);
      expect(harness.adapter.status().sockets).toBe(1);
      expect((await fetch(harness.url('/health'))).status).toBe(503);
      harness.listener.stopAccepting();
      expect((await fetch(harness.url(PLUGIN_PEER_WS_PATH))).status).toBe(503);
    } finally {
      socket?.close();
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('reclaims the reservation after a genuine failed upgrade', async () => {
    const link = makeServerLink(idleHandler());
    const harness = await startHarness({ link });
    let socket: WebSocket | undefined;
    try {
      // A real HTTP request that asks for an upgrade but carries no WebSocket key
      // cannot be upgraded; the reservation must be reclaimed immediately.
      const status = await rawHttpStatus(harness.port, [
        `GET ${PLUGIN_PEER_WS_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `${PEER_HANDSHAKE_HEADER}: ${handshakeHeader()}`,
      ]);
      expect(status).toBe(400);
      expect(harness.adapter.status().sockets).toBe(0);

      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(socket);
      expect(harness.adapter.status().sockets).toBe(1);
    } finally {
      socket?.close();
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('stops accepting, closes live transports, and completes listener shutdown', async () => {
    const link = makeServerLink(idleHandler());
    const client = makeClientLink();
    const harness = await startHarness({ link });
    const socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
    const binding: PluginPeerClientSocketBinding = bindPluginPeerClientSocket(client, socket);
    try {
      await openSocket(socket);
      expect(binding.attached).toBe(true);
      const closed = socketClosed(socket);
      const startedAt = Date.now();
      await bounded(harness.stop(), 'listener stop');
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      // The transport closes the live peer socket itself (1013 "try again later"),
      // so `server.stop(false)` never has to wait on an open WebSocket.
      expect([1006, 1013]).toContain(await closed);
      expect(binding.attached).toBe(false);
      // A stopped transport never leaves the link attached to a dead socket.
      expect(link.status().attached).toBe(false);
      await expect(fetch(harness.url('/health'))).rejects.toThrow();
    } finally {
      socket.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('preserves daemon and health routing on master-control', async () => {
    let shutdowns = 0;
    const harness = await startHarness({
      link: makeServerLink(idleHandler()),
      daemonControl: {
        accepted: true,
        async handle() {
          shutdowns += 1;
          return Response.json({ status: 'accepted' }, { status: 202 });
        },
      },
    });
    try {
      const daemon = await fetch(harness.url(DAEMON_SHUTDOWN_PATH), { method: 'POST' });
      expect(daemon.status).toBe(202);
      expect(shutdowns).toBe(1);
      expect((await fetch(harness.url('/health'))).status).toBe(404);
      // The reserved peer path is handled by the peer transport, never 404.
      expect((await fetch(harness.url('/__bungee/internal/plugin-peer/v1'))).status).toBe(426);
    } finally {
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('validates transport limits and client binding options', () => {
    const link = makeServerLink(idleHandler());
    expect(() => createPluginPeerWebSocketServer({
      authorize: () => null,
      limits: { maxHandshakes: 0 },
    })).toThrow(PluginPeerWebSocketError);
    expect(() => createPluginPeerWebSocketServer({
      authorize: () => null,
      limits: { maxSockets: 65_536 },
    })).toThrow(PluginPeerWebSocketError);
    expect(() => createPluginPeerWebSocketServer({
      authorize: () => null,
      limits: { handshakeTimeoutMs: 0 },
    })).toThrow(PluginPeerWebSocketError);
    expect(() => createPluginPeerWebSocketServer({
      authorize: () => null,
      allowedOrigins: ['*'],
    })).toThrow(PluginPeerWebSocketError);
    expect(() => createPluginPeerWebSocketServer({
      authorize: null as unknown as PluginPeerWebSocketAuthorize,
    })).toThrow(PluginPeerWebSocketError);
    expect(() => bindPluginPeerClientSocket(
      link,
      null as unknown as WebSocket,
    )).toThrow(PluginPeerWebSocketError);
    cleanup(link);
  }, TEST_TIMEOUT_MS);

  test('keeps the real authorization slot after a handshake timeout', async () => {
    let release: ((value: PluginPeerRpcLink | null) => void) | undefined;
    let calls = 0;
    const link = makeServerLink(idleHandler());
    const harness = await startHarness({
      link,
      authorize: () => {
        calls += 1;
        return new Promise<PluginPeerRpcLink | null>((resolve) => { release = resolve; });
      },
      limits: { maxHandshakes: 1, handshakeTimeoutMs: 60 },
    });
    let first: WebSocket | undefined;
    try {
      first = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await awaitCondition(() => calls === 1, 'hanging authorization');
      // The HTTP wait ends at the timeout, but the real authorization is still live.
      await socketRejected(first);
      expect(harness.adapter.status().handshakes).toBe(1);

      const second = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(second);
      expect(calls).toBe(1); // no second authorization was ever admitted

      // A hung authorization cannot block shutdown.
      await bounded(harness.adapter.stop(), 'bounded stop with a hung authorization');
      expect(harness.adapter.status().sockets).toBe(0);

      release?.(null);
      await awaitCondition(() => harness.adapter.status().handshakes === 0, 'authorization slot release');

      // A late result can never upgrade after admission was closed.
      const late = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(late);
    } finally {
      first?.close();
      release?.(null);
      cleanup(link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('stopAccepting closes handshake admission without cutting established work', async () => {
    let release: ((value: PluginPeerRpcLink | null) => void) | undefined;
    let calls = 0;
    const link = makeServerLink(immediateHandler(new Uint8Array([4])));
    const realAuthorize = createAuthorize(link);
    const client = makeClientLink();
    const harness = await startHarness({
      link,
      authorize: (request, signal) => {
        calls += 1;
        if (calls === 1) return realAuthorize(request, signal);
        return new Promise<PluginPeerRpcLink | null>((resolve) => { release = resolve; });
      },
    });
    let established: WebSocket | undefined;
    try {
      established = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, established);
      await openSocket(established);

      const pending = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await awaitCondition(() => calls === 2, 'pending authorization');

      harness.listener.stopAccepting();
      expect(harness.adapter.status().accepting).toBe(false);
      // The in-flight authorization ends promptly and can never upgrade later.
      await socketRejected(pending);
      const late = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await socketRejected(late);

      // Established transport and its in-flight RPC are untouched.
      expect(harness.adapter.status().sockets).toBe(1);
      expect(client.status().attached).toBe(true);
      const call = client.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 30_000 });
      expect(Array.from(await bounded(call.result, 'established work after stopAccepting'))).toEqual([4]);
      await bounded(call.terminal, 'established terminal after stopAccepting');
      release?.(null);
    } finally {
      established?.close();
      release?.(null);
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('binds a socket that is already open', async () => {
    const link = makeServerLink(immediateHandler(new Uint8Array([3])));
    const client = makeClientLink();
    const harness = await startHarness({ link });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      await openSocket(socket);
      const binding = bindPluginPeerClientSocket(client, socket);
      expect(binding.attached).toBe(true);
      expect(client.status().attached).toBe(true);
      const call = client.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 30_000 });
      expect(Array.from(await bounded(call.result, 'already-open bind result'))).toEqual([3]);
      await bounded(call.terminal, 'already-open bind terminal');
    } finally {
      socket?.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('rejects a second live binding and never lets a stale close cut the new transport', async () => {
    const link = makeServerLink(immediateHandler(new Uint8Array([5])));
    const client = makeClientLink();
    const harness = await startHarness({ link });
    let first: WebSocket | undefined;
    let spare: WebSocket | undefined;
    let third: WebSocket | undefined;
    try {
      first = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      const firstBinding = bindPluginPeerClientSocket(client, first);
      await openSocket(first);
      expect(firstBinding.attached).toBe(true);

      // A second live binding for the same link is refused outright.
      const spareSocket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      spare = spareSocket;
      spareSocket.addEventListener('error', () => { /* the server refuses the duplicate socket */ });
      expect(() => bindPluginPeerClientSocket(client, spareSocket)).toThrow(PluginPeerWebSocketError);
      await socketRejected(spareSocket);

      first.close();
      await socketClosed(first);
      expect(firstBinding.closed).toBe(true);
      await awaitCondition(() => harness.adapter.status().sockets === 0, 'old server connection physically closed');

      third = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      const thirdBinding = bindPluginPeerClientSocket(client, third);
      await openSocket(third);
      expect(thirdBinding.attached).toBe(true);

      // A stale call on the dead binding must not detach the new transport.
      firstBinding.close();
      expect(thirdBinding.attached).toBe(true);
      expect(client.status().attached).toBe(true);
      const call = client.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 30_000 });
      expect(Array.from(await bounded(call.result, 'result after stale close'))).toEqual([5]);
      await bounded(call.terminal, 'terminal after stale close');
    } finally {
      first?.close();
      spare?.close();
      third?.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('releases the socket bound after repeated real closes', async () => {
    const link = makeServerLink(idleHandler());
    const client = makeClientLink();
    const harness = await startHarness({ link, limits: { maxSockets: 1 } });
    const sockets: WebSocket[] = [];
    try {
      for (let cycle = 0; cycle < 4; cycle += 1) {
        const socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
        sockets.push(socket);
        const binding = bindPluginPeerClientSocket(client, socket);
        await openSocket(socket);
        // `attached` on the server link proves the server's own open ran and the
        // transport really owns the link for this cycle.
        await awaitCondition(() => link.status().attached, `cycle ${cycle} server attach`);
        expect(harness.adapter.status().sockets).toBe(1);
        expect(binding.attached).toBe(true);
        socket.close();
        await socketClosed(socket);
        await awaitCondition(() => harness.adapter.status().sockets === 0, `cycle ${cycle} confirmed close`);
        expect(client.status().attached).toBe(false);
      }
    } finally {
      for (const socket of sockets) socket.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('confirms a normal close instead of waiting out the close grace', async () => {
    const link = makeServerLink(idleHandler());
    const client = makeClientLink();
    const harness = await startHarness({ link, limits: { socketCloseTimeoutMs: 5_000 } });
    let socket: WebSocket | undefined;
    try {
      socket = connectPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      bindPluginPeerClientSocket(client, socket);
      await openSocket(socket);
      const startedAt = Date.now();
      await bounded(harness.adapter.stop(), 'adapter stop with a responsive peer');
      // The real close callback releases the socket long before the 5 s grace.
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(harness.adapter.status().sockets).toBe(0);
      expect(link.status().attached).toBe(false);
    } finally {
      socket?.close();
      cleanup(client, link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);

  test('keeps a still-closing socket inside the bound and hard-terminates an unresponsive peer', async () => {
    const link = makeServerLink(idleHandler());
    let gracefulCloseRequested = false;
    const harness = await startHarness({
      link,
      limits: { socketCloseTimeoutMs: 300, maxSockets: 1 },
      onNativeOpen(socket) {
        // Fault injection on the REAL Bun socket: suppress only graceful close.
        // Bun normally closes even a silent peer immediately; silence alone
        // cannot exercise the fallback. The native terminate and close event
        // stay intact, so shutdown still needs real transport-close evidence.
        socket.close = () => { gracefulCloseRequested = true; };
      },
    });
    let raw: Socket | undefined;
    try {
      raw = await openRawPeerSocket(harness.port, { [PEER_HANDSHAKE_HEADER]: handshakeHeader() });
      // The server-side attach proves the real socket is open, so the graceful
      // close below really has to wait for an answer that never comes.
      await awaitCondition(() => link.status().attached, 'raw peer transport attach');

      const startedAt = Date.now();
      const stopping = harness.adapter.stop();
      await nextMacrotask();
      expect(gracefulCloseRequested).toBe(true);
      // A socket that is only closing still counts against the socket bound.
      expect(harness.adapter.status().sockets).toBe(1);
      await bounded(stopping, 'adapter stop with an unresponsive peer');
      const elapsed = Date.now() - startedAt;
      // The graceful close really was attempted for (most of) the configured
      // grace before the hard terminate.
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(2_000);
      // Only the real Bun close callback released the socket.
      expect(harness.adapter.status().sockets).toBe(0);
      expect(link.status().attached).toBe(false);
    } finally {
      raw?.destroy();
      cleanup(link);
      await harness.stop();
    }
  }, TEST_TIMEOUT_MS);
});
