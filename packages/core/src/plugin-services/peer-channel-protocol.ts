/**
 * Host communication lane protocol (P5): strict, bounded codecs for the three
 * non-RPC lanes — `event`, `snapshot`, `stream`.
 *
 * Scope boundary: this module only defines shapes and constants. It opens no
 * transport, keeps no state, and grants no authority: every request/response is
 * authenticated and correlated by the peer link (`peer-rpc-link.ts`), and every
 * authorization decision belongs to the host adapter (`channels.ts`).
 *
 * Design rules:
 * - A lane request rides the link's existing request/response machinery; only the
 *   lane payload is lane-specific. Bulk bytes never ride a request envelope: they
 *   travel as `emit` frames (stream chunks) or as bounded chunk responses
 *   (snapshot bodies), never by enlarging the 64 KiB RPC message.
 * - Every codec is strict: exact key sets, bounded strings/numbers, and a byte
 *   bound. A malformed lane payload is refused, never partially trusted.
 * - Every request carries the host-minted `caller` + `callerScope`, so the
 *   receiving host correlates an inbound frame to the exact original owner it was
 *   authorized for (never to a bare plugin name).
 * - Result bodies are pure JSON `{ ok: true, ... } | { ok: false, code, detail? }`,
 *   so a lane can report `gap`/`conflict`/`unauthorized` without widening the
 *   link's own fixed wire-error vocabulary.
 */

import { decodeRpcJson, encodeRpcJson, type RpcCallPurpose, type RpcJson } from './wire-contract';
import type { PluginPeerRpcRequestExecution } from './peer-rpc-link';

export const PLUGIN_CHANNEL_VERSION = 1 as const;

/** A lane request context stays far below the 8 KiB peer header cap. */
export const CHANNEL_REQUEST_MAX_BYTES = 4 * 1024;
/** A JSON result payload (event body / snapshot descriptor) stays below the frame cap. */
export const CHANNEL_RESULT_MAX_BYTES = 60 * 1024;
/** Largest single chunk body that fits one peer frame with the emit wrapper. */
export const CHANNEL_MAX_CHUNK_BYTES = 60 * 1024;

export type PluginChannelLane = 'event' | 'snapshot' | 'stream';

/**
 * The exact transport surface a lane engine needs. `PluginPeerRpcLink` satisfies
 * it structurally; a same-process route uses the hub's in-process loopback port,
 * so local and remote transfers share one implementation and one set of limits.
 */
export interface PluginChannelLinkPort {
  /**
   * Exact transport admission state. `true` once this link has retired: NEW
   * open/subscribe/read work is refused by the hub, while frames belonging to an
   * already-accepted transfer/subscription/session keep flowing.
   */
  readonly retired?: boolean;
  requestOnLane(
    lane: PluginChannelLane,
    context: RpcJson,
    body: Uint8Array,
    options: { readonly deadlineAt: number; readonly signal?: AbortSignal },
  ): PluginPeerRpcRequestExecution;
  emitLane(
    lane: PluginChannelLane,
    kind: 'chunk' | 'notification',
    requestId: string,
    deadlineAt: number,
    context: RpcJson,
    body: Uint8Array,
    priority?: 'data' | 'control',
  ): boolean;
}

export type PluginChannelErrorCode =
  | 'unavailable'
  | 'ambiguous'
  | 'unauthorized'
  | 'invalid'
  | 'overloaded'
  | 'expired'
  | 'conflict'
  | 'gap'
  | 'truncated'
  | 'rejected'
  | 'cancelled'
  | 'closed'
  | 'unknown'
  | 'failed';

export const PLUGIN_CHANNEL_LANES: readonly PluginChannelLane[] = Object.freeze(['event', 'snapshot', 'stream']);

/** Fixed-code channel error. It never carries a cause, path, or payload. */
export class PluginChannelError extends Error {
  readonly name = 'PluginChannelError';
  constructor(readonly code: PluginChannelErrorCode, message: string) {
    super(message);
  }
}

export function failChannel(code: PluginChannelErrorCode, message: string): never {
  throw new PluginChannelError(code, message);
}

/** Logical target of one lane request; the physical identity is never a plugin concern. */
export interface PluginChannelTarget {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._@/-]{0,127}$/;
const SERVICE = /^[a-z][a-z0-9.-]{0,127}$/;
/** Event ids are lowercase hex; they are minted per durable sequence. */
const EVENT_ID = /^[0-9a-f]{16,64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OBJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
/** Canonical contract hash: lowercase hex, 32 or 64 chars. */
const CONTRACT_HASH = /^[0-9a-f]{32,64}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

function isSafeInt(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value);
}

function isServiceId(value: unknown): value is string {
  return typeof value === 'string' && SERVICE.test(value);
}

function decodeTarget(value: unknown): PluginChannelTarget | null {
  if (!isPlainRecord(value) || !exactKeys(value, ['provider', 'service', 'major'])) return null;
  if (!isName(value.provider) || !isServiceId(value.service) || !isSafeInt(value.major, 1)) return null;
  return Object.freeze({ provider: value.provider, service: value.service, major: value.major });
}

function maybeDigest(value: unknown): value is `sha256:${string}` | null {
  return value === null || (typeof value === 'string' && DIGEST.test(value));
}

/** Encodes one lane request payload into the link's bounded JSON envelope. */
function encodePayload(value: unknown): RpcJson {
  try { return JSON.parse(encodeRpcJson(value, CHANNEL_REQUEST_MAX_BYTES)) as RpcJson; }
  catch { return failChannel('invalid', 'channel request payload is not valid bounded JSON'); }
}

/** Decodes one lane request payload; `null` means "refuse, never dispatch". */
function decodePayload(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  try {
    const text = encodeRpcJson(value, CHANNEL_REQUEST_MAX_BYTES);
    const parsed = decodeRpcJson(text, CHANNEL_REQUEST_MAX_BYTES);
    return isPlainRecord(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function encodeChannelResult(
  value:
    | { readonly ok: true; readonly [key: string]: unknown }
    | { readonly ok: false; readonly code: PluginChannelErrorCode; readonly detail?: Record<string, unknown> },
): Uint8Array {
  const encoded = encodePayload(value);
  return new TextEncoder().encode(JSON.stringify(encoded));
}

export type PluginChannelResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly code: PluginChannelErrorCode; readonly detail?: Record<string, unknown> };

const ERROR_CODES = new Set<PluginChannelErrorCode>([
  'unavailable', 'ambiguous', 'unauthorized', 'invalid', 'overloaded', 'expired',
  'conflict', 'gap', 'truncated', 'rejected', 'cancelled', 'closed', 'unknown', 'failed',
]);

/** Strict decode of a JSON lane result body; `null` is a protocol failure. */
export function decodeChannelResult(bytes: Uint8Array): PluginChannelResult | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > CHANNEL_RESULT_MAX_BYTES) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  let parsed: unknown;
  try { parsed = decodeRpcJson(text, CHANNEL_RESULT_MAX_BYTES); } catch { return null; }
  if (!isPlainRecord(parsed) || typeof parsed.ok !== 'boolean') return null;
  if (parsed.ok === false) {
    const keys = Object.keys(parsed);
    if (keys.length === 2) {
      if (!exactKeys(parsed, ['ok', 'code'])) return null;
      if (typeof parsed.code !== 'string' || !ERROR_CODES.has(parsed.code as PluginChannelErrorCode)) return null;
      return Object.freeze({ ok: false, code: parsed.code as PluginChannelErrorCode });
    }
    if (!exactKeys(parsed, ['ok', 'code', 'detail'])) return null;
    if (typeof parsed.code !== 'string' || !ERROR_CODES.has(parsed.code as PluginChannelErrorCode)) return null;
    if (!isPlainRecord(parsed.detail)) return null;
    return Object.freeze({ ok: false, code: parsed.code as PluginChannelErrorCode, detail: Object.freeze({ ...parsed.detail }) });
  }
  const { ok: _ok, ...value } = parsed;
  return Object.freeze({ ok: true, value: Object.freeze(value) });
}

/** Raw chunk response body: bytes carried by a snapshot/stream chunk call. */
export function encodeChannelBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > CHANNEL_MAX_CHUNK_BYTES) {
    return failChannel('invalid', 'channel chunk exceeds the frame body budget');
  }
  return new Uint8Array(bytes);
}

/* -------------------------------------------------------------------------- */
/* Lane request envelopes                                                      */
/* -------------------------------------------------------------------------- */

/** Common envelope: target + host-minted caller identity + lane-specific request. */
const RPC_CALL_PURPOSES = new Set<RpcCallPurpose>(['bootstrap', 'background', 'management', 'request', 'attempt']);

interface LaneRequestBase {
  readonly v: typeof PLUGIN_CHANNEL_VERSION;
  readonly target: PluginChannelTarget;
  /** Consumer plugin name; host-minted, never payload-claimed. */
  readonly caller: string;
  /** Consumer owner scope key; host-minted (`global` or a binding scope). */
  readonly callerScope: string;
  /**
   * Host-minted invocation purpose shared across the peer boundary, so the
   * providing host can keep the original request/attempt/management context
   * instead of re-interpreting the call as an unauthenticated background task.
   */
  readonly purpose: RpcCallPurpose;
  /**
   * Canonical hash of the consumer's declared lane contract (id + version + the
   * `wire-contract` data schema). The provider refuses a request that does not
   * hash to its own contract, so the two sides cannot silently disagree about
   * the payload type.
   */
  readonly contract: string;
  readonly kind: string;
}

export interface ChannelStreamOpenRequest extends LaneRequestBase {
  readonly kind: 'stream.open' | 'stream.open-write';
  readonly request: {
    /** Consumer-minted correlation id; becomes the transfer id for every later frame. */
    readonly clientId: string;
    readonly objectId: string;
    readonly version: number;
    readonly offset: number;
    readonly size: number | null;
    readonly digest: `sha256:${string}` | null;
    readonly creditBytes: number;
    readonly idleMs: number;
  };
}

/**
 * One duplex session negotiation: a SINGLE transfer id carries both a provider ->
 * consumer read flow and a consumer -> provider write flow, each with its own
 * independent absolute credit window, over one shared terminal.
 */
export interface ChannelStreamOpenDuplexRequest extends LaneRequestBase {
  readonly kind: 'stream.open-duplex';
  readonly request: {
    readonly clientId: string;
    readonly objectId: string;
    readonly version: number;
    readonly readOffset: number;
    readonly readSize: number | null;
    readonly readDigest: `sha256:${string}` | null;
    readonly writeSize: number | null;
    readonly writeDigest: `sha256:${string}` | null;
    readonly readCreditBytes: number;
    readonly writeCreditBytes: number;
    readonly idleMs: number;
  };
}

export interface ChannelStreamFinishRequest extends LaneRequestBase {
  readonly kind: 'stream.finish';
  readonly request: {
    readonly transferId: string;
    readonly size: number;
    readonly digest: `sha256:${string}`;
  };
}

export interface ChannelEventSubscribeRequest extends LaneRequestBase {
  readonly kind: 'event.subscribe';
  readonly request: {
    readonly clientId: string;
    readonly delivery: 'transient' | 'reliable';
    readonly consumerId: string;
    readonly from: number | null;
  };
}

export interface ChannelEventAckRequest extends LaneRequestBase {
  readonly kind: 'event.ack';
  readonly request: { readonly subscriptionId: string; readonly sequence: number };
}

export interface ChannelSnapshotDescribeRequest extends LaneRequestBase {
  readonly kind: 'snapshot.describe';
  readonly request: { readonly version: number | null };
}

/**
 * Pins one immutable version for a WHOLE read: the provider retains the exact
 * source until `snapshot.release` (or its bounded idle expiry), so a refresh or a
 * version eviction can never swap or free the body mid-read.
 */
export interface ChannelSnapshotOpenRequest extends LaneRequestBase {
  readonly kind: 'snapshot.open';
  readonly request: { readonly version: number | null };
}

export interface ChannelSnapshotChunkRequest extends LaneRequestBase {
  readonly kind: 'snapshot.chunk';
  readonly request: { readonly sessionId: string; readonly offset: number; readonly length: number };
}

export interface ChannelSnapshotReleaseRequest extends LaneRequestBase {
  readonly kind: 'snapshot.release';
  readonly request: { readonly sessionId: string };
}

function laneEnvelope(record: Record<string, unknown>): Omit<LaneRequestBase, 'kind'> | null {
  if (!exactKeys(record, ['v', 'kind', 'target', 'caller', 'callerScope', 'purpose', 'contract', 'request'])) return null;
  if (record.v !== PLUGIN_CHANNEL_VERSION) return null;
  const target = decodeTarget(record.target);
  if (target === null || !isName(record.caller) || typeof record.callerScope !== 'string' || !NAME.test(record.callerScope)) return null;
  if (typeof record.purpose !== 'string' || !RPC_CALL_PURPOSES.has(record.purpose as RpcCallPurpose)) return null;
  if (typeof record.contract !== 'string' || !CONTRACT_HASH.test(record.contract)) return null;
  return { v: PLUGIN_CHANNEL_VERSION, target, caller: record.caller, callerScope: record.callerScope, purpose: record.purpose as RpcCallPurpose, contract: record.contract };
}

export function encodeStreamOpenRequest(
  kind: 'stream.open' | 'stream.open-write',
  target: PluginChannelTarget,
  caller: string,
  callerScope: string,
  contract: string,
  request: ChannelStreamOpenRequest['request'],
  purpose: RpcCallPurpose = 'background',
): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind, target, caller, callerScope, purpose, contract, request });
}

export function decodeStreamOpenRequest(payload: unknown): ChannelStreamOpenRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || (record.kind !== 'stream.open' && record.kind !== 'stream.open-write')) return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['clientId', 'objectId', 'version', 'offset', 'size', 'digest', 'creditBytes', 'idleMs'])) return null;
  if (typeof request.clientId !== 'string' || !NAME.test(request.clientId)) return null;
  if (typeof request.objectId !== 'string' || !OBJECT_ID.test(request.objectId)) return null;
  if (!isSafeInt(request.version, 1) || !isSafeInt(request.offset)) return null;
  if (request.size !== null && !isSafeInt(request.size, 1)) return null;
  if (!maybeDigest(request.digest)) return null;
  if (!isSafeInt(request.creditBytes, 1) || !isSafeInt(request.idleMs, 1)) return null;
  return Object.freeze({
    ...base, kind: record.kind,
    request: Object.freeze({
      clientId: request.clientId, objectId: request.objectId, version: request.version, offset: request.offset,
      size: request.size, digest: request.digest as `sha256:${string}` | null,
      creditBytes: request.creditBytes, idleMs: request.idleMs,
    }),
  });
}

export function encodeStreamOpenDuplexRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelStreamOpenDuplexRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'stream.open-duplex', target, caller, callerScope, purpose, contract, request });
}

export function decodeStreamOpenDuplexRequest(payload: unknown): ChannelStreamOpenDuplexRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'stream.open-duplex') return null;
  const request = record.request;
  if (!isPlainRecord(request)) return null;
  if (!exactKeys(request, ['clientId', 'objectId', 'version', 'readOffset', 'readSize', 'readDigest', 'writeSize', 'writeDigest', 'readCreditBytes', 'writeCreditBytes', 'idleMs'])) return null;
  if (typeof request.clientId !== 'string' || !NAME.test(request.clientId)) return null;
  if (typeof request.objectId !== 'string' || !OBJECT_ID.test(request.objectId)) return null;
  if (!isSafeInt(request.version, 1) || !isSafeInt(request.readOffset)) return null;
  if (request.readSize !== null && !isSafeInt(request.readSize, 1)) return null;
  if (!maybeDigest(request.readDigest)) return null;
  if (request.writeSize !== null && !isSafeInt(request.writeSize, 1)) return null;
  if (!maybeDigest(request.writeDigest)) return null;
  if (!isSafeInt(request.readCreditBytes, 1) || !isSafeInt(request.writeCreditBytes, 1) || !isSafeInt(request.idleMs, 1)) return null;
  return Object.freeze({
    ...base, kind: 'stream.open-duplex',
    request: Object.freeze({
      clientId: request.clientId, objectId: request.objectId, version: request.version,
      readOffset: request.readOffset, readSize: request.readSize,
      readDigest: request.readDigest as `sha256:${string}` | null,
      writeSize: request.writeSize, writeDigest: request.writeDigest as `sha256:${string}` | null,
      readCreditBytes: request.readCreditBytes, writeCreditBytes: request.writeCreditBytes, idleMs: request.idleMs,
    }),
  });
}

export function encodeStreamFinishRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelStreamFinishRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'stream.finish', target, caller, callerScope, purpose, contract, request });
}

export function decodeStreamFinishRequest(payload: unknown): ChannelStreamFinishRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'stream.finish') return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['transferId', 'size', 'digest'])) return null;
  if (typeof request.transferId !== 'string' || !NAME.test(request.transferId)) return null;
  if (!isSafeInt(request.size, 1)) return null;
  if (typeof request.digest !== 'string' || !DIGEST.test(request.digest)) return null;
  return Object.freeze({
    ...base, kind: 'stream.finish',
    request: Object.freeze({ transferId: request.transferId, size: request.size, digest: request.digest as `sha256:${string}` }),
  });
}

export function encodeEventSubscribeRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelEventSubscribeRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'event.subscribe', target, caller, callerScope, purpose, contract, request });
}

export function decodeEventSubscribeRequest(payload: unknown): ChannelEventSubscribeRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'event.subscribe') return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['clientId', 'delivery', 'consumerId', 'from'])) return null;
  if (typeof request.clientId !== 'string' || !NAME.test(request.clientId)) return null;
  if (request.delivery !== 'transient' && request.delivery !== 'reliable') return null;
  if (typeof request.consumerId !== 'string' || !NAME.test(request.consumerId)) return null;
  if (request.from !== null && !isSafeInt(request.from, 1)) return null;
  return Object.freeze({
    ...base, kind: 'event.subscribe',
    request: Object.freeze({ clientId: request.clientId, delivery: request.delivery, consumerId: request.consumerId, from: request.from }),
  });
}

export function encodeEventAckRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelEventAckRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'event.ack', target, caller, callerScope, purpose, contract, request });
}

export function decodeEventAckRequest(payload: unknown): ChannelEventAckRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'event.ack') return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['subscriptionId', 'sequence'])) return null;
  if (typeof request.subscriptionId !== 'string' || !NAME.test(request.subscriptionId)) return null;
  if (!isSafeInt(request.sequence, 1)) return null;
  return Object.freeze({ ...base, kind: 'event.ack', request: Object.freeze({ subscriptionId: request.subscriptionId, sequence: request.sequence }) });
}

export function encodeSnapshotDescribeRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelSnapshotDescribeRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'snapshot.describe', target, caller, callerScope, purpose, contract, request });
}

export function decodeSnapshotDescribeRequest(payload: unknown): ChannelSnapshotDescribeRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'snapshot.describe') return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['version'])) return null;
  if (request.version !== null && !isSafeInt(request.version, 1)) return null;
  return Object.freeze({ ...base, kind: 'snapshot.describe', request: Object.freeze({ version: request.version }) });
}

export function encodeSnapshotOpenRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelSnapshotOpenRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'snapshot.open', target, caller, callerScope, purpose, contract, request });
}

export function decodeSnapshotOpenRequest(payload: unknown): ChannelSnapshotOpenRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'snapshot.open') return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['version'])) return null;
  if (request.version !== null && !isSafeInt(request.version, 1)) return null;
  return Object.freeze({ ...base, kind: 'snapshot.open', request: Object.freeze({ version: request.version }) });
}

export function encodeSnapshotChunkRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelSnapshotChunkRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'snapshot.chunk', target, caller, callerScope, purpose, contract, request });
}

export function decodeSnapshotChunkRequest(payload: unknown): ChannelSnapshotChunkRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'snapshot.chunk') return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['sessionId', 'offset', 'length'])) return null;
  if (typeof request.sessionId !== 'string' || !NAME.test(request.sessionId)) return null;
  if (!isSafeInt(request.offset) || !isSafeInt(request.length, 1) || request.length > CHANNEL_MAX_CHUNK_BYTES) return null;
  return Object.freeze({
    ...base, kind: 'snapshot.chunk',
    request: Object.freeze({ sessionId: request.sessionId, offset: request.offset, length: request.length }),
  });
}

export function encodeSnapshotReleaseRequest(target: PluginChannelTarget, caller: string, callerScope: string, contract: string, request: ChannelSnapshotReleaseRequest['request'], purpose: RpcCallPurpose = 'background'): RpcJson {
  return encodePayload({ v: PLUGIN_CHANNEL_VERSION, kind: 'snapshot.release', target, caller, callerScope, purpose, contract, request });
}

export function decodeSnapshotReleaseRequest(payload: unknown): ChannelSnapshotReleaseRequest | null {
  const record = decodePayload(payload);
  if (record === null) return null;
  const base = laneEnvelope(record);
  if (base === null || record.kind !== 'snapshot.release') return null;
  const request = record.request;
  if (!isPlainRecord(request) || !exactKeys(request, ['sessionId'])) return null;
  if (typeof request.sessionId !== 'string' || !NAME.test(request.sessionId)) return null;
  return Object.freeze({ ...base, kind: 'snapshot.release', request: Object.freeze({ sessionId: request.sessionId }) });
}

/* -------------------------------------------------------------------------- */
/* Emit frame payloads                                                         */
/* -------------------------------------------------------------------------- */

export interface ChannelStreamChunkEmit {
  readonly kind: 'stream.chunk';
  readonly transferId: string;
  readonly offset: number;
  readonly last: boolean;
}

export interface ChannelStreamDataEmit {
  readonly kind: 'stream.data';
  readonly transferId: string;
  readonly offset: number;
  readonly last: boolean;
}

/**
 * Consumer half-close of the READ direction of a duplex session: it will accept
 * no further read chunks (and stops granting read credit), while the WRITE
 * direction of the same session keeps running.
 */
export interface ChannelStreamEndReadEmit {
  readonly kind: 'stream.end-read';
  readonly transferId: string;
}

/**
 * Provider -> consumer end of the READ direction: the producer has emitted every
 * byte of this immutable version (including a zero-byte body). It is ordered on
 * the same link AFTER the final data frame, so the receiver can settle the read
 * with a real protocol end instead of a timing guess.
 */
export interface ChannelStreamEndEmit {
  readonly kind: 'stream.end';
  readonly transferId: string;
}

export interface ChannelStreamCreditEmit {
  readonly kind: 'stream.credit';
  readonly transferId: string;
  /**
   * Which window this grant governs, so one duplex session can carry two fully
   * independent credit windows on the SAME transfer id:
   * - `read`:  the provider -> consumer flow (granted by the consumer);
   * - `write`: the consumer -> provider flow (granted by the provider).
   */
  readonly direction: 'read' | 'write';
  /**
   * ABSOLUTE credit window: the total byte count the receiver currently allows
   * from offset 0. Absolute (never a delta) because a window is idempotent: a
   * retried or repeated grant can never double-count, and a lost frame heals as
   * soon as the sender re-emits the current window.
   */
  readonly window: number;
}

export interface ChannelEventNotifyEmit {
  readonly kind: 'event.notify';
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly delivery: 'transient' | 'reliable';
}

/**
 * Provider -> consumer reliable-event gap/failure notice: the ordered delivery
 * can no longer continue (a refused emit while disconnected, a bounded queue
 * overflow, an unreadable replay). The consumer must observe a REAL failure
 * instead of a silent close, and re-subscribe from its durable checkpoint.
 */
export interface ChannelEventGapEmit {
  readonly kind: 'event.gap';
  readonly subscriptionId: string;
  readonly code: PluginChannelErrorCode;
}

export type ChannelEmitPayload = ChannelStreamChunkEmit | ChannelStreamDataEmit | ChannelStreamCreditEmit | ChannelStreamEndReadEmit | ChannelStreamEndEmit | ChannelEventNotifyEmit | ChannelEventGapEmit;

export function encodeChannelEmit(payload: ChannelEmitPayload): RpcJson {
  return encodePayload(payload);
}

export function decodeChannelEmit(payload: unknown): ChannelEmitPayload | null {
  const record = decodePayload(payload);
  if (record === null || typeof record.kind !== 'string') return null;
  switch (record.kind) {
    case 'stream.chunk':
    case 'stream.data': {
      if (!exactKeys(record, ['kind', 'transferId', 'offset', 'last'])) return null;
      if (typeof record.transferId !== 'string' || !NAME.test(record.transferId)) return null;
      if (!isSafeInt(record.offset) || typeof record.last !== 'boolean') return null;
      return Object.freeze({
        kind: record.kind as 'stream.chunk' | 'stream.data',
        transferId: record.transferId, offset: record.offset, last: record.last as boolean,
      });
    }
    case 'stream.credit': {
      if (!exactKeys(record, ['kind', 'transferId', 'direction', 'window'])) return null;
      if (typeof record.transferId !== 'string' || !NAME.test(record.transferId)) return null;
      if (record.direction !== 'read' && record.direction !== 'write') return null;
      if (!isSafeInt(record.window)) return null;
      return Object.freeze({
        kind: 'stream.credit', transferId: record.transferId,
        direction: record.direction as 'read' | 'write', window: record.window,
      });
    }
    case 'stream.end-read': {
      if (!exactKeys(record, ['kind', 'transferId'])) return null;
      if (typeof record.transferId !== 'string' || !NAME.test(record.transferId)) return null;
      return Object.freeze({ kind: 'stream.end-read', transferId: record.transferId });
    }
    case 'stream.end': {
      if (!exactKeys(record, ['kind', 'transferId'])) return null;
      if (typeof record.transferId !== 'string' || !NAME.test(record.transferId)) return null;
      return Object.freeze({ kind: 'stream.end', transferId: record.transferId });
    }
    case 'event.notify': {
      if (!exactKeys(record, ['kind', 'subscriptionId', 'sequence', 'eventId', 'delivery'])) return null;
      if (typeof record.subscriptionId !== 'string' || !NAME.test(record.subscriptionId)) return null;
      // Transient notifications carry sequence 0 (they are not an ordered log).
      if (!isSafeInt(record.sequence, 0)) return null;
      if (typeof record.eventId !== 'string' || !EVENT_ID.test(record.eventId)) return null;
      if (record.delivery !== 'transient' && record.delivery !== 'reliable') return null;
      return Object.freeze({
        kind: 'event.notify', subscriptionId: record.subscriptionId, sequence: record.sequence,
        eventId: record.eventId, delivery: record.delivery,
      });
    }
    case 'event.gap': {
      if (!exactKeys(record, ['kind', 'subscriptionId', 'code'])) return null;
      if (typeof record.subscriptionId !== 'string' || !NAME.test(record.subscriptionId)) return null;
      if (typeof record.code !== 'string' || !ERROR_CODES.has(record.code as PluginChannelErrorCode)) return null;
      return Object.freeze({
        kind: 'event.gap', subscriptionId: record.subscriptionId, code: record.code as PluginChannelErrorCode,
      });
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Result payloads                                                             */
/* -------------------------------------------------------------------------- */

export interface ChannelStreamOpenResult {
  readonly transferId: string;
  readonly size: number | null;
  readonly digest: `sha256:${string}` | null;
  readonly frameBytes: number;
  readonly creditBytes: number;
}

export function decodeStreamOpenResult(result: PluginChannelResult): ChannelStreamOpenResult | null {
  if (!result.ok) return null;
  const value = result.value;
  if (!exactKeys(value, ['transferId', 'size', 'digest', 'frameBytes', 'creditBytes'])) return null;
  if (typeof value.transferId !== 'string' || !NAME.test(value.transferId)) return null;
  if (value.size !== null && !isSafeInt(value.size, 1)) return null;
  if (!maybeDigest(value.digest)) return null;
  if (!isSafeInt(value.frameBytes, 1) || !isSafeInt(value.creditBytes, 1)) return null;
  return Object.freeze({
    transferId: value.transferId, size: value.size,
    digest: value.digest as `sha256:${string}` | null,
    frameBytes: value.frameBytes, creditBytes: value.creditBytes,
  });
}

export interface ChannelStreamOpenDuplexResult {
  readonly transferId: string;
  readonly readSize: number | null;
  readonly readDigest: `sha256:${string}` | null;
  readonly readFrameBytes: number;
  readonly readCreditBytes: number;
  readonly writeCreditBytes: number;
}

export function decodeStreamOpenDuplexResult(result: PluginChannelResult): ChannelStreamOpenDuplexResult | null {
  if (!result.ok) return null;
  const value = result.value;
  if (!exactKeys(value, ['transferId', 'readSize', 'readDigest', 'readFrameBytes', 'readCreditBytes', 'writeCreditBytes'])) return null;
  if (typeof value.transferId !== 'string' || !NAME.test(value.transferId)) return null;
  if (value.readSize !== null && !isSafeInt(value.readSize, 1)) return null;
  if (!maybeDigest(value.readDigest)) return null;
  if (!isSafeInt(value.readFrameBytes, 1) || !isSafeInt(value.readCreditBytes, 1) || !isSafeInt(value.writeCreditBytes, 1)) return null;
  return Object.freeze({
    transferId: value.transferId, readSize: value.readSize,
    readDigest: value.readDigest as `sha256:${string}` | null,
    readFrameBytes: value.readFrameBytes, readCreditBytes: value.readCreditBytes, writeCreditBytes: value.writeCreditBytes,
  });
}

export interface ChannelSnapshotOpenResult {
  readonly sessionId: string;
  readonly descriptor: ChannelSnapshotDescriptor;
}

export function decodeSnapshotOpenResult(result: PluginChannelResult): ChannelSnapshotOpenResult | null {
  if (!result.ok) return null;
  const value = result.value;
  if (!exactKeys(value, ['sessionId', 'descriptor'])) return null;
  if (typeof value.sessionId !== 'string' || !NAME.test(value.sessionId)) return null;
  if (!isPlainRecord(value.descriptor)) return null;
  const descriptor = decodeDescriptorRecord(value.descriptor);
  if (descriptor === null) return null;
  return Object.freeze({ sessionId: value.sessionId, descriptor });
}

function decodeDescriptorRecord(value: Record<string, unknown>): ChannelSnapshotDescriptor | null {
  if (!exactKeys(value, ['owner', 'epoch', 'version', 'schemaVersion', 'digest', 'size', 'chunkBytes'])) return null;
  if (typeof value.owner !== 'string' || !NAME.test(value.owner)) return null;
  if (!isSafeInt(value.epoch, 1) || !isSafeInt(value.version, 1) || !isSafeInt(value.schemaVersion, 1)) return null;
  if (typeof value.digest !== 'string' || !DIGEST.test(value.digest)) return null;
  if (!isSafeInt(value.size, 1) || !isSafeInt(value.chunkBytes, 1) || value.chunkBytes > CHANNEL_MAX_CHUNK_BYTES) return null;
  return Object.freeze({
    owner: value.owner, epoch: value.epoch, version: value.version, schemaVersion: value.schemaVersion,
    digest: value.digest as `sha256:${string}`, size: value.size, chunkBytes: value.chunkBytes,
  });
}

export interface ChannelEventSubscribeResult {
  readonly subscriptionId: string;
  readonly delivery: 'transient' | 'reliable';
  readonly fromSequence: number;
  readonly oldestSequence: number | null;
  readonly prunedThrough: number;
}

export function decodeEventSubscribeResult(result: PluginChannelResult): ChannelEventSubscribeResult | null {
  if (!result.ok) return null;
  const value = result.value;
  if (!exactKeys(value, ['subscriptionId', 'delivery', 'fromSequence', 'oldestSequence', 'prunedThrough'])) return null;
  if (typeof value.subscriptionId !== 'string' || !NAME.test(value.subscriptionId)) return null;
  if (value.delivery !== 'transient' && value.delivery !== 'reliable') return null;
  if (!isSafeInt(value.fromSequence, 1)) return null;
  if (value.oldestSequence !== null && !isSafeInt(value.oldestSequence, 1)) return null;
  if (!isSafeInt(value.prunedThrough)) return null;
  return Object.freeze({
    subscriptionId: value.subscriptionId, delivery: value.delivery,
    fromSequence: value.fromSequence, oldestSequence: value.oldestSequence, prunedThrough: value.prunedThrough,
  });
}

export interface ChannelEventAckResult {
  readonly acked: number;
}

export function decodeEventAckResult(result: PluginChannelResult): ChannelEventAckResult | null {
  if (!result.ok) return null;
  const value = result.value;
  if (!exactKeys(value, ['acked'])) return null;
  if (!isSafeInt(value.acked, 1)) return null;
  return Object.freeze({ acked: value.acked });
}

export interface ChannelSnapshotDescriptor {
  readonly owner: string;
  readonly epoch: number;
  readonly version: number;
  readonly schemaVersion: number;
  readonly digest: `sha256:${string}`;
  readonly size: number;
  readonly chunkBytes: number;
}

export function decodeSnapshotDescriptor(result: PluginChannelResult): ChannelSnapshotDescriptor | null {
  if (!result.ok) return null;
  return decodeDescriptorRecord(result.value);
}

/** Encoding helpers for the lane success/error bodies, kept in one place. */
export function streamOpenResultBody(result: ChannelStreamOpenResult): Uint8Array {
  return encodeChannelResult({ ok: true, ...result });
}

export function streamOpenDuplexResultBody(result: ChannelStreamOpenDuplexResult): Uint8Array {
  return encodeChannelResult({ ok: true, ...result });
}

export function snapshotOpenResultBody(result: ChannelSnapshotOpenResult): Uint8Array {
  return encodeChannelResult({ ok: true, sessionId: result.sessionId, descriptor: { ...result.descriptor } });
}

export function eventSubscribeResultBody(result: ChannelEventSubscribeResult): Uint8Array {
  return encodeChannelResult({ ok: true, ...result });
}

export function eventAckResultBody(result: ChannelEventAckResult): Uint8Array {
  return encodeChannelResult({ ok: true, ...result });
}

export function successBody(value: Record<string, unknown> = {}): Uint8Array {
  return encodeChannelResult({ ok: true, ...value });
}

export function errorBody(code: PluginChannelErrorCode, detail?: Record<string, unknown>): Uint8Array {
  return detail === undefined ? encodeChannelResult({ ok: false, code }) : encodeChannelResult({ ok: false, code, detail });
}
