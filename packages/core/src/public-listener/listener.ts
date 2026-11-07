import { randomUUID } from 'node:crypto';
import { DEFAULT_WEBSOCKET_MAX_CONNECTIONS, DEFAULT_WEBSOCKET_MAX_MESSAGE_BYTES } from '@jeffusion/bungee-types';
import { createWebSocketBridge, isWebSocketUpgradeRequest, type WebSocketBridgeData } from '../websocket';
import type { AccessLogEntry } from '../logger/access-log-writer';
import { observeTransportResponse, type TransportOutcome } from '../logger/transport-outcome';
import { forwardPublicWebSocket } from './websocket';
import type { DataPrincipal } from '../plugin-extensions';
import { createPublicRequestForwarder, type AdmittedWorkerSelector } from './forwarding';

export interface PublicListener {
  readonly port: number | null;
  start(): void;
  stop(): Promise<void>;
}

export class PublicListenerLifecycleError extends Error {
  readonly name = 'PublicListenerLifecycleError';
}

export type IngressPublicListenerOptions = {
  readonly admission: AdmittedWorkerSelector;
  readonly transportSecret: string;
  readonly authenticate?: (request: Request) => DataPrincipal | null;
  readonly hostname: string;
  readonly port: number;
  readonly recordAccess?: (entry: AccessLogEntry) => void;
};

/** Ingress has no control/API routing: every request is passed to the current worker set. */
export function createIngressPublicListener(options: IngressPublicListenerOptions): PublicListener {
  if (options.hostname.length === 0 || !Number.isSafeInteger(options.port)
    || options.port < 0 || options.port > 65_535) {
    throw new PublicListenerLifecycleError('public listener address is invalid');
  }
  let server: ReturnType<typeof Bun.serve> | null = null;
  const bridge = createWebSocketBridge({
    // Bun only applies parser options to future connections, using a fresh handler.
    onNativeLimitsChanged: () => server?.reload({ fetch: handleRequest, websocket: { ...bridge.websocket } }),
    messageLimit: () => options.admission.websocketMaxMessageBytes ?? DEFAULT_WEBSOCKET_MAX_MESSAGE_BYTES,
    connectionLimit: () => options.admission.websocketMaxConnections === undefined
    ? DEFAULT_WEBSOCKET_MAX_CONNECTIONS : options.admission.websocketMaxConnections });
  const forward = createPublicRequestForwarder(options);
  let unsubscribe: (() => void) | undefined;
  let started = false;
  async function handleRequest(request: Request, currentServer: Bun.Server<WebSocketBridgeData>): Promise<Response | undefined> {
    const accessId = randomUUID();
    const websocket = isWebSocketUpgradeRequest(request);
    const recordAccess = options.recordAccess;
    const collector = !websocket && recordAccess && options.admission.requestLogCollector;
    const timestamp = Date.now();
    const startedAt = performance.now();
    const path = collector ? new URL(request.url).pathname : '';
    let settled = false;
    const record = (status: number, transportOutcome: TransportOutcome, transportCode?: string) => {
      if (!collector || !recordAccess || settled) return;
      settled = transportOutcome !== 'pending';
      try {
        const entry = collector(Object.freeze({
          accessId, timestamp, method: request.method, path, status,
          durationMs: Math.round(performance.now() - startedAt),
          transportType: 'http', transportOutcome, transportCode,
        }));
        if (entry?.recordKind === 'access' && entry.accessId === accessId && entry.requestId === accessId) {
          recordAccess(entry);
        }
      } catch { /* logging does not own transport */ }
    };
    const peer = currentServer.requestIP(request)?.address;
    let response: Response | undefined;
    try {
      response = websocket
        ? await forwardPublicWebSocket(request, currentServer, bridge, options, accessId, peer)
        : await forward(request, peer, accessId);
    } catch {
      response = Response.json({ error: 'internal_server_error' }, { status: 500 });
    }
    if (!collector || !response) return response;
    // Bun omits the body of HEAD responses, including rejections created here.
    if (request.method === 'HEAD' || response.headers.get('content-length') === '0') {
      record(response.status, request.signal.aborted ? 'cancelled' : 'completed', request.signal.aborted ? 'client_cancelled' : undefined);
      return response;
    }
    const status = response.status;
    if (response.body) record(status, 'pending');
    return observeTransportResponse(response, request.signal, (outcome, code) => {
      record(status, outcome, code ?? (outcome === 'cancelled' ? 'client_cancelled' : undefined));
    });
  }
  return {
    get port() { return server?.port ?? null; },
    start() {
      if (started) throw new PublicListenerLifecycleError('public listener can only start once');
      started = true;
      bridge.refreshMessagePolicy();
      server = Bun.serve({
        hostname: options.hostname,
        port: options.port,
        reusePort: false,
        idleTimeout: 0,
        // The serving worker enforces its ACKed body_parser_limit while reading
        // the stream, so Bun's transport default must not reject it first.
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        websocket: bridge.websocket,
        fetch: handleRequest,
      });
      unsubscribe = options.admission.subscribeWebSocketMessagePolicy?.(maxMessageBytes => bridge.refreshMessagePolicy(maxMessageBytes));
    },
    async stop() {
      unsubscribe?.(); unsubscribe = undefined;
      const current = server;
      server = null;
      if (current !== null) {
        try { await bridge.stop(); }
        catch (error) { await current.stop(true); throw error; }
        await current.stop(false);
      }
    },
  };
}
