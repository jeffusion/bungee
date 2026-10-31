import { DEFAULT_WEBSOCKET_MAX_CONNECTIONS, DEFAULT_WEBSOCKET_MAX_MESSAGE_BYTES } from '@jeffusion/bungee-types';
import { createWebSocketBridge, isWebSocketUpgradeRequest, type WebSocketBridgeData } from '../websocket';
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
  function handleRequest(request: Request, currentServer: Bun.Server<WebSocketBridgeData>) {
    const peer = currentServer.requestIP(request)?.address;
    return isWebSocketUpgradeRequest(request)
      ? forwardPublicWebSocket(request, currentServer, bridge, options, peer)
      : forward(request, peer);
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
      if (current !== null) { await bridge.stop(); await current.stop(false); }
    },
  };
}
