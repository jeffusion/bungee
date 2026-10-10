import { isIP } from 'node:net';
import { PLUGIN_STORAGE_RPC_PATH } from '../data-admission/rpc';
import { attestManagementRequestSource } from './request-source';
import { PLUGIN_PEER_WS_PATH, type PluginPeerConnectionData, type PluginPeerWebSocketServer } from '../plugin-services/peer-websocket';
import {
  DAEMON_CONTROL_HTTP_PREFIX,
  DAEMON_SHUTDOWN_PATH,
  type DaemonControlRequestContext,
  type DaemonShutdownHandler,
} from '../daemon-control';

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
} as const;

export type ManagementControlApi = {
  handle(request: Request): Promise<Response | null>;
};

export type MasterUIHandler = (request: Request) => Promise<Response | null>;
export type ListenerRouteProfile = 'management' | 'master-control';

export type ManagementListenerOptions = {
  readonly controlApi: ManagementControlApi;
  readonly hostname: string;
  readonly port: number;
  readonly profile: ListenerRouteProfile;
  readonly shutdownTimeoutMs?: number;
  readonly trustedProxyAddresses?: readonly string[];
  readonly masterUIHandler?: MasterUIHandler;
  readonly health?: () => {live: boolean; management: boolean; data: boolean; degraded: boolean};
  readonly daemonControl?: DaemonShutdownHandler;
  /**
   * Optional plugin-peer WebSocket transport. It is consulted only on the
   * `master-control` profile for its own fixed private path; when omitted the
   * peer path is an ordinary 404 and the listener installs no websocket handler.
   */
  readonly internalPluginPeer?: PluginPeerWebSocketServer;
  readonly onResponseSettlementError?: (error: unknown) => void;
};

export interface ManagementListener {
  readonly port: number | null;
  readonly hostname: string | null;
  start(): void;
  ready(): void;
  stopAccepting(): void;
  stop(): Promise<void>;
}

export class ManagementListenerLifecycleError extends Error {
  readonly name = 'ManagementListenerLifecycleError';
}

function reportSettlementError(error: unknown, reporter?: (error: unknown) => void): void {
  if (reporter !== undefined) {
    try {
      reporter(error);
      return;
    } catch {
      // Fall through to a safe warning when the error reporter itself fails.
    }
  }
  process.emitWarning('management response-settlement callback failed', {
    code: 'BUNGEE_RESPONSE_SETTLEMENT_CALLBACK',
  });
}

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: JSON_HEADERS });
}

function isReservedDaemonPath(pathname: string): boolean {
  const internalPrefix = '/__bungee/internal/';
  if (!pathname.startsWith(internalPrefix)) return false;
  const remainder = pathname.slice(internalPrefix.length);
  let decoded: string;
  try { decoded = decodeURIComponent(remainder); }
  catch { return true; }
  return decoded === 'daemon' || decoded.startsWith('daemon/')
    || /^(?:d|%64)(?:a|%61)(?:e|%65)(?:m|%6d)(?:o|%6f)(?:n|%6e)(?:\/|%2f|$)/i.test(decoded);
}

export function trackManagementResponse(response: Response, settle: () => void): Response {
  if (response.body === null) {
    settle();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          settle();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        settle();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { settle(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function mergeManagementRequestSignals(requestSignal: AbortSignal, shutdownSignal: AbortSignal): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([requestSignal, shutdownSignal]), dispose() {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  requestSignal.addEventListener('abort', abort, { once: true });
  shutdownSignal.addEventListener('abort', abort, { once: true });
  if (requestSignal.aborted || shutdownSignal.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose() {
      requestSignal.removeEventListener('abort', abort);
      shutdownSignal.removeEventListener('abort', abort);
    },
  };
}

export async function handleManagementRequest(
  request: Request,
  options: Pick<ManagementListenerOptions, 'controlApi' | 'masterUIHandler' | 'daemonControl' | 'profile' | 'health'>,
  context?: DaemonControlRequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const profile = options.profile;
  if (profile === 'master-control') {
    if (isReservedDaemonPath(url.pathname)) {
      if (url.pathname !== DAEMON_SHUTDOWN_PATH || options.daemonControl === undefined) return notFound();
      return options.daemonControl.handle(request, context);
    }
    if (url.pathname === PLUGIN_STORAGE_RPC_PATH) return await options.controlApi.handle(request) ?? notFound();
    return notFound();
  }
  if (profile === 'management' && (url.pathname.startsWith('/__bungee/internal')
    || url.pathname === '/__ui' || url.pathname.startsWith('/__ui/'))) return notFound();
  if (['/health','/health/live','/health/management','/health/data'].includes(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
    const health = options.health?.() ?? {live:true,management:true,data:false,degraded:true};
    const check = url.pathname.split('/')[2] as 'live'|'management'|'data'|undefined;
    const ready = check ? health[check] : health.live && health.management;
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({status:health.degraded ? 'degraded' : 'ok',...health}), {
      status:ready ? 200 : 503, headers:JSON_HEADERS,
    });
  }
  const handled = await options.controlApi.handle(request);
  if (handled !== null) return handled;
  const uiHandled = await options.masterUIHandler?.(request);
  if (uiHandled !== null && uiHandled !== undefined) return uiHandled;
  return notFound();
}

/** Resolves `true` when the promise settles in time, `false` when the bound elapses. */
async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function createManagementListener(options: ManagementListenerOptions): ManagementListener {
  const profile = options.profile;
  const validManagementHost = profile === 'master-control'
    ? options.hostname === '127.0.0.1'
    : options.hostname.length > 0 && isIP(options.hostname) !== 0;
  const minimumPort = profile === 'master-control' ? 1 : 0;
  if (!validManagementHost || !Number.isSafeInteger(options.port)
    || options.port < minimumPort || options.port > 65_535
    || (options.shutdownTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0))) {
    throw new ManagementListenerLifecycleError('management listener address is invalid');
  }
  let server: Bun.Server<PluginPeerConnectionData> | null = null;
  let started = false;
  let accepting = false;
  let stopPromise: Promise<void> | null = null;
  const peer = profile === 'master-control' ? options.internalPluginPeer : undefined;
  const activeRequests = new Set<AbortController>();
  const drainWaiters = new Set<() => void>();
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const waitForDrain = (): Promise<void> => activeRequests.size === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => drainWaiters.add(resolve));

  return {
    get port() { return server?.port ?? null; },
    get hostname() { return server?.hostname ?? null; },
    start() {
      if (started) throw new ManagementListenerLifecycleError('management listener can only start once');
      started = true;
      const respond = async (
        request: Request,
        connection: Bun.Server<PluginPeerConnectionData>,
      ): Promise<Response | undefined> => {
        // Supervised peers need this authenticated private channel while workers
        // bootstrap, before management readiness can be established. The peer
        // transport owns a separate admission gate and stopAccepting closes it
        // synchronously; no ordinary management or legacy state-RPC route is
        // admitted early.
        const peerRequest = peer !== undefined && new URL(request.url).pathname === PLUGIN_PEER_WS_PATH;
        if (!accepting && !peerRequest) {
          return Response.json({ error: 'service_unavailable' }, { status: 503, headers: JSON_HEADERS });
        }
        const lifetime = new AbortController();
        activeRequests.add(lifetime);
        let released = false;
        const combined = mergeManagementRequestSignals(request.signal, lifetime.signal);
        const release = () => {
          if (released) return;
          released = true;
          activeRequests.delete(lifetime);
          combined.dispose();
          if (activeRequests.size === 0) {
            for (const resolve of drainWaiters) resolve();
            drainWaiters.clear();
          }
        };
        try {
          // Track before the first await, but upgrade the original Bun request.
          // Only a successful upgrade transfers lifetime to the socket adapter;
          // rejected HTTP responses still require normal body settlement.
          if (peer !== undefined && peerRequest) {
            const outcome = await peer.handle(request, connection, combined.signal);
            if (outcome === undefined) { release(); return undefined; }
            if (outcome !== null) return trackManagementResponse(outcome, release);
          }
          if (!accepting) return trackManagementResponse(
            Response.json({ error: 'service_unavailable' }, { status: 503, headers: JSON_HEADERS }), release,
          );
          let settled = false;
          const callbacks = new Set<{
            readonly callback: () => void | Promise<void>;
            readonly onError?: (error: unknown) => void;
          }>();
          const context: DaemonControlRequestContext = {
            onResponseSettled(callback, onError) { callbacks.add({ callback, onError }); },
          };
          const settle = () => {
            if (settled) return;
            settled = true;
            release();
            for (const pending of callbacks) {
              try {
                const result = pending.callback();
                void Promise.resolve(result).catch((error) => reportSettlementError(error, pending.onError ?? options.onResponseSettlementError));
              }
              catch (error) {
                reportSettlementError(error, pending.onError ?? options.onResponseSettlementError);
              }
            }
            callbacks.clear();
          };
          const handledRequest = new Request(request, { signal: combined.signal });
          attestManagementRequestSource(handledRequest, connection.requestIP(request)?.address, options.trustedProxyAddresses);
          const response = await handleManagementRequest(handledRequest, options, context);
          return trackManagementResponse(response, settle);
        } catch (error) {
          release();
          throw error;
        }
      };
      server = peer === undefined
        ? Bun.serve<PluginPeerConnectionData>({
            hostname: options.hostname,
            port: options.port,
            reusePort: false,
            fetch: async (request, connection) => (await respond(request, connection)) ?? notFound(),
          })
        : Bun.serve<PluginPeerConnectionData>({
            hostname: options.hostname,
            port: options.port,
            reusePort: false,
            fetch: (request, connection) => respond(request, connection),
            websocket: peer.websocket,
          });
    },
    ready() {
      if (!started || server === null) {
        throw new ManagementListenerLifecycleError('management listener must bind before becoming ready');
      }
      accepting = true;
    },
    stopAccepting() {
      accepting = false;
      // Close handshake admission synchronously so an authorization that is still
      // in flight cannot upgrade after the listener stopped accepting. Established
      // peer transports and their in-flight RPC are left running.
      peer?.stopAccepting();
    },
    async stop() {
      if (stopPromise !== null) return stopPromise;
      const current = server;
      server = null;
      accepting = false;
      stopPromise = (async () => {
        // Stop accepting peer upgrades and close existing peer transports BEFORE
        // awaiting the server: `server.stop(false)` waits for open WebSockets, so
        // they must already be draining. A peer stop that cannot confirm keeps the
        // shutdown on the forced path instead of hanging.
        const peerStopped = peer === undefined ? true : await settleWithin(peer.stop(), shutdownTimeoutMs);
        if (current === null) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const drained = await Promise.race([
          waitForDrain().then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
        ]);
        if (timer !== null) clearTimeout(timer);
        if (drained && peerStopped
          && await settleWithin(Promise.resolve().then(() => current.stop(false)), shutdownTimeoutMs)) return;
        drainWaiters.clear();
        for (const request of activeRequests) request.abort('management listener shutdown timeout');
        const forced = current.stop(true);
        let forceTimer: ReturnType<typeof setTimeout> | null = null;
        const forcedCompleted = await Promise.race([
          forced.then(() => true, () => false),
          new Promise<false>((resolve) => { forceTimer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
        ]);
        if (forceTimer !== null) clearTimeout(forceTimer);
        if (!forcedCompleted) throw new ManagementListenerLifecycleError('management listener did not stop after forced shutdown');
      })();
      return stopPromise;
    },
  };
}
