/**
 * P4 authenticated paired plugin-peer RPC link (protocol/flow).
 *
 * Owns only network-call correlation, in-flight slots, and completion receipts
 * over the signed peer channel. It never decides logical caller authority, holds
 * no endpoint lease, opens no command journal, and never re-executes or retries a
 * command: the host maps an authenticated inbound call to the real
 * `RpcServiceRuntime.invokeTracked` pair through `onRequest`.
 *
 * Contract:
 * - Every frame is decoded, authenticated (inverse direction, exact authority,
 *   credential identity) and replay-windowed before dispatch. Kind, lane, the
 *   exact `context.op` key set and the body shape are validated before any record
 *   lookup, so a malformed wrapper is rejected even with an unknown request id.
 * - `request()` prepares (sequence + sign + encode) first: a prepare failure or an
 *   explicit `send === false` is known-not-started. A send that throws after the
 *   frame may have entered the transport is unknown: the result gets a fixed code
 *   but the terminal stays pending until a real terminal/inspect/host proof.
 * - A result is delivered as soon as it exists; a terminal is emitted only when
 *   the provider terminal promise resolves. Rejected/absent/broken terminals keep
 *   the record fail-closed. Detached or non-copyable result buffers become a fixed
 *   failure, never an empty success.
 * - `dispose()` stops new admission but keeps draining existing legal work over an
 *   attached transport. `confirmRemoteStopped()` (host-only) is the trusted proof
 *   that the whole remote endpoint is gone: it releases outbound barriers, drops
 *   ACKs and completed receipts, and keeps local inbound tasks until their real
 *   terminal.
 * - Outbound pending calls, inbound active + completed receipts, and the ACK
 *   outbox are bounded; every byte buffer is a captured copy; every error is a
 *   fixed code with no cause or secret.
 */

import { createHash, randomUUID } from 'node:crypto';
import { encodeCanonicalRpcJson, encodeRpcJson, type RpcJson } from './wire-contract';
import {
  PEER_BODY_MAX_BYTES,
  PEER_HEADER_MAX_BYTES,
  PluginPeerProtocolError,
  PluginPeerReplayWindow,
  signPluginPeerPacket,
  verifyPluginPeerPacket,
  type PluginPeerAuthority,
  type PluginPeerCredential,
  type PluginPeerDirection,
  type PluginPeerHeader,
  type PluginPeerKind,
  type PluginPeerLane,
  type PluginPeerPacket,
} from './peer-protocol';
import { decodePluginPeerFrame, encodePluginPeerFrame } from './peer-frame';

/**
 * Metadata operation carried by the strict `header.context` wrapper.
 *
 * `emit` is the only lane-neutral fire-and-forget operation: the `rpc` lane
 * never uses it (its strict `KIND_BY_OP` mapping still rejects it), while the
 * event/stream/snapshot lanes use it for bulk chunks and notifications that must
 * not pay for a per-frame acknowledgement barrier.
 */
export type PluginPeerRpcOp = 'call' | 'result' | 'terminal' | 'cancel' | 'inspect' | 'ack' | 'ack-confirmed' | 'emit';

/** Fixed result-failure codes that may cross the wire; no provider cause rides along. */
export type PluginPeerRpcWireErrorCode = 'failed' | 'overloaded' | 'expired' | 'unknown' | 'closed';

export type PluginPeerRpcLinkErrorCode =
  | PluginPeerRpcWireErrorCode
  | 'invalid_context'
  | 'invalid_call'
  | 'duplicate_conflict'
  | 'cancelled'
  | 'timeout'
  | 'disconnected';

/** Fixed-code error. It never carries a cause, payload, key, or secret. */
export class PluginPeerRpcLinkError extends Error {
  readonly name = 'PluginPeerRpcLinkError';

  constructor(
    readonly code: PluginPeerRpcLinkErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PluginPeerRpcLinkLimits {
  readonly maxOutboundPending?: number;
  readonly maxInboundRecords?: number;
  readonly maxAckOutbox?: number;
}

/** Authenticated inbound call handed to the host mapper. */
export interface PluginPeerRpcInboundCall {
  readonly requestId: string;
  /** Exact lane the call arrived on; lanes never share correlation records. */
  readonly lane: PluginPeerLane;
  /**
   * Opaque caller metadata. For the `rpc` lane this is the strict `caller`
   * field; for the other lanes it is the complete (already op-validated)
   * lane-specific request context, which only that lane handler may parse.
   * Structure only: it grants no authorization.
   */
  readonly metadata: RpcJson;
  /** Complete op-validated request context; `metadata === context` off the rpc lane. */
  readonly context: RpcJson;
  /** Captured body copy; the caller may write to its own copy freely. */
  readonly body: Uint8Array;
  readonly deadlineAt: number;
  readonly sequence: number;
}

/**
 * One lane's inbound surface. The link still owns decode/authentication,
 * anti-replay, correlation, deadlines, cancellation and the result/terminal
 * barrier; the handler owns only the lane-specific semantics.
 */
export interface PluginPeerLaneHandler {
  /**
   * Admits one lane request. Returning `null` is an explicit refusal (the link
   * answers with a fixed `closed` result + terminal), never a silent drop.
   */
  onRequest(call: PluginPeerRpcInboundCall, signal: AbortSignal): PluginPeerRpcRequestExecution | null;
  /**
   * Fire-and-forget lane frame (`kind: 'chunk' | 'notification'`). The link
   * validates the op/kind/body shape first; the handler owns its meaning.
   */
  onEmit?(frame: PluginPeerLaneEmit): void;
  /**
   * The transport was re-attached after a disconnect (a real reconnect, never
   * the first attach). A lane that lost frames while detached can now re-signal
   * a real gap/failure using its own durable state; it must not resend or retry
   * business CALLs/commands.
   */
  onTransportReady?(): void;
  /** Retire/close/remote-stop notification so pending lane work settles honestly. */
  onTransportEnd?(reason: 'retired' | 'closed' | 'remote-stopped'): void;
}

/** One authenticated fire-and-forget lane frame. */
export interface PluginPeerLaneEmit {
  readonly lane: PluginPeerLane;
  readonly kind: 'chunk' | 'notification';
  readonly requestId: string;
  readonly deadlineAt: number;
  readonly context: RpcJson;
  readonly body: Uint8Array;
  readonly sequence: number;
}

export interface PluginPeerRpcRequestExecution {
  readonly result: Promise<Uint8Array>;
  readonly terminal: Promise<void>;
}

/**
 * Host mapper. It must return synchronously; the two promises are independent
 * and the terminal must reflect the REAL provider completion, not the reply.
 */
export type PluginPeerRpcRequestHandler = (
  call: PluginPeerRpcInboundCall,
  signal: AbortSignal,
) => PluginPeerRpcRequestExecution;

/** Transport adapter. `false` means the frame never entered the transport. */
export type PluginPeerRpcSendAdapter = (frame: Uint8Array, priority: 'data' | 'control') => boolean;

export interface PluginPeerRpcLinkOptions {
  readonly credential: PluginPeerCredential;
  /** Exact host authority the link is bound to; a changed authority needs a new link. */
  readonly authority: PluginPeerAuthority;
  /** Direction used for every frame this link sends; the inbound direction is its inverse. */
  readonly outgoingDirection: PluginPeerDirection;
  readonly onRequest: PluginPeerRpcRequestHandler;
  readonly limits?: PluginPeerRpcLinkLimits;
}

export interface PluginPeerRpcRequestOptions {
  readonly signal?: AbortSignal;
  /** Absolute deadline shared with the wire `deadline_at`; required. */
  readonly deadlineAt: number;
}

export interface PluginPeerRpcLinkStatus {
  readonly attached: boolean;
  readonly retired: boolean;
  readonly closed: boolean;
  readonly outboundPending: number;
  readonly ackOutbox: number;
  readonly inboundActive: number;
  readonly inboundReceipts: number;
}

export const PEER_RPC_LINK_MAX_PENDING = 64;
export const PEER_RPC_LINK_MAX_ACK_OUTBOX = 64;
export const PEER_RPC_LINK_MAX_INBOUND_RECORDS = 64;
/** Global hard cap for any per-link limit; small overrides stay available for tests. */
export const PEER_RPC_LINK_HARD_LIMIT = 1024;

const MAX_TIMER_MS = 2_147_483_647;
const EMPTY_BODY = new Uint8Array(0);
const OPS = new Set<PluginPeerRpcOp>(['call', 'result', 'terminal', 'cancel', 'inspect', 'ack', 'ack-confirmed', 'emit']);
const EMIT_KINDS = new Set<PluginPeerKind>(['chunk', 'notification']);
const NON_RPC_LANES = new Set<PluginPeerLane>(['event', 'snapshot', 'stream']);
const WIRE_ERRORS = new Set<PluginPeerRpcWireErrorCode>(['failed', 'overloaded', 'expired', 'unknown', 'closed']);
/** Only the rpc lane uses this fixed mapping; `emit` is lane-neutral and checked separately. */
const KIND_BY_OP: Partial<Record<PluginPeerRpcOp, PluginPeerKind>> = {
  call: 'request',
  inspect: 'request',
  result: 'response',
  terminal: 'terminal',
  cancel: 'cancel',
  ack: 'response',
  'ack-confirmed': 'response',
};

const CALL_KEYS = ['op', 'caller'] as const;
const RESULT_KEYS = ['op', 'error'] as const;
const OP_KEYS = ['op'] as const;
const INSPECT_KEYS = ['op', 'original_call_sequence', 'original_deadline_at'] as const;

function fail(code: PluginPeerRpcLinkErrorCode, message: string): never {
  throw new PluginPeerRpcLinkError(code, message);
}

function invalidContext(message: string): never {
  return fail('invalid_context', message);
}

function inverseDirection(direction: PluginPeerDirection): PluginPeerDirection {
  return direction === 'peer-to-control' ? 'control-to-peer' : 'peer-to-control';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const type = typeof value;
  if (type !== 'object' && type !== 'function') return false;
  try { return typeof (value as { then?: unknown }).then === 'function'; } catch { return false; }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let settleResolve!: (value: T) => void;
  let settleReject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((accept, decline) => { settleResolve = accept; settleReject = decline; });
  // Local handler so an ignored pair never becomes an unhandled rejection.
  void promise.catch(() => undefined);
  return {
    promise,
    resolve(value) { if (settled) return; settled = true; settleResolve(value); },
    reject(error) { if (settled) return; settled = true; settleReject(error); },
  };
}

function rejectedPromise<T>(error: unknown): Promise<T> {
  const promise = Promise.reject<T>(error);
  void promise.catch(() => undefined);
  return promise;
}

function asRecord(value: RpcJson, label: string): { readonly [key: string]: RpcJson } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidContext(`${label} must be a metadata object`);
  }
  return value as { readonly [key: string]: RpcJson };
}

function exactKeys(value: { readonly [key: string]: RpcJson }, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    return invalidContext(`${label} has unexpected or missing fields`);
  }
}

function readOp(context: RpcJson): PluginPeerRpcOp {
  const record = asRecord(context, 'peer RPC context');
  const op = record.op;
  if (typeof op !== 'string' || !OPS.has(op as PluginPeerRpcOp)) {
    return invalidContext('peer RPC context operation is invalid');
  }
  return op as PluginPeerRpcOp;
}

function requireOp(record: { readonly [key: string]: RpcJson }, op: PluginPeerRpcOp, label: string): void {
  if (record.op !== op) return invalidContext(`${label} operation is invalid`);
}

function requireEmptyBody(body: Uint8Array, label: string): void {
  if (body.byteLength !== 0) return invalidContext(`${label} must not carry a body`);
}

function parseCallContext(context: RpcJson): RpcJson {
  const record = asRecord(context, 'peer RPC call');
  exactKeys(record, CALL_KEYS, 'peer RPC call');
  requireOp(record, 'call', 'peer RPC call');
  return record.caller;
}

function parseResultContext(context: RpcJson): PluginPeerRpcWireErrorCode | null {
  const record = asRecord(context, 'peer RPC result');
  exactKeys(record, RESULT_KEYS, 'peer RPC result');
  requireOp(record, 'result', 'peer RPC result');
  const error = record.error;
  if (error === null) return null;
  if (typeof error !== 'string' || !WIRE_ERRORS.has(error as PluginPeerRpcWireErrorCode)) {
    return invalidContext('peer RPC result error code is invalid');
  }
  return error as PluginPeerRpcWireErrorCode;
}

function parseInspectContext(context: RpcJson): { readonly originalCallSequence: number; readonly originalDeadlineAt: number } {
  const record = asRecord(context, 'peer RPC inspect');
  exactKeys(record, INSPECT_KEYS, 'peer RPC inspect');
  requireOp(record, 'inspect', 'peer RPC inspect');
  const sequence = record.original_call_sequence;
  const deadline = record.original_deadline_at;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0) {
    return invalidContext('peer RPC inspect sequence is invalid');
  }
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= 0) {
    return invalidContext('peer RPC inspect deadline is invalid');
  }
  return { originalCallSequence: sequence, originalDeadlineAt: deadline };
}

function parseBareContext(context: RpcJson, op: PluginPeerRpcOp, label: string): void {
  const record = asRecord(context, label);
  exactKeys(record, OP_KEYS, label);
  requireOp(record, op, label);
}

const LANE_CALL_KEYS = ['op', 'request'] as const;
const LANE_EMIT_KEYS = ['op', 'emit'] as const;

/** The lane request payload from a `{ op:'call', request }` wrapper. */
function parseLaneCallContext(context: RpcJson): RpcJson {
  const record = asRecord(context, 'peer lane call');
  exactKeys(record, LANE_CALL_KEYS, 'peer lane call');
  requireOp(record, 'call', 'peer lane call');
  return record.request!;
}

/** The lane frame payload from a `{ op:'emit', emit }` wrapper. */
function parseLaneEmitContext(context: RpcJson): RpcJson {
  const record = asRecord(context, 'peer lane emit');
  exactKeys(record, LANE_EMIT_KEYS, 'peer lane emit');
  requireOp(record, 'emit', 'peer lane emit');
  return record.emit!;
}

function fingerprintOf(context: RpcJson, body: Uint8Array, deadlineAt: number): string {
  return createHash('sha256')
    .update(encodeCanonicalRpcJson(context, PEER_HEADER_MAX_BYTES), 'utf8')
    .update('\0', 'utf8')
    .update(body)
    .update('\0', 'utf8')
    .update(String(deadlineAt), 'utf8')
    .digest('hex');
}

function resolveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > PEER_RPC_LINK_HARD_LIMIT) {
    throw new PluginPeerRpcLinkError('invalid_call', `invalid ${label}`);
  }
  return value;
}

interface OutboundCall {
  readonly lane: PluginPeerLane;
  readonly requestId: string;
  readonly sequence: number;
  readonly deadlineAt: number;
  readonly result: Deferred<Uint8Array>;
  readonly terminal: Deferred<void>;
  resultSettled: boolean;
  terminalSettled: boolean;
  remoteTerminal: boolean;
  awaitingAck: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  removeAbort: (() => void) | null;
}

interface InboundRecord {
  readonly lane: PluginPeerLane;
  readonly requestId: string;
  readonly sequence: number;
  readonly fingerprint: string;
  readonly deadlineAt: number;
  readonly controller: AbortController;
  resultSettled: boolean;
  resultBody: Uint8Array | null;
  resultError: PluginPeerRpcWireErrorCode | null;
  taskTerminal: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface AckEntry {
  readonly lane: PluginPeerLane;
  readonly requestId: string;
  readonly deadlineAt: number;
}

export class PluginPeerRpcLink {
  readonly #credential: PluginPeerCredential;
  readonly #authority: PluginPeerAuthority;
  readonly #outgoingDirection: PluginPeerDirection;
  readonly #incomingDirection: PluginPeerDirection;
  readonly #onRequest: PluginPeerRpcRequestHandler;
  readonly #maxOutboundPending: number;
  readonly #maxInboundRecords: number;
  readonly #maxAckOutbox: number;
  readonly #incomingReplay = new PluginPeerReplayWindow();
  readonly #outbound = new Map<string, OutboundCall>();
  readonly #inbound = new Map<string, InboundRecord>();
  readonly #ackOutbox = new Map<string, AckEntry>();
  #send: PluginPeerRpcSendAdapter | null = null;
  #everAttached = false;
  #outSequence = 0;
  #draining = false;
  #remoteStopped = false;
  readonly #laneHandlers = new Map<PluginPeerLane, PluginPeerLaneHandler>();

  constructor(options: PluginPeerRpcLinkOptions) {
    if (options === null || typeof options !== 'object') throw new PluginPeerRpcLinkError('invalid_call', 'peer RPC link options are required');
    if (typeof options.onRequest !== 'function') throw new PluginPeerRpcLinkError('invalid_call', 'peer RPC link requires an onRequest handler');
    if (options.outgoingDirection !== 'peer-to-control' && options.outgoingDirection !== 'control-to-peer') {
      throw new PluginPeerRpcLinkError('invalid_call', 'peer RPC link direction is invalid');
    }
    // The credential is only reachable through the peer-protocol brand: a single
    // signed probe validates it and yields the canonical authority clone.
    const probe = signPluginPeerPacket({
      direction: options.outgoingDirection,
      authority: options.authority,
      sequence: 1,
      request_id: randomUUID(),
      lane: 'rpc',
      kind: 'terminal',
      deadline_at: 1,
      context: { op: 'terminal' },
    }, EMPTY_BODY, options.credential);
    this.#credential = options.credential;
    this.#authority = probe.header.authority;
    this.#outgoingDirection = options.outgoingDirection;
    this.#incomingDirection = inverseDirection(options.outgoingDirection);
    this.#onRequest = options.onRequest;
    const limits = options.limits ?? {};
    this.#maxOutboundPending = resolveLimit(limits.maxOutboundPending, PEER_RPC_LINK_MAX_PENDING, 'outbound pending limit');
    this.#maxInboundRecords = resolveLimit(limits.maxInboundRecords, PEER_RPC_LINK_MAX_INBOUND_RECORDS, 'inbound record limit');
    this.#maxAckOutbox = resolveLimit(limits.maxAckOutbox, PEER_RPC_LINK_MAX_ACK_OUTBOX, 'ack outbox limit');
  }

  /**
   * Installs the transport. A repeat call is a reconnect: sequences and the replay
   * window are never reset, pending calls are re-inspected, retained ACKs are
   * resent, and waiting ACK transfers are flushed. Calls are never resent and
   * commands are never retried. Attaching while draining is allowed so existing
   * work can finish.
   */
  attach(send: PluginPeerRpcSendAdapter): void {
    if (typeof send !== 'function') throw new PluginPeerRpcLinkError('invalid_call', 'peer RPC send adapter must be a function');
    const reattach = this.#send !== null || this.#everAttached;
    this.#send = send;
    this.#everAttached = true;
    if (reattach) this.#recover();
  }

  /** Detaches the transport without claiming any remote task ended. */
  disconnect(): void {
    this.#send = null;
  }

  /**
   * Installs the handler for one non-rpc lane. A lane is served by exactly one
   * handler; re-registration (for example after a hub rebuild) replaces it, and
   * the previous handler is told the transport ended so it cannot leak work.
   * The `rpc` lane is never registrable here — it keeps its constructor handler.
   */
  registerLaneHandler(lane: PluginPeerLane, handler: PluginPeerLaneHandler): void {
    if (lane === 'rpc' || lane === 'registry') {
      throw new PluginPeerRpcLinkError('invalid_call', 'peer lane cannot be registered separately');
    }
    const previous = this.#laneHandlers.get(lane);
    if (previous !== undefined && previous !== handler) {
      try { previous.onTransportEnd?.('closed'); } catch { /* host-owned handler */ }
    }
    this.#laneHandlers.set(lane, handler);
  }

  /** Removes one lane handler, telling it the lane is gone. */
  releaseLaneHandler(lane: PluginPeerLane): void {
    const handler = this.#laneHandlers.get(lane);
    if (handler === undefined) return;
    this.#laneHandlers.delete(lane);
    try { handler.onTransportEnd?.('closed'); } catch { /* host-owned handler */ }
  }

  /**
   * Correlates one outbound call. Only a prepare failure or an explicit
   * `send === false` is known-not-started (fixed result + resolved terminal); a
   * send that throws keeps a pending terminal until a real proof arrives.
   */
  request(context: RpcJson, body: Uint8Array, options: PluginPeerRpcRequestOptions): PluginPeerRpcRequestExecution {
    return this.#admitRequest('rpc', context, body, options, { op: 'call', caller: context });
  }

  /**
   * Correlates one outbound non-rpc lane call. The lane request context is
   * wrapped as `{ op: 'call', request: context }` and the receiving lane handler
   * owns its validation; correlation, deadlines, cancellation and the
   * result/terminal barrier are exactly the rpc lane's.
   */
  requestOnLane(lane: PluginPeerLane, context: RpcJson, body: Uint8Array, options: PluginPeerRpcRequestOptions): PluginPeerRpcRequestExecution {
    const refused = (code: PluginPeerRpcLinkErrorCode): PluginPeerRpcRequestExecution => Object.freeze({
      result: rejectedPromise<Uint8Array>(new PluginPeerRpcLinkError(code, 'peer lane call was not admitted')),
      terminal: Promise.resolve(),
    });
    if (!NON_RPC_LANES.has(lane)) return refused('invalid_call');
    let callContext: RpcJson;
    try { callContext = { op: 'call', request: context }; }
    catch { return refused('invalid_call'); }
    return this.#admitRequest(lane, context, body, options, callContext);
  }

  #admitRequest(
    lane: PluginPeerLane,
    _context: RpcJson,
    body: Uint8Array,
    options: PluginPeerRpcRequestOptions,
    callContext: RpcJson,
  ): PluginPeerRpcRequestExecution {
    const preAdmission = (code: PluginPeerRpcLinkErrorCode): PluginPeerRpcRequestExecution => Object.freeze({
      result: rejectedPromise<Uint8Array>(new PluginPeerRpcLinkError(code, 'peer RPC call was not admitted')),
      terminal: Promise.resolve(),
    });
    // Draining stops NEW rpc admission. A non-rpc lane call (stream finish,
    // event ack, snapshot chunk/release) may belong to an already-accepted
    // transfer/subscription/session, so the lane handler decides new-vs-
    // continuation by exact identity; the link never blocks a lane continuation.
    if (this.#remoteStopped) return preAdmission('closed');
    if (this.#draining && lane === 'rpc') return preAdmission('closed');
    if (this.#send === null) return preAdmission('disconnected');
    if (!(body instanceof Uint8Array) || body.byteLength > PEER_BODY_MAX_BYTES) return preAdmission('invalid_call');
    if (options === null || typeof options !== 'object') return preAdmission('invalid_call');
    const deadlineAt = options.deadlineAt;
    if (typeof deadlineAt !== 'number' || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) return preAdmission('invalid_call');
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return preAdmission('invalid_call');
    if (this.#outbound.size >= this.#maxOutboundPending) return preAdmission('overloaded');
    if (Date.now() >= deadlineAt) return preAdmission('expired');
    if (signal?.aborted) return preAdmission('cancelled');

    try {
      encodeRpcJson(callContext, PEER_HEADER_MAX_BYTES);
    } catch {
      return preAdmission('invalid_call');
    }

    const requestId = randomUUID();
    const bodyCopy = new Uint8Array(body);
    const prepared = this.#prepareOrNull(lane, 'request', requestId, deadlineAt, callContext, bodyCopy);
    if (prepared === null) return preAdmission('invalid_call'); // nothing entered the transport

    const result = createDeferred<Uint8Array>();
    const terminal = createDeferred<void>();
    const call: OutboundCall = {
      lane, requestId, sequence: prepared.sequence, deadlineAt, result, terminal,
      resultSettled: false, terminalSettled: false, remoteTerminal: false, awaitingAck: false,
      timer: undefined, removeAbort: null,
    };
    // The record and its cancellation/deadline barriers exist before the real
    // write so a synchronous peer reply or abort can be correlated.
    this.#outbound.set(requestId, call);
    this.#armOutbound(call, signal);
    if (call.resultSettled) {
      // Reentrant pre-dispatch cancellation: never send the call.
      if (!call.terminalSettled) this.#settleOutboundTerminal(call, false);
      this.#discardOutbound(call);
      return Object.freeze({ result: result.promise, terminal: terminal.promise });
    }

    let accepted = false;
    try {
      accepted = this.#write(prepared.frame, 'data');
    } catch {
      // The frame may or may not have entered the transport.
      if (!call.resultSettled) this.#rejectOutboundResult(call, new PluginPeerRpcLinkError('unknown', 'peer RPC send outcome is unknown'));
      return Object.freeze({ result: result.promise, terminal: terminal.promise });
    }
    if (!accepted) {
      // Explicitly not queued: known-not-started, roll the record back.
      if (!call.resultSettled) this.#rejectOutboundResult(call, new PluginPeerRpcLinkError('disconnected', 'peer RPC frame was not queued'));
      if (!call.terminalSettled) this.#settleOutboundTerminal(call, false);
      this.#discardOutbound(call);
    }
    return Object.freeze({ result: result.promise, terminal: terminal.promise });
  }

  /**
   * Sends one fire-and-forget lane frame (bulk chunk / notification). Returns
   * `false` when the frame never entered the transport (detached, refusing
   * socket, or a prepare failure), so a caller can apply backpressure instead of
   * assuming delivery. It never creates a correlation record and never blocks.
   */
  emitLane(
    lane: PluginPeerLane,
    kind: 'chunk' | 'notification',
    requestId: string,
    deadlineAt: number,
    context: RpcJson,
    body: Uint8Array,
    priority: 'data' | 'control' = 'data',
  ): boolean {
    if (!NON_RPC_LANES.has(lane) || !EMIT_KINDS.has(kind)) return false;
    // A draining link still carries lane continuations (credit/chunk/end-read);
    // only a real remote stop refuses every emit.
    if (this.#remoteStopped) return false;
    if (this.#send === null) return false;
    if (!(body instanceof Uint8Array) || body.byteLength > PEER_BODY_MAX_BYTES) return false;
    if (typeof requestId !== 'string' || requestId.length === 0) return false;
    if (typeof deadlineAt !== 'number' || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) return false;
    let emitContext: RpcJson;
    try { emitContext = { op: 'emit', emit: context }; }
    catch { return false; }
    const prepared = this.#prepareOrNull(lane, kind, requestId, deadlineAt, emitContext, new Uint8Array(body));
    if (prepared === null) return false;
    try { return this.#write(prepared.frame, priority); }
    catch { return false; }
  }

  /**
   * Admits one received frame: decode, authenticate, replay-check, then dispatch.
   * Legal frames for existing work are still accepted while draining.
   */
  receive(frame: Uint8Array | ArrayBuffer): void {
    const packet = decodePluginPeerFrame(frame);
    verifyPluginPeerPacket(packet.header, packet.body, this.#credential, {
      direction: this.#incomingDirection,
      authority: this.#authority,
    });
    this.#incomingReplay.accept(packet.header.sequence);
    this.#dispatch(packet);
  }

  /**
   * Host-only proof that the whole remote endpoint is gone. Releases every
   * outbound barrier, drops retained ACKs and completed receipts, and aborts (but
   * never releases early) local inbound tasks. Never use for a single task ACK or
   * a socket close.
   */
  confirmRemoteStopped(): void {
    this.#remoteStopped = true;
    for (const call of [...this.#outbound.values()]) {
      if (!call.resultSettled) this.#rejectOutboundResult(call, new PluginPeerRpcLinkError('unknown', 'remote peer stopped before a result arrived'));
      if (!call.terminalSettled) this.#settleOutboundTerminal(call, false);
      this.#discardOutbound(call);
    }
    this.#ackOutbox.clear();
    for (const record of [...this.#inbound.values()]) {
      if (record.taskTerminal) { this.#inbound.delete(record.requestId); continue; }
      this.#clearInboundTimer(record);
      record.controller.abort('remote-stopped');
    }
    this.#notifyLanes('remote-stopped');
  }

  /** Tells every lane handler that this link can no longer carry its work. */
  #notifyLanes(reason: 'retired' | 'closed' | 'remote-stopped'): void {
    for (const handler of [...this.#laneHandlers.values()]) {
      try { handler.onTransportEnd?.(reason); } catch { /* host-owned handler */ }
    }
  }

  /** Stops admitting new calls; existing work keeps draining. */
  retire(): void {
    this.#draining = true;
    this.#notifyLanes('retired');
  }

  /** Exact link admission state: `true` once retired (new work is refused). */
  get retired(): boolean {
    return this.#draining;
  }

  /**
   * Stops admission, rejects unsettled outbound results, and aborts local inbound
   * signals. Existing result/terminal/inspect/ACK traffic still flows over an
   * attached transport, so receipts can drain; only a real terminal settles an
   * outbound barrier.
   */
  dispose(): void {
    this.#draining = true;
    for (const call of this.#outbound.values()) {
      if (!call.resultSettled) this.#rejectOutboundResult(call, new PluginPeerRpcLinkError('closed', 'peer RPC link stopped admitting calls'));
    }
    for (const record of this.#inbound.values()) {
      this.#clearInboundTimer(record);
      if (!record.taskTerminal) record.controller.abort('closed');
    }
    this.#notifyLanes('closed');
  }

  /** Counts only; it never exposes payload, metadata, or key material. */
  status(): PluginPeerRpcLinkStatus {
    let active = 0;
    let receipts = 0;
    for (const record of this.#inbound.values()) {
      if (record.taskTerminal) receipts += 1;
      else active += 1;
    }
    return Object.freeze({
      attached: this.#send !== null,
      retired: this.#draining,
      closed: this.#draining,
      outboundPending: this.#outbound.size,
      ackOutbox: this.#ackOutbox.size,
      inboundActive: active,
      inboundReceipts: receipts,
    });
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  #armOutbound(call: OutboundCall, signal: AbortSignal | undefined): void {
    const abort = (): void => {
      this.#rejectOutboundResult(call, new PluginPeerRpcLinkError('cancelled', 'peer RPC call was cancelled'));
      this.#sendCancel(call);
    };
    if (signal !== undefined) {
      if (signal.aborted) abort();
      else {
        const listener = (): void => abort();
        signal.addEventListener('abort', listener, { once: true });
        call.removeAbort = () => signal.removeEventListener('abort', listener);
      }
    }
    this.#armDeadline(call.deadlineAt, () => {
      this.#rejectOutboundResult(call, new PluginPeerRpcLinkError('timeout', 'peer RPC call deadline exceeded'));
      this.#sendCancel(call);
    }, (timer) => { call.timer = timer; });
  }

  #resolveOutboundResult(call: OutboundCall, body: Uint8Array): void {
    if (call.resultSettled) return;
    call.resultSettled = true;
    call.result.resolve(body);
    this.#completeOutbound(call);
  }

  #rejectOutboundResult(call: OutboundCall, error: unknown): void {
    if (call.resultSettled) return;
    call.resultSettled = true;
    call.result.reject(error);
    this.#completeOutbound(call);
  }

  #settleOutboundTerminal(call: OutboundCall, fromRemote: boolean): void {
    if (call.terminalSettled) return;
    call.terminalSettled = true;
    if (fromRemote) call.remoteTerminal = true;
    call.terminal.resolve(undefined);
    this.#completeOutbound(call);
  }

  #completeOutbound(call: OutboundCall): void {
    if (!call.resultSettled || !call.terminalSettled) return;
    if (this.#remoteStopped || !call.remoteTerminal) { this.#discardOutbound(call); return; }
    call.awaitingAck = true;
    this.#transferAck(call);
  }

  /**
   * Moves a finished call into the ACK outbox and removes its slot/timers BEFORE
   * the external send, so a synchronous ack-confirmed cannot re-enter this call.
   * Returns false (slot retained) when the outbox is full.
   */
  #transferAck(call: OutboundCall): boolean {
    if (this.#ackOutbox.size >= this.#maxAckOutbox) return false;
    if (!this.#outbound.delete(call.requestId)) { call.awaitingAck = false; return true; }
    this.#clearOutboundResources(call);
    const entry: AckEntry = { lane: call.lane, requestId: call.requestId, deadlineAt: call.deadlineAt };
    this.#ackOutbox.set(call.requestId, entry);
    this.#sendAck(entry);
    return true;
  }

  #discardOutbound(call: OutboundCall): void {
    if (!this.#outbound.delete(call.requestId)) return;
    call.awaitingAck = false;
    this.#clearOutboundResources(call);
  }

  #clearOutboundResources(call: OutboundCall): void {
    if (call.timer !== undefined) { clearTimeout(call.timer); call.timer = undefined; }
    if (call.removeAbort !== null) { call.removeAbort(); call.removeAbort = null; }
  }

  #flushAckQueue(): void {
    for (const call of [...this.#outbound.values()]) {
      if (!call.awaitingAck) continue;
      if (!this.#transferAck(call)) return;
    }
  }

  #sendCancel(call: OutboundCall): void {
    if (this.#remoteStopped) return;
    try {
      this.#emit(call.lane, 'cancel', call.requestId, call.deadlineAt, { op: 'cancel' }, EMPTY_BODY, 'control');
    } catch { /* best-effort control frame */ }
  }

  #sendAck(entry: AckEntry): void {
    if (this.#remoteStopped) return;
    try {
      this.#emit(entry.lane, 'response', entry.requestId, entry.deadlineAt, { op: 'ack' }, EMPTY_BODY, 'control');
    } catch { /* entry stays in the outbox for the next recovery */ }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  #onCall(header: PluginPeerHeader, body: Uint8Array): void {
    const metadata = parseCallContext(header.context);
    this.#admitInbound(header, body, metadata, header.context, this.#onRequest);
  }

  /** Admits one lane call; the lane handler owns the request payload semantics. */
  #onLaneCall(header: PluginPeerHeader, body: Uint8Array, handler: PluginPeerLaneHandler): void {
    const request = parseLaneCallContext(header.context);
    this.#admitInbound(header, body, request, header.context, (call, signal) => handler.onRequest(call, signal));
  }

  /** Admits one lane emit frame; it never creates a correlation record. */
  #onLaneEmit(header: PluginPeerHeader, body: Uint8Array, handler: PluginPeerLaneHandler): void {
    const payload = parseLaneEmitContext(header.context);
    if (handler.onEmit === undefined) return;
    const frame: PluginPeerLaneEmit = Object.freeze({
      lane: header.lane,
      kind: header.kind as 'chunk' | 'notification',
      requestId: header.request_id,
      deadlineAt: header.deadline_at,
      context: payload,
      body: new Uint8Array(body),
      sequence: header.sequence,
    });
    try { handler.onEmit(frame); } catch { /* the lane handler owns its own failure accounting */ }
  }

  #admitInbound(
    header: PluginPeerHeader,
    body: Uint8Array,
    metadata: RpcJson,
    context: RpcJson,
    requestHandler: (call: PluginPeerRpcInboundCall, signal: AbortSignal) => PluginPeerRpcRequestExecution | null,
  ): void {
    const fingerprint = fingerprintOf(header.context, body, header.deadline_at);
    const existing = this.#inbound.get(header.request_id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return fail('duplicate_conflict', 'peer RPC call identity conflicts with an existing record');
      }
      this.#resendInbound(existing);
      return;
    }
    if (this.#remoteStopped) return;
    // A draining link refuses a NEW rpc call, but a lane call may be a
    // continuation of an already-accepted transfer/subscription/session; its
    // lane handler authorizes it by exact identity (see `authorizeInbound`).
    if (this.#draining && header.lane === 'rpc') return this.#rejectIncoming(header, 'closed');
    if (header.deadline_at <= Date.now()) return this.#rejectIncoming(header, 'expired');
    if (this.#inbound.size >= this.#maxInboundRecords) return this.#rejectIncoming(header, 'overloaded');

    const record: InboundRecord = {
      lane: header.lane,
      requestId: header.request_id,
      sequence: header.sequence,
      fingerprint,
      deadlineAt: header.deadline_at,
      controller: new AbortController(),
      resultSettled: false,
      resultBody: null,
      resultError: null,
      taskTerminal: false,
      timer: undefined,
    };
    this.#inbound.set(header.request_id, record);
    this.#armInboundDeadline(record);

    const call: PluginPeerRpcInboundCall = Object.freeze({
      requestId: header.request_id,
      lane: header.lane,
      metadata,
      context,
      body: new Uint8Array(body),
      deadlineAt: header.deadline_at,
      sequence: header.sequence,
    });

    let execution: unknown;
    try {
      execution = requestHandler(call, record.controller.signal);
    } catch {
      // The callback may have dispatched real work before throwing; a result
      // failure is sent but the terminal stays unknown.
      this.#failInboundResult(record);
      return;
    }
    if (execution === null || typeof execution !== 'object') {
      this.#failInboundResult(record);
      return;
    }

    // Read each field in its own guard: a broken getter must never escape, and a
    // failed result read must not prevent subscribing to a valid terminal.
    let resultValue: unknown;
    let resultReadFailed = false;
    try { resultValue = (execution as { readonly result?: unknown }).result; } catch { resultReadFailed = true; }
    let terminalValue: unknown;
    let terminalReadFailed = false;
    try { terminalValue = (execution as { readonly terminal?: unknown }).terminal; } catch { terminalReadFailed = true; }

    if (resultReadFailed || !isThenable(resultValue)) {
      this.#failInboundResult(record);
    } else {
      try {
        void Promise.resolve(resultValue).then(
          (value) => { this.#resolveInboundResult(record, value); },
          () => { this.#failInboundResult(record); },
        ).catch(() => undefined);
      } catch {
        this.#failInboundResult(record);
      }
    }
    if (!terminalReadFailed && isThenable(terminalValue)) {
      try {
        void Promise.resolve(terminalValue).then(
          () => { this.#settleInboundTerminal(record); },
          () => { /* rejected terminal: retain fail-closed, never forge completion */ },
        ).catch(() => undefined);
      } catch { /* subscription failure is not real terminal evidence */ }
    }
  }

  #resolveInboundResult(record: InboundRecord, value: unknown): void {
    if (record.resultSettled || this.#inbound.get(record.requestId) !== record) return;
    // Copy and validate before committing; a detached or unreadable buffer must
    // not become a committed empty success.
    let body: Uint8Array | null = null;
    let error: PluginPeerRpcWireErrorCode | null = null;
    try {
      if (value instanceof Uint8Array && value.byteLength <= PEER_BODY_MAX_BYTES) body = new Uint8Array(value);
      else error = 'failed';
    } catch {
      body = null;
      error = 'failed';
    }
    if (record.resultSettled || this.#inbound.get(record.requestId) !== record) return;
    record.resultSettled = true;
    record.resultBody = body;
    record.resultError = error;
    this.#sendInboundResult(record);
  }

  #failInboundResult(record: InboundRecord): void {
    if (record.resultSettled || this.#inbound.get(record.requestId) !== record) return;
    record.resultSettled = true;
    record.resultBody = null;
    record.resultError = 'failed';
    this.#sendInboundResult(record);
  }

  #settleInboundTerminal(record: InboundRecord): void {
    if (record.taskTerminal || this.#inbound.get(record.requestId) !== record) return;
    record.taskTerminal = true;
    this.#clearInboundTimer(record);
    if (this.#remoteStopped) { this.#inbound.delete(record.requestId); return; }
    this.#sendInboundTerminal(record);
  }

  #sendInboundResult(record: InboundRecord): void {
    if (this.#remoteStopped) return;
    const error = record.resultError;
    const body = error === null && record.resultBody !== null ? record.resultBody : EMPTY_BODY;
    try {
      this.#emit(record.lane, 'response', record.requestId, record.deadlineAt, { op: 'result', error }, body, 'data');
    } catch { /* retained for a reconnect inspect to resend */ }
  }

  #sendInboundTerminal(record: InboundRecord): void {
    if (this.#remoteStopped) return;
    try {
      this.#emit(record.lane, 'terminal', record.requestId, record.deadlineAt, { op: 'terminal' }, EMPTY_BODY, 'control');
    } catch { /* retained for a reconnect inspect to resend */ }
  }

  #resendInbound(record: InboundRecord): void {
    if (record.resultSettled) this.#sendInboundResult(record);
    if (record.taskTerminal) this.#sendInboundTerminal(record);
  }

  #rejectIncoming(header: PluginPeerHeader, code: PluginPeerRpcWireErrorCode): void {
    if (this.#remoteStopped) return;
    try {
      this.#emit(header.lane, 'response', header.request_id, header.deadline_at, { op: 'result', error: code }, EMPTY_BODY, 'data');
      this.#emit(header.lane, 'terminal', header.request_id, header.deadline_at, { op: 'terminal' }, EMPTY_BODY, 'control');
    } catch { /* a disconnected link simply could not answer */ }
  }

  #armInboundDeadline(record: InboundRecord): void {
    this.#armDeadline(record.deadlineAt, () => {
      if (!record.taskTerminal) record.controller.abort('deadline');
    }, (timer) => { record.timer = timer; });
  }

  #clearInboundTimer(record: InboundRecord): void {
    if (record.timer !== undefined) { clearTimeout(record.timer); record.timer = undefined; }
  }

  // -------------------------------------------------------------------------
  // Frame dispatch: kind/lane/op/body are validated before any record lookup.
  // -------------------------------------------------------------------------

  #dispatch(packet: PluginPeerPacket): void {
    const header = packet.header;
    const op = readOp(header.context);
    if (header.lane === 'rpc') {
      if (header.kind !== KIND_BY_OP[op]) return invalidContext('peer RPC kind does not match its operation');
      switch (op) {
        case 'call': return this.#onCall(header, packet.body);
        case 'result': return this.#onResult(header, packet.body);
        case 'terminal': return this.#onTerminal(header, packet.body);
        case 'cancel': return this.#onCancel(header, packet.body);
        case 'inspect': return this.#onInspect(header, packet.body);
        case 'ack': return this.#onAck(header, packet.body);
        case 'ack-confirmed': return this.#onAckConfirmed(header, packet.body);
        case 'emit': return invalidContext('the rpc lane does not carry emit frames');
      }
      return;
    }
    // A non-rpc lane keeps the same authentication/correlation/barrier machinery;
    // only the lane payload semantics belong to its registered handler.
    const handler = this.#laneHandlers.get(header.lane);
    if (handler === undefined) return invalidContext('peer lane is not served by this link');
    switch (op) {
      case 'call':
        if (header.kind !== 'request') return invalidContext('peer lane call must be a request frame');
        return this.#onLaneCall(header, packet.body, handler);
      case 'emit':
        if (!EMIT_KINDS.has(header.kind)) return invalidContext('peer lane emit kind is invalid');
        return this.#onLaneEmit(header, packet.body, handler);
      case 'result': return this.#onResult(header, packet.body);
      case 'terminal': return this.#onTerminal(header, packet.body);
      case 'cancel': return this.#onCancel(header, packet.body);
      case 'inspect': return this.#onInspect(header, packet.body);
      case 'ack': return this.#onAck(header, packet.body);
      case 'ack-confirmed': return this.#onAckConfirmed(header, packet.body);
    }
  }

  #onResult(header: PluginPeerHeader, body: Uint8Array): void {
    const error = parseResultContext(header.context);
    if (error !== null) requireEmptyBody(body, 'peer RPC error result');
    const call = this.#outbound.get(header.request_id);
    if (call === undefined) {
      const ack = this.#ackOutbox.get(header.request_id);
      if (ack === undefined) return;
      if (header.lane !== ack.lane) return invalidContext('peer RPC late result lane does not match its call');
      if (header.deadline_at !== ack.deadlineAt) return invalidContext('peer RPC late result deadline does not match its call');
      // The provider may have ignored our early ACK while its result producer
      // was pending. A late result proves it can now accept the retained ACK.
      this.#sendAck(ack);
      return;
    }
    if (header.lane !== call.lane) return invalidContext('peer RPC result lane does not match its call');
    if (header.deadline_at !== call.deadlineAt) return invalidContext('peer RPC result deadline does not match its call');
    if (call.resultSettled) return;
    if (error === null) this.#resolveOutboundResult(call, new Uint8Array(body));
    else this.#rejectOutboundResult(call, new PluginPeerRpcLinkError(error, 'peer RPC call failed'));
  }

  #onTerminal(header: PluginPeerHeader, body: Uint8Array): void {
    parseBareContext(header.context, 'terminal', 'peer RPC terminal');
    requireEmptyBody(body, 'peer RPC terminal');
    const call = this.#outbound.get(header.request_id);
    if (call === undefined) return;
    if (header.lane !== call.lane) return invalidContext('peer RPC terminal lane does not match its call');
    if (header.deadline_at !== call.deadlineAt) return invalidContext('peer RPC terminal deadline does not match its call');
    if (call.terminalSettled) return;
    this.#settleOutboundTerminal(call, true);
  }

  #onCancel(header: PluginPeerHeader, body: Uint8Array): void {
    parseBareContext(header.context, 'cancel', 'peer RPC cancel');
    requireEmptyBody(body, 'peer RPC cancel');
    const record = this.#inbound.get(header.request_id);
    if (record === undefined) return;
    if (header.lane !== record.lane) return invalidContext('peer RPC cancel lane does not match its call');
    if (header.deadline_at !== record.deadlineAt) return invalidContext('peer RPC cancel deadline does not match its call');
    if (record.taskTerminal) return;
    record.controller.abort('cancel'); // abort is not completion; the record is retained
  }

  #onInspect(header: PluginPeerHeader, body: Uint8Array): void {
    const { originalCallSequence, originalDeadlineAt } = parseInspectContext(header.context);
    requireEmptyBody(body, 'peer RPC inspect');
    if (originalDeadlineAt !== header.deadline_at) return invalidContext('peer RPC inspect deadline does not match its call');
    if (originalCallSequence >= header.sequence) return invalidContext('peer RPC inspect sequence is not in the past');
    const record = this.#inbound.get(header.request_id);
    if (record !== undefined) {
      if (record.lane !== header.lane) return invalidContext('peer RPC inspect lane does not match its record');
      if (record.sequence !== originalCallSequence || record.deadlineAt !== header.deadline_at) {
        return invalidContext('peer RPC inspect does not correlate with its record');
      }
      this.#resendInbound(record);
      return;
    }
    // No record: burn the original call sequence so a late CALL from the old
    // socket cannot start work after we answered "terminal". The caller's other
    // records are never touched by this correlation.
    try {
      this.#incomingReplay.accept(originalCallSequence);
    } catch (error) {
      if (!(error instanceof PluginPeerProtocolError) || error.code !== 'replayed') throw error;
    }
    if (this.#remoteStopped) return;
    try {
      this.#emit(header.lane, 'response', header.request_id, header.deadline_at, { op: 'result', error: 'unknown' }, EMPTY_BODY, 'data');
      this.#emit(header.lane, 'terminal', header.request_id, header.deadline_at, { op: 'terminal' }, EMPTY_BODY, 'control');
    } catch { /* disconnected */ }
  }

  #onAck(header: PluginPeerHeader, body: Uint8Array): void {
    parseBareContext(header.context, 'ack', 'peer RPC ack');
    requireEmptyBody(body, 'peer RPC ack');
    const record = this.#inbound.get(header.request_id);
    if (record === undefined) {
      this.#sendAckConfirmed(header);
      return;
    }
    if (header.lane !== record.lane) return invalidContext('peer RPC ack lane does not match its call');
    if (header.deadline_at !== record.deadlineAt) return invalidContext('peer RPC ack deadline does not match its call');
    // Release only a genuinely finished task whose result was also consumed, so a
    // terminal that arrived before the producer result cannot drop its quota.
    if (!record.taskTerminal || !record.resultSettled) return;
    this.#clearInboundTimer(record);
    this.#inbound.delete(header.request_id);
    this.#sendAckConfirmed(header);
  }

  #onAckConfirmed(header: PluginPeerHeader, body: Uint8Array): void {
    parseBareContext(header.context, 'ack-confirmed', 'peer RPC ack-confirmed');
    requireEmptyBody(body, 'peer RPC ack-confirmed');
    const entry = this.#ackOutbox.get(header.request_id);
    if (entry === undefined) return;
    if (header.lane !== entry.lane) return invalidContext('peer RPC ack-confirmed lane does not match its call');
    if (entry.deadlineAt !== header.deadline_at) return invalidContext('peer RPC ack-confirmed deadline does not match its call');
    this.#ackOutbox.delete(header.request_id);
    this.#flushAckQueue();
  }

  #sendAckConfirmed(header: PluginPeerHeader): void {
    if (this.#remoteStopped) return;
    try {
      this.#emit(header.lane, 'response', header.request_id, header.deadline_at, { op: 'ack-confirmed' }, EMPTY_BODY, 'control');
    } catch { /* disconnected */ }
  }

  // -------------------------------------------------------------------------
  // Transport primitives: prepare is pure; write touches the transport.
  // -------------------------------------------------------------------------

  #recover(): void {
    if (this.#send === null || this.#remoteStopped) return;
    for (const call of [...this.#outbound.values()]) {
      if (call.awaitingAck || (call.resultSettled && call.terminalSettled)) continue;
      try {
        this.#emit(call.lane, 'request', call.requestId, call.deadlineAt, {
          op: 'inspect',
          original_call_sequence: call.sequence,
          original_deadline_at: call.deadlineAt,
        }, EMPTY_BODY, 'control');
      } catch { /* the next reconnect retries */ }
    }
    for (const entry of [...this.#ackOutbox.values()]) this.#sendAck(entry);
    this.#flushAckQueue();
    // A lane that lost frames while detached can now re-signal a real gap using
    // its own durable state; this is a notification, never a CALL/command retry.
    for (const handler of [...this.#laneHandlers.values()]) {
      try { handler.onTransportReady?.(); } catch { /* host-owned handler */ }
    }
  }

  #prepareOrNull(
    lane: PluginPeerLane,
    kind: PluginPeerKind,
    requestId: string,
    deadlineAt: number,
    context: RpcJson,
    body: Uint8Array,
  ): { readonly sequence: number; readonly frame: Uint8Array } | null {
    try {
      return this.#prepare(lane, kind, requestId, deadlineAt, context, body);
    } catch {
      return null;
    }
  }

  #prepare(
    lane: PluginPeerLane,
    kind: PluginPeerKind,
    requestId: string,
    deadlineAt: number,
    context: RpcJson,
    body: Uint8Array,
  ): { readonly sequence: number; readonly frame: Uint8Array } {
    const sequence = this.#nextSequence();
    const packet = signPluginPeerPacket({
      direction: this.#outgoingDirection,
      authority: this.#authority,
      sequence,
      request_id: requestId,
      lane,
      kind,
      deadline_at: deadlineAt,
      context,
    }, body, this.#credential);
    return { sequence, frame: encodePluginPeerFrame(packet) };
  }

  #write(frame: Uint8Array, priority: 'data' | 'control'): boolean {
    const send = this.#send;
    if (send === null) return false;
    return send(frame, priority) === true;
  }

  #emit(
    lane: PluginPeerLane,
    kind: PluginPeerKind,
    requestId: string,
    deadlineAt: number,
    context: RpcJson,
    body: Uint8Array,
    priority: 'data' | 'control',
  ): boolean {
    const prepared = this.#prepare(lane, kind, requestId, deadlineAt, context, body);
    return this.#write(prepared.frame, priority);
  }

  #nextSequence(): number {
    this.#outSequence += 1;
    if (!Number.isSafeInteger(this.#outSequence)) {
      throw new PluginPeerRpcLinkError('failed', 'peer RPC sequence exhausted');
    }
    return this.#outSequence;
  }

  #armDeadline(deadlineAt: number, onExpire: () => void, store: (timer: ReturnType<typeof setTimeout>) => void): void {
    const arm = (): void => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) { onExpire(); return; }
      const timer = setTimeout(() => {
        if (Date.now() >= deadlineAt) onExpire();
        else arm();
      }, Math.min(remaining, MAX_TIMER_MS));
      timer.unref?.();
      store(timer);
    };
    arm();
  }
}
