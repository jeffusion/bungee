/**
 * Host communication lane engines (P5): stream (read + write) / event / snapshot
 * over one authenticated peer link, or in-process for a same-process provider.
 *
 * This module is the transport-and-semantics layer only. It never decides which
 * plugin may speak: every inbound lane frame is authorized by the host adapter
 * (`channels.ts`) through {@link PluginPeerChannelHubOptions.authorizeInbound},
 * and every provider registration is created by that adapter. The hub owns:
 *
 * - bounded state machines for each lane, always failing closed with a fixed
 *   {@link PluginChannelErrorCode};
 * - real backpressure (credit windows for read and write streams, bounded
 *   per-consumer windows for events, bounded chunk call sizes for snapshots);
 * - honest terminal states: `complete | failed | cancelled | truncated` — a
 *   written buffer, a resolved result producer, or a resolved terminal is never
 *   treated as proof that the peer consumed the bytes;
 * - provider-side Host leases: admitting a lane request takes the exact providing
 *   plugin's Host lease and holds it until the real source/sink task settles, so
 *   owner disposal can never race a live provider task.
 *
 * Reuse, not a second framework: requests ride the link's existing
 * authentication/correlation/deadline/cancellation/ACK machinery
 * (`requestOnLane`), and bulk bytes ride `emitLane` frames or bounded chunk
 * responses. A same-process route uses the in-process loopback port, so local and
 * remote transfers share exactly one implementation and one set of limits.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DurableMutation } from '../plugin-durable-state';
import type { PluginServiceProcess } from './contracts';
import type { PluginPeerLaneEmit, PluginPeerLaneHandler, PluginPeerRpcRequestExecution } from './peer-rpc-link';
import type { RpcCallPurpose, RpcJson } from './wire-contract';
import {
  CHANNEL_MAX_CHUNK_BYTES,
  decodeChannelEmit,
  decodeChannelResult,
  decodeEventAckRequest,
  decodeEventAckResult,
  decodeEventSubscribeRequest,
  decodeEventSubscribeResult,
  decodeSnapshotChunkRequest,
  decodeSnapshotDescriptor,
  decodeSnapshotDescribeRequest,
  decodeSnapshotOpenRequest,
  decodeSnapshotOpenResult,
  decodeSnapshotReleaseRequest,
  decodeStreamFinishRequest,
  decodeStreamOpenDuplexRequest,
  decodeStreamOpenDuplexResult,
  decodeStreamOpenRequest,
  decodeStreamOpenResult,
  encodeChannelEmit,
  encodeEventAckRequest,
  encodeEventSubscribeRequest,
  encodeSnapshotChunkRequest,
  encodeSnapshotDescribeRequest,
  encodeSnapshotOpenRequest,
  encodeSnapshotReleaseRequest,
  encodeStreamFinishRequest,
  encodeStreamOpenDuplexRequest,
  encodeStreamOpenRequest,
  errorBody,
  eventAckResultBody,
  eventSubscribeResultBody,
  snapshotOpenResultBody,
  streamOpenDuplexResultBody,
  streamOpenResultBody,
  successBody,
  type ChannelSnapshotDescriptor,
  type PluginChannelErrorCode,
  type PluginChannelLane,
  type PluginChannelLinkPort,
  type PluginChannelResult,
  type PluginChannelTarget,
} from './peer-channel-protocol';

/* -------------------------------------------------------------------------- */
/* Limits (bounded by contract, never by unbounded queues)                     */
/* -------------------------------------------------------------------------- */

export const CHANNEL_MAX_ACTIVE_TRANSFERS = 32;
export const CHANNEL_MAX_SUBSCRIPTIONS = 64;
/** Per-transfer buffered bytes a consumer may hold before it must consume. */
export const CHANNEL_MAX_TRANSFER_BUFFER_BYTES = 4 * CHANNEL_MAX_CHUNK_BYTES;
/** Process-wide buffered bytes across every outbound transfer. */
export const CHANNEL_MAX_TOTAL_BUFFER_BYTES = 16 * CHANNEL_MAX_CHUNK_BYTES;
/** Absolute byte ceiling for one stream object / snapshot body. */
export const CHANNEL_STREAM_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Outstanding credit a receiver may grant for one transfer. */
export const CHANNEL_STREAM_MAX_CREDIT_BYTES = 8 * CHANNEL_MAX_CHUNK_BYTES;
/** A lost credit window heals: its owner re-announces it this often. */
export const CHANNEL_CREDIT_HEARTBEAT_MS = 1_000;
export const CHANNEL_STREAM_DEFAULT_CREDIT_BYTES = 4 * CHANNEL_MAX_CHUNK_BYTES;
export const CHANNEL_STREAM_DEFAULT_IDLE_MS = 30_000;
export const CHANNEL_STREAM_DEFAULT_DEADLINE_MS = 120_000;
export const CHANNEL_STREAM_EMIT_RETRIES = 256;
/** Bounded wait for an in-flight sink write to settle after cancellation. */
export const CHANNEL_STREAM_ABORT_DRAIN_MS = 30_000;
/**
 * Grace for already-in-flight duplex read frames after the peer session ends.
 * Frames are delivered in order within milliseconds of being emitted, so this
 * only has to cover a queue that is already on the wire — never a long wait.
 */
export const CHANNEL_DUPLEX_TERMINAL_GRACE_MS = 1_000;
/** Credit frames must never be dropped: a much longer bounded retry window. */
export const CHANNEL_STREAM_CREDIT_RETRIES = 512;
export const CHANNEL_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const CHANNEL_SNAPSHOT_CHUNK_CONCURRENCY = 4;
/** A pinned snapshot read session is released after this idle bound. */
export const CHANNEL_SNAPSHOT_SESSION_IDLE_MS = 60_000;
/** Concurrent pinned snapshot read sessions per hub. */
export const CHANNEL_SNAPSHOT_MAX_SESSIONS = 32;
export const CHANNEL_EVENT_QUEUE_MAX = 256;
export const CHANNEL_EVENT_REPLAY_BATCH = 64;
export const CHANNEL_EVENT_MAX_PAYLOAD_BYTES = 60 * 1024;
export const CHANNEL_SNAPSHOT_CHUNK_BYTES = CHANNEL_MAX_CHUNK_BYTES;

const EMPTY = new Uint8Array(0);

/* -------------------------------------------------------------------------- */
/* Provider implementation contracts                                           */
/* -------------------------------------------------------------------------- */

export interface PluginChannelStreamSource {
  readonly size: number;
  readonly digest: `sha256:${string}`;
  /** Reads `length` bytes at `offset` of this immutable version. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface PluginChannelStreamSink {
  /** Consumes one chunk at `offset`; resolves once the sink accepted it. */
  write(offset: number, bytes: Uint8Array): Promise<void>;
  /** Final commit of the complete body; must verify the size/digest contract. */
  finish(size: number, digest: `sha256:${string}`): Promise<void>;
  /** Reclaims an unfinished transfer; never called after `finish` resolved. */
  abort?(reason: 'cancelled' | 'failed' | 'closed'): void;
}

export interface PluginChannelStreamProvider {
  /** Read side: the immutable version to serve, or `null` when unavailable. */
  open?(input: { readonly caller: string; readonly callerScope: string; readonly objectId: string; readonly version: number }): PluginChannelStreamSource | null;
  /** Write side: the sink that will receive the consumer's bytes, or `null`. */
  accept?(input: { readonly caller: string; readonly callerScope: string; readonly objectId: string; readonly version: number }): PluginChannelStreamSink | null;
  /**
   * Duplex session: ONE negotiation for both directions over one transfer id and
   * one shared terminal. A read-only or write-only side is expressed by omitting
   * the other half; returning `null` refuses the whole session.
   */
  duplex?(input: { readonly caller: string; readonly callerScope: string; readonly objectId: string; readonly version: number }): {
    readonly source?: PluginChannelStreamSource;
    readonly sink?: PluginChannelStreamSink;
  } | null;
}

export interface PluginChannelSnapshotSource {
  readonly descriptor: ChannelSnapshotDescriptor;
  read(offset: number, length: number): Promise<Uint8Array>;
  /**
   * Retains exactly this immutable version for one whole-body read. Called by the
   * hub when it pins the source for a session, before any chunk is read.
   */
  retain?(): void | Promise<void>;
  /**
   * Releases the provider-side retention of exactly this immutable version. The
   * hub calls it once when the read session (which pinned this source for the
   * WHOLE body) ends; a bound store uses it to keep an in-use version alive.
   */
  release?(): void | Promise<void>;
}

export interface PluginChannelSnapshotProvider {
  /** Current immutable descriptor + reader, or `null` when no valid snapshot exists. */
  current(): PluginChannelSnapshotSource | null | Promise<PluginChannelSnapshotSource | null>;
  /** One explicitly named still-retained version, or `null` once it was evicted. */
  version(version: number): PluginChannelSnapshotSource | null | Promise<PluginChannelSnapshotSource | null>;
}

export interface PluginChannelEventEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly payload: Uint8Array;
}

export interface PluginChannelEventAck {
  /** The consumer's durable checkpoint after this ack (never lower than before). */
  readonly acked: number;
}

export interface PluginChannelReliableEventLog {
  /** Oldest still-replayable sequence, or `null` when the log holds no events. */
  oldestSequence(): number | null | Promise<number | null>;
  latestSequence(): number | Promise<number>;
  /** Highest sequence already pruned; a `from` at or below it is an explicit gap. */
  prunedThrough(): number | Promise<number>;
  /** Bounded replay from `from`; a contiguous run, never sparse. */
  list(fromSequence: number, limit: number): Promise<readonly PluginChannelEventEntry[]>;
  /** Highest durable checkpoint for this consumer (0 when none). */
  checkpoint(consumerId: string): number | Promise<number>;
  /** Monotonic durable ack: an older sequence never lowers the stored checkpoint. */
  ack(consumerId: string, sequence: number): PluginChannelEventAck | Promise<PluginChannelEventAck>;
  /** Durable append; the returned sequence and event id are stable and unique. */
  append(payload: Uint8Array): { readonly sequence: number; readonly eventId: string } | Promise<{readonly sequence:number;readonly eventId:string}>;
  appendWithState?(payload:Uint8Array,mutations:readonly DurableMutation[]):Promise<{readonly sequence:number;readonly eventId:string}>;

}

export interface PluginChannelEventProvider {
  readonly delivery: 'transient' | 'reliable';
  /** Present exactly for a reliable topic; absence is refused, never guessed. */
  readonly log?: PluginChannelReliableEventLog;
}

export interface PluginChannelEventDelivery {
  readonly sequence: number;
  readonly eventId: string;
  readonly payload: Uint8Array;
  readonly delivery: 'transient' | 'reliable';
}

/* -------------------------------------------------------------------------- */
/* Hub                                                                         */
/* -------------------------------------------------------------------------- */

export interface PluginChannelRegistrationInput {
  readonly lane: PluginChannelLane;
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly process: PluginServiceProcess;
  /** Canonical hash of the provider's declared lane contract. */
  readonly contract: string;
}

interface Registration {
  readonly key: string;
  readonly lane: PluginChannelLane;
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly process: PluginServiceProcess;
  readonly contract: string;
  readonly stream?: PluginChannelStreamProvider;
  readonly snapshot?: PluginChannelSnapshotProvider;
  readonly event?: PluginChannelEventProvider;
  ready: boolean;
  retiring: boolean;
}

export interface PluginChannelProviderHandle {
  markReady(): void;
  retire(): void;
  dispose(): void;
}

export type PluginChannelRouteResolution =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly link: PluginChannelLinkPort }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'unavailable' };

/** Host-minted invocation context for one provider-side lane task. */
export interface PluginChannelProviderContext {
  readonly purpose: RpcCallPurpose;
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
}

export interface PluginPeerChannelHubOptions {
  readonly process: PluginServiceProcess;
  /** The only peer process this hub can reach over a link. */
  readonly peerProcess: PluginServiceProcess;
  /**
   * Host-owned route resolution for one target. The hub prefers a local
   * registration when the host says so, otherwise exactly one remote link, and
   * reports `ambiguous`/`unavailable` instead of guessing.
   */
  readonly resolveRoute: (target: PluginChannelTarget, lane: PluginChannelLane) => PluginChannelRouteResolution;
  /** Trusted host decision for one inbound lane request. */
  readonly authorizeInbound: (request: {
    readonly lane: PluginChannelLane;
    readonly target: PluginChannelTarget;
    readonly caller: string;
    readonly callerScope: string;
    readonly providerProcess: PluginServiceProcess;
    readonly local: boolean;
    readonly link: PluginChannelLinkPort | null;
    /**
     * `true` for a frame that belongs to an ALREADY-accepted transfer,
     * subscription or snapshot session (finish/ACK/chunk/release), `false` for a
     * NEW open/subscribe/describe. A draining peer may still admit continuations
     * by exact identity while it refuses every new lane request.
     */
    readonly continuation: boolean;
  }) => boolean;
  /**
   * Host-only provider lease for the exact providing plugin; the hub holds it
   * from admission until the real provider task settles. `null` refuses the work.
   * The host-minted invocation context (purpose + absolute deadline + signal)
   * rides along, so a peer-originated lane task keeps the caller's real purpose
   * and cancellation instead of being downgraded to a background task.
   */
  readonly beginProviderOperation?: (plugin: string, context: PluginChannelProviderContext) => (() => void) | null;
  readonly onDiagnostic?: (event: { readonly kind: string; readonly lane: PluginChannelLane; readonly code: PluginChannelErrorCode | 'invalid' }) => void;
}

function callTargetKey(lane: PluginChannelLane, target: PluginChannelTarget): string {
  return [lane, target.provider, target.service, String(target.major)].join('\0');
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  /** True once settled; lets callers avoid acting on an already-finished transfer. */
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let settleResolve!: (value: T) => void;
  let settleReject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((accept, decline) => { settleResolve = accept; settleReject = decline; });
  void promise.catch(() => undefined);
  return {
    promise,
    get settled() { return settled; },
    resolve(value) { if (settled) return; settled = true; settleResolve(value); },
    reject(error) { if (settled) return; settled = true; settleReject(error); },
  };
}

function decodeResultOrError(bytes: Uint8Array): PluginChannelResult {
  return decodeChannelResult(bytes) ?? Object.freeze({ ok: false as const, code: 'failed' as const });
}

function safeSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

class ChannelError extends Error {
  readonly name = 'ChannelError';
  constructor(readonly code: PluginChannelErrorCode, message: string) {
    super(message);
  }
}

/* Stream state ------------------------------------------------------------- */

interface StreamInbound {
  readonly link: PluginChannelLinkPort;
  readonly providerKey: string;
  readonly transferId: string;
  readonly caller: string;
  readonly callerScope: string;
  readonly deadlineAt: number;
  readonly frameBytes: number;
  readonly idleMs: number;
  readonly release: (() => void) | null;
  /** Duplex: abort the sibling write half when this read half fails. */
  readonly abortSibling?: (reason: 'cancelled' | 'failed') => void;
  /** Absolute credit window: the highest byte offset this producer may send to. */
  window: number;
  creditWaiters: Array<() => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  aborted: boolean;
  finished: boolean;
}

interface StreamOutbound {
  readonly link: PluginChannelLinkPort;
  readonly providerKey: string;
  readonly transferId: string;
  readonly deadlineAt: number;
  readonly idleMs: number;
  readonly baseOffset: number;
  /** Adopted from the provider's open result when the caller left it open. */
  expectedSize: number | null;
  expectedDigest: `sha256:${string}` | null;
  readonly hash: ReturnType<typeof createHash> | null;
  readonly chunks: Uint8Array[];
  queuedBytes: number;
  receivedBytes: number;
  /** Bytes the caller already consumed (the window base). */
  consumedBytes: number;
  /** Allowance granted but not yet consumed. */
  slack: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  lastSeen: boolean;
  /** The consumer half-closed this read direction (duplex): iteration must end. */
  halfClosed: boolean;
  completed: boolean;
  failure: Error | null;
  waiters: Array<() => void>;
  readonly completion: Deferred<{ readonly bytes: number; readonly digest: `sha256:${string}` }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  readonly controller: AbortController;
  /** Released when the transfer settles (Host owner lease, if any). */
  readonly release: (() => void) | null;
  /** Present when this read flow is one half of a duplex session. */
  duplex?: DuplexOutbound;
}

interface WriteInbound {
  readonly link: PluginChannelLinkPort;
  readonly providerKey: string;
  readonly transferId: string;
  readonly caller: string;
  readonly callerScope: string;
  readonly deadlineAt: number;
  readonly idleMs: number;
  readonly release: (() => void) | null;
  readonly expectedSize: number | null;
  readonly expectedDigest: `sha256:${string}` | null;
  readonly hash: ReturnType<typeof createHash>;
  readonly sink: PluginChannelStreamSink;
  readonly finishedWait: Deferred<void>;
  /** Duplex: abort the sibling read half when this write half fails. */
  readonly abortSibling?: (reason: 'cancelled' | 'failed') => void;
  /** Serializes sink.write calls: one sink is never written concurrently. */
  writeTail: Promise<void>;
  offset: number;
  /** Allowance the sink already accepted but the consumer has not used yet. */
  slack: number;
  /** Highest absolute window announced to the consumer. */
  window: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
  aborting: boolean;
  /** A finish request is committing: late data frames are refused, not written. */
  finishing: boolean;
}

interface WriteOutbound {
  readonly link: PluginChannelLinkPort;
  readonly transferId: string;
  readonly deadlineAt: number;
  readonly idleMs: number;
  readonly purpose: RpcCallPurpose;
  readonly controller: AbortController;
  readonly completion: Deferred<{ readonly bytes: number; readonly digest: `sha256:${string}` }>;
  /** Absolute window announced by the provider: this consumer may send up to here. */
  window: number;
  hash: ReturnType<typeof createHash>;
  bytes: number;
  creditWaiters: Array<() => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  failure: Error | null;
  /** A finish request is in flight: its result, not the terminal, settles this. */
  finishing: boolean;
  writeTail: Promise<void>;
  queuedWriteBytes: number;
  release: (() => void) | null;
  /** Present when this write flow is one half of a duplex session. */
  duplex?: DuplexOutbound;
}

/**
 * One consumer-side duplex session: the read and write flows of the SAME transfer
 * id, with the shared completion that settles only when both real halves have
 * settled (a half-closed direction contributes `null`).
 */
interface DuplexOutbound {
  readonly transferId: string;
  readonly read: StreamOutbound;
  readonly write: WriteOutbound;
  readonly completion: Deferred<PluginChannelDuplexResult>;
  readSettled: boolean;
  writeSettled: boolean;
  readValue: { readonly bytes: number; readonly digest: `sha256:${string}` } | null;
  writeValue: { readonly bytes: number; readonly digest: `sha256:${string}` } | null;
  failure: Error | null;
  settled: boolean;
  /** True once the consumer half-closed the read direction (a legal end, not a failure). */
  readHalfClosed: boolean;
  /** The one Host operation lease for the whole session, released on drain. */
  readonly release: (() => void) | null;
  /** Session-level request controller (aborted only when the whole session ends). */
  readonly controller: AbortController;
}

/** One provider-side pinned snapshot read session (whole-body retention). */
interface SnapshotSession {
  readonly link: PluginChannelLinkPort;
  readonly providerKey: string;
  readonly sessionId: string;
  readonly caller: string;
  readonly callerScope: string;
  readonly deadlineAt: number;
  readonly source: PluginChannelSnapshotSource;
  readonly release: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** Real `source.read` calls still in flight; release waits for these. */
  activeReads: number;
  released: boolean;
  releaseTask?: Promise<void>;
  /** Callers of a release waiting for every active read to drain. */
  drainWaiters: Array<() => void>;
}

/* Event state -------------------------------------------------------------- */

interface QueuedEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly payload: Uint8Array;
}

interface EventSubscription {
  readonly link: PluginChannelLinkPort;
  readonly providerKey: string;
  readonly subscriptionId: string;
  readonly caller: string;
  readonly callerScope: string;
  readonly consumerId: string;
  readonly delivery: 'transient' | 'reliable';
  readonly deadlineAt: number;
  readonly release: (() => void) | null;
  pending: QueuedEvent[];
  dropped: number;
  lastAcked: number;
  /** Highest CONTIGUOUS sequence delivered (the true ACK ceiling). */
  lastDelivered: number;
  /** One real task reads the durable log for both history and live delivery. */
  replaying: boolean;
  closed: boolean;
  /** A reliable delivery gap that must be signalled once the transport is up. */
  gapPending: boolean;
  gapCode: PluginChannelErrorCode | null;
  waiters: Array<() => void>;
  workWaiters: Array<() => void>;
  wakeVersion: number;
}

interface EventOutbound {
  readonly link: PluginChannelLinkPort;
  readonly subscriptionId: string;
  readonly deadlineAt: number;
  readonly delivery: 'transient' | 'reliable';
  readonly purpose: RpcCallPurpose;
  readonly handler: (event: PluginChannelEventDelivery) => void;
  queue: QueuedEvent[];
  dropped: number;
  scheduled: boolean;
  ready: boolean;
  closed: boolean;
  /** Highest sequence whose callback actually RAN, contiguous from `fromSequence`. */
  delivered: number;
  readonly terminal: Deferred<'closed' | 'failed'>;
  readonly controller: AbortController;
  release: (() => void) | null;
}

/** One consumer-visible live read stream. */
export interface PluginChannelStream {
  readonly transferId: string;
  readonly size: number | null;
  readonly digest: `sha256:${string}` | null;
  /** Resolves only after the consumer fully consumed and verified the body. */
  readonly completed: Promise<{ readonly bytes: number; readonly digest: `sha256:${string}` }>;
  chunks(): AsyncGenerator<Uint8Array, void, void>;
  /** Drains the whole body and resolves the verified result. */
  collect(): Promise<{ readonly bytes: number; readonly digest: `sha256:${string}`; readonly body: Uint8Array }>;
  cancel(): void;
}

/** Combined result of one duplex session; a half-closed direction is `null`. */
export interface PluginChannelDuplexResult {
  readonly read: { readonly bytes: number; readonly digest: `sha256:${string}` } | null;
  readonly write: { readonly bytes: number; readonly digest: `sha256:${string}` } | null;
}

/**
 * One consumer-visible duplex session: a single transfer id with an independent
 * read flow and write flow (each with its own credit window), a shared terminal,
 * and per-direction half-close. The session drains only when BOTH real halves
 * have settled.
 */
export interface PluginChannelDuplexSession {
  readonly transferId: string;
  readonly readSize: number | null;
  readonly readDigest: `sha256:${string}` | null;
  readonly completed: Promise<PluginChannelDuplexResult>;
  chunks(): AsyncGenerator<Uint8Array, void, void>;
  collect(): Promise<{ readonly bytes: number; readonly digest: `sha256:${string}`; readonly body: Uint8Array }>;
  write(chunk: Uint8Array): Promise<void>;
  /** Commits the write direction; the read direction keeps running. */
  finishWrite(): Promise<{ readonly bytes: number; readonly digest: `sha256:${string}` }>;
  /** Half-closes the read direction; the write direction keeps running. */
  endRead(): void;
  abort(): void;
}

/** One consumer-visible write stream. */
export interface PluginChannelWriteStream {
  readonly transferId: string;
  /** Resolves after the provider durably accepted and verified the whole body. */
  readonly completed: Promise<{ readonly bytes: number; readonly digest: `sha256:${string}` }>;
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ readonly bytes: number; readonly digest: `sha256:${string}` }>;
  abort(): void;
}

/** One consumer-visible event subscription. */
export interface PluginChannelEventSubscription {
  readonly subscriptionId: string;
  readonly delivery: 'transient' | 'reliable';
  readonly fromSequence: number;
  readonly oldestSequence: number | null;
  readonly prunedThrough: number;
  readonly dropped: () => number;
  /**
   * Settles exactly once: `'closed'` on an orderly close, `'failed'` when the
   * ordered reliable delivery can no longer continue (a real gap/overflow/
   * refusal). It never resolves silently as a success, so a consumer can
   * re-subscribe from its durable checkpoint instead of waiting forever.
   */
  readonly terminal: Promise<'closed' | 'failed'>;
  ack(sequence: number): Promise<number>;
  close(): void;
}

export interface PluginChannelSnapshotRead {
  readonly descriptor: ChannelSnapshotDescriptor;
  readonly bytes: Uint8Array;
}

/** Module-private handle brand: only the hub can mint or read it. */
const HANDLE_REGISTRATIONS = new WeakMap<object, Registration>();

export class PluginPeerChannelHub {
  readonly #options: PluginPeerChannelHubOptions;
  readonly #registrations = new Map<string, Registration>();
  readonly #streamInbound = new Map<string, StreamInbound>();
  readonly #streamOutbound = new Map<string, StreamOutbound>();
  readonly #writeInbound = new Map<string, WriteInbound>();
  readonly #writeOutbound = new Map<string, WriteOutbound>();
  readonly #eventInbound = new Map<string, EventSubscription>();
  readonly #eventOutbound = new Map<string, EventOutbound>();
  /** Pinned whole-body snapshot read sessions (provider side). */
  readonly #snapshotSessions = new Map<string, SnapshotSession>();
  #bufferedBytes = 0;
  #disposed = false;
  #loopback: PluginChannelLinkPort | null = null;

  constructor(options: PluginPeerChannelHubOptions) {
    this.#options = options;
  }

  get process(): PluginServiceProcess { return this.#options.process; }

  /** A lane handler bound to one concrete link (or to the in-process loopback). */
  handlerFor(link: PluginChannelLinkPort): PluginPeerLaneHandler {
    const handler: PluginPeerLaneHandler = {
      onRequest: (call, signal) => this.#onRequest(link, call.metadata, call.deadlineAt, signal),
      onEmit: (frame) => this.#onEmit(link, frame),
      onTransportReady: () => this.#onTransportReady(link),
      onTransportEnd: (reason) => this.#onTransportEnd(link, reason),
    };
    return Object.freeze(handler);
  }

  /** Host-only directory view of this hub's real registrations (for the peer directory). */
  publicationView(): readonly {
    readonly provider: string; readonly service: string; readonly major: number;
    readonly scope: 'global'; readonly scopeKey: 'global'; readonly ready: boolean;
    readonly lane: PluginChannelLane;
  }[] {
    const view = [];
    for (const registration of this.#registrations.values()) {
      view.push(Object.freeze({
        provider: registration.provider, service: registration.service, major: registration.major,
        scope: 'global' as const, scopeKey: 'global',
        ready: registration.ready && !registration.retiring, lane: registration.lane,
      }));
    }
    view.sort((left, right) => left.provider.localeCompare(right.provider)
      || left.service.localeCompare(right.service) || left.major - right.major || left.lane.localeCompare(right.lane));
    return Object.freeze(view);
  }

  /** In-process port for a same-process route; one instance per hub. */
  loopbackPort(): PluginChannelLinkPort {
    if (this.#loopback === null) {
      const port: PluginChannelLinkPort = {
        retired: false,
        requestOnLane: (lane, context, body, options) => this.#loopbackRequest(port, lane, context, body, options),
        emitLane: (lane, kind, requestId, deadlineAt, context, body) => {
          if (this.#disposed) return false;
          if (kind !== 'chunk' && kind !== 'notification') return false;
          try {
            this.#onEmit(port, Object.freeze({
              lane, kind, requestId, deadlineAt, context, body: new Uint8Array(body), sequence: 0,
            }));
            return true;
          } catch { return false; }
        },
      };
      this.#loopback = port;
    }
    return this.#loopback;
  }

  registerStream(input: PluginChannelRegistrationInput, provider: PluginChannelStreamProvider): PluginChannelProviderHandle {
    if (provider.open === undefined && provider.accept === undefined && provider.duplex === undefined) {
      throw new ChannelError('invalid', 'a stream provider must offer a read, write or duplex side');
    }
    return this.#register(input, { stream: provider });
  }

  registerSnapshot(input: PluginChannelRegistrationInput, provider: PluginChannelSnapshotProvider): PluginChannelProviderHandle {
    return this.#register(input, { snapshot: provider });
  }

  registerEvent(input: PluginChannelRegistrationInput, provider: PluginChannelEventProvider): PluginChannelProviderHandle {
    if (provider.delivery === 'reliable' && provider.log === undefined) {
      throw new ChannelError('invalid', 'a reliable event topic requires a durable log');
    }
    return this.#register(input, { event: provider });
  }

  #register(
    input: PluginChannelRegistrationInput,
    impl: { readonly stream?: PluginChannelStreamProvider; readonly snapshot?: PluginChannelSnapshotProvider; readonly event?: PluginChannelEventProvider },
  ): PluginChannelProviderHandle {
    const key = callTargetKey(input.lane, { provider: input.provider, service: input.service, major: input.major });
    if (this.#registrations.has(key)) throw new ChannelError('conflict', 'channel provider is already registered');
    if (typeof input.contract !== 'string' || input.contract.length === 0) throw new ChannelError('invalid', 'channel registration requires a contract hash');
    const registration: Registration = {
      key, lane: input.lane, provider: input.provider, service: input.service,
      major: input.major, process: input.process, contract: input.contract,
      stream: impl.stream, snapshot: impl.snapshot, event: impl.event,
      ready: false, retiring: false,
    };
    this.#registrations.set(key, registration);
    let released = false;
    const handle: PluginChannelProviderHandle = Object.freeze({
      markReady: () => { if (!released) registration.ready = true; },
      retire: () => { registration.retiring = true; },
      dispose: () => {
        if (released) return;
        released = true;
        registration.ready = false;
        registration.retiring = true;
        if (this.#registrations.get(key) === registration) this.#registrations.delete(key);
        // Accepted inbound work keeps draining through its own Host lease.
      },
    });
    HANDLE_REGISTRATIONS.set(handle, registration);
    return handle;
  }

  #registrationOf(handle: PluginChannelProviderHandle): Registration {
    const registration = HANDLE_REGISTRATIONS.get(handle as object);
    if (registration === undefined) throw new ChannelError('unauthorized', 'channel provider handle is not host-issued');
    return registration;
  }

  /**
   * Appends one reliable event and fans it out to every current subscriber.
   * Capacity/quota failure propagates so the publishing plugin sees an explicit
   * refusal instead of a silent drop. `extend` (when given) commits the provider's
   * business state in the same durable transaction as the event.
   */
  async publishReliable(
    handle: PluginChannelProviderHandle,
    payload: Uint8Array,
    appendPlan?: (payload: Uint8Array) => { readonly sequence: number; readonly eventId: string } | Promise<{readonly sequence:number;readonly eventId:string}>,
  ): Promise<number> {
    const registration = this.#registrationOf(handle);
    const log = registration.event?.log;
    if (log === undefined) throw new ChannelError('unavailable', 'channel reliable event log is unavailable');
    if (payload.byteLength > CHANNEL_EVENT_MAX_PAYLOAD_BYTES) throw new ChannelError('invalid', 'channel event payload exceeds the frame budget');
    // `appendPlan` lets the host commit the event inside the provider's own
    // business-state transaction; the fan-out happens only after that commit.
    const appended = await (appendPlan === undefined ? log.append(payload) : appendPlan(payload));
    this.#fanOut(registration, { sequence: appended.sequence, eventId: appended.eventId, payload: new Uint8Array(payload) }, 'reliable');
    return appended.sequence;
  }

  /** Fans one transient notification out to every current subscriber. */
  publishTransient(handle: PluginChannelProviderHandle, payload: Uint8Array): void {
    const registration = this.#registrationOf(handle);
    if (registration.event === undefined || registration.event.delivery !== 'transient') {
      throw new ChannelError('unavailable', 'channel transient event topic is unavailable');
    }
    if (payload.byteLength > CHANNEL_EVENT_MAX_PAYLOAD_BYTES) throw new ChannelError('invalid', 'channel event payload exceeds the frame budget');
    this.#fanOut(registration, { sequence: 0, eventId: randomUUID().replace(/-/g, ''), payload: new Uint8Array(payload) }, 'transient');
  }

  /* ------------------------------------------------------------------ */
  /* Route resolution                                                    */
  /* ------------------------------------------------------------------ */

  #route(target: PluginChannelTarget, lane: PluginChannelLane): { readonly link: PluginChannelLinkPort; readonly providerKey: string } {
    const localKey = callTargetKey(lane, target);
    const local = this.#registrations.get(localKey);
    if (local !== undefined && local.ready && !local.retiring && local.process === this.#options.process) {
      return { link: this.loopbackPort(), providerKey: localKey };
    }
    const resolution = this.#options.resolveRoute(target, lane);
    if (resolution.kind === 'remote') return { link: resolution.link, providerKey: localKey };
    if (resolution.kind === 'ambiguous') throw new ChannelError('ambiguous', 'peer channel target is ambiguous');
    throw new ChannelError('unavailable', 'peer channel target is unavailable');
  }

  /**
   * Refuses NEW consumer work on an exactly-retired link. Frames that belong to
   * an already-accepted transfer/subscription/session are NOT routed through
   * here; they keep flowing (finish/ACK/chunk/release/credit).
   */
  #assertLinkAdmitsNewWork(link: PluginChannelLinkPort): void {
    if (link.retired === true) throw new ChannelError('closed', 'peer channel link is retiring');
  }

  /* ------------------------------------------------------------------ */
  /* Consumer operations                                                 */
  /* ------------------------------------------------------------------ */

  openStream(
    target: PluginChannelTarget,
    caller: string,
    callerScope: string,
    contract: string,
    request: {
      readonly objectId: string;
      readonly version: number;
      readonly offset: number;
      readonly size: number | null;
      readonly digest: `sha256:${string}` | null;
      readonly creditBytes?: number;
      readonly idleMs?: number;
      readonly deadlineAt?: number;
      readonly signal?: AbortSignal;
      readonly purpose?: RpcCallPurpose;
      readonly release?: () => void;
    },
  ): PluginChannelStream {
    const { link, providerKey } = this.#route(target, 'stream');
    this.#assertLinkAdmitsNewWork(link);
    if (this.#streamOutbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS) throw new ChannelError('overloaded', 'peer channel stream capacity is exhausted');
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new ChannelError('invalid', 'peer channel stream offset is invalid');
    if (request.size !== null && (!Number.isSafeInteger(request.size) || request.size < 1)) throw new ChannelError('invalid', 'peer channel stream size is invalid');
    if (request.size !== null && request.size > CHANNEL_STREAM_MAX_TOTAL_BYTES) throw new ChannelError('overloaded', 'peer channel stream exceeds the total byte ceiling');
    const creditBytes = request.creditBytes ?? CHANNEL_STREAM_DEFAULT_CREDIT_BYTES;
    const idleMs = request.idleMs ?? CHANNEL_STREAM_DEFAULT_IDLE_MS;
    if (!Number.isSafeInteger(creditBytes) || creditBytes < 1 || creditBytes > CHANNEL_STREAM_MAX_CREDIT_BYTES) throw new ChannelError('invalid', 'peer channel stream credit is invalid');
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new ChannelError('invalid', 'peer channel stream idle deadline is invalid');
    const deadlineAt = request.deadlineAt ?? Date.now() + CHANNEL_STREAM_DEFAULT_DEADLINE_MS;

    const transferId = randomUUID();
    const controller = new AbortController();
    const removeOuterAbort = linkExternalSignal(request.signal, controller);
    const drainingLease = terminalGatedRelease(request.release);
    const state: StreamOutbound = {
      link, providerKey, transferId, deadlineAt, idleMs,
      baseOffset: request.offset,
      expectedSize: request.size,
      expectedDigest: request.offset === 0 ? request.digest : null,
      hash: request.offset === 0 ? createHash('sha256') : null,
      chunks: [], queuedBytes: 0, receivedBytes: 0, consumedBytes: 0, slack: creditBytes, heartbeat: null,
      lastSeen: false, halfClosed: false, completed: false, failure: null, waiters: [],
      completion: createDeferred(), idleTimer: null, controller,
      release: drainingLease.release,
    };
    this.#streamOutbound.set(transferId, state);
    this.#armStreamIdle(state);
    this.#armStreamHeartbeat(state);

    const openCall = link.requestOnLane(
      'stream',
      encodeStreamOpenRequest('stream.open', target, caller, callerScope, contract, {
        clientId: transferId, objectId: request.objectId, version: request.version,
        offset: request.offset, size: request.size, digest: request.digest,
        creditBytes, idleMs,
      }, request.purpose),
      EMPTY,
      { deadlineAt, signal: controller.signal },
    );
    drainingLease.observe(openCall.terminal);
    void openCall.terminal.then(
      () => { removeOuterAbort(); this.#onStreamTerminal(state); },
      () => { removeOuterAbort(); this.#failStream(state, 'truncated'); },
    );
    void openCall.result.then(
      (bytes) => {
        const result = decodeResultOrError(bytes);
        if (!result.ok) { this.#failStream(state, result.code === 'unavailable' ? 'unavailable' : 'failed'); return; }
        const open = decodeStreamOpenResult(result);
        if (open === null || open.transferId !== transferId) { this.#failStream(state, 'invalid'); return; }
        if (request.size !== null && open.size !== null && open.size !== request.size) { this.#failStream(state, 'conflict'); return; }
        // The provider's own size/digest are authoritative: adopt them when the
        // caller left them open, so the stream is still fully verified.
        if (state.expectedSize === null && open.size !== null) state.expectedSize = open.size;
        if (state.expectedDigest === null && request.offset === 0 && open.digest !== null) state.expectedDigest = open.digest;
        if (open.size !== null && open.size > CHANNEL_STREAM_MAX_TOTAL_BYTES) this.#failStream(state, 'overloaded');
      },
      (error) => { this.#failStream(state, errorCodeOf(error)); },
    );

    return Object.freeze({
      transferId,
      size: request.size,
      digest: request.digest,
      completed: state.completion.promise,
      chunks: () => this.#iterateStream(state),
      collect: () => this.#collectStream(state),
      cancel: () => { this.#cancelStream(state); },
    });
  }

  /** Opens a write stream: the consumer sends the bytes, the provider commits them. */
  openWriteStream(
    target: PluginChannelTarget,
    caller: string,
    callerScope: string,
    contract: string,
    request: {
      readonly objectId: string;
      readonly version: number;
      readonly size: number | null;
      readonly digest: `sha256:${string}` | null;
      readonly creditBytes?: number;
      readonly idleMs?: number;
      readonly deadlineAt?: number;
      readonly signal?: AbortSignal;
      readonly purpose?: RpcCallPurpose;
      readonly release?: () => void;
    },
  ): PluginChannelWriteStream {
    const { link } = this.#route(target, 'stream');
    this.#assertLinkAdmitsNewWork(link);
    if (this.#writeOutbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS) throw new ChannelError('overloaded', 'peer channel write capacity is exhausted');
    if (request.size !== null && (!Number.isSafeInteger(request.size) || request.size < 1 || request.size > CHANNEL_STREAM_MAX_TOTAL_BYTES)) {
      throw new ChannelError('invalid', 'peer channel write size is invalid');
    }
    const creditBytes = request.creditBytes ?? CHANNEL_STREAM_DEFAULT_CREDIT_BYTES;
    const idleMs = request.idleMs ?? CHANNEL_STREAM_DEFAULT_IDLE_MS;
    if (!Number.isSafeInteger(creditBytes) || creditBytes < 1 || creditBytes > CHANNEL_STREAM_MAX_CREDIT_BYTES) throw new ChannelError('invalid', 'peer channel write credit is invalid');
    const deadlineAt = request.deadlineAt ?? Date.now() + CHANNEL_STREAM_DEFAULT_DEADLINE_MS;
    const transferId = randomUUID();
    const controller = new AbortController();
    const removeOuterAbort = linkExternalSignal(request.signal, controller);
    const drainingLease = terminalGatedRelease(request.release);
    const state: WriteOutbound = {
      link, transferId, deadlineAt, idleMs, purpose: request.purpose ?? 'background', controller,
      completion: createDeferred(), window: 0, hash: createHash('sha256'), bytes: 0,
      creditWaiters: [], idleTimer: null, failure: null, finishing: false,
      writeTail: Promise.resolve(), queuedWriteBytes: 0, release: drainingLease.release,
    };
    this.#writeOutbound.set(transferId, state);
    this.#armWriteIdle(state);

    const openCall = link.requestOnLane(
      'stream',
      encodeStreamOpenRequest('stream.open-write', target, caller, callerScope, contract, {
        clientId: transferId, objectId: request.objectId, version: request.version,
        offset: 0, size: request.size, digest: request.digest,
        creditBytes, idleMs,
      }, request.purpose),
      EMPTY,
      { deadlineAt, signal: controller.signal },
    );
    drainingLease.observe(openCall.terminal);
    void openCall.terminal.then(
      () => { removeOuterAbort(); if (state.failure === null && !isSettled(state.completion) && !state.finishing) this.#failWrite(state, 'truncated'); },
      () => { removeOuterAbort(); this.#failWrite(state, 'truncated'); },
    );
    void openCall.result.then(
      (bytes) => {
        const result = decodeResultOrError(bytes);
        if (!result.ok) { this.#failWrite(state, result.code === 'unavailable' ? 'unavailable' : 'failed'); return; }
        const open = decodeStreamOpenResult(result);
        if (open === null || open.transferId !== transferId) { this.#failWrite(state, 'invalid'); return; }
        state.window = Math.max(state.window, Math.min(open.creditBytes, CHANNEL_STREAM_MAX_CREDIT_BYTES));
        this.#wakeWrite(state);
      },
      (error) => { this.#failWrite(state, errorCodeOf(error)); },
    );

    return Object.freeze({
      transferId,
      completed: state.completion.promise,
      write: (chunk: Uint8Array) => this.#writeChunk(state, chunk),
      finish: () => this.#finishWrite(state, target, caller, callerScope, contract),
      abort: () => { this.#abortWrite(state, 'cancelled'); },
    });
  }

  /**
   * Opens a true duplex session: ONE negotiation creates a single transfer id
   * carrying an independent read flow and write flow with one shared terminal.
   */
  openDuplex(
    target: PluginChannelTarget,
    caller: string,
    callerScope: string,
    contract: string,
    request: {
      readonly objectId: string;
      readonly version: number;
      readonly readOffset?: number;
      readonly readSize?: number | null;
      readonly readDigest?: `sha256:${string}` | null;
      readonly writeSize?: number | null;
      readonly writeDigest?: `sha256:${string}` | null;
      readonly readCreditBytes?: number;
      readonly writeCreditBytes?: number;
      readonly idleMs?: number;
      readonly deadlineAt?: number;
      readonly signal?: AbortSignal;
      readonly purpose?: RpcCallPurpose;
      readonly release?: () => void;
    },
  ): PluginChannelDuplexSession {
    const { link } = this.#route(target, 'stream');
    this.#assertLinkAdmitsNewWork(link);
    if (this.#streamOutbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS || this.#writeOutbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS) {
      throw new ChannelError('overloaded', 'peer channel duplex capacity is exhausted');
    }
    const readOffset = request.readOffset ?? 0;
    if (!Number.isSafeInteger(readOffset) || readOffset < 0) throw new ChannelError('invalid', 'peer channel duplex read offset is invalid');
    const readSize = request.readSize ?? null;
    if (readSize !== null && (!Number.isSafeInteger(readSize) || readSize < 1 || readSize > CHANNEL_STREAM_MAX_TOTAL_BYTES)) {
      throw new ChannelError('invalid', 'peer channel duplex read size is invalid');
    }
    const writeSize = request.writeSize ?? null;
    if (writeSize !== null && (!Number.isSafeInteger(writeSize) || writeSize < 1 || writeSize > CHANNEL_STREAM_MAX_TOTAL_BYTES)) {
      throw new ChannelError('invalid', 'peer channel duplex write size is invalid');
    }
    const readCreditBytes = request.readCreditBytes ?? CHANNEL_STREAM_DEFAULT_CREDIT_BYTES;
    const writeCreditBytes = request.writeCreditBytes ?? CHANNEL_STREAM_DEFAULT_CREDIT_BYTES;
    if (!Number.isSafeInteger(readCreditBytes) || readCreditBytes < 1 || readCreditBytes > CHANNEL_STREAM_MAX_CREDIT_BYTES
      || !Number.isSafeInteger(writeCreditBytes) || writeCreditBytes < 1 || writeCreditBytes > CHANNEL_STREAM_MAX_CREDIT_BYTES) {
      throw new ChannelError('invalid', 'peer channel duplex credit is invalid');
    }
    const idleMs = request.idleMs ?? CHANNEL_STREAM_DEFAULT_IDLE_MS;
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new ChannelError('invalid', 'peer channel duplex idle deadline is invalid');
    const deadlineAt = request.deadlineAt ?? Date.now() + CHANNEL_STREAM_DEFAULT_DEADLINE_MS;

    const transferId = randomUUID();
    // Three controllers: the SESSION controller owns the one open-duplex request
    // (so a read half-close cancels nothing), and each direction has its own so a
    // half-close of one direction never aborts the other's in-flight requests.
    const sessionController = new AbortController();
    const readController = new AbortController();
    const writeController = new AbortController();
    const removeSessionAbort = linkExternalSignal(request.signal, sessionController);
    const removeReadAbort = linkExternalSignal(request.signal, readController);
    const removeWriteAbort = linkExternalSignal(request.signal, writeController);
    const removeOuterAbort = () => { removeSessionAbort(); removeReadAbort(); removeWriteAbort(); };
    const drainingLease = terminalGatedRelease(request.release);
    const read: StreamOutbound = {
      link, providerKey: callTargetKey('stream', target), transferId, deadlineAt, idleMs,
      baseOffset: readOffset, expectedSize: readSize, expectedDigest: readOffset === 0 ? request.readDigest ?? null : null,
      hash: readOffset === 0 ? createHash('sha256') : null,
      chunks: [], queuedBytes: 0, receivedBytes: 0, consumedBytes: 0, slack: readCreditBytes, heartbeat: null,
      lastSeen: false, halfClosed: false, completed: false, failure: null, waiters: [],
      completion: createDeferred(), idleTimer: null, controller: readController, release: null,
    };
    const write: WriteOutbound = {
      link, transferId, deadlineAt, idleMs, purpose: request.purpose ?? 'background', controller: writeController,
      completion: createDeferred(), window: writeCreditBytes, hash: createHash('sha256'), bytes: 0,
      creditWaiters: [], idleTimer: null, failure: null, finishing: false,
      writeTail: Promise.resolve(), queuedWriteBytes: 0, release: null,
    };
    const duplex: DuplexOutbound = {
      transferId, read, write, completion: createDeferred(),
      readSettled: false, writeSettled: false, readValue: null, writeValue: null,
      failure: null, settled: false, readHalfClosed: false, release: drainingLease.release,
      controller: sessionController,
    };
    read.duplex = duplex;
    write.duplex = duplex;
    this.#streamOutbound.set(transferId, read);
    this.#writeOutbound.set(transferId, write);
    this.#armStreamIdle(read);
    this.#armWriteIdle(write);

    const openCall = link.requestOnLane(
      'stream',
      encodeStreamOpenDuplexRequest(target, caller, callerScope, contract, {
        clientId: transferId, objectId: request.objectId, version: request.version,
        readOffset, readSize, readDigest: request.readDigest ?? null,
        writeSize, writeDigest: request.writeDigest ?? null,
        readCreditBytes, writeCreditBytes, idleMs,
      }, request.purpose),
      EMPTY,
      { deadlineAt, signal: sessionController.signal },
    );
    drainingLease.observe(openCall.terminal);
    void openCall.terminal.then(
      () => {
        removeOuterAbort();
        // The provider's session terminal resolves only after it emitted the
        // ordered `stream.end` for its read direction (or explicitly ended it).
        // A read half that never reached a real end is a truncation — never a
        // timer guess about an in-flight frame.
        if (duplex.settled || duplex.readSettled || read.lastSeen) return;
        this.#duplexFail(duplex, 'truncated');
      },
      () => { removeOuterAbort(); if (!duplex.settled) this.#duplexFail(duplex, 'closed'); },
    );
    void openCall.result.then(
      (bytes) => {
        const result = decodeResultOrError(bytes);
        if (!result.ok) { this.#duplexFail(duplex, result.code as PluginChannelErrorCode); return; }
        const open = decodeStreamOpenDuplexResult(result);
        if (open === null || open.transferId !== transferId) { this.#duplexFail(duplex, 'invalid'); return; }
        if (readSize !== null && open.readSize !== null && open.readSize !== readSize) { this.#duplexFail(duplex, 'conflict'); return; }
        if (read.expectedSize === null && open.readSize !== null) read.expectedSize = open.readSize;
        if (read.expectedDigest === null && readOffset === 0 && open.readDigest !== null) read.expectedDigest = open.readDigest;
        if (open.readSize !== null && open.readSize > CHANNEL_STREAM_MAX_TOTAL_BYTES) { this.#duplexFail(duplex, 'overloaded'); return; }
        write.window = Math.max(write.window, Math.min(open.writeCreditBytes, CHANNEL_STREAM_MAX_CREDIT_BYTES));
        this.#wakeWrite(write);
        if (open.readSize === null) {
          // The provider explicitly offered NO read direction (`readSize` is null
          // only when it has no source). The consumer must never wait for a half
          // that can never exist: settle the read half as a real `null` now, while
          // the write direction keeps running to its own terminal.
          this.#settleAbsentRead(read);
          this.#duplexSettle(duplex, 'read', null);
        }
      },
      (error) => { this.#duplexFail(duplex, errorCodeOf(error)); },
    );

    const session: PluginChannelDuplexSession = Object.freeze({
      transferId,
      get readSize(): number | null { return read.expectedSize; },
      get readDigest(): `sha256:${string}` | null { return read.expectedDigest; },
      completed: duplex.completion.promise,
      chunks: () => this.#iterateStream(read),
      collect: () => this.#collectStream(read),
      write: (chunk: Uint8Array) => this.#writeChunk(write, chunk),
      finishWrite: () => this.#finishWrite(write, target, caller, callerScope, contract),
      endRead: () => this.#endDuplexRead(read),
      abort: () => { this.#abortDuplex(duplex, 'cancelled'); },
    });
    return session;
  }

  /** Half-closes the read direction: the write direction keeps running. */
  #endDuplexRead(read: StreamOutbound): void {
    const duplex = read.duplex;
    if (duplex === undefined || duplex.readHalfClosed || read.completed || read.failure !== null) return;
    duplex.readHalfClosed = true;
    const payload = encodeChannelEmit({ kind: 'stream.end-read', transferId: read.transferId });
    void this.#emitLaneWithRetry(read.link, read.transferId, read.deadlineAt, payload).catch(() => undefined);
    read.completed = true;
    read.halfClosed = true;
    this.#clearStreamResources(read);
    for (const resolve of read.waiters.splice(0)) resolve();
    read.completion.resolve(Object.freeze({ bytes: read.receivedBytes, digest: `sha256:${(read.hash ?? createHash('sha256')).digest('hex')}` }));
    this.#duplexSettle(duplex, 'read', null);
  }

  #abortDuplex(duplex: DuplexOutbound, code: PluginChannelErrorCode): void {
    this.#duplexFail(duplex, code);
  }

  /** Ends a read half the provider never offered: a real `null`, not a hang. */
  #settleAbsentRead(read: StreamOutbound): void {
    if (read.completed || read.failure !== null) return;
    read.completed = true;
    read.halfClosed = true;
    this.#clearStreamResources(read);
    read.completion.resolve(Object.freeze({ bytes: read.receivedBytes, digest: `sha256:${(read.hash ?? createHash('sha256')).digest('hex')}` }));
    for (const resolve of read.waiters.splice(0)) resolve();
  }

  #duplexSettle(duplex: DuplexOutbound, half: 'read' | 'write', value: { readonly bytes: number; readonly digest: `sha256:${string}` } | null): void {
    if (half === 'read') { duplex.readSettled = true; duplex.readValue = value; }
    else { duplex.writeSettled = true; duplex.writeValue = value; }
    this.#duplexCheck(duplex);
  }

  #duplexFail(duplex: DuplexOutbound, code: PluginChannelErrorCode, half?: 'read' | 'write'): void {
    if (duplex.settled) return;
    // Tell the provider the whole session is over (its inbound request signal
    // aborts and both halves drain); a half-close never reaches this path.
    try { duplex.controller.abort('failed'); } catch { /* already aborted */ }
    // A failed direction IS settled: without this the shared terminal would wait
    // forever for a half that can never complete again.
    if (half === 'read') duplex.readSettled = true;
    if (half === 'write') duplex.writeSettled = true;
    if (duplex.failure === null) duplex.failure = new ChannelError(code, `peer channel duplex ${code}`);
    this.#duplexCheck(duplex);
  }

  #duplexCheck(duplex: DuplexOutbound): void {
    if (duplex.settled) return;
    if (duplex.failure !== null) {
      // A failure in either direction drains the whole session: force the other
      // half to settle before the shared terminal rejects.
      if (!duplex.readSettled) this.#failStream(duplex.read, 'failed');
      if (!duplex.writeSettled) this.#failWrite(duplex.write, 'failed');
      if (duplex.settled) return;
    }
    if (!duplex.readSettled || !duplex.writeSettled) return;
    duplex.settled = true;
    this.#releaseDuplex(duplex);
    if (duplex.failure !== null) duplex.completion.reject(duplex.failure);
    else duplex.completion.resolve(Object.freeze({ read: duplex.readValue, write: duplex.writeValue }));
  }

  #releaseDuplex(duplex: DuplexOutbound): void {
    try { duplex.controller.abort('settled'); } catch { /* already aborted */ }
    try { duplex.read.controller.abort('settled'); } catch { /* already aborted */ }
    try { duplex.write.controller.abort('settled'); } catch { /* already aborted */ }
    duplex.release?.();
  }

  #writeChunk(state: WriteOutbound, chunk: Uint8Array): Promise<void> {
    if (state.failure !== null) return Promise.reject(state.failure);
    if (state.finishing) return Promise.reject(new ChannelError('conflict', 'write direction is finishing'));
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > CHANNEL_MAX_CHUNK_BYTES) {
      return Promise.reject(new ChannelError('invalid', 'peer channel write chunk is invalid'));
    }
    if (state.queuedWriteBytes + chunk.byteLength > CHANNEL_MAX_TRANSFER_BUFFER_BYTES) {
      return Promise.reject(new ChannelError('overloaded', 'peer channel pending writes exceed the buffer budget'));
    }
    const bytes = new Uint8Array(chunk);
    state.queuedWriteBytes += bytes.byteLength;
    const task = state.writeTail.then(() => this.#sendWriteChunk(state, bytes))
      .finally(() => { state.queuedWriteBytes -= bytes.byteLength; });
    state.writeTail = task;
    void task.catch(() => undefined);
    return task;
  }

  async #sendWriteChunk(state: WriteOutbound, chunk: Uint8Array): Promise<void> {
    if (state.failure !== null) throw state.failure;
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw new ChannelError('invalid', 'peer channel write chunk is empty');
    if (chunk.byteLength > CHANNEL_MAX_CHUNK_BYTES) throw new ChannelError('invalid', 'peer channel write chunk exceeds the frame budget');
    const bytes = new Uint8Array(chunk);
    const offset = state.bytes;
    const payload = encodeChannelEmit({ kind: 'stream.data', transferId: state.transferId, offset, last: false });
    for (let attempt = 0; attempt < CHANNEL_STREAM_EMIT_RETRIES; attempt++) {
      if (state.failure !== null) throw state.failure;
      if (state.window - state.bytes >= bytes.byteLength) {
        if (state.link.emitLane('stream', 'chunk', state.transferId, state.deadlineAt, payload, bytes)) {
          state.hash.update(bytes);
          state.bytes += bytes.byteLength;
          this.#armWriteIdle(state);
          return;
        }
        // Credit and socket capacity are independent. A refused frame was not
        // queued, so yield to transport drain before retrying that same chunk.
        // Waiting for already-available credit would exhaust retries in microtasks.
        await delay(2);
        continue;
      }
      await this.#awaitWriteCredit(state, bytes.byteLength);
    }
    this.#abortWrite(state, 'overloaded');
    throw new ChannelError('overloaded', 'peer channel write was not accepted by the transport');
  }

  async #finishWrite(state: WriteOutbound, target: PluginChannelTarget, caller: string, callerScope: string, contract: string): Promise<{ readonly bytes: number; readonly digest: `sha256:${string}` }> {
    if (state.failure !== null) throw state.failure;
    state.finishing = true;
    await state.writeTail;
    if (state.failure !== null) throw state.failure;
    const digest = `sha256:${state.hash.digest('hex')}` as `sha256:${string}`;
    const call = state.link.requestOnLane(
      'stream',
      encodeStreamFinishRequest(target, caller, callerScope, contract, { transferId: state.transferId, size: state.bytes, digest }, state.purpose),
      EMPTY,
      { deadlineAt: state.deadlineAt, signal: state.controller.signal },
    );
    void call.terminal.catch(() => undefined);
    try {
      const body = await call.result;
      const result = decodeResultOrError(body);
      if (!result.ok) throw new ChannelError(result.code, `peer channel write finish failed: ${result.code}`);
    } catch (error) {
      // A definitive provider error body is that error; a LOST finish response is
      // `unknown` — the provider may already have committed, so a blind retry is
      // never implied. The finish request WAS dispatched before this point.
      const code = error instanceof ChannelError ? error.code : 'unknown';
      this.#failWrite(state, code);
      throw state.failure ?? error;
    }
    this.#settleWrite(state, state.bytes, digest);
    return Object.freeze({ bytes: state.bytes, digest });
  }

  /** Waits until the whole chunk fits the granted window (never a partial spin). */
  async #awaitWriteCredit(state: WriteOutbound, needed: number): Promise<void> {
    while (state.window - state.bytes < needed && state.failure === null) {
      await new Promise<void>((resolve) => { state.creditWaiters.push(resolve); });
    }
  }

  #wakeWrite(state: WriteOutbound): void {
    for (const resolve of state.creditWaiters.splice(0)) resolve();
  }

  #armWriteIdle(state: WriteOutbound): void {
    if (state.idleTimer !== null) clearTimeout(state.idleTimer);
    const timer = setTimeout(() => { this.#failWrite(state, 'truncated'); }, state.idleMs);
    timer.unref?.();
    state.idleTimer = timer;
  }

  #failWrite(state: WriteOutbound, code: PluginChannelErrorCode): void {
    if (state.failure !== null || isSettled(state.completion)) return;
    state.failure = new ChannelError(code, `peer channel write ${code}`);
    this.#clearWriteTimers(state);
    this.#writeOutbound.delete(state.transferId);
    try { state.controller.abort('failed'); } catch { /* already aborted */ }
    state.release?.();
    state.completion.reject(state.failure);
    this.#wakeWrite(state);
    if (state.duplex !== undefined) this.#duplexFail(state.duplex, code, 'write');
  }

  #abortWrite(state: WriteOutbound, code: PluginChannelErrorCode): void {
    this.#failWrite(state, code);
  }

  #settleWrite(state: WriteOutbound, bytes: number, digest: `sha256:${string}`): void {
    if (state.failure !== null || isSettled(state.completion)) return;
    this.#clearWriteTimers(state);
    this.#writeOutbound.delete(state.transferId);
    state.release?.();
    state.completion.resolve(Object.freeze({ bytes, digest }));
    this.#wakeWrite(state);
    if (state.duplex !== undefined) this.#duplexSettle(state.duplex, 'write', { bytes, digest });
  }

  #clearWriteTimers(state: WriteOutbound): void {
    if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  }

  async * #iterateStream(state: StreamOutbound): AsyncGenerator<Uint8Array, void, void> {
    try {
      for (;;) {
        if (state.failure !== null) throw state.failure;
        if (state.chunks.length > 0) {
          const chunk = state.chunks.shift()!;
          state.queuedBytes -= chunk.byteLength;
          this.#bufferedBytes -= chunk.byteLength;
          yield chunk;
          // Real credit: every consumed byte is granted back to the producer.
          this.#grantCredit(state, chunk.byteLength);
          continue;
        }
        if (state.halfClosed || state.completed) return;
        if (state.lastSeen) { this.#verifyAndSettle(state); return; }
        await new Promise<void>((resolve) => { state.waiters.push(resolve); });
      }
    } finally {
      // An early `return`/`throw` from the caller must release the transfer, never
      // leave a live producer pumping into a discarded buffer. If every byte was
      // already received, verify it instead of discarding a complete body.
      if (!state.completed && state.failure === null) {
        if (state.lastSeen && state.chunks.length === 0) this.#verifyAndSettle(state);
        else this.#cancelStream(state);
      }
    }
  }

  async #collectStream(state: StreamOutbound): Promise<{ readonly bytes: number; readonly digest: `sha256:${string}`; readonly body: Uint8Array }> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.#iterateStream(state)) chunks.push(chunk);
    const done = await state.completion.promise;
    return Object.freeze({ bytes: done.bytes, digest: done.digest, body: concat(chunks) });
  }

  #grantCredit(state: StreamOutbound, bytes: number): void {
    if (bytes <= 0 || state.lastSeen || state.failure !== null) return;
    state.consumedBytes += bytes;
    state.slack = Math.min(state.slack + bytes, CHANNEL_STREAM_MAX_CREDIT_BYTES);
    this.#announceStreamWindow(state);
  }

  /**
   * Absolute window = resume offset + consumed + still-granted allowance; never
   * a delta. Including the base offset is what makes a resumed read
   * (`offset > 0`, possibly beyond the initial credit) actually progress.
   */
  #announceStreamWindow(state: StreamOutbound): void {
    if (state.failure !== null) return;
    const window = state.baseOffset + state.consumedBytes + state.slack;
    const payload = encodeChannelEmit({ kind: 'stream.credit', transferId: state.transferId, direction: 'read', window });
    void this.#emitLaneWithRetry(state.link, state.transferId, state.deadlineAt, payload)
      .then((delivered) => { if (!delivered && state.failure === null) this.#failStream(state, 'overloaded'); });
  }

  /** Repeats the window so a refused frame heals instead of starving the producer. */
  #armStreamHeartbeat(state: StreamOutbound): void {
    if (state.heartbeat !== null) clearInterval(state.heartbeat);
    const timer = setInterval(() => { this.#announceStreamWindow(state); }, CHANNEL_CREDIT_HEARTBEAT_MS);
    timer.unref?.();
    state.heartbeat = timer;
  }

  /** Describes the peer's snapshot without transferring the body (reconciliation). */
  async describeSnapshot(
    target: PluginChannelTarget,
    caller: string,
    callerScope: string,
    contract: string,
    options: { readonly version?: number | null; readonly deadlineAt?: number; readonly signal?: AbortSignal; readonly purpose?: RpcCallPurpose } = {},
  ): Promise<ChannelSnapshotDescriptor> {
    const { link } = this.#route(target, 'snapshot');
    this.#assertLinkAdmitsNewWork(link);
    const deadlineAt = options.deadlineAt ?? Date.now() + CHANNEL_STREAM_DEFAULT_DEADLINE_MS;
    const described = await this.#requestResult('snapshot', link, encodeSnapshotDescribeRequest(target, caller, callerScope, contract, { version: options.version ?? null }, options.purpose), deadlineAt, options.signal);
    if (!described.ok) throw new ChannelError(described.code, `snapshot describe failed: ${described.code}`);
    const descriptor = decodeSnapshotDescriptor(described);
    if (descriptor === null) throw new ChannelError('invalid', 'snapshot descriptor is invalid');
    if (descriptor.size > CHANNEL_SNAPSHOT_MAX_BYTES) throw new ChannelError('overloaded', 'snapshot exceeds the bounded receive budget');
    return descriptor;
  }

  async readSnapshot(
    target: PluginChannelTarget,
    caller: string,
    callerScope: string,
    contract: string,
    options: { readonly version?: number | null; readonly deadlineAt?: number; readonly signal?: AbortSignal; readonly purpose?: RpcCallPurpose } = {},
  ): Promise<PluginChannelSnapshotRead> {
    const { link } = this.#route(target, 'snapshot');
    this.#assertLinkAdmitsNewWork(link);
    const deadlineAt = options.deadlineAt ?? Date.now() + CHANNEL_STREAM_DEFAULT_DEADLINE_MS;
    // Pin the WHOLE version first: the provider retains the exact source (and its
    // descriptor owner/epoch/version/schema/digest/size) until our release.
    const opened = await this.#requestResult('snapshot', link, encodeSnapshotOpenRequest(target, caller, callerScope, contract, { version: options.version ?? null }, options.purpose), deadlineAt, options.signal);
    if (!opened.ok) throw new ChannelError(opened.code, `snapshot open failed: ${opened.code}`);
    const session = decodeSnapshotOpenResult(opened);
    if (session === null) throw new ChannelError('invalid', 'snapshot session is invalid');
    const descriptor = session.descriptor;
    if (descriptor.size > CHANNEL_SNAPSHOT_MAX_BYTES) {
      await this.#releaseSnapshot(link, target, caller, callerScope, contract, session.sessionId, deadlineAt, options.signal, options.purpose);
      throw new ChannelError('overloaded', 'snapshot exceeds the bounded receive budget');
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(descriptor.size);
      const chunkBytes = Math.min(descriptor.chunkBytes, CHANNEL_SNAPSHOT_CHUNK_BYTES);
      const total = Math.ceil(descriptor.size / chunkBytes);
      let next = 0;
      const workers = Array.from({ length: Math.min(CHANNEL_SNAPSHOT_CHUNK_CONCURRENCY, total) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= total) return;
          const offset = index * chunkBytes;
          const length = Math.min(chunkBytes, descriptor.size - offset);
          const body = await this.#requestBytes(link, encodeSnapshotChunkRequest(target, caller, callerScope, contract, {
            sessionId: session.sessionId, offset, length,
          }, options.purpose), deadlineAt, options.signal);
          if (body.byteLength !== length) throw new ChannelError('truncated', 'snapshot chunk length mismatch');
          bytes.set(body, offset);
        }
      });
      // Wait for EVERY in-flight chunk read to settle before the pinned session is
      // released in `finally`: a fast rejection from one worker must never release
      // the provider retention/lease under another worker that is still reading.
      const results = await Promise.allSettled(workers);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
      if (safeSha256(bytes) !== descriptor.digest) throw new ChannelError('failed', 'snapshot digest mismatch');
    } finally {
      // The pinned session is released exactly once, on success or failure, so a
      // failed read can never keep an old version retained.
      await this.#releaseSnapshot(link, target, caller, callerScope, contract, session.sessionId, deadlineAt, options.signal, options.purpose);
    }
    return Object.freeze({ descriptor, bytes });
  }

  async #releaseSnapshot(link: PluginChannelLinkPort, target: PluginChannelTarget, caller: string, callerScope: string, contract: string, sessionId: string, deadlineAt: number, signal: AbortSignal | undefined, purpose: RpcCallPurpose | undefined): Promise<void> {
    try {
      await this.#requestResult('snapshot', link, encodeSnapshotReleaseRequest(target, caller, callerScope, contract, { sessionId }, purpose), deadlineAt, signal);
    } catch {
      // Best-effort: an unreleased session is bounded by the provider's idle expiry.
    }
  }

  async subscribeEvents(
    target: PluginChannelTarget,
    caller: string,
    callerScope: string,
    contract: string,
    request: {
      readonly delivery: 'transient' | 'reliable';
      readonly consumerId: string;
      readonly from?: number | null;
      readonly deadlineAt?: number;
      readonly signal?: AbortSignal;
      readonly purpose?: RpcCallPurpose;
      readonly release?: () => void;
      readonly onEvent: (event: PluginChannelEventDelivery) => void;
    },
  ): Promise<PluginChannelEventSubscription> {
    const { link } = this.#route(target, 'event');
    this.#assertLinkAdmitsNewWork(link);
    if (this.#eventOutbound.size >= CHANNEL_MAX_SUBSCRIPTIONS) throw new ChannelError('overloaded', 'peer channel subscription capacity is exhausted');
    const deadlineAt = request.deadlineAt ?? Date.now() + CHANNEL_STREAM_DEFAULT_DEADLINE_MS;
    const subscriptionId = randomUUID();
    const controller = new AbortController();
    const removeOuterAbort = linkExternalSignal(request.signal, controller);
    const drainingLease = terminalGatedRelease(request.release);
    const state: EventOutbound = {
      link, subscriptionId, deadlineAt, delivery: request.delivery, handler: request.onEvent, purpose: request.purpose ?? 'background',
      queue: [], dropped: 0, scheduled: false, ready: false, closed: false, delivered: 0,
      terminal: createDeferred<'closed' | 'failed'>(), controller, release: drainingLease.release,
    };
    this.#eventOutbound.set(subscriptionId, state);
    const call = link.requestOnLane('event', encodeEventSubscribeRequest(target, caller, callerScope, contract, {
      clientId: subscriptionId, delivery: request.delivery, consumerId: request.consumerId, from: request.from ?? null,
    }, request.purpose), EMPTY, { deadlineAt, signal: controller.signal });
    drainingLease.observe(call.terminal);
    // A provider-side end of the subscription must release the local slot too.
    void call.terminal.then(
      () => { removeOuterAbort(); this.#closeOutboundSubscription(state); },
      () => { removeOuterAbort(); this.#closeOutboundSubscription(state); },
    );
    let result: PluginChannelResult;
    try {
      result = decodeResultOrError(await call.result);
    } catch (error) {
      this.#closeOutboundSubscription(state);
      throw new ChannelError(errorCodeOf(error), 'event subscribe failed');
    }
    if (!result.ok) {
      this.#closeOutboundSubscription(state);
      const error = new ChannelError(result.code, `event subscribe failed: ${result.code}`) as ChannelError & { detail?: Record<string, unknown> };
      error.detail = result.detail ?? {};
      throw error;
    }
    const subscribed = decodeEventSubscribeResult(result);
    if (subscribed === null || subscribed.subscriptionId !== subscriptionId) {
      this.#closeOutboundSubscription(state);
      throw new ChannelError('invalid', 'event subscribe result is invalid');
    }
    // The contiguous callback-delivery ceiling starts at the first sequence the
    // provider will replay.
    state.delivered = subscribed.fromSequence - 1;
    state.ready = true;
    if (!state.closed && state.queue.length > 0 && !state.scheduled) {
      state.scheduled = true;
      queueMicrotask(() => this.#drainOutboundEvents(state));
    }
    return Object.freeze({
      subscriptionId,
      delivery: subscribed.delivery,
      fromSequence: subscribed.fromSequence,
      oldestSequence: subscribed.oldestSequence,
      prunedThrough: subscribed.prunedThrough,
      dropped: () => state.dropped,
      terminal: state.terminal.promise,
      ack: async (sequence: number): Promise<number> => {
        if (state.closed) throw new ChannelError('closed', 'event subscription is closed');
        if (subscribed.delivery !== 'reliable') throw new ChannelError('invalid', 'a transient subscription has no durable ack');
        if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ChannelError('invalid', 'event ack sequence is invalid');
        // The durable checkpoint advances only over a CONTIGUOUS callback run: an
        // ACK past a real gap would silently skip an undelivered reliable event.
        if (sequence > state.delivered) throw new ChannelError('rejected', 'event ack exceeds contiguous callback delivery');
        const ackResult = await this.#requestResult(
          'event', link,
          encodeEventAckRequest(target, caller, callerScope, contract, { subscriptionId, sequence }, state.purpose),
          Date.now() + CHANNEL_STREAM_DEFAULT_DEADLINE_MS,
          state.controller.signal,
        );
        if (!ackResult.ok) throw new ChannelError(ackResult.code, `event ack failed: ${ackResult.code}`);
        const acked = decodeEventAckResult(ackResult);
        if (acked === null) throw new ChannelError('invalid', 'event ack result is invalid');
        return acked.acked;
      },
      close: () => {
        this.#closeOutboundSubscription(state);
        removeOuterAbort();
        try { state.controller.abort('closed'); } catch { /* already aborted */ }
      },
    });
  }

  #closeOutboundSubscription(state: EventOutbound): void {
    if (state.closed) return;
    state.closed = true;
    this.#eventOutbound.delete(state.subscriptionId);
    state.queue.length = 0;
    state.release?.();
    state.terminal.resolve('closed');
  }

  /** A real reliable gap/failure: observable to the consumer, never a silent close. */
  #failOutboundSubscription(state: EventOutbound, code: PluginChannelErrorCode): void {
    if (state.closed) return;
    state.closed = true;
    this.#eventOutbound.delete(state.subscriptionId);
    state.queue.length = 0;
    state.release?.();
    try { state.controller.abort(code); } catch { /* already aborted */ }
    state.terminal.resolve('failed');
  }

  /** Request helpers ---------------------------------------------------- */

  #requestResult(
    lane: PluginChannelLane,
    link: PluginChannelLinkPort,
    context: RpcJson,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<PluginChannelResult> {
    const call = link.requestOnLane(lane, context, EMPTY, { deadlineAt, ...(signal === undefined ? {} : { signal }) });
    void call.terminal.catch(() => undefined);
    return call.result.then(
      (bytes) => decodeResultOrError(bytes),
      () => Object.freeze({ ok: false as const, code: 'failed' as const }),
    );
  }

  async #requestBytes(
    link: PluginChannelLinkPort,
    context: RpcJson,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const call = link.requestOnLane('snapshot', context, EMPTY, { deadlineAt, ...(signal === undefined ? {} : { signal }) });
    void call.terminal.catch(() => undefined);
    return call.result;
  }

  /* ------------------------------------------------------------------ */
  /* Inbound dispatch                                                    */
  /* ------------------------------------------------------------------ */

  #onRequest(
    link: PluginChannelLinkPort,
    payload: unknown,
    deadlineAt: number,
    signal: AbortSignal,
  ): PluginPeerRpcRequestExecution | null {
    if (this.#disposed) return null;
    const kind = (payload as { kind?: unknown } | null)?.kind;
    switch (kind) {
      case 'stream.open': return this.#onStreamOpen(link, payload, deadlineAt, signal);
      case 'stream.open-write': return this.#onStreamOpenWrite(link, payload, deadlineAt, signal);
      case 'stream.open-duplex': return this.#onStreamOpenDuplex(link, payload, deadlineAt, signal);
      case 'stream.finish': return this.#onStreamFinish(link, payload);
      case 'snapshot.describe': return this.#deferred(this.#onSnapshotDescribe(link, payload));
      case 'snapshot.open': return this.#deferred(this.#onSnapshotOpen(link, payload, deadlineAt, signal));
      case 'snapshot.chunk': return this.#onSnapshotChunk(link, payload);
      case 'snapshot.release': return this.#onSnapshotRelease(link, payload);
      case 'event.subscribe': return this.#deferred(this.#onEventSubscribe(link, payload, deadlineAt, signal));
      case 'event.ack': return this.#deferred(this.#onEventAck(link, payload));
      default: return null;
    }
  }

  #authorized(link: PluginChannelLinkPort, lane: PluginChannelLane, target: PluginChannelTarget, caller: string, callerScope: string, process: PluginServiceProcess, continuation = false): boolean {
    // A same-process route carries no peer frame, but it is still authorized by
    // the host with the same trusted declaration check (`local: true`); the host
    // adapter's own consumption check is a second, not a substitute, gate.
    const local = link === this.#loopback;
    try {
      return this.#options.authorizeInbound({
        lane, target, caller, callerScope, providerProcess: process, local, link: local ? null : link, continuation,
      });
    } catch { return false; }
  }

  #registrationFor(lane: PluginChannelLane, target: PluginChannelTarget): Registration | null {
    const registration = this.#registrations.get(callTargetKey(lane, target));
    if (registration === undefined || !registration.ready || registration.retiring) return null;
    return registration;
  }

  /**
   * A retiring provider admits no NEW work, but an ALREADY-ACCEPTED transfer's
   * finish/ack must still complete on the original registration. This lookup
   * therefore ignores `retiring` (a disposed registration is removed from the
   * map entirely, so revoked providers are still refused).
   */
  #registrationIncludingRetiring(lane: PluginChannelLane, target: PluginChannelTarget): Registration | null {
    const registration = this.#registrations.get(callTargetKey(lane, target));
    if (registration === undefined || !registration.ready) return null;
    return registration;
  }

  #rejected(lane: PluginChannelLane, code: PluginChannelErrorCode | 'invalid'): void {
    try { this.#options.onDiagnostic?.({ kind: 'rejected', lane, code }); } catch { /* diagnostics never affect admission */ }
  }

  #deferred(pending:Promise<PluginPeerRpcRequestExecution|null>):PluginPeerRpcRequestExecution {
    const execution=pending.then(value=>value ?? this.#immediate(errorBody('failed')));
    return Object.freeze({result:execution.then(value=>value.result),terminal:execution.then(value=>value.terminal)});
  }

  #immediate(body: Uint8Array): PluginPeerRpcRequestExecution {
    return Object.freeze({ result: Promise.resolve(body), terminal: Promise.resolve() });
  }

  /** Takes the provider owner's Host lease; `null` when the host refuses. */
  #beginProvider(plugin: string, context: { readonly purpose: RpcCallPurpose; readonly deadlineAt?: number; readonly signal?: AbortSignal }): (() => void) | null {
    if (this.#options.beginProviderOperation === undefined) return () => undefined;
    try { return this.#options.beginProviderOperation(plugin, context); } catch { return null; }
  }

  #onStreamOpen(link: PluginChannelLinkPort, payload: unknown, deadlineAt: number, signal: AbortSignal): PluginPeerRpcRequestExecution | null {
    const request = decodeStreamOpenRequest(payload);
    if (request === null || request.kind !== 'stream.open') { this.#rejected('stream', 'invalid'); return null; }
    const registration = this.#registrationFor('stream', request.target);
    if (registration === null || registration.stream?.open === undefined) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'stream', request.target, request.caller, request.callerScope, registration.process)) {
      this.#rejected('stream', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    let source: PluginChannelStreamSource | null;
    try { source = registration.stream.open({ caller: request.caller, callerScope: request.callerScope, objectId: request.request.objectId, version: request.request.version }); }
    catch { return this.#immediate(errorBody('failed')); }
    if (source === null) return this.#immediate(errorBody('unavailable'));
    const { offset, size, digest, creditBytes, idleMs, clientId } = request.request;
    if (size !== null && source.size !== size) return this.#immediate(errorBody('conflict'));
    if (digest !== null && source.digest !== digest) return this.#immediate(errorBody('conflict'));
    if (offset > source.size) return this.#immediate(errorBody('invalid'));
    if (source.size > CHANNEL_STREAM_MAX_TOTAL_BYTES) return this.#immediate(errorBody('overloaded'));
    if (this.#streamInbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS) return this.#immediate(errorBody('overloaded'));
    if (clientId.length > 128 || this.#streamInbound.has(clientId)) return this.#immediate(errorBody('conflict'));
    const release = this.#beginProvider(registration.provider, { purpose: request.purpose, deadlineAt, signal });
    if (release === null) return this.#immediate(errorBody('overloaded'));

    const transfer: StreamInbound = {
      link, providerKey: registration.key, transferId: clientId,
      caller: request.caller, callerScope: request.callerScope, deadlineAt,
      frameBytes: Math.min(creditBytes, CHANNEL_MAX_CHUNK_BYTES),
      idleMs, release, window: creditBytes, creditWaiters: [], idleTimer: null, aborted: false, finished: false,
    };
    this.#streamInbound.set(transfer.transferId, transfer);
    this.#armInboundIdle(transfer);

    const onAbort = () => { this.#abortInboundStream(transfer); };
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* signal already aborted */ }
    if (signal.aborted) this.#abortInboundStream(transfer);

    const result = streamOpenResultBody({
      transferId: transfer.transferId, size: source.size, digest: source.digest,
      frameBytes: transfer.frameBytes, creditBytes,
    });
    const terminal = this.#pumpStream(transfer, source, offset);
    void terminal.catch(() => undefined);
    return Object.freeze({
      result: Promise.resolve(result),
      terminal: terminal.finally(() => {
        try { signal.removeEventListener('abort', onAbort); } catch { /* already removed */ }
      }),
    });
  }

  #onStreamOpenWrite(link: PluginChannelLinkPort, payload: unknown, deadlineAt: number, signal: AbortSignal): PluginPeerRpcRequestExecution | null {
    const request = decodeStreamOpenRequest(payload);
    if (request === null || request.kind !== 'stream.open-write') { this.#rejected('stream', 'invalid'); return null; }
    const registration = this.#registrationFor('stream', request.target);
    if (registration === null || registration.stream?.accept === undefined) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'stream', request.target, request.caller, request.callerScope, registration.process)) {
      this.#rejected('stream', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    let sink: PluginChannelStreamSink | null;
    try { sink = registration.stream.accept({ caller: request.caller, callerScope: request.callerScope, objectId: request.request.objectId, version: request.request.version }); }
    catch { return this.#immediate(errorBody('failed')); }
    if (sink === null) return this.#immediate(errorBody('unavailable'));
    const { size, digest, creditBytes, idleMs, clientId } = request.request;
    if (size !== null && size > CHANNEL_STREAM_MAX_TOTAL_BYTES) return this.#immediate(errorBody('overloaded'));
    if (this.#writeInbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS) return this.#immediate(errorBody('overloaded'));
    if (clientId.length > 128 || this.#writeInbound.has(clientId)) return this.#immediate(errorBody('conflict'));
    const release = this.#beginProvider(registration.provider, { purpose: request.purpose, deadlineAt, signal });
    if (release === null) return this.#immediate(errorBody('overloaded'));

    const transfer: WriteInbound = {
      link, providerKey: registration.key, transferId: clientId,
      caller: request.caller, callerScope: request.callerScope, deadlineAt, idleMs, release,
      expectedSize: size, expectedDigest: digest, hash: createHash('sha256'),
      sink, finishedWait: createDeferred<void>(), writeTail: Promise.resolve(),
      offset: 0, slack: creditBytes, window: creditBytes,
      heartbeat: null, idleTimer: null, finished: false, aborting: false, finishing: false,
    };
    this.#writeInbound.set(transfer.transferId, transfer);
    this.#armWriteInboundIdle(transfer);
    this.#armWriteHeartbeat(transfer);
    const onAbort = () => { this.#abortInboundWrite(transfer, 'cancelled'); };
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* already aborted */ }
    if (signal.aborted) this.#abortInboundWrite(transfer, 'cancelled');

    const result = streamOpenResultBody({
      transferId: transfer.transferId, size, digest, frameBytes: CHANNEL_MAX_CHUNK_BYTES, creditBytes,
    });
    const terminal = this.#awaitWriteFinish(transfer, signal, onAbort);
    void terminal.catch(() => undefined);
    return Object.freeze({ result: Promise.resolve(result), terminal });
  }

  /**
   * Admits ONE duplex session: a single client id, one provider lease and one
   * shared terminal for both directions. A failure/cancel in either direction
   * aborts the sibling, so the session drains as a whole.
   */
  #onStreamOpenDuplex(link: PluginChannelLinkPort, payload: unknown, deadlineAt: number, signal: AbortSignal): PluginPeerRpcRequestExecution | null {
    const request = decodeStreamOpenDuplexRequest(payload);
    if (request === null) { this.#rejected('stream', 'invalid'); return null; }
    const registration = this.#registrationFor('stream', request.target);
    if (registration === null || registration.stream?.duplex === undefined) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'stream', request.target, request.caller, request.callerScope, registration.process)) {
      this.#rejected('stream', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    let impl: { readonly source?: PluginChannelStreamSource; readonly sink?: PluginChannelStreamSink } | null;
    try { impl = registration.stream.duplex({ caller: request.caller, callerScope: request.callerScope, objectId: request.request.objectId, version: request.request.version }); }
    catch { return this.#immediate(errorBody('failed')); }
    if (impl === null) return this.#immediate(errorBody('unavailable'));
    if (impl.source === undefined && impl.sink === undefined) return this.#immediate(errorBody('invalid'));
    const { readOffset, readSize, readDigest, writeSize, writeDigest, readCreditBytes, writeCreditBytes, idleMs, clientId } = request.request;
    if (impl.source !== undefined) {
      if (readSize !== null && impl.source.size !== readSize) return this.#immediate(errorBody('conflict'));
      if (readDigest !== null && impl.source.digest !== readDigest) return this.#immediate(errorBody('conflict'));
      if (readOffset > impl.source.size) return this.#immediate(errorBody('invalid'));
      if (impl.source.size > CHANNEL_STREAM_MAX_TOTAL_BYTES) return this.#immediate(errorBody('overloaded'));
    } else if (readSize !== null || readDigest !== null || readOffset !== 0) {
      // Requesting a read side the provider does not offer is a contract mismatch.
      return this.#immediate(errorBody('unavailable'));
    }
    if (writeSize !== null && writeSize > CHANNEL_STREAM_MAX_TOTAL_BYTES) return this.#immediate(errorBody('overloaded'));
    if (this.#streamInbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS || this.#writeInbound.size >= CHANNEL_MAX_ACTIVE_TRANSFERS) return this.#immediate(errorBody('overloaded'));
    if (clientId.length > 128 || this.#streamInbound.has(clientId) || this.#writeInbound.has(clientId)) return this.#immediate(errorBody('conflict'));
    const release = this.#beginProvider(registration.provider, { purpose: request.purpose, deadlineAt, signal });
    if (release === null) return this.#immediate(errorBody('overloaded'));

    let halves = (impl.source === undefined ? 0 : 1) + (impl.sink === undefined ? 0 : 1);
    const sessionDone = createDeferred<void>();
    const sharedRelease = (): void => {
      halves -= 1;
      if (halves > 0) return;
      try { release(); } finally { sessionDone.resolve(undefined); }
    };

    let readHalf: StreamInbound | null = null;
    let writeHalf: WriteInbound | null = null;

    if (impl.source !== undefined) {
      readHalf = {
        link, providerKey: registration.key, transferId: clientId,
        caller: request.caller, callerScope: request.callerScope, deadlineAt,
        frameBytes: Math.min(readCreditBytes, CHANNEL_MAX_CHUNK_BYTES),
        idleMs, release: sharedRelease, window: readCreditBytes, creditWaiters: [], idleTimer: null, aborted: false, finished: false,
        abortSibling: (reason) => { if (writeHalf !== null) this.#abortInboundWrite(writeHalf, reason); },
      };
      this.#streamInbound.set(clientId, readHalf);
      this.#armInboundIdle(readHalf);
    }
    if (impl.sink !== undefined) {
      writeHalf = {
        link, providerKey: registration.key, transferId: clientId,
        caller: request.caller, callerScope: request.callerScope, deadlineAt, idleMs, release: sharedRelease,
        expectedSize: writeSize, expectedDigest: writeDigest, hash: createHash('sha256'),
        sink: impl.sink, finishedWait: createDeferred<void>(), writeTail: Promise.resolve(),
        offset: 0, slack: writeCreditBytes, window: writeCreditBytes,
        heartbeat: null, idleTimer: null, finished: false, aborting: false, finishing: false,
        abortSibling: (reason) => { if (readHalf !== null) this.#abortInboundStreamWith(readHalf, reason); },
      };
      this.#writeInbound.set(clientId, writeHalf);
      this.#armWriteInboundIdle(writeHalf);
      this.#armWriteHeartbeat(writeHalf);
    }

    const onAbort = (): void => {
      if (readHalf !== null) this.#abortInboundStream(readHalf);
      if (writeHalf !== null) this.#abortInboundWrite(writeHalf, 'cancelled');
    };
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* signal already aborted */ }
    if (signal.aborted) onAbort();

    const result = streamOpenDuplexResultBody({
      transferId: clientId,
      readSize: impl.source?.size ?? null,
      readDigest: impl.source?.digest ?? null,
      readFrameBytes: readHalf?.frameBytes ?? CHANNEL_MAX_CHUNK_BYTES,
      readCreditBytes,
      writeCreditBytes,
    });
    if (readHalf !== null && impl.source !== undefined) {
      const pump = this.#pumpStream(readHalf, impl.source, readOffset);
      void pump.catch(() => undefined);
    }
    const terminal = sessionDone.promise.finally(() => {
      try { signal.removeEventListener('abort', onAbort); } catch { /* already removed */ }
    });
    void terminal.catch(() => undefined);
    return Object.freeze({ result: Promise.resolve(result), terminal });
  }

  /** Consumer half-closed the read direction of a duplex session. */
  #onStreamEndRead(link: PluginChannelLinkPort, payload: { readonly transferId: string }): void {
    const transfer = this.#streamInbound.get(payload.transferId);
    if (transfer === undefined || transfer.link !== link) return;
    this.#abortInboundStreamWith(transfer, 'cancelled');
  }

  /**
   * Provider finished the read direction (ordered after its final data frame, so
   * the receiver can settle honestly without a timer guess).
   */
  #onStreamEnd(link: PluginChannelLinkPort, payload: { readonly transferId: string }): void {
    const state = this.#streamOutbound.get(payload.transferId);
    if (state === undefined || state.link !== link) return;
    if (state.failure !== null || state.completed) return;
    state.lastSeen = true;
    for (const resolve of state.waiters.splice(0)) resolve();
  }

  /** Emits the ordered read-direction end frame; resolves after transport accept. */
  async #emitStreamEnd(transfer: StreamInbound): Promise<void> {
    const payload = encodeChannelEmit({ kind: 'stream.end', transferId: transfer.transferId });
    await this.#emitLaneWithRetry(transfer.link, transfer.transferId, transfer.deadlineAt, payload);
  }

  async #awaitWriteFinish(transfer: WriteInbound, signal: AbortSignal, onAbort: () => void): Promise<void> {
    try {
      await transfer.finishedWait.promise;
    } finally {
      try { signal.removeEventListener('abort', onAbort); } catch { /* already removed */ }
    }
  }

  #onStreamFinish(link: PluginChannelLinkPort, payload: unknown): PluginPeerRpcRequestExecution | null {
    const request = decodeStreamFinishRequest(payload);
    if (request === null) { this.#rejected('stream', 'invalid'); return null; }
    // An already-accepted write half (standalone OR one side of a duplex session)
    // must still be committable; the transfer lookup below is the real ownership
    // proof, so `accept` is not required here.
    const registration = this.#registrationIncludingRetiring('stream', request.target);
    if (registration === null) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'stream', request.target, request.caller, request.callerScope, registration.process, true)) {
      this.#rejected('stream', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    const transfer = this.#writeInbound.get(request.request.transferId);
    if (transfer === undefined || transfer.link !== link || transfer.providerKey !== registration.key) return this.#immediate(errorBody('expired'));
    if (transfer.caller !== request.caller || transfer.callerScope !== request.callerScope) return this.#immediate(errorBody('unauthorized'));
    if (transfer.finishing) return this.#immediate(errorBody('conflict'));
    if (transfer.expectedSize !== null && transfer.offset !== transfer.expectedSize) return this.#immediate(errorBody('truncated'));
    if (transfer.offset !== request.request.size) return this.#immediate(errorBody('truncated'));
    const actual = `sha256:${transfer.hash.digest('hex')}`;
    if (actual !== request.request.digest) return this.#immediate(errorBody('truncated'));
    if (transfer.expectedDigest !== null && transfer.expectedDigest !== actual) return this.#immediate(errorBody('conflict'));
    transfer.finishing = true;
    const committedOffset = transfer.offset;
    // Commit barrier: the sink's finish runs only after EVERY accepted write has
    // really settled, so the committed body can never be missing a write.
    const finishTask = transfer.writeTail.then(() => {
      if (transfer.aborting) throw new ChannelError('cancelled', 'write was aborted before commit');
      return transfer.sink.finish(committedOffset, actual);
    });
    // Cancellation must also wait for an already executing finish, not only the
    // writes that preceded it. A rejected write remains rejected in this chain.
    transfer.writeTail = finishTask;
    // The REAL terminal resolves only when the provider task truly ends: no timer
    // ever fabricates completion of an unfinished finish.
    const terminal = finishTask.then(
      () => { this.#settleInboundWrite(transfer); },
      () => { this.#abortInboundWrite(transfer, 'failed'); },
    );
    void terminal.catch(() => undefined);
    // Only the CALL result may time out into `unknown` (the provider may already
    // have committed, so a blind retry is never implied); the terminal and the
    // provider lease stay held until the real task settles.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bounded = new Promise<Uint8Array>((resolve) => {
      timer = setTimeout(() => resolve(errorBody('unknown')), CHANNEL_STREAM_ABORT_DRAIN_MS);
      timer.unref?.();
    });
    const result = Promise.race([
      finishTask.then(() => successBody({ digest: actual, size: committedOffset }), () => errorBody('failed')),
      bounded,
    ]).finally(() => { if (timer !== null) clearTimeout(timer); });
    return Object.freeze({ result, terminal });
  }

  #settleInboundWrite(transfer: WriteInbound): void {
    if (transfer.finished) return;
    transfer.finished = true;
    this.#clearWriteInboundTimer(transfer);
    this.#writeInbound.delete(transfer.transferId);
    transfer.release?.();
    transfer.finishedWait.resolve(undefined);
  }

  #abortInboundWrite(transfer: WriteInbound, reason: 'cancelled' | 'failed' | 'closed'): void {
    if (transfer.finished || transfer.aborting) return;
    transfer.aborting = true;
    transfer.finishing = true;
    this.#clearWriteInboundTimer(transfer);
    try { transfer.sink.abort?.(reason); } catch { /* sink-owned */ }
    // A failed/cancelled write half drains the sibling read half of a duplex.
    transfer.abortSibling?.(reason === 'failed' ? 'failed' : 'cancelled');
    // The provider lease, transfer slot and terminal stay held until the REAL
    // sink task (including any in-flight write) settles. There is deliberately NO
    // timer here: only the real task end (or process exit) confirms the terminal,
    // never a fabricated 30s "settled" while the provider is still writing.
    const settle = (): void => {
      if (transfer.finished) return;
      transfer.finished = true;
      this.#writeInbound.delete(transfer.transferId);
      transfer.release?.();
      transfer.finishedWait.resolve(undefined);
    };
    void transfer.writeTail.then(settle, settle);
  }

  #clearWriteInboundTimer(transfer: WriteInbound): void {
    if (transfer.idleTimer !== null) { clearTimeout(transfer.idleTimer); transfer.idleTimer = null; }
    if (transfer.heartbeat !== null) { clearInterval(transfer.heartbeat); transfer.heartbeat = null; }
  }

  #armWriteInboundIdle(transfer: WriteInbound): void {
    if (transfer.idleTimer !== null) clearTimeout(transfer.idleTimer);
    const timer = setTimeout(() => { this.#abortInboundWrite(transfer, 'failed'); }, transfer.idleMs);
    timer.unref?.();
    transfer.idleTimer = timer;
  }

  async #pumpStream(transfer: StreamInbound, source: PluginChannelStreamSource, startOffset: number): Promise<void> {
    let offset = startOffset;
    try {
      while (offset < source.size) {
        if (transfer.aborted) return;
        if (!await this.#awaitCredit(transfer, offset)) return;
        const length = Math.min(transfer.frameBytes, source.size - offset, transfer.window - offset);
        if (length <= 0) continue;
        const bytes = await source.read(offset, length);
        if (transfer.aborted) return;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > length) {
          throw new ChannelError('failed', 'channel stream source returned an invalid chunk');
        }
        const last = offset + bytes.byteLength >= source.size;
        if (!await this.#emitChunk(transfer, offset, bytes, last)) throw new ChannelError('truncated', 'channel stream frame was not accepted by the transport');
        offset += bytes.byteLength;
      }
      // The whole read direction is done: emit the ordered end marker BEFORE the
      // session terminal, so the receiver settles on a real protocol end (also
      // for a zero-byte body) instead of a timing guess.
      await this.#emitStreamEnd(transfer);
    } catch {
      // Fail closed: the link reports a fixed result/terminal failure; this
      // terminal resolution is the honest producer end. A duplex session drains
      // its sibling direction too.
      transfer.abortSibling?.('failed');
    } finally {
      this.#finishInboundStream(transfer);
    }
  }

  async #emitChunk(transfer: StreamInbound, offset: number, bytes: Uint8Array, last: boolean): Promise<boolean> {
    const payload = encodeChannelEmit({ kind: 'stream.chunk', transferId: transfer.transferId, offset, last });
    for (let attempt = 0; attempt < CHANNEL_STREAM_EMIT_RETRIES; attempt++) {
      if (transfer.aborted) return false;
      if (transfer.link.emitLane('stream', 'chunk', transfer.transferId, transfer.deadlineAt, payload, bytes)) return true;
      await delay(2);
    }
    return false;
  }

  async #awaitCredit(transfer: StreamInbound, offset: number): Promise<boolean> {
    while (transfer.window <= offset) {
      if (transfer.aborted || transfer.finished) return false;
      await new Promise<void>((resolve) => { transfer.creditWaiters.push(resolve); });
    }
    return !transfer.aborted;
  }

  #armInboundIdle(transfer: StreamInbound): void {
    if (transfer.idleTimer !== null) clearTimeout(transfer.idleTimer);
    const timer = setTimeout(() => { this.#abortInboundStream(transfer); }, transfer.idleMs);
    timer.unref?.();
    transfer.idleTimer = timer;
  }

  #abortInboundStream(transfer: StreamInbound): void {
    if (transfer.finished || transfer.aborted) return;
    transfer.aborted = true;
    this.#wakeCredit(transfer);
    // A failed/cancelled read half drains the sibling write half of a duplex.
    transfer.abortSibling?.('cancelled');
  }

  /** Half-close of the read direction: abort ONLY this half, keep the sibling. */
  #abortInboundStreamWith(transfer: StreamInbound, reason: 'cancelled' | 'failed'): void {
    if (transfer.finished || transfer.aborted) return;
    void reason;
    transfer.aborted = true;
    this.#wakeCredit(transfer);
  }

  #finishInboundStream(transfer: StreamInbound): void {
    if (transfer.finished) return;
    transfer.finished = true;
    if (transfer.idleTimer !== null) { clearTimeout(transfer.idleTimer); transfer.idleTimer = null; }
    this.#streamInbound.delete(transfer.transferId);
    transfer.release?.();
    this.#wakeCredit(transfer);
  }

  #wakeCredit(transfer: StreamInbound): void {
    for (const resolve of transfer.creditWaiters.splice(0)) resolve();
  }

  async #onSnapshotDescribe(link: PluginChannelLinkPort, payload: unknown): Promise<PluginPeerRpcRequestExecution | null> {
    const request = decodeSnapshotDescribeRequest(payload);
    if (request === null) { this.#rejected('snapshot', 'invalid'); return null; }
    const registration = this.#registrationFor('snapshot', request.target);
    if (registration === null || registration.snapshot === undefined) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'snapshot', request.target, request.caller, request.callerScope, registration.process)) {
      this.#rejected('snapshot', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    let source: PluginChannelSnapshotSource | null;
    try {
      source = await (request.request.version === null ? registration.snapshot.current() : registration.snapshot.version(request.request.version));
    } catch { return this.#immediate(errorBody('failed')); }
    if (source === null) return this.#immediate(errorBody(request.request.version === null ? 'unavailable' : 'conflict'));
    if (source.descriptor.size > CHANNEL_SNAPSHOT_MAX_BYTES) {await source.release?.();return this.#immediate(errorBody('overloaded'));}
    const descriptor=source.descriptor;
    try { await source.release?.(); } catch { return this.#immediate(errorBody('failed')); }
    return this.#immediate(successBody({ ...descriptor }));
  }

  /**
   * Pins one immutable version for a WHOLE read and returns its exact descriptor.
   * The provider lease and the source's own retention are held until the session
   * is released (or idle-expires), so a concurrent refresh or version eviction can
   * never swap or free the body mid-read.
   */
  async #onSnapshotOpen(link: PluginChannelLinkPort, payload: unknown, deadlineAt: number, signal: AbortSignal): Promise<PluginPeerRpcRequestExecution | null> {
    const request = decodeSnapshotOpenRequest(payload);
    if (request === null) { this.#rejected('snapshot', 'invalid'); return null; }
    const registration = this.#registrationFor('snapshot', request.target);
    if (registration === null || registration.snapshot === undefined) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'snapshot', request.target, request.caller, request.callerScope, registration.process)) {
      this.#rejected('snapshot', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    let source: PluginChannelSnapshotSource | null;
    try {
      source = await (request.request.version === null ? registration.snapshot.current() : registration.snapshot.version(request.request.version));
    } catch { return this.#immediate(errorBody('failed')); }
    if (source === null) return this.#immediate(errorBody(request.request.version === null ? 'unavailable' : 'conflict'));
    if (source.descriptor.size > CHANNEL_SNAPSHOT_MAX_BYTES) {await source.release?.();return this.#immediate(errorBody('overloaded'));}
    if (this.#snapshotSessions.size >= CHANNEL_SNAPSHOT_MAX_SESSIONS) {await source.release?.();return this.#immediate(errorBody('overloaded'));}
    // Retain the exact version BEFORE any byte is read, so a concurrent publish or
    // GC can never free/replace the body under this whole-body read.
    try { await source.retain?.(); } catch { await source.release?.();return this.#immediate(errorBody('failed')); }
    // Async storage permits other admissions while the retain is pending.
    if(this.#snapshotSessions.size>=CHANNEL_SNAPSHOT_MAX_SESSIONS || this.#disposed || registration.retiring){await source.release?.();return this.#immediate(errorBody('overloaded'));}
    const release = this.#beginProvider(registration.provider, { purpose: request.purpose, deadlineAt, signal });
    if (release === null) {
      try { await source.release?.(); } catch { /* provider-owned */ }
      return this.#immediate(errorBody('overloaded'));
    }
    const sessionId = randomUUID();
    const session: SnapshotSession = {
      link, providerKey: registration.key, sessionId,
      caller: request.caller, callerScope: request.callerScope, deadlineAt,
      source, release, idleTimer: null, closed: false,
      activeReads: 0, released: false, drainWaiters: [],
    };
    this.#snapshotSessions.set(sessionId, session);
    this.#armSnapshotIdle(session);
    const onAbort = () => { void this.#closeSnapshotSession(session); };
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* signal already aborted */ }
    if (signal.aborted) void this.#closeSnapshotSession(session);
    return this.#immediate(snapshotOpenResultBody({ sessionId, descriptor: source.descriptor }));
  }

  #armSnapshotIdle(session: SnapshotSession): void {
    if (session.closed) return;
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    const timer = setTimeout(() => { void this.#closeSnapshotSession(session); }, CHANNEL_SNAPSHOT_SESSION_IDLE_MS);
    timer.unref?.();
    session.idleTimer = timer;
  }

  /**
   * Stops NEW reads immediately, then releases the provider retention and Host
   * lease only after EVERY in-flight `source.read` has really settled. The
   * returned promise is the real drain, so `snapshot.release` (or an idle expiry)
   * can wait for it instead of dropping retention under a live read. A new chunk
   * request is refused as `expired` the instant the session is closed.
   */
  #closeSnapshotSession(session: SnapshotSession): Promise<void> {
    if (!session.closed) {
      session.closed = true;
      if (session.idleTimer !== null) { clearTimeout(session.idleTimer); session.idleTimer = null; }
      this.#snapshotSessions.delete(session.sessionId);
    }
    return this.#releaseSnapshotSession(session);
  }

  #releaseSnapshotSession(session: SnapshotSession): Promise<void> {
    if (session.released) return session.releaseTask ?? Promise.resolve();
    if (session.activeReads > 0) {
      return new Promise<void>((resolve) => { session.drainWaiters.push(resolve); });
    }
    session.released = true;
    session.releaseTask=Promise.resolve().then(()=>session.source.release?.()).catch(()=>undefined).then(()=>{
      session.release?.();for(const resolve of session.drainWaiters.splice(0))resolve();
    });
    return session.releaseTask;
  }

  #onSnapshotChunk(link: PluginChannelLinkPort, payload: unknown): PluginPeerRpcRequestExecution | null {
    const request = decodeSnapshotChunkRequest(payload);
    if (request === null) { this.#rejected('snapshot', 'invalid'); return null; }
    // The session (not the registration) owns the read: an already-accepted
    // session keeps working even after the provider retired.
    const registration = this.#registrationIncludingRetiring('snapshot', request.target);
    if (registration === null) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'snapshot', request.target, request.caller, request.callerScope, registration.process, true)) {
      this.#rejected('snapshot', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    const session = this.#snapshotSessions.get(request.request.sessionId);
    if (session === undefined || session.closed
      || session.link !== link || session.providerKey !== registration.key
      || session.caller !== request.caller || session.callerScope !== request.callerScope) {
      return this.#immediate(errorBody('expired'));
    }
    const { offset, length } = request.request;
    if (offset + length > session.source.descriptor.size) return this.#immediate(errorBody('invalid'));
    this.#armSnapshotIdle(session);
    // The terminal is the REAL end of the source read PLUS the drain bookkeeping,
    // never a pre-resolved stand-in: the caller's ACK barrier waits for the actual
    // task, and a concurrent close can only release after this read settles.
    session.activeReads += 1;
    const result = session.source.read(offset, length).then(
      (bytes) => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new ChannelError('failed', 'channel snapshot source returned an invalid chunk');
        return new Uint8Array(bytes);
      },
      () => { throw new ChannelError('failed', 'channel snapshot read failed'); },
    ).finally(() => {
      session.activeReads -= 1;
      if (session.closed && session.activeReads === 0) void this.#releaseSnapshotSession(session);
    });
    return Object.freeze({ result, terminal: result.then(() => undefined, () => undefined) });
  }

  #onSnapshotRelease(link: PluginChannelLinkPort, payload: unknown): PluginPeerRpcRequestExecution | null {
    const request = decodeSnapshotReleaseRequest(payload);
    if (request === null) { this.#rejected('snapshot', 'invalid'); return null; }
    const registration = this.#registrationIncludingRetiring('snapshot', request.target);
    if (registration === null) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'snapshot', request.target, request.caller, request.callerScope, registration.process, true)) {
      this.#rejected('snapshot', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    const session = this.#snapshotSessions.get(request.request.sessionId);
    if (session === undefined || session.closed
      || session.link !== link || session.providerKey !== registration.key
      || session.caller !== request.caller || session.callerScope !== request.callerScope) {
      return this.#immediate(errorBody('expired'));
    }
    // The release result resolves only after every in-flight read has drained, so
    // a caller that awaits it really waited for the retention/lease release.
    const drained = this.#closeSnapshotSession(session);
    return Object.freeze({ result: drained.then(() => successBody({})), terminal: drained });
  }

  async #onEventSubscribe(link: PluginChannelLinkPort, payload: unknown, deadlineAt: number, signal: AbortSignal): Promise<PluginPeerRpcRequestExecution | null> {
    const request = decodeEventSubscribeRequest(payload);
    if (request === null) { this.#rejected('event', 'invalid'); return null; }
    const registration = this.#registrationFor('event', request.target);
    if (registration === null || registration.event === undefined) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'event', request.target, request.caller, request.callerScope, registration.process)) {
      this.#rejected('event', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    const provider = registration.event;
    if (provider.delivery !== request.request.delivery) return this.#immediate(errorBody('invalid'));
    if (request.request.delivery === 'reliable' && provider.log === undefined) return this.#immediate(errorBody('unavailable'));
    if (this.#eventInbound.size >= CHANNEL_MAX_SUBSCRIPTIONS) return this.#immediate(errorBody('overloaded'));
    if (this.#eventInbound.has(request.request.clientId)) return this.#immediate(errorBody('conflict'));

    // A checkpoint is isolated per (caller plugin, caller scope, consumer id): two
    // plugins that happen to pick the same consumer id never share a cursor.
    const consumerKey = `${request.caller}\0${request.callerScope}\0${request.request.consumerId}`;
    let from = request.request.from;
    let oldest: number | null = null;
    let prunedThrough = 0;
    if (provider.delivery === 'reliable' && provider.log !== undefined) {
      const log = provider.log;
      try {
        oldest = await log.oldestSequence();
        prunedThrough = await log.prunedThrough();
        if (from === null) from = await log.checkpoint(consumerKey) + 1;
        if (from < 1) from = 1;
        if ((oldest !== null && from < oldest) || from <= prunedThrough) {
          return this.#immediate(errorBody('gap', { oldestSequence: oldest, prunedThrough }));
        }
      } catch { return this.#immediate(errorBody('failed')); }
    } else {
      from = 1;
    }
    // Re-check after durable cursor IPC: another subscription may have admitted.
    if(this.#disposed || registration.retiring)return this.#immediate(errorBody('unavailable'));
    if(this.#eventInbound.size>=CHANNEL_MAX_SUBSCRIPTIONS)return this.#immediate(errorBody('overloaded'));
    if(this.#eventInbound.has(request.request.clientId))return this.#immediate(errorBody('conflict'));
    const subscriptionId = request.request.clientId;
    const release = this.#beginProvider(registration.provider, { purpose: request.purpose, deadlineAt, signal });
    if (release === null) return this.#immediate(errorBody('overloaded'));
    const subscription: EventSubscription = {
      link, providerKey: registration.key, subscriptionId, caller: request.caller, callerScope: request.callerScope,
      consumerId: consumerKey, delivery: request.request.delivery, deadlineAt, release,
      pending: [], dropped: 0, lastAcked: from - 1, lastDelivered: from - 1, replaying: false, closed: false,
      gapPending: false, gapCode: null, waiters: [], workWaiters: [], wakeVersion: 0,
    };
    this.#eventInbound.set(subscriptionId, subscription);

    const onAbort = () => { this.#closeInboundSubscription(subscription); };
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* already aborted */ }
    if (signal.aborted) this.#closeInboundSubscription(subscription);

    const result = eventSubscribeResultBody({
      subscriptionId, delivery: subscription.delivery,
      fromSequence: from, oldestSequence: oldest, prunedThrough,
    });
    const terminal = this.#replayReliable(provider, subscription, from)
      .then(() => this.#waitForClose(subscription))
      .finally(() => {
        try { signal.removeEventListener('abort', onAbort); } catch { /* already removed */ }
      });
    void terminal.catch(() => undefined);
    return Object.freeze({ result: Promise.resolve(result), terminal });
  }

  #waitForClose(subscription: EventSubscription): Promise<void> {
    if (subscription.closed) return Promise.resolve();
    return new Promise<void>((resolve) => { subscription.waiters.push(resolve); });
  }

  async #replayReliable(provider: PluginChannelEventProvider, subscription: EventSubscription, from: number): Promise<void> {
    if (provider.delivery !== 'reliable' || provider.log === undefined) return;
    const log = provider.log;
    subscription.replaying = true;
    try {
      let cursor = from;
      while (!subscription.closed) {
        if (subscription.gapPending || subscription.pending.length >= CHANNEL_EVENT_QUEUE_MAX) {
          await new Promise<void>(resolve => { subscription.workWaiters.push(resolve); });
          continue;
        }
        const wakeVersion = subscription.wakeVersion;
        const available = CHANNEL_EVENT_QUEUE_MAX - subscription.pending.length;
        let entries: readonly PluginChannelEventEntry[];
        try { entries = await log.list(cursor, Math.min(available, CHANNEL_EVENT_REPLAY_BATCH)); }
        catch {
          // A failed or partial replay is NOT an empty log: signal a real gap so
          // the consumer observes a failure instead of a silent short replay.
          this.#signalEventGap(subscription, 'failed');
          return;
        }
        if (subscription.closed) return;
        if (entries.length === 0) {
          // A publish during the asynchronous read must not be lost between an
          // empty result and installing the waiter. Later publishes/ACKs wake it.
          if (subscription.wakeVersion === wakeVersion) {
            await new Promise<void>(resolve => { subscription.workWaiters.push(resolve); });
          }
          continue;
        }
        for (const entry of entries) {
          if (subscription.closed) return;
          if (entry.sequence !== cursor) { this.#signalEventGap(subscription, 'gap'); break; }
          this.#emitEvent(subscription, { sequence: entry.sequence, eventId: entry.eventId, payload: entry.payload });
          if (subscription.gapPending || subscription.closed) break;
          cursor = entry.sequence + 1;
        }
      }
    } finally {
      subscription.replaying = false;
      if (subscription.closed) this.#finishInboundSubscription(subscription);
    }
  }

  #wakeEventDelivery(subscription: EventSubscription): void {
    subscription.wakeVersion += 1;
    for (const resolve of subscription.workWaiters.splice(0)) resolve();
  }

  #deliverEvent(subscription: EventSubscription, event: QueuedEvent): void {
    if (subscription.closed) return;
    if (subscription.delivery === 'reliable') {
      // The durable log is the only queue. One retained replay task delivers both
      // history and live facts in order; saturation waits for ACK, not for retry.
      this.#wakeEventDelivery(subscription);
      return;
    }
    this.#emitEvent(subscription, event);
  }

  #emitEvent(subscription: EventSubscription, event: QueuedEvent): void {
    if (subscription.closed) return;
    // A pending real gap must be signalled before any later event, or the
    // consumer's contiguous ACK window could advance over lost sequences.
    if (subscription.gapPending) { this.#flushEventGap(subscription); return; }
    const ordered = subscription.delivery !== 'reliable' || event.sequence <= 0
      ? true
      : event.sequence === subscription.lastDelivered + 1;
    if (subscription.pending.length >= CHANNEL_EVENT_QUEUE_MAX) {
      if (subscription.delivery === 'reliable') {
        // The bounded unacked window is full: surface a gap instead of silently
        // forgetting an unacked reliable event.
        this.#signalEventGap(subscription, 'overloaded');
        return;
      }
      subscription.pending.shift();
      subscription.dropped += 1;
    }
    const encoded = encodeChannelEmit({
      kind: 'event.notify', subscriptionId: subscription.subscriptionId,
      sequence: event.sequence, eventId: event.eventId, delivery: subscription.delivery,
    });
    const accepted = subscription.link.emitLane('event', 'notification', subscription.subscriptionId, subscription.deadlineAt, encoded, event.payload);
    if (!accepted) {
      subscription.dropped += 1;
      // A refused reliable frame is a real gap; it is signalled once the transport
      // is available again, never silently dropped.
      if (subscription.delivery === 'reliable' && event.sequence > 0) this.#signalEventGap(subscription, 'gap');
      return;
    }
    subscription.pending.push({ sequence: event.sequence, eventId: event.eventId, payload: event.payload });
    // The ACK ceiling advances only over a CONTIGUOUS run; a hole caps it, so a
    // consumer can never ACK past an undelivered sequence.
    if (ordered && event.sequence > subscription.lastDelivered) subscription.lastDelivered = event.sequence;
  }

  /** Marks a real reliable-delivery gap and tries to signal it immediately. */
  #signalEventGap(subscription: EventSubscription, code: PluginChannelErrorCode): void {
    if (subscription.gapPending) return;
    subscription.gapPending = true;
    subscription.gapCode = code;
    this.#flushEventGap(subscription);
  }

  #flushEventGap(subscription: EventSubscription): void {
    if (subscription.closed || !subscription.gapPending) return;
    const encoded = encodeChannelEmit({
      kind: 'event.gap', subscriptionId: subscription.subscriptionId,
      code: subscription.gapCode ?? 'gap',
    });
    if (!subscription.link.emitLane('event', 'notification', subscription.subscriptionId, subscription.deadlineAt, encoded, EMPTY)) {
      // Transport is down: keep the gap pending; it flushes on transport ready.
      return;
    }
    subscription.gapPending = false;
    this.#closeInboundSubscription(subscription);
  }

  /** A reconnect lets a lane re-signal a gap it could not send while detached. */
  #onTransportReady(link: PluginChannelLinkPort): void {
    for (const subscription of [...this.#eventInbound.values()]) {
      if (subscription.link === link && subscription.gapPending) this.#flushEventGap(subscription);
    }
  }

  #closeInboundSubscription(subscription: EventSubscription): void {
    if (subscription.closed) return;
    subscription.closed = true;
    this.#wakeEventDelivery(subscription);
    if (!subscription.replaying) this.#finishInboundSubscription(subscription);
    for (const resolve of subscription.waiters.splice(0)) resolve();
  }

  #finishInboundSubscription(subscription: EventSubscription): void {
    this.#eventInbound.delete(subscription.subscriptionId);
    subscription.release?.();
  }

  async #onEventAck(link: PluginChannelLinkPort, payload: unknown): Promise<PluginPeerRpcRequestExecution | null> {
    const request = decodeEventAckRequest(payload);
    if (request === null) { this.#rejected('event', 'invalid'); return null; }
    // An already-accepted subscription must keep ACKing after its provider retires.
    const registration = this.#registrationIncludingRetiring('event', request.target);
    if (registration === null || registration.event === undefined) return this.#immediate(errorBody('unavailable'));
    if (registration.contract !== request.contract) return this.#immediate(errorBody('conflict', { reason: 'contract' }));
    if (!this.#authorized(link, 'event', request.target, request.caller, request.callerScope, registration.process, true)) {
      this.#rejected('event', 'unauthorized');
      return this.#immediate(errorBody('unauthorized'));
    }
    const subscription = this.#eventInbound.get(request.request.subscriptionId);
    // Correlation is exact: same physical link, same target registration, same
    // original owner. A bare caller-string match could ACK another worker's or
    // another topic's subscription.
    if (subscription === undefined
      || subscription.link !== link
      || subscription.providerKey !== registration.key
      || subscription.caller !== request.caller
      || subscription.callerScope !== request.callerScope) {
      return this.#immediate(errorBody('expired'));
    }
    const sequence = request.request.sequence;
    if (sequence > subscription.lastDelivered) return this.#immediate(errorBody('rejected', { reason: 'undelivered' }));
    if (sequence <= subscription.lastAcked) return this.#immediate(errorBody('rejected', { reason: 'regressed' }));
    const log = registration.event.log;
    let acked = sequence;
    if (registration.event.delivery === 'reliable' && log !== undefined) {
      try { acked = (await log.ack(subscription.consumerId, sequence)).acked; }
      catch { return this.#immediate(errorBody('failed')); }
    }
    subscription.lastAcked = Math.max(subscription.lastAcked, acked);
    subscription.pending = subscription.pending.filter(entry => entry.sequence > subscription.lastAcked);
    this.#wakeEventDelivery(subscription);
    return this.#immediate(eventAckResultBody({ acked: subscription.lastAcked }));
  }

  #fanOut(registration: Registration, event: QueuedEvent, delivery: 'transient' | 'reliable'): void {
    for (const subscription of [...this.#eventInbound.values()]) {
      if (subscription.closed || subscription.delivery !== delivery) continue;
      if (subscription.providerKey !== registration.key) continue;
      this.#deliverEvent(subscription, event);
    }
  }

  /* Emit + transport callbacks --------------------------------------- */

  #onEmit(link: PluginChannelLinkPort, frame: PluginPeerLaneEmit): void {
    if (this.#disposed) return;
    const lane = frame.lane;
    if (lane !== 'event' && lane !== 'snapshot' && lane !== 'stream') return;
    const payload = decodeChannelEmit(frame.context);
    if (payload === null) { this.#rejected(lane, 'invalid'); return; }
    switch (payload.kind) {
      case 'stream.chunk': return this.#onStreamChunk(link, frame.body, payload);
      case 'stream.data': return this.#onStreamData(link, frame.body, payload);
      case 'stream.credit': return this.#onStreamCredit(link, payload);
      case 'stream.end-read': return this.#onStreamEndRead(link, payload);
      case 'stream.end': return this.#onStreamEnd(link, payload);
      case 'event.notify': return this.#onEventNotify(link, frame.body, payload);
      case 'event.gap': return this.#onEventGap(link, payload);
    }
  }

  #onStreamChunk(link: PluginChannelLinkPort, body: Uint8Array, payload: { readonly transferId: string; readonly offset: number; readonly last: boolean }): void {
    const state = this.#streamOutbound.get(payload.transferId);
    if (state === undefined || state.link !== link) return;
    if (state.failure !== null || state.lastSeen) return;
    if (payload.offset !== state.baseOffset + state.receivedBytes) { this.#failStream(state, 'truncated'); return; }
    if (state.queuedBytes + body.byteLength > CHANNEL_MAX_TRANSFER_BUFFER_BYTES
      || this.#bufferedBytes + body.byteLength > CHANNEL_MAX_TOTAL_BUFFER_BYTES) {
      this.#failStream(state, 'overloaded');
      return;
    }
    const bytes = new Uint8Array(body);
    state.chunks.push(bytes);
    state.queuedBytes += bytes.byteLength;
    this.#bufferedBytes += bytes.byteLength;
    state.receivedBytes += bytes.byteLength;
    if (state.hash !== null) state.hash.update(bytes);
    this.#armStreamIdle(state);
    if (payload.last) state.lastSeen = true;
    for (const resolve of state.waiters.splice(0)) resolve();
  }

  #onStreamData(link: PluginChannelLinkPort, body: Uint8Array, payload: { readonly transferId: string; readonly offset: number; readonly last: boolean }): void {
    const transfer = this.#writeInbound.get(payload.transferId);
    if (transfer === undefined || transfer.link !== link || transfer.finished || transfer.aborting || transfer.finishing) return;
    if (payload.offset !== transfer.offset) { this.#abortInboundWrite(transfer, 'failed'); return; }
    if (body.byteLength === 0 || body.byteLength > CHANNEL_MAX_CHUNK_BYTES) { this.#abortInboundWrite(transfer, 'failed'); return; }
    if (transfer.offset + body.byteLength > transfer.window) { this.#abortInboundWrite(transfer, 'failed'); return; }
    if (transfer.expectedSize !== null && transfer.offset + body.byteLength > transfer.expectedSize) { this.#abortInboundWrite(transfer, 'failed'); return; }
    // The absolute ceiling also applies when the caller declared no size, so an
    // unknown-size write can never stream without bound.
    if (transfer.offset + body.byteLength > CHANNEL_STREAM_MAX_TOTAL_BYTES) { this.#abortInboundWrite(transfer, 'failed'); return; }
    const bytes = new Uint8Array(body);
    const offset = transfer.offset;
    transfer.slack -= bytes.byteLength;
    transfer.offset += bytes.byteLength;
    transfer.hash.update(bytes);
    this.#armWriteInboundIdle(transfer);
    // One sink is written SERIALLY: a later chunk waits for the earlier write to
    // settle instead of racing it, and credit is granted per CONSUMED byte (after
    // the real sink accepted it), never per received byte.
    const task = transfer.writeTail.then(() => {
      if (transfer.aborting) throw new ChannelError('cancelled', 'write direction was aborted');
      return transfer.sink.write(offset, bytes);
    }).then(() => { this.#grantWriteCredit(transfer, bytes.byteLength); });
    transfer.writeTail = task;
    void task.catch(() => { this.#abortInboundWrite(transfer, 'failed'); });
  }

  #grantWriteCredit(transfer: WriteInbound, bytes: number): void {
    if (transfer.finished || transfer.aborting) return;
    transfer.slack = Math.min(transfer.slack + bytes, CHANNEL_STREAM_MAX_CREDIT_BYTES);
    this.#announceWriteWindow(transfer);
  }

  /** Announces the ABSOLUTE window (received so far + still-unconsumed allowance). */
  #announceWriteWindow(transfer: WriteInbound): void {
    if (transfer.finished) return;
    transfer.window = Math.max(transfer.window, transfer.offset + transfer.slack);
    const payload = encodeChannelEmit({ kind: 'stream.credit', transferId: transfer.transferId, direction: 'write', window: transfer.window });
    void this.#emitLaneWithRetry(transfer.link, transfer.transferId, transfer.deadlineAt, payload)
      .then((delivered) => { if (!delivered && !transfer.finished) this.#abortInboundWrite(transfer, 'failed'); });
  }

  /** Repeats the window so a frame refused by the transport heals instead of stalling. */
  #armWriteHeartbeat(transfer: WriteInbound): void {
    if (transfer.heartbeat !== null) clearInterval(transfer.heartbeat);
    const timer = setInterval(() => { this.#announceWriteWindow(transfer); }, CHANNEL_CREDIT_HEARTBEAT_MS);
    timer.unref?.();
    transfer.heartbeat = timer;
  }

  /** Retries one lane emit until the transport accepts it, bounded and yielding. */
  async #emitLaneWithRetry(link: PluginChannelLinkPort, requestId: string, deadlineAt: number, payload: RpcJson): Promise<boolean> {
    for (let attempt = 0; attempt < CHANNEL_STREAM_CREDIT_RETRIES; attempt++) {
      if (link.emitLane('stream', 'notification', requestId, deadlineAt, payload, EMPTY)) return true;
      await delay(2);
    }
    return false;
  }

  #onStreamCredit(link: PluginChannelLinkPort, payload: { readonly transferId: string; readonly direction: 'read' | 'write'; readonly window: number }): void {
    // The direction selects the flow, so a duplex session can never cross its two
    // independent windows on the same transfer id.
    if (payload.direction === 'read') {
      const transfer = this.#streamInbound.get(payload.transferId);
      if (transfer === undefined || transfer.link !== link) return;
      // Absolute and monotonic: a repeated or reordered window can never inflate
      // the allowance, and a lost frame is corrected by the next announcement.
      transfer.window = Math.max(transfer.window, payload.window);
      this.#armInboundIdle(transfer);
      this.#wakeCredit(transfer);
      return;
    }
    const state = this.#writeOutbound.get(payload.transferId);
    if (state === undefined || state.link !== link) return;
    state.window = Math.max(state.window, payload.window);
    this.#armWriteIdle(state);
    this.#wakeWrite(state);
  }

  #onEventNotify(link: PluginChannelLinkPort, body: Uint8Array, payload: { readonly subscriptionId: string; readonly sequence: number; readonly eventId: string; readonly delivery: 'transient' | 'reliable' }): void {
    const state = this.#eventOutbound.get(payload.subscriptionId);
    if (state === undefined || state.link !== link || state.closed) return;
    if (payload.delivery !== state.delivery) { this.#failOutboundSubscription(state, 'invalid'); return; }
    if (state.queue.length >= CHANNEL_EVENT_QUEUE_MAX) {
      if (state.delivery === 'reliable' && payload.sequence > 0) {
        // A reliable event must NEVER be silently shifted away: surface the real
        // overflow so the consumer re-syncs from its durable checkpoint.
        this.#failOutboundSubscription(state, 'overloaded');
        return;
      }
      state.queue.shift();
      state.dropped += 1;
    }
    state.queue.push({ sequence: payload.sequence, eventId: payload.eventId, payload: new Uint8Array(body) });
    if (state.ready && !state.scheduled) {
      state.scheduled = true;
      queueMicrotask(() => this.#drainOutboundEvents(state));
    }
  }

  /** A provider-signalled real reliable gap: fail publicly, never close silently. */
  #onEventGap(link: PluginChannelLinkPort, payload: { readonly subscriptionId: string; readonly code: PluginChannelErrorCode }): void {
    const state = this.#eventOutbound.get(payload.subscriptionId);
    if (state === undefined || state.link !== link || state.closed) return;
    this.#failOutboundSubscription(state, payload.code);
  }

  #drainOutboundEvents(state: EventOutbound): void {
    state.scheduled = false;
    while (!state.closed && state.queue.length > 0) {
      const event = state.queue.shift()!;
      if (state.delivery === 'reliable' && event.sequence > 0 && event.sequence !== state.delivered + 1) {
        // A hole in the ordered run: never invoke a later callback as if the run
        // were contiguous, and never let an ACK cross the missing sequence.
        this.#failOutboundSubscription(state, 'gap');
        return;
      }
      // Advance the contiguous-delivery ceiling BEFORE the callback so an ACK
      // issued inside the callback sees exactly this delivered sequence.
      if (state.delivery === 'reliable' && event.sequence > 0) state.delivered = event.sequence;
      try { state.handler({ sequence: event.sequence, eventId: event.eventId, payload: event.payload, delivery: state.delivery }); }
      catch {
        this.#failOutboundSubscription(state, 'failed');
        return;
      }
    }
  }

  #onTransportEnd(link: PluginChannelLinkPort, reason: 'retired' | 'closed' | 'remote-stopped'): void {
    if (reason === 'retired') return;
    for (const state of [...this.#streamOutbound.values()]) {
      if (state.link === link) this.#failStream(state, reason === 'remote-stopped' ? 'truncated' : 'closed');
    }
    for (const state of [...this.#writeOutbound.values()]) {
      if (state.link === link) this.#failWrite(state, reason === 'remote-stopped' ? 'truncated' : 'closed');
    }
    for (const transfer of [...this.#streamInbound.values()]) {
      if (transfer.link === link) this.#abortInboundStream(transfer);
    }
    for (const transfer of [...this.#writeInbound.values()]) {
      if (transfer.link === link) this.#abortInboundWrite(transfer, 'closed');
    }
    for (const subscription of [...this.#eventInbound.values()]) {
      if (subscription.link === link) this.#closeInboundSubscription(subscription);
    }
    for (const state of [...this.#eventOutbound.values()]) {
      if (state.link !== link) continue;
      // A reliable subscription that ends without an orderly provider close is a
      // REAL failure, never a silent close.
      if (state.delivery === 'reliable') this.#failOutboundSubscription(state, 'closed');
      else this.#closeOutboundSubscription(state);
    }
    for (const session of [...this.#snapshotSessions.values()]) {
      if (session.link === link) void this.#closeSnapshotSession(session);
    }
  }

  /* Outbound stream settlement --------------------------------------- */

  #armStreamIdle(state: StreamOutbound): void {
    if (state.idleTimer !== null) clearTimeout(state.idleTimer);
    const timer = setTimeout(() => { this.#failStream(state, 'truncated'); }, state.idleMs);
    timer.unref?.();
    state.idleTimer = timer;
  }

  #onStreamTerminal(state: StreamOutbound): void {
    // The producer end is real evidence only once the consumer verified `last`.
    if (state.failure !== null || state.completed) return;
    if (state.lastSeen) return;
    this.#failStream(state, 'truncated');
  }

  /** Verifies size/digest and only then resolves the consumer's completion. */
  #verifyAndSettle(state: StreamOutbound): void {
    if (state.failure !== null || state.completed) return;
    if (state.expectedSize !== null && state.baseOffset + state.receivedBytes !== state.expectedSize) {
      return this.#failStream(state, 'truncated');
    }
    let digest: `sha256:${string}` | null = null;
    if (state.hash !== null) {
      digest = `sha256:${state.hash.digest('hex')}`;
      if (state.expectedDigest !== null && digest !== state.expectedDigest) return this.#failStream(state, 'truncated');
    }
    this.#settleStream(state, digest ?? `sha256:${(state.hash ?? createHash('sha256')).digest('hex')}`);
  }

  #failStream(state: StreamOutbound, code: PluginChannelErrorCode): void {
    if (state.failure !== null || state.completed) return;
    state.failure = new ChannelError(code, `peer channel stream ${code}`);
    this.#clearStreamResources(state);
    state.completion.reject(state.failure);
    for (const resolve of state.waiters.splice(0)) resolve();
    if (state.duplex !== undefined) this.#duplexFail(state.duplex, code, 'read');
  }

  #settleStream(state: StreamOutbound, digest: `sha256:${string}`): void {
    if (state.failure !== null || state.completed) return;
    state.completed = true;
    this.#clearStreamResources(state);
    state.completion.resolve(Object.freeze({ bytes: state.receivedBytes, digest }));
    for (const resolve of state.waiters.splice(0)) resolve();
    if (state.duplex !== undefined) this.#duplexSettle(state.duplex, 'read', { bytes: state.receivedBytes, digest });
  }

  #clearStreamResources(state: StreamOutbound): void {
    if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
    if (state.heartbeat !== null) { clearInterval(state.heartbeat); state.heartbeat = null; }
    this.#streamOutbound.delete(state.transferId);
    this.#bufferedBytes -= state.queuedBytes;
    state.queuedBytes = 0;
    state.chunks.length = 0;
    state.release?.();
    try { state.controller.abort('settled'); } catch { /* already aborted */ }
  }

  #cancelStream(state: StreamOutbound): void {
    this.#failStream(state, 'cancelled');
    try { state.controller.abort('cancelled'); } catch { /* already aborted */ }
  }

  /* In-process loopback -------------------------------------------------- */

  #loopbackRequest(
    port: PluginChannelLinkPort,
    _lane: PluginChannelLane,
    context: import('./wire-contract').RpcJson,
    _body: Uint8Array,
    options: { readonly deadlineAt: number; readonly signal?: AbortSignal },
  ): PluginPeerRpcRequestExecution {
    if (this.#disposed) {
      return Object.freeze({ result: Promise.reject(new ChannelError('closed', 'peer channel hub is disposed')), terminal: Promise.resolve() });
    }
    if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt <= 0 || Date.now() >= options.deadlineAt) {
      return Object.freeze({ result: Promise.reject(new ChannelError('expired', 'peer channel request deadline expired')), terminal: Promise.resolve() });
    }
    const controller = new AbortController();
    const removeOuter = linkExternalSignal(options.signal, controller);
    const timer = setTimeout(() => { try { controller.abort('deadline'); } catch { /* already aborted */ } }, options.deadlineAt - Date.now());
    timer.unref?.();
    const execution = this.#onRequest(port, context, options.deadlineAt, controller.signal);
    if (execution === null) {
      clearTimeout(timer); removeOuter();
      return Object.freeze({
        result: Promise.reject(new ChannelError('unavailable', 'peer channel target is unavailable')),
        terminal: Promise.resolve(),
      });
    }
    return Object.freeze({
      result: execution.result,
      terminal: execution.terminal.finally(() => { clearTimeout(timer); removeOuter(); }),
    });
  }

  /* Lifecycle ---------------------------------------------------------- */

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const state of [...this.#streamOutbound.values()]) this.#failStream(state, 'closed');
    for (const state of [...this.#writeOutbound.values()]) this.#failWrite(state, 'closed');
    for (const transfer of [...this.#streamInbound.values()]) this.#abortInboundStream(transfer);
    for (const transfer of [...this.#writeInbound.values()]) this.#abortInboundWrite(transfer, 'closed');
    for (const subscription of [...this.#eventInbound.values()]) this.#closeInboundSubscription(subscription);
    for (const state of [...this.#eventOutbound.values()]) this.#closeOutboundSubscription(state);
    for (const session of [...this.#snapshotSessions.values()]) void this.#closeSnapshotSession(session);
    this.#registrations.clear();
    this.#bufferedBytes = 0;
  }

  status(): {
    readonly registrations: number;
    readonly activeInboundTransfers: number;
    readonly activeOutboundTransfers: number;
    readonly subscriptions: number;
    readonly subscribers: number;
    readonly bufferedBytes: number;
  } {
    return Object.freeze({
      registrations: this.#registrations.size,
      activeInboundTransfers: this.#streamInbound.size + this.#writeInbound.size,
      activeOutboundTransfers: this.#streamOutbound.size + this.#writeOutbound.size,
      subscriptions: this.#eventInbound.size,
      subscribers: this.#eventOutbound.size,
      bufferedBytes: this.#bufferedBytes,
    });
  }
}

/** Result cancellation never substitutes for the authenticated task terminal. */
function terminalGatedRelease(release: (() => void) | undefined): {
  readonly release: () => void;
  observe(terminal: Promise<void>): void;
} {
  let requested = false;
  let ended = false;
  let released = false;
  const complete = (): void => {
    if (!requested || !ended || released) return;
    released = true;
    release?.();
  };
  return {
    release: () => { requested = true; complete(); },
    observe: (terminal) => {
      void terminal.then(() => { ended = true; complete(); }, () => {
        // An unobservable terminal is not proof that the task ended.
      });
    },
  };
}

function isSettled<T>(deferred: Deferred<T>): boolean {
  return deferred.settled;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** Links an external AbortSignal into a locally owned controller; returns a remover. */
function linkExternalSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  if (signal.aborted) { try { controller.abort('caller'); } catch { /* already aborted */ } return () => undefined; }
  const listener = () => { try { controller.abort('caller'); } catch { /* already aborted */ } };
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

function errorCodeOf(error: unknown): PluginChannelErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'cancelled') return 'cancelled';
  if (code === 'timeout' || code === 'expired') return 'expired';
  if (code === 'closed' || code === 'disconnected') return 'closed';
  if (code === 'overloaded') return 'overloaded';
  return 'failed';
}
