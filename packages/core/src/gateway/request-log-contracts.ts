import type { BodyConsumer, BodyEvent, BodyHandle, BodyViewIdentity } from './body-contracts';
import type { WebSocketMessageView } from './websocket-contracts';
import type { TransportType } from '../logger/transport-outcome';

export interface RequestLogContext {
  readonly transportType: TransportType;
  readonly method: string;
  readonly path: string;
  readonly webSocketMode?: 'responses';
}

export interface RequestLogBodyContext extends RequestLogContext {
  readonly stage: Exclude<BodyViewIdentity['stage'], 'upstream-response'>;
  readonly contentType: string;
}

/** Return a serializable log value, or undefined to skip this representation. */
export type RequestLogBodyParser = (body: BodyHandle, consumer: BodyConsumer) => unknown | Promise<unknown>;

export interface RequestLogStreamBody {
  /** Incrementally decoded UTF-8 text from the shared body source. */
  textChunks(): AsyncIterable<string>;
  events(): AsyncIterable<BodyEvent>;
}

/** Yield one serialized JSON value, or declare a text result and yield its fragments. */
export interface RequestLogBodyStreamParser {
  readonly format?: 'text';
  readonly stream: (body: RequestLogStreamBody) => AsyncIterable<string>;
}

export type RequestLogBodyHandler = RequestLogBodyParser | RequestLogBodyStreamParser;

export type RequestLogEvent =
  | { readonly kind: 'http'; readonly status: number; readonly contentType: string; readonly body: BodyHandle; readonly signal: AbortSignal }
  | RequestLogWebSocketEvent;

export interface RequestLogWebSocketEvent {
  readonly kind: 'websocket';
  readonly direction: 'client' | 'upstream';
  readonly message: WebSocketMessageView;
  /** Wall-clock time at the client-side message boundary. */
  readonly timestamp: number;
  readonly relatedOperationId?: string;
  /** A final rejection sent by the hosted handler. Forwarded error events may be intermediate. */
  readonly hostedErrorOutcome?: 'failed' | 'cancelled';
  /** The hosted handler finished sending messages for this client request. */
  readonly settled?: true;
  /** JSON inspection is unavailable for this frame because it exceeded the observation budget. */
  readonly oversized?: true;
}

export interface RequestLogWebSocketBody {
  /** Append an attributed client-facing JSON message in delivery order. */
  append(message: WebSocketMessageView): void;
  /** Discard the request when several candidates could have started the operation. */
  discardRequest(): void;
  /** Discard the response when its full membership cannot be established. */
  discardResponse(reason?: 'size_limit'): void;
  /** Release a candidate that cannot be attributed to an operation. */
  discard(): void;
}

export interface RequestLogWebSocketBodies {
  start(request: WebSocketMessageView): RequestLogWebSocketBody | undefined;
}

export interface RequestLogRecords {
  /** Resolves with the operation ID after admission, or undefined when skipped. */
  start(fields: {
    readonly protocol: string;
    readonly operation: string;
    readonly body?: RequestLogWebSocketBody;
    /** For a WebSocket request confirmed by a later frame, the timestamp of its first client frame. */
    readonly startedAt?: number;
  }): Promise<string | undefined>;
  /** Omit the result when observation ended without a confirmed terminal. */
  finish(id: string, result?: {
    readonly outcome: 'completed' | 'failed' | 'incomplete' | 'cancelled';
    readonly code?: string;
    /** A confirmed HTTP terminal makes a subsequent client disconnect expected for this operation. */
    readonly acceptClientDisconnect?: true;
  }): void;
}

export interface RequestLogObserver {
  /** Fast, synchronous admission for the log queue. Return false only for messages the observer can ignore. */
  shouldObserveWebSocket?(direction: 'client' | 'upstream', message: WebSocketMessageView): boolean;
  /** Correlate ordered messages synchronously. Return lifecycle work that retains only bounded metadata. */
  prepareWebSocket?(event: RequestLogWebSocketEvent, bodies?: RequestLogWebSocketBodies):
    ((records: RequestLogRecords) => void | Promise<void>) | undefined;
  observe(event: RequestLogEvent, records: RequestLogRecords): void | Promise<void>;
}
