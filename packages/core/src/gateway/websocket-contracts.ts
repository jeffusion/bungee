/** Read-only WebSocket SDK. HTTP bodies and WebSocket messages have separate owners. */
export interface WebSocketMessageView {
  readonly kind: 'text' | 'binary';
  readonly byteLength: number;
  /** Demand-driven, shared, deeply frozen JSON; undefined for binary/invalid JSON. */
  json(): unknown;
}

export interface WebSocketSessionContext {
  readonly connectionId: string;
  readonly keyId?: string | null;
  readonly routeId: string;
  readonly upstreamId: string;
  readonly upstreamUrl: string;
  readonly servingRevision?: number;
}

export interface WebSocketSessionMetrics {
  readonly durationMs: number;
  readonly clientMessages: number;
  readonly upstreamMessages: number;
  readonly clientBytes: number;
  readonly upstreamBytes: number;
}

export type WebSocketObservationEvent = Readonly<WebSocketSessionContext & {
  /** Delivery lease expires when the observer returns or exceeds its deadline. */
  readonly isActive: () => boolean;
} & (
  | { readonly phase: 'open' }
  | { readonly phase: 'message'; readonly direction: 'client' | 'upstream'; readonly message: WebSocketMessageView }
  | { readonly phase: 'incomplete'; readonly reason: 'observer-timeout' | 'observer-error' | 'buffer-limit' | 'message-limit' }
  | { readonly phase: 'close'; readonly code: number; readonly reason: string; readonly metrics: WebSocketSessionMetrics }
)>;

/** Handshake-only transforms; message data is never mutable through this hook. */
export interface WebSocketHandshakeContext {
  readonly connectionId: string;
  readonly routeId: string;
  readonly upstreamId: string;
  readonly signal: AbortSignal;
  url: URL;
  headers: Headers;
}
export interface GatewayWebSocketInput {
  readonly request: Request;
  readonly nativeRequest: Request;
  readonly server: Bun.Server<any>;
  readonly bridge: import('../websocket').WebSocketBridge;
  readonly config: import('@jeffusion/bungee-types').AppConfig;
  readonly servingRevision: number;
  readonly logging?: import('../logger/request-logger').RequestLoggerDependencies;
  /** Host shutdown barrier; retains observer/credential owners until close cleanup. */
  readonly retain: (completion: Promise<void>) => void;
}
export interface GatewayWebSocketResult { readonly response?: Response }
