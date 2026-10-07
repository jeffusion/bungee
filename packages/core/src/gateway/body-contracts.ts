/** A representation changes whenever a hook or rule rewrites its bytes. */
export interface BodyViewIdentity {
  readonly requestId: string;
  readonly attemptId: string;
  readonly direction: 'request' | 'response';
  readonly stage: 'original-request' | 'outbound-request' | 'upstream-response' | 'client-response';
  readonly version: number;
  readonly contentType: string;
  readonly contentEncoding: string;
}
export interface BodyConsumer {
  readonly id: string;
  readonly mandatory?: boolean;
  readonly signal?: AbortSignal;
  readonly backlogBytes?: number;
  readonly backlogEvents?: number;
}
export interface BodyEvent {
  readonly data: string;
  readonly hasData?: boolean;
  readonly json?: unknown;
  readonly event?: string;
  readonly id?: string;
  readonly retry?: string;
  readonly comments?: string[];
  readonly raw?: string;
  readonly truncated?: boolean;
}
/** Byte arrays are borrowed read-only views. Writers must create a new representation. */
export interface BodyHandle {
  readonly identity: Readonly<BodyViewIdentity>;
  readonly maxBytes: number;
  bytes(consumer?: BodyConsumer): Promise<Uint8Array>;
  decoded(consumer?: BodyConsumer): Promise<Uint8Array>;
  json(consumer?: BodyConsumer, emptyObject?: boolean): Promise<unknown>;
  events(consumer?: BodyConsumer): AsyncIterable<BodyEvent>;
}
