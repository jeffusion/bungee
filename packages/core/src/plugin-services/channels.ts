/**
 * Host channel adapter (P5): the plugin-facing, host-authorized surface for the
 * `stream` (read + write), `events` and `snapshot` lanes.
 *
 * It is deliberately a sibling of `HostRpcAdapter`, not a second host: the same
 * `PluginServiceHost` owner lifecycle drives `markReady`/`retire`/`dispose`, the
 * same manifest declarations authorize every provide/consume, the same
 * `wire-contract` data schemas type every lane payload, and every byte still
 * crosses the one authenticated peer link (or stays in-process when the provider
 * lives in this same Host). This adapter only:
 *
 * - validates the declared contract for the calling owner (kind/process/scope),
 * - registers provider implementations with the shared {@link PluginPeerChannelHub},
 * - hands the consumer a bounded, cancelable handle that holds a real Host lease
 *   for its whole lifetime (so owner disposal can never race live lane work),
 * - supplies the default durable reliable-event log over the host communication
 *   store (namespace-isolated per provider plugin), including the same-transaction
 *   outbox seam, and the host-managed snapshot view store.
 */

import { assertSupportedServiceDeclarations, isCrossProcessSelfSnapshot } from './contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { PluginServiceDeclarations, PluginServiceProcess, PluginServiceScope } from './contracts';
import type { HostRpcLifecycleIdentity, HostRpcLifecycleState } from './host-rpc';
import type { InferRpcData, RpcCallPurpose, RpcDataSchema, RpcJson } from './wire-contract';
import { assertRpcData, assertRpcDataSchema, decodeRpcJson, encodeRpcJson } from './wire-contract';
import type { DurableCommand, PluginDurableState } from '../plugin-durable-state';
import {
  CHANNEL_EVENT_MAX_PAYLOAD_BYTES,
  CHANNEL_EVENT_REPLAY_BATCH,
  CHANNEL_SNAPSHOT_MAX_BYTES,
  PluginPeerChannelHub,
  type PluginChannelEventDelivery,
  type PluginChannelEventProvider,
  type PluginChannelEventSubscription,
  type PluginChannelProviderHandle,
  type PluginChannelReliableEventLog,
  type PluginChannelDuplexSession,
  type PluginChannelSnapshotProvider,
  type PluginChannelSnapshotRead,
  type PluginChannelSnapshotSource,
  type PluginChannelStream,
  type PluginChannelStreamProvider,
  type PluginChannelStreamSink,
  type PluginChannelStreamSource,
  type PluginChannelWriteStream,
} from './peer-channel-hub';
import type { ChannelSnapshotDescriptor, PluginChannelTarget } from './peer-channel-protocol';
import type { CommunicationMutator, CommunicationNamespaceStore } from './persistence';
import { HostSnapshotStore } from './snapshot-store';

/** Manifest lane kind → hub lane name. */
const CHANNEL_KINDS = new Set(['events', 'snapshot', 'stream']);
const CHANNEL_KIND_LANE: Readonly<Record<'events' | 'snapshot' | 'stream', 'event' | 'snapshot' | 'stream'>> = Object.freeze({
  events: 'event', snapshot: 'snapshot', stream: 'stream',
});

/* -------------------------------------------------------------------------- */
/* Public plugin-facing surface (types and runtime schema from one source)     */
/* -------------------------------------------------------------------------- */

export interface PluginChannelPublication {
  readonly contractId: string;
  readonly version: number;
  readonly lane: 'stream' | 'snapshot' | 'event';
  /** Canonical hash of the declared contract; both sides must agree on it. */
  readonly contract: string;
}

/**
 * Read/write stream contract. `object` is the `wire-contract` schema of the
 * immutable object reference the consumer names (`{ objectId, version, ... }`),
 * so the SDK type and the runtime schema come from the same literal.
 */
export interface PluginStreamContract<S extends RpcDataSchema = RpcDataSchema> {
  readonly id: string;
  readonly version: number;
  readonly object: S;
}

export interface PluginStreamReadInput {
  readonly offset?: number;
  readonly size?: number | null;
  readonly digest?: `sha256:${string}` | null;
  readonly creditBytes?: number;
  readonly idleMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PluginStreamWriteInput {
  readonly size?: number | null;
  readonly digest?: `sha256:${string}` | null;
  readonly creditBytes?: number;
  readonly idleMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PluginStreamDuplexInput {
  readonly readOffset?: number;
  readonly readSize?: number | null;
  readonly readDigest?: `sha256:${string}` | null;
  readonly writeSize?: number | null;
  readonly writeDigest?: `sha256:${string}` | null;
  readonly readCreditBytes?: number;
  readonly writeCreditBytes?: number;
  readonly idleMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PluginStreamSourceReader {
  readonly size: number;
  readonly digest: `sha256:${string}`;
  read(offset: number, length: number): Promise<Uint8Array> | Uint8Array;
}

export interface PluginStreamSinkWriter {
  write(offset: number, bytes: Uint8Array): Promise<void> | void;
  finish(size: number, digest: `sha256:${string}`): Promise<void> | void;
  abort?(reason: 'cancelled' | 'failed' | 'closed'): void;
}

export interface PluginStreamServices {
  /** Provider side: announce an immutable object family (read and/or write). */
  provide<S extends RpcDataSchema>(contract: PluginStreamContract<S>, provider: {
    open?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): PluginStreamSourceReader | null;
    accept?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): PluginStreamSinkWriter | null;
    /** True duplex: ONE session carries both directions and one shared terminal. */
    duplex?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): {
      readonly source?: PluginStreamSourceReader;
      readonly sink?: PluginStreamSinkWriter;
    } | null;
  }): PluginChannelPublication;
  /** Consumer side: read a peer/local-provided immutable version. */
  open<S extends RpcDataSchema>(provider: string, contract: PluginStreamContract<S>, object: InferRpcData<S>, input?: PluginStreamReadInput): PluginChannelStream;
  /** Consumer side: write a body the provider durably accepts and commits. */
  openWrite<S extends RpcDataSchema>(provider: string, contract: PluginStreamContract<S>, object: InferRpcData<S>, input?: PluginStreamWriteInput): PluginChannelWriteStream;
  /** Consumer side: one true duplex session over a single transfer id. */
  openDuplex<S extends RpcDataSchema>(provider: string, contract: PluginStreamContract<S>, object: InferRpcData<S>, input?: PluginStreamDuplexInput): PluginChannelDuplexSession;
}

export interface PluginSnapshotContract<S extends RpcDataSchema = RpcDataSchema> {
  readonly id: string;
  readonly version: number;
  /** Schema of the snapshot's plugin-defined content (same literal both sides). */
  readonly content: S;
}

export interface HostSnapshotStoreOptionsView {
  readonly id: string;
  readonly schemaVersion: number;
  readonly epoch?: number;
  readonly maxVersions?: number;
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
}

/**
 * One provider-owned immutable version. `retain`/`release` are optional but are
 * honoured for the WHOLE host read session, so a bounded/GC'd store can keep the
 * exact version alive while it is being read (and free it afterwards).
 */
export interface PluginSnapshotVersionSource {
  readonly descriptor: ChannelSnapshotDescriptor;
  read(offset: number, length: number): Promise<Uint8Array>;
  retain?(): void;
  release?(): void;
}

export interface PluginSnapshotServices {
  /** Provider side: single writer of the current immutable snapshot + retained versions. */
  provide<S extends RpcDataSchema>(contract: PluginSnapshotContract<S>, provider: {
    current(): PluginSnapshotVersionSource | null;
    version(version: number): PluginSnapshotVersionSource | null;
  }): PluginChannelPublication;
  /** Consumer side: the host-managed local view of the peer's current version. */
  consume<S extends RpcDataSchema>(provider: string, contract: PluginSnapshotContract<S>): PluginSnapshotView;
  /**
   * Host-managed persistent, atomic, digest-addressed version store for THIS
   * provider plugin (bounded retention, chunked over the host communication
   * store). `null` when this process has no durable host store: a provider then
   * keeps its own in-memory source rather than inventing its own persistence.
   */
  store?(options: HostSnapshotStoreOptionsView): HostSnapshotStore | null;
}

export interface PluginSnapshotStatus {
  readonly status: 'empty' | 'loading' | 'ready' | 'stale' | 'failed';
  readonly version: number | null;
  readonly digest: `sha256:${string}` | null;
  readonly size: number | null;
  readonly appliedAt: number | null;
  readonly error: string | null;
}

/**
 * Host-managed local snapshot view: the host performs the verified atomic
 * replace, keeps the previous view readable while a refresh is in flight, and
 * reconciles continuously so a lost notification or a reconnect recovers.
 */
export interface PluginSnapshotView {
  /** The currently applied immutable version, or `null` before the first apply. */
  current(): PluginChannelSnapshotRead | null;
  status(): PluginSnapshotStatus;
  /** One reconciliation pass: `applied`, `unchanged`, or `failed`. */
  sync(options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly version?: number | null; readonly force?: boolean }): Promise<'applied' | 'unchanged' | 'failed'>;
  /** Continuous reconciliation; returns the stop function. */
  start(options?: { readonly intervalMs?: number }): () => void;
  /** Notified exactly when a new version becomes the applied view. */
  onApplied(listener: (view: PluginChannelSnapshotRead) => void): () => void;
}

export interface PluginEventContract<S extends RpcDataSchema = RpcDataSchema> {
  readonly id: string;
  readonly version: number;
  readonly delivery: 'transient' | 'reliable';
  /** Schema of one event payload; the same literal types both sides. */
  readonly event: S;
  /** Reliable topics: explicit bounded retention (events kept, then real gap). */
  readonly retention?: { readonly maxEvents: number };
}

export interface PluginEventServices {
  /** Provider side: register one topic; reliable topics require a durable log. */
  provide<S extends RpcDataSchema>(contract: PluginEventContract<S>, options?: {
    readonly log?: PluginChannelReliableEventLog;
  }): PluginEventPublisher<S>;
  /** Consumer side: subscribe to a peer/local theme; reliable is at-least-once. */
  subscribe<S extends RpcDataSchema>(
    provider: string,
    contract: PluginEventContract<S>,
    options: {
      readonly consumerId: string;
      readonly from?: number | null;
      readonly onEvent: (event: { readonly sequence: number; readonly eventId: string; readonly payload: InferRpcData<S>; readonly delivery: 'transient' | 'reliable' }) => void;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<PluginChannelEventSubscription>;
}

export interface PluginEventPublisher<S extends RpcDataSchema = RpcDataSchema> {
  readonly contractId: string;
  readonly delivery: 'transient' | 'reliable';
  /** Reliable: durable append + fan-out; resolves with the durable sequence. */
  publish(payload: InferRpcData<S>): Promise<number>;
  /**
   * Reliable outbox: commits the event and the plugin's business state in ONE
   * durable transaction (the same Host database). Never a distributed promise.
   */
  publishWithState(payload: InferRpcData<S>, command: DurableCommand): Promise<number>;
  /** Transient: best-effort fan-out; `false` means it was not admitted. */
  notify(payload: InferRpcData<S>): boolean;
}

/** Deployment capability declaration, available before the plugin declares work. */
export interface PluginChannelCapabilities {
  /** Same-process provide/consume works. */
  readonly local: boolean;
  /** A peer transport is wired for this process. */
  readonly remote: boolean;
  /** Reliable event topics can be provided (a durable log exists here). */
  readonly reliableEvents: boolean;
  /** `publishWithState` can commit state + outbox atomically here. */
  readonly outbox: boolean;
  /** Host-managed snapshot views are available. */
  readonly snapshotViews: boolean;
  /** Write streams are available. */
  readonly writeStreams: boolean;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

/** Host-only directory entry for one real local channel publication. */
export interface HostChannelPublicationView {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly scope: PluginServiceScope;
  readonly scopeKey: string;
  readonly ready: boolean;
  readonly lane: 'stream' | 'snapshot' | 'event';
  readonly contract: string;
}

export interface HostChannelOperation {
  readonly purpose: RpcCallPurpose;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly release: () => void;
}

export interface PluginChannelOwnerInput {
  readonly plugin: string;
  readonly scope: string;
  readonly declarations: PluginServiceDeclarations;
  readonly lifecycle: HostRpcLifecycleIdentity;
  readonly getLifecycleState: () => HostRpcLifecycleState;
  /** Trusted host dependency records; a channel consumption must be a declared dependency. */
  readonly dependencies: Readonly<Record<string, string>>;
  /** Registers a real pending task so owner disposal drains it honestly. */
  readonly trackPending: (promise: Promise<unknown>) => void;
  /**
   * Host-only: begins one channel operation (lease + invocation-frame rules).
   * `options.background` requests the explicit Host background context used by
   * Host-managed work (e.g. snapshot reconciliation timers), which must not be
   * derived from a plugin's closed bootstrap closure.
   */
  readonly beginOperation: (options?: { readonly background?: boolean }) => HostChannelOperation | null;
}

export interface HostChannelOwnerHandle {
  readonly stream?: PluginStreamServices;
  readonly events?: PluginEventServices;
  readonly snapshot?: PluginSnapshotServices;
  readonly capabilities: PluginChannelCapabilities;
  markReady(): void;
  retire(): void;
  dispose(): Promise<void>;
}

export type PluginReliableEventLogFactory = (input: {
  readonly plugin: string;
  readonly topic: string;
  /** Contract major: a different major is a different schema and log. */
  readonly major: number;
  readonly maxEvents: number;
}) => PluginChannelReliableEventLog | null;

export interface HostChannelAdapterOptions {
  readonly hub: PluginPeerChannelHub;
  readonly process: PluginServiceProcess;
  /** Provider-side durable namespace factory; absent refuses reliable topics. */
  readonly eventLog?: PluginReliableEventLogFactory;
  /** Provider-side durable state for the same-transaction outbox seam. */
  readonly durableState?: (plugin: string) => PluginDurableState | null;
  /** True when a peer transport is actually wired in this process. */
  readonly remoteTransport?: () => boolean;
  /**
   * Host durable namespace for the snapshot version store of one provider plugin.
   * Absent (e.g. a worker without a durable store) means `store()` returns null.
   */
  readonly snapshotNamespace?: (plugin: string) => CommunicationNamespaceStore | null;
}

interface LaneDeclaration {
  readonly scope: PluginServiceScope;
}

function laneKindOf(declarations: PluginServiceDeclarations, kind: 'provides' | 'consumes', input: {
  readonly plugin?: string; readonly id: string; readonly version: number; readonly lane: string; readonly process: PluginServiceProcess;
}): LaneDeclaration | null {
  const list = kind === 'provides' ? declarations.provides ?? [] : declarations.consumes ?? [];
  for (const service of list) {
    if (service.id !== input.id || service.version !== input.version) continue;
    if ((service.kind ?? 'local') !== input.lane) continue;
    if (service.process !== input.process) continue;
    if (kind === 'consumes' && (service as { plugin?: string }).plugin !== input.plugin) continue;
    return { scope: service.scope ?? 'global' };
  }
  return null;
}

function channelError(code: string, message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

/** Canonical contract hash: only the fields that define the wire contract. */
function contractHashOf(value: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortJson(value));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortJson(record[key]);
    return out;
  }
  return value;
}

function targetOf(provider: string, service: string, major: number): PluginChannelTarget {
  return Object.freeze({ provider, service, major });
}

/** Full descriptor identity: version+digest alone is not an immutable identity. */
function descriptorsEqual(left: ChannelSnapshotDescriptor, right: ChannelSnapshotDescriptor): boolean {
  return left.owner === right.owner && left.epoch === right.epoch && left.version === right.version
    && left.schemaVersion === right.schemaVersion && left.digest === right.digest
    && left.size === right.size && left.chunkBytes === right.chunkBytes;
}

/**
 * A snapshot body has one fixed encoding: UTF-8 JSON validated against the
 * declared `content` wire-contract schema. Binary payloads belong to a stream.
 */
function assertSnapshotContent(schema: RpcDataSchema, bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) throw channelError('invalid', 'snapshot body must be bytes');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw channelError('invalid', 'snapshot body is not valid UTF-8'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw channelError('invalid', 'snapshot body is not valid JSON'); }
  assertRpcData(schema, parsed, CHANNEL_SNAPSHOT_MAX_BYTES);
}

function laneTargetKey(lane: string, target: PluginChannelTarget, hash: string, plugin: string, scope: string): string {
  return [lane, target.provider, target.service, String(target.major), hash, plugin, scope].join('\0');
}

interface LocalRegistration {
  readonly target: PluginChannelTarget;
  readonly lane: 'stream' | 'snapshot' | 'event';
  readonly contract: string;
  readonly handle: PluginChannelProviderHandle;
  ready: boolean;
}

interface SnapshotViewState {
  readonly target: PluginChannelTarget;
  readonly contract: string;
  readonly caller: string;
  readonly callerScope: string;
  /** Owner instance the view belongs to; a re-created owner gets a new one. */
  readonly ownerToken: string;
  descriptor: ChannelSnapshotDescriptor | null;
  bytes: Uint8Array | null;
  status: 'empty' | 'loading' | 'ready' | 'stale' | 'failed';
  appliedAt: number | null;
  error: string | null;
  generation: number;
  readonly listeners: Set<(view: PluginChannelSnapshotRead) => void>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: Promise<'applied' | 'unchanged' | 'failed'> | null;
}

export class HostChannelAdapter {
  readonly #options: HostChannelAdapterOptions;
  readonly #local = new Map<string, LocalRegistration>();
  readonly #views = new Map<string, SnapshotViewState>();
  readonly #snapshotStores = new Set<HostSnapshotStore>();

  constructor(options: HostChannelAdapterOptions) {
    this.#options = options;
  }

  get process(): PluginServiceProcess { return this.#options.process; }

  capabilities(): PluginChannelCapabilities {
    return Object.freeze({
      local: true,
      remote: this.#options.remoteTransport?.() === true,
      reliableEvents: this.#options.eventLog !== undefined,
      outbox: this.#options.eventLog !== undefined && this.#options.durableState !== undefined,
      snapshotViews: true,
      writeStreams: true,
    });
  }

  /** Host-only: one owner's lane surface. */
  createOwner(input: PluginChannelOwnerInput): HostChannelOwnerHandle {
    assertSupportedServiceDeclarations(input.declarations);
    const created: Array<{ readonly key: string; readonly registration: LocalRegistration }> = [];
    /** Unique per owner instance: a new owner with the same plugin/scope must
     * never inherit a previous, already-disposed owner's snapshot view state. */
    const ownerToken = randomUUID();
    const viewKeys = new Set<string>();
    const snapshotStores = new Set<HostSnapshotStore>();
    let disposed = false;
    const assertActive = (): void => {
      if (disposed) throw channelError('revoked', 'channel owner was disposed');
      if (input.getLifecycleState().revoked) throw channelError('revoked', 'channel owner was revoked');
    };
    const begin = (options?: { readonly background?: boolean }): HostChannelOperation => {
      assertActive();
      const operation = input.beginOperation(options);
      if (operation === null) throw channelError('not_ready', 'channel operation is not admissible for this owner');
      return operation;
    };
    /**
     * Applies the Host frame's deadline/revocation to one lane call. The caller's
     * own signal is COMBINED with the Host frame signal, never substituted for it:
     * a caller-supplied signal must not drop the Host's cancellation.
     */
    const deadlineFor = (operation: HostChannelOperation, requestedTimeoutMs: number | undefined, outerSignal?: AbortSignal): { deadlineAt: number; signal: AbortSignal | undefined; release: () => void } => {
      const requested = requestedTimeoutMs === undefined ? Date.now() + 120_000 : Date.now() + requestedTimeoutMs;
      const deadlineAt = operation.deadlineAt === undefined ? requested : Math.min(requested, operation.deadlineAt);
      return { deadlineAt, signal: combineSignals(operation.signal, outerSignal), release: operation.release };
    };

    const register = (lane: 'stream' | 'snapshot' | 'event', contractId: string, version: number, hash: string, handle: PluginChannelProviderHandle): PluginChannelPublication => {
      const key = laneTargetKey(lane, targetOf(input.plugin, contractId, version), hash, input.plugin, input.scope);
      const registration: LocalRegistration = { target: targetOf(input.plugin, contractId, version), lane, contract: hash, handle, ready: false };
      this.#local.set(key, registration);
      created.push({ key, registration });
      return Object.freeze({ contractId, version, lane, contract: hash });
    };

    const stream: PluginStreamServices = {
      provide: <S extends RpcDataSchema>(contract: PluginStreamContract<S>, provider: {
        open?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): PluginStreamSourceReader | null;
        accept?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): PluginStreamSinkWriter | null;
      }): PluginChannelPublication => {
        const operation = begin();
        try {
          if (input.scope !== 'global') throw channelError('unauthorized', 'only global-scope channel publications are routable');
          assertRpcDataSchema(contract.object);
          const declared = laneKindOf(input.declarations, 'provides', { id: contract.id, version: contract.version, lane: 'stream', process: this.#options.process });
          if (declared === null) {
            throw channelError('unauthorized', 'stream publication is not declared by the manifest');
          }
          if (declared.scope !== 'global') throw channelError('unauthorized', 'binding-scope stream publications are not routable');
          const hash = contractHashOf({ lane: 'stream', id: contract.id, version: contract.version, object: contract.object });
          const handle = this.#options.hub.registerStream(
            { lane: 'stream', provider: input.plugin, service: contract.id, major: contract.version, process: this.#options.process, contract: hash },
            wrapStreamProvider(provider, contract.object),
          );
          return register('stream', contract.id, contract.version, hash, handle);
        } finally { operation.release(); }
      },
      open: <S extends RpcDataSchema>(provider: string, contract: PluginStreamContract<S>, object: InferRpcData<S>, readInput: PluginStreamReadInput = {}): PluginChannelStream => {
        const operation = begin();
        // Every validation failure between admission and the real transfer must
        // return the just-taken Host operation lease, or a refused call leaks it.
        try {
          assertRpcData(contract.object, object);
          assertConsume(input, provider, contract.id, contract.version, 'stream', this.#options.process);
          const hash = contractHashOf({ lane: 'stream', id: contract.id, version: contract.version, object: contract.object });
          this.#assertLocalReadiness('stream', targetOf(provider, contract.id, contract.version), hash);
          const { deadlineAt, signal, release } = deadlineFor(operation, readInput.timeoutMs, readInput.signal);
          const objectId = String((object as { objectId?: unknown }).objectId ?? '');
          const version = Number((object as { version?: unknown }).version ?? 0);
          try {
            const handle = this.#options.hub.openStream(targetOf(provider, contract.id, contract.version), input.plugin, input.scope, hash, {
              objectId, version,
              offset: readInput.offset ?? 0,
              size: readInput.size ?? null,
              digest: readInput.digest ?? null,
              ...(readInput.creditBytes === undefined ? {} : { creditBytes: readInput.creditBytes }),
              ...(readInput.idleMs === undefined ? {} : { idleMs: readInput.idleMs }),
              deadlineAt,
              ...(signal === undefined ? {} : { signal }),
              purpose: operation.purpose,
              release,
            });
            input.trackPending(handle.completed.catch(() => undefined));
            return handle;
          } catch (error) { release(); throw error; }
        } catch (error) { operation.release(); throw error; }
      },
      openDuplex: <S extends RpcDataSchema>(provider: string, contract: PluginStreamContract<S>, object: InferRpcData<S>, duplexInput: PluginStreamDuplexInput = {}): PluginChannelDuplexSession => {
        const operation = begin();
        try {
          assertRpcData(contract.object, object);
          assertConsume(input, provider, contract.id, contract.version, 'stream', this.#options.process);
          const hash = contractHashOf({ lane: 'stream', id: contract.id, version: contract.version, object: contract.object });
          this.#assertLocalReadiness('stream', targetOf(provider, contract.id, contract.version), hash);
          const { deadlineAt, signal, release } = deadlineFor(operation, duplexInput.timeoutMs, duplexInput.signal);
          const objectId = String((object as { objectId?: unknown }).objectId ?? '');
          const version = Number((object as { version?: unknown }).version ?? 0);
          try {
            const handle = this.#options.hub.openDuplex(targetOf(provider, contract.id, contract.version), input.plugin, input.scope, hash, {
              objectId, version,
              ...(duplexInput.readOffset === undefined ? {} : { readOffset: duplexInput.readOffset }),
              readSize: duplexInput.readSize ?? null,
              readDigest: duplexInput.readDigest ?? null,
              writeSize: duplexInput.writeSize ?? null,
              writeDigest: duplexInput.writeDigest ?? null,
              ...(duplexInput.readCreditBytes === undefined ? {} : { readCreditBytes: duplexInput.readCreditBytes }),
              ...(duplexInput.writeCreditBytes === undefined ? {} : { writeCreditBytes: duplexInput.writeCreditBytes }),
              ...(duplexInput.idleMs === undefined ? {} : { idleMs: duplexInput.idleMs }),
              deadlineAt,
              ...(signal === undefined ? {} : { signal }),
              purpose: operation.purpose,
              release,
            });
            input.trackPending(handle.completed.catch(() => undefined));
            return handle;
          } catch (error) { release(); throw error; }
        } catch (error) { operation.release(); throw error; }
      },
      openWrite: <S extends RpcDataSchema>(provider: string, contract: PluginStreamContract<S>, object: InferRpcData<S>, writeInput: PluginStreamWriteInput = {}): PluginChannelWriteStream => {
        const operation = begin();
        try {
          assertRpcData(contract.object, object);
          assertConsume(input, provider, contract.id, contract.version, 'stream', this.#options.process);
          const hash = contractHashOf({ lane: 'stream', id: contract.id, version: contract.version, object: contract.object });
          this.#assertLocalReadiness('stream', targetOf(provider, contract.id, contract.version), hash);
          const { deadlineAt, signal, release } = deadlineFor(operation, writeInput.timeoutMs, writeInput.signal);
          const objectId = String((object as { objectId?: unknown }).objectId ?? '');
          const version = Number((object as { version?: unknown }).version ?? 0);
          try {
            const handle = this.#options.hub.openWriteStream(targetOf(provider, contract.id, contract.version), input.plugin, input.scope, hash, {
              objectId, version,
              size: writeInput.size ?? null,
              digest: writeInput.digest ?? null,
              ...(writeInput.creditBytes === undefined ? {} : { creditBytes: writeInput.creditBytes }),
              ...(writeInput.idleMs === undefined ? {} : { idleMs: writeInput.idleMs }),
              deadlineAt,
              ...(signal === undefined ? {} : { signal }),
              purpose: operation.purpose,
              release,
            });
            input.trackPending(handle.completed.catch(() => undefined));
            return handle;
          } catch (error) { release(); throw error; }
        } catch (error) { operation.release(); throw error; }
      },
    };

    const snapshot: PluginSnapshotServices = {
      provide: <S extends RpcDataSchema>(contract: PluginSnapshotContract<S>, provider: {
        current(): { readonly descriptor: ChannelSnapshotDescriptor; read(offset: number, length: number): Promise<Uint8Array> } | null;
        version(version: number): { readonly descriptor: ChannelSnapshotDescriptor; read(offset: number, length: number): Promise<Uint8Array> } | null;
      }): PluginChannelPublication => {
        const operation = begin();
        try {
          if (input.scope !== 'global') throw channelError('unauthorized', 'only global-scope channel publications are routable');
          assertRpcDataSchema(contract.content);
          const declared = laneKindOf(input.declarations, 'provides', { id: contract.id, version: contract.version, lane: 'snapshot', process: this.#options.process });
          if (declared === null) {
            throw channelError('unauthorized', 'snapshot publication is not declared by the manifest');
          }
          if (declared.scope !== 'global') throw channelError('unauthorized', 'binding-scope snapshot publications are not routable');
          const hash = contractHashOf({ lane: 'snapshot', id: contract.id, version: contract.version, content: contract.content });
          const handle = this.#options.hub.registerSnapshot(
            { lane: 'snapshot', provider: input.plugin, service: contract.id, major: contract.version, process: this.#options.process, contract: hash },
            wrapSnapshotProvider(provider),
          );
          return register('snapshot', contract.id, contract.version, hash, handle);
        } finally { operation.release(); }
      },
      consume: <S extends RpcDataSchema>(provider: string, contract: PluginSnapshotContract<S>): PluginSnapshotView => {
        assertActive();
        assertRpcDataSchema(contract.content);
        assertConsume(input, provider, contract.id, contract.version, 'snapshot', this.#options.process);
        const hash = contractHashOf({ lane: 'snapshot', id: contract.id, version: contract.version, content: contract.content });
        const target = targetOf(provider, contract.id, contract.version);
        this.#assertLocalReadiness('snapshot', target, hash);
        return this.#snapshotView(target, hash, input, ownerToken, viewKeys, contract.content as RpcDataSchema, assertActive);
      },
      store: (options: HostSnapshotStoreOptionsView): HostSnapshotStore | null => {
        assertActive();
        const namespace = this.#options.snapshotNamespace?.(input.plugin) ?? null;
        if (namespace === null) return null;
        const store = new HostSnapshotStore(namespace, {
          owner: input.plugin, id: options.id, schemaVersion: options.schemaVersion,
          ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
          ...(options.maxVersions === undefined ? {} : { maxVersions: options.maxVersions }),
          ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
          ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
        });
        this.#snapshotStores.add(store); snapshotStores.add(store);
        return store;
      },
    };

    const events: PluginEventServices = {
      provide: <S extends RpcDataSchema>(contract: PluginEventContract<S>, options: { readonly log?: PluginChannelReliableEventLog } = {}): PluginEventPublisher<S> => {
        const operation = begin();
        try {
          if (input.scope !== 'global') throw channelError('unauthorized', 'only global-scope channel publications are routable');
          assertRpcDataSchema(contract.event);
          const declared = laneKindOf(input.declarations, 'provides', { id: contract.id, version: contract.version, lane: 'events', process: this.#options.process });
          if (declared === null) {
            throw channelError('unauthorized', 'event publication is not declared by the manifest');
          }
          if (declared.scope !== 'global') throw channelError('unauthorized', 'binding-scope event publications are not routable');
          const maxEvents = contract.retention?.maxEvents ?? CHANNEL_EVENT_LOG_MAX;
          let log = options.log;
          if (contract.delivery === 'reliable' && log === undefined) {
            log = this.#options.eventLog?.({ plugin: input.plugin, topic: contract.id, major: contract.version, maxEvents }) ?? undefined;
          }
          if (contract.delivery === 'reliable' && log === undefined) throw channelError('capability_unavailable', 'a durable reliable event log is unavailable in this process');
          const hash = contractHashOf({ lane: 'event', id: contract.id, version: contract.version, delivery: contract.delivery, event: contract.event, retention: contract.retention ?? null });
          const resolvedLog: PluginChannelReliableEventLog | null = contract.delivery === 'reliable' ? log! : null;
          const provider: PluginChannelEventProvider = resolvedLog === null
            ? { delivery: 'transient' }
            : { delivery: 'reliable', log: resolvedLog };
          const handle = this.#options.hub.registerEvent(
            { lane: 'event', provider: input.plugin, service: contract.id, major: contract.version, process: this.#options.process, contract: hash },
            provider,
          );
          register('event', contract.id, contract.version, hash, handle);
          const publish = (payload: InferRpcData<S>): Promise<number> => {
            assertActive();
            if (contract.delivery !== 'reliable') return Promise.reject(channelError('invalid', 'a transient topic has no durable publish'));
            assertRpcData(contract.event, payload);
            // A NEW durable operation always passes the Host admission gate: a
            // stale (settled) bootstrap/RPC closure or a retiring owner can never
            // keep writing business state through a cached publisher.
            const operation = begin();
            const start = (): Promise<number> => {
              try { return this.#options.hub.publishReliable(handle, encodeEventPayload(payload)); }
              catch (error) { operation.release(); throw error; }
            };
            const pending = start();
            input.trackPending(pending.catch(() => undefined));
            return pending.finally(() => operation.release());
          };
          const publishWithState = (payload: InferRpcData<S>, command: DurableCommand): Promise<number> => {
            assertActive();
            if (contract.delivery !== 'reliable') throw channelError('invalid', 'a transient topic has no durable publish');
            const durable = this.#options.durableState?.(input.plugin) ?? null;
            const transactionLog = resolvedLog;
            const appendWithin = transactionLog?.appendWithinTransaction;
            if (durable === null || transactionLog === null || appendWithin === undefined) {
              throw channelError('capability_unavailable', 'same-transaction state + outbox commit is unavailable in this process');
            }
            assertRpcData(contract.event, payload);
            // Host admission precedes the durable append: a retiring owner must not
            // start a new outbox transaction through a cached publisher.
            const operation = begin();
            const start = (): Promise<number> => {
              try {
                const bytes = encodeEventPayload(payload);
                const payloadHash = createHash('sha256').update(bytes).digest('hex');
                // The outbox receipt id is derived from the stable command id, so the
                // same command can never produce a second event after a retry/restart.
                const receiptId = `outbox:${command.commandId}`;
                const appendRow = appendWithin.bind(transactionLog);
                const appendPlan = (payloadBytes: Uint8Array): { readonly sequence: number; readonly eventId: string } => {
                  let appended: { readonly sequence: number; readonly eventId: string } | null = null;
                  durable.execute(command, { extend: () => { appended = appendRow(payloadBytes, receiptId); } });
                  if (appended !== null) return appended;
                  // Idempotent replay: the first committed run already appended the
                  // event AND its durable receipt in the same transaction, so recover
                  // the first result instead of appending a second event.
                  const receipt = transactionLog.receipt?.(receiptId) ?? null;
                  if (receipt === null) throw channelError('failed', 'outbox receipt is missing after an idempotent replay');
                  if (receipt.payloadHash !== payloadHash) throw channelError('conflict', 'outbox command id was reused with a different event payload');
                  return { sequence: receipt.sequence, eventId: receipt.eventId };
                };
                return this.#options.hub.publishReliable(handle, bytes, appendPlan);
              } catch (error) { operation.release(); throw error; }
            };
            const pending = start();
            input.trackPending(pending.catch(() => undefined));
            return pending.finally(() => operation.release());
          };
          const publisher: PluginEventPublisher<S> = Object.freeze({
            contractId: contract.id,
            delivery: contract.delivery,
            publish,
            publishWithState,
            notify: (payload: InferRpcData<S>): boolean => {
              assertActive();
              if (contract.delivery !== 'transient') throw channelError('invalid', 'a reliable topic must use publish');
              assertRpcData(contract.event, payload);
              // A transient notification is still NEW work: it must pass the same
              // Host admission gate, not rely on `assertActive` alone.
              const operation = begin();
              try { this.#options.hub.publishTransient(handle, encodeEventPayload(payload)); return true; }
              finally { operation.release(); }
            },
          });
          return publisher;
        } finally { operation.release(); }
      },
      subscribe: <S extends RpcDataSchema>(provider: string, contract: PluginEventContract<S>, options: {
        readonly consumerId: string;
        readonly from?: number | null;
        readonly onEvent: (event: { readonly sequence: number; readonly eventId: string; readonly payload: InferRpcData<S>; readonly delivery: 'transient' | 'reliable' }) => void;
        readonly timeoutMs?: number;
        readonly signal?: AbortSignal;
      }): Promise<PluginChannelEventSubscription> => {
        const operation = begin();
        try {
          assertRpcDataSchema(contract.event);
          assertConsume(input, provider, contract.id, contract.version, 'events', this.#options.process);
          const hash = contractHashOf({ lane: 'event', id: contract.id, version: contract.version, delivery: contract.delivery, event: contract.event, retention: contract.retention ?? null });
          this.#assertLocalReadiness('event', targetOf(provider, contract.id, contract.version), hash);
          const { deadlineAt, signal, release } = deadlineFor(operation, options.timeoutMs, options.signal);
          const subscribed = this.#options.hub.subscribeEvents(targetOf(provider, contract.id, contract.version), input.plugin, input.scope, hash, {
            delivery: contract.delivery,
            consumerId: options.consumerId,
            from: options.from ?? null,
            deadlineAt,
            ...(signal === undefined ? {} : { signal }),
            purpose: operation.purpose,
            release,
            onEvent: (event: PluginChannelEventDelivery) => {
              let payload: unknown = null;
              try {
                payload = decodeEventPayload(event.payload);
                assertRpcData(contract.event, payload);
              } catch { throw channelError('invalid', 'event payload does not match its declared contract'); }
              options.onEvent({ sequence: event.sequence, eventId: event.eventId, payload: payload as InferRpcData<S>, delivery: event.delivery });
            },
          });
          // The hub only takes ownership of the release once the real subscribe
          // request was accepted; a synchronous refusal must not leak it.
          return Promise.resolve(subscribed).catch((error) => { release(); throw error; });
        } catch (error) { operation.release(); throw error; }
      },
    };

    const ownerHandle: HostChannelOwnerHandle = {
      stream,
      snapshot,
      events,
      capabilities: this.capabilities(),
      markReady: () => {
        // A declared channel publication that was never actually registered is a
        // real readiness failure: the owner must not be announced ready, or peers
        // would route to a service that does not exist.
        for (const service of input.declarations.provides ?? []) {
          if (service.process !== this.#options.process) continue;
          if (!CHANNEL_KINDS.has(service.kind ?? 'local')) continue;
          if ((service.scope ?? 'global') !== input.scope) continue;
          const lane = CHANNEL_KIND_LANE[service.kind as 'events' | 'snapshot' | 'stream'];
          const published = created.some((entry) => entry.registration.lane === lane
            && entry.registration.target.service === service.id
            && entry.registration.target.major === service.version);
          if (!published) throw channelError('not_ready', `declared ${service.kind} publication was not registered: ${service.id}`);
        }
        for (const entry of created) { this.#local.get(entry.key)!.ready = true; entry.registration.handle.markReady(); }
      },
      retire: () => {
        for (const entry of created) { this.#local.get(entry.key)!.ready = false; entry.registration.handle.retire(); }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        for (const entry of created) {
          const local = this.#local.get(entry.key);
          if (local !== undefined) { local.ready = false; if (local === entry.registration) this.#local.delete(entry.key); }
          try { entry.registration.handle.dispose(); } catch { /* already released */ }
        }
        created.length = 0;
        // Owner disposal tears down its own snapshot views: timers, listeners and
        // cached bytes are released instead of outliving the owner.
        for (const key of viewKeys) this.#disposeView(key);
        viewKeys.clear();
        for (const store of snapshotStores) this.#snapshotStores.delete(store);
        snapshotStores.clear();
      },
    };
    return Object.freeze(ownerHandle);
  }

  /** Bounded, rotating retry of snapshot retention; publication success is independent. */
  maintainSnapshots(limit = 8): { readonly stores: number; readonly removed: number; readonly failures: number } {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid snapshot maintenance limit');
    const selected: HostSnapshotStore[] = [];
    for (const store of this.#snapshotStores) {
      selected.push(store);
      if (selected.length >= Math.min(limit, 32)) break;
    }
    let removed = 0, failures = 0;
    for (const store of selected) {
      const result = store.maintain();
      removed += result.removed;
      if (result.error !== null) failures += 1;
      this.#snapshotStores.delete(store); this.#snapshotStores.add(store);
    }
    return Object.freeze({ stores: selected.length, removed, failures });
  }

  /** Host-only: local channel publications advertised to a peer over the directory. */
  publicationView(): readonly HostChannelPublicationView[] {
    const view: HostChannelPublicationView[] = [];
    for (const registration of this.#local.values()) {
      view.push(Object.freeze({
        provider: registration.target.provider,
        service: registration.target.service,
        major: registration.target.major,
        scope: 'global' as const,
        scopeKey: 'global',
        ready: registration.ready,
        lane: registration.lane,
        contract: registration.contract,
      }));
    }
    view.sort((left, right) => left.provider.localeCompare(right.provider)
      || left.service.localeCompare(right.service) || left.major - right.major);
    return Object.freeze(view);
  }

  #assertLocalReadiness(lane: 'stream' | 'snapshot' | 'event', target: PluginChannelTarget, hash: string): void {
    for (const [key, registration] of this.#local) {
      if (registration.target.provider !== target.provider || registration.target.service !== target.service || registration.target.major !== target.major) continue;
      if (registration.lane !== lane) continue;
      if (registration.contract !== hash) throw channelError('conflict', 'local channel contract does not match the caller contract');
      if (!registration.ready) throw channelError('not_ready', 'local channel provider is not ready');
      void key;
      return;
    }
    // No local registration: the host route resolver decides local/remote/ambiguous.
  }

  #snapshotView(target: PluginChannelTarget, hash: string, input: PluginChannelOwnerInput, ownerToken: string, viewKeys: Set<string>, contentSchema: RpcDataSchema, assertActive: () => void): PluginSnapshotView {
    // The key includes the owner instance token, so a same-named plugin/scope that
    // was disposed and re-created can never read or overwrite the old view.
    const key = laneTargetKey('snapshot', target, hash, input.plugin, `${input.scope}@${ownerToken}`);
    viewKeys.add(key);
    let state = this.#views.get(key);
    if (state === undefined) {
      // Bounded admission: a new view is refused once the host already holds the
      // maximum number of live views, so the cache cannot grow without limit.
      // Existing views (and their own next `sync()`) keep working.
      if (this.#views.size >= CHANNEL_SNAPSHOT_VIEW_MAX_COUNT) {
        throw channelError('overloaded', 'snapshot view cache is at its bounded capacity');
      }
      state = {
        target, contract: hash, caller: input.plugin, callerScope: input.scope, ownerToken,
        descriptor: null, bytes: null, status: 'empty', appliedAt: null, error: null, generation: 0,
        listeners: new Set(), timer: null, inflight: null,
      };
      this.#views.set(key, state);
    }
    const currentState = state;
    const owner = input;
    const syncOnce = async (options: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly version?: number | null; readonly force?: boolean }, background: boolean): Promise<'applied' | 'unchanged' | 'failed'> => {
      // `background` is the explicit Host context used by Host-managed
      // reconciliation: it never inherits a plugin's (possibly closed) frame.
      const operation = owner.beginOperation(background ? { background: true } : undefined);
      if (operation === null) {
        if (currentState.bytes === null) currentState.status = 'failed';
        currentState.error = 'not_ready';
        return 'failed';
      }
      const deadlineAt = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
      if (currentState.bytes === null) currentState.status = 'loading';
      const callDeadline = deadlineAt === undefined ? undefined : (operation.deadlineAt === undefined ? deadlineAt : Math.min(deadlineAt, operation.deadlineAt));
      const callSignal = combineSignals(operation.signal, options.signal);
      try {
        // Reconcile cheaply first: a descriptor read alone decides whether the
        // applied view is still current, so an unchanged refresh costs no body.
        const described = await this.#options.hub.describeSnapshot(target, owner.plugin, owner.scope, hash, {
          ...(options.version === undefined ? {} : { version: options.version }),
          ...(callDeadline === undefined ? {} : { deadlineAt: callDeadline }),
          ...(callSignal === undefined ? {} : { signal: callSignal }),
          purpose: operation.purpose,
        });
        // Full-descriptor reconciliation: version+digest alone would accept a
        // changed owner/epoch/schema/size for the same (version, digest) pair.
        const unchanged = currentState.descriptor !== null && descriptorsEqual(currentState.descriptor, described);
        if (unchanged && options.force !== true) {
          currentState.status = 'ready';
          currentState.error = null;
          return 'unchanged';
        }
        const read = await this.#options.hub.readSnapshot(target, owner.plugin, owner.scope, hash, {
          version: options.version ?? described.version,
          ...(callDeadline === undefined ? {} : { deadlineAt: callDeadline }),
          ...(callSignal === undefined ? {} : { signal: callSignal }),
          purpose: operation.purpose,
        });
        // The provider must have served exactly the descriptor we reconciled
        // against; otherwise the read is mixed and is refused.
        if (!descriptorsEqual(read.descriptor, described)) throw channelError('conflict', 'snapshot descriptor changed during the read');
        // A snapshot body is fixed UTF-8 JSON validated against the declared
        // content schema; a schema mismatch keeps the PREVIOUS snapshot and never
        // becomes ready.
        assertSnapshotContent(contentSchema, read.bytes);
        // Atomic replace: one synchronous swap of the whole view generation.
        currentState.generation += 1;
        currentState.descriptor = read.descriptor;
        currentState.bytes = new Uint8Array(read.bytes);
        currentState.appliedAt = Date.now();
        currentState.status = 'ready';
        currentState.error = null;
        this.#touchView(key, currentState);
        this.#enforceViewCache(key);
        // Every listener receives its OWN copy: a listener can never mutate the
        // verified bytes the view keeps and serves to later readers.
        for (const listener of [...currentState.listeners]) {
          try {
            listener(Object.freeze({ descriptor: currentState.descriptor, bytes: new Uint8Array(currentState.bytes!) }));
          } catch { /* listener failures never break the view */ }
        }
        return 'applied';
      } catch (error) {
        // A failed refresh (including a content-schema mismatch) keeps the
        // previous verified snapshot; it never half-applies.
        currentState.status = currentState.bytes === null ? 'failed' : 'stale';
        currentState.error = String((error as { code?: string } | null)?.code ?? 'failed');
        return 'failed';
      } finally { operation.release(); }
    };
    const schedule = (options: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly version?: number | null; readonly force?: boolean }, background: boolean): Promise<'applied' | 'unchanged' | 'failed'> => {
      if (currentState.inflight !== null) return currentState.inflight;
      const run = syncOnce(options, background);
      currentState.inflight = run;
      // When the in-flight pass ends the view is no longer mid-sync, so the cache
      // budget is re-enforced: a batch of concurrent refreshes can no longer leave
      // the host holding more than the bounded cache after they all settle.
      void run.finally(() => {
        if (currentState.inflight === run) currentState.inflight = null;
        this.#enforceViewCache(key);
      });
      return run;
    };
    const view: PluginSnapshotView = Object.freeze({
      // Every public view accessor is bound to the owning instance: a disposed (or
      // revoked) owner's view is refused outright, and a same-named re-created
      // owner can never borrow the old view's state.
      current: (): PluginChannelSnapshotRead | null => {
        assertActive();
        if (currentState.descriptor === null || currentState.bytes === null) return null;
        this.#touchView(key, currentState);
        // A defensive copy: the caller receives the verified bytes but can never
        // mutate the view the host keeps serving.
        return Object.freeze({ descriptor: currentState.descriptor, bytes: new Uint8Array(currentState.bytes) });
      },
      status: (): PluginSnapshotStatus => {
        assertActive();
        return Object.freeze({
          status: currentState.status,
          version: currentState.descriptor?.version ?? null,
          digest: currentState.descriptor?.digest ?? null,
          size: currentState.descriptor?.size ?? null,
          appliedAt: currentState.appliedAt,
          error: currentState.error,
        });
      },
      sync: (options = {}) => { assertActive(); return schedule(options, false); },
      start: (options: { readonly intervalMs?: number } = {}) => {
        assertActive();
        const intervalMs = options.intervalMs ?? 5_000;
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw channelError('invalid', 'snapshot reconciliation interval is invalid');
        if (currentState.timer !== null) clearInterval(currentState.timer);
        // Host-managed reconciliation runs in the explicit background context, so it
        // keeps working even when `start()` was called from a bootstrap closure.
        const timer = setInterval(() => { void schedule({}, true).catch(() => undefined); }, intervalMs);
        timer.unref?.();
        currentState.timer = timer;
        void schedule({}, true).catch(() => undefined);
        return () => {
          if (currentState.timer !== null) { clearInterval(currentState.timer); currentState.timer = null; }
        };
      },
      onApplied: (listener: (applied: PluginChannelSnapshotRead) => void) => {
        assertActive();
        currentState.listeners.add(listener);
        return () => { currentState.listeners.delete(listener); };
      },
    });
    return view;
  }

  /** Moves one view to the MRU end of the bounded cache. */
  #touchView(key: string, state: SnapshotViewState): void {
    if (this.#views.get(key) === state) { this.#views.delete(key); this.#views.set(key, state); }
  }

  /**
   * Bounds the total cached snapshot bytes. The least-recently-used view that is
   * neither the just-applied one nor holding no bytes is dropped: its bytes are
   * released and its status returns to `empty`, so the cache can never grow
   * without limit. An in-flight refresh is NOT exempt: its retained bytes count
   * against the budget like any other view, and its just-read body is written back
   * when the refresh completes. A dropped view reloads through its own next
   * `sync()`.
   */
  #enforceViewCache(protectKey: string): void {
    const total = (): number => {
      let bytes = 0;
      for (const state of this.#views.values()) bytes += state.bytes?.byteLength ?? 0;
      return bytes;
    };
    if (total() <= CHANNEL_SNAPSHOT_VIEW_CACHE_MAX_BYTES) return;
    for (const [key, state] of [...this.#views]) {
      if (total() <= CHANNEL_SNAPSHOT_VIEW_CACHE_MAX_BYTES) break;
      if (key === protectKey || state.bytes === null) continue;
      state.bytes = null;
      state.descriptor = null;
      state.status = 'empty';
    }
  }

  /** Host-only teardown of one owner's view: stop its timer and drop its state. */
  #disposeView(key: string): void {
    const state = this.#views.get(key);
    if (state === undefined) return;
    if (state.timer !== null) { clearInterval(state.timer); state.timer = null; }
    state.listeners.clear();
    state.bytes = null;
    state.descriptor = null;
    state.inflight = null;
    state.status = 'empty';
    this.#views.delete(key);
  }
}

function assertConsume(input: PluginChannelOwnerInput, provider: string, id: string, version: number, lane: 'stream' | 'snapshot' | 'events', process: PluginServiceProcess): LaneDeclaration {
  const declaration = laneKindOf(input.declarations, 'consumes', { plugin: provider, id, version, lane, process });
  if (declaration === null) {
    throw channelError('unauthorized', `${lane} consumption is not declared by the manifest`);
  }
  const consumption = input.declarations.consumes!.find(service => service.plugin === provider && service.id === id
    && service.version === version && service.kind === lane && service.process === process)!;
  const selfSnapshot = isCrossProcessSelfSnapshot(input.plugin, consumption, input.declarations);
  if (provider === input.plugin ? !selfSnapshot : !Object.hasOwn(input.dependencies, provider)) {
    throw channelError('unauthorized', `channel ${lane} consumption requires a declared dependency: ${provider}`);
  }
  return declaration;
}

function wrapStreamProvider<S extends RpcDataSchema>(
  provider: {
    open?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): PluginStreamSourceReader | null;
    accept?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): PluginStreamSinkWriter | null;
    duplex?(input: { readonly caller: string; readonly callerScope: string; readonly object: InferRpcData<S> }): {
      readonly source?: PluginStreamSourceReader;
      readonly sink?: PluginStreamSinkWriter;
    } | null;
  },
  schema: S,
): PluginChannelStreamProvider {
  const wrapped: PluginChannelStreamProvider = {};
  if (provider.open !== undefined) {
    wrapped.open = (input) => {
      assertRpcData(schema, { objectId: input.objectId, version: input.version });
      const reader = provider.open!({ caller: input.caller, callerScope: input.callerScope, object: { objectId: input.objectId, version: input.version } as unknown as InferRpcData<S> });
      if (reader === null) return null;
      const source: PluginChannelStreamSource = {
        size: reader.size,
        digest: reader.digest,
        read: async (offset, length) => reader.read(offset, length),
      };
      return source;
    };
  }
  if (provider.accept !== undefined) {
    wrapped.accept = (input) => {
      assertRpcData(schema, { objectId: input.objectId, version: input.version });
      const writer = provider.accept!({ caller: input.caller, callerScope: input.callerScope, object: { objectId: input.objectId, version: input.version } as unknown as InferRpcData<S> });
      if (writer === null) return null;
      const sink: PluginChannelStreamSink = {
        write: async (offset, bytes) => { await writer.write(offset, bytes); },
        finish: async (size, digest) => { await writer.finish(size, digest); },
        abort: (reason) => { try { writer.abort?.(reason); } catch { /* sink-owned */ } },
      };
      return sink;
    };
  }
  if (provider.duplex !== undefined) {
    wrapped.duplex = (input) => {
      assertRpcData(schema, { objectId: input.objectId, version: input.version });
      const impl = provider.duplex!({ caller: input.caller, callerScope: input.callerScope, object: { objectId: input.objectId, version: input.version } as unknown as InferRpcData<S> });
      if (impl === null) return null;
      const out: { source?: PluginChannelStreamSource; sink?: PluginChannelStreamSink } = {};
      if (impl.source !== undefined) {
        const reader = impl.source;
        out.source = { size: reader.size, digest: reader.digest, read: async (offset, length) => reader.read(offset, length) };
      }
      if (impl.sink !== undefined) {
        const writer = impl.sink;
        out.sink = {
          write: async (offset, bytes) => { await writer.write(offset, bytes); },
          finish: async (size, digest) => { await writer.finish(size, digest); },
          abort: (reason) => { try { writer.abort?.(reason); } catch { /* sink-owned */ } },
        };
      }
      return Object.freeze(out);
    };
  }
  return Object.freeze(wrapped);
}

function wrapSnapshotProvider(provider: {
  current(): PluginSnapshotVersionSource | null;
  version(version: number): PluginSnapshotVersionSource | null;
}): PluginChannelSnapshotProvider {
  const wrap = (value: PluginSnapshotVersionSource | null): PluginChannelSnapshotSource | null => {
    if (value === null) return null;
    // `retain`/`release` MUST survive the wrap: a bounded provider store keeps an
    // in-use version alive through exactly these calls. Dropping them lets GC free
    // (or evict) a version while the host is still reading it.
    return Object.freeze({
      descriptor: value.descriptor,
      read: (offset: number, length: number) => value.read(offset, length),
      ...(typeof value.retain === 'function' ? { retain: () => value.retain!() } : {}),
      ...(typeof value.release === 'function' ? { release: () => value.release!() } : {}),
    });
  };
  const wrapped: PluginChannelSnapshotProvider = {
    current: () => wrap(provider.current()),
    version: (version: number) => wrap(provider.version(version)),
  };
  return Object.freeze(wrapped);
}

function encodeEventPayload(payload: unknown): Uint8Array {
  return new TextEncoder().encode(encodeRpcJson(payload, CHANNEL_EVENT_MAX_PAYLOAD_BYTES));
}

function decodeEventPayload(bytes: Uint8Array): unknown {
  return decodeRpcJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), CHANNEL_EVENT_MAX_PAYLOAD_BYTES) as RpcJson;
}

/* -------------------------------------------------------------------------- */
/* Default durable reliable-event log over the host communication store         */
/* -------------------------------------------------------------------------- */

/** Bounded replay window; the retained event log never grows past this. */
export const CHANNEL_EVENT_LOG_MAX = 128;
const CHANNEL_EVENT_LOG_HARD_MAX = 4096;
/** Bounded total bytes the host-managed snapshot view cache may retain. */
export const CHANNEL_SNAPSHOT_VIEW_CACHE_MAX_BYTES = 128 * 1024 * 1024;
/** Bounded number of live snapshot views a host adapter may hold at once. */
export const CHANNEL_SNAPSHOT_VIEW_MAX_COUNT = 64;

/** Combines independent abort signals without dropping any of them. */
function combineSignals(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const any = (AbortSignal as unknown as { any?: (list: readonly AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any.call(AbortSignal, present);
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => { if (!controller.signal.aborted) controller.abort(signal.reason); };
  for (const signal of present) {
    if (signal.aborted) { abort(signal); break; }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

/**
 * Namespace-isolated durable log over the host's `plugin_communication_records`
 * table. It owns no schema and no file: the table is created by the audited v14
 * migration, and one provider plugin can never read another namespace.
 *
 * Durability contract:
 * - sequence is monotonic and durable (a per-topic meta record), so publishing
 *   continues after every consumer acknowledged and never restarts at 1;
 * - event ids are derived from (namespace, topic, sequence), so two events with
 *   identical payloads are still distinct;
 * - every append + prune + meta update is ONE immediate transaction;
 * - retention is an explicit bounded policy (events per topic), never one
 *   consumer's ack, so a second consumer can still replay inside the window;
 * - checkpoints are per consumer and monotonic.
 */
export class StoreBackedReliableEventLog implements PluginChannelReliableEventLog {
  readonly #store: CommunicationNamespaceStore;
  readonly #topic: string;
  readonly #major: number;
  readonly #maxEvents: number;
  readonly #namespaceKey: string;
  readonly #eventPrefix: string;
  readonly #checkpointPrefix: string;
  readonly #metaKey: string;

  constructor(store: CommunicationNamespaceStore, topic: string, maxEvents: number = CHANNEL_EVENT_LOG_MAX, major = 1) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > CHANNEL_EVENT_LOG_HARD_MAX) {
      throw channelError('invalid', 'event retention must be a bounded positive integer');
    }
    if (!Number.isSafeInteger(major) || major < 1) throw channelError('invalid', 'event contract major is invalid');
    this.#store = store;
    this.#topic = topic;
    this.#major = major;
    this.#maxEvents = maxEvents;
    // A different contract major has a different schema and must never share a
    // sequence, an event id or a retention window with another major.
    this.#namespaceKey = `${topic}@${major}`;
    this.#eventPrefix = `e:${shortHash(this.#namespaceKey)}:`;
    this.#checkpointPrefix = `c:${shortHash(this.#namespaceKey)}:`;
    this.#metaKey = `m:${shortHash(this.#namespaceKey)}`;
  }

  get topic(): string { return this.#topic; }
  get major(): number { return this.#major; }

  #eventKey(sequence: number): string {
    return `${this.#eventPrefix}${String(sequence).padStart(16, '0')}`;
  }

  #checkpointKey(consumerId: string): string {
    return `${this.#checkpointPrefix}${shortHash(consumerId)}`;
  }

  #eventId(sequence: number): string {
    // Stable and unique per (namespace, topic, major, sequence): never a payload
    // hash, so two events with identical content stay distinct, and a different
    // contract major can never alias this log.
    return createHash('sha256').update(`${this.#store.namespace}\0${this.#namespaceKey}\0${String(sequence)}`).digest('hex');
  }

  /**
   * Reads the durable watermark. A missing record is an empty log; a present but
   * unparsable/invalid record is CORRUPTION and throws — it must never be
   * silently reported as "no events", which would reset the sequence and renumber
   * or lose retained events.
   */
  #readMeta(mutator: CommunicationMutator): { readonly latest: number; readonly pruned: number } {
    const record = mutator.get(this.#metaKey);
    if (record === null) return { latest: 0, pruned: 0 };
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.payload)); }
    catch { throw channelError('corruption', 'reliable event log watermark is unreadable'); }
    if (parsed === null || typeof parsed !== 'object') throw channelError('corruption', 'reliable event log watermark is invalid');
    const latest = (parsed as { latest?: unknown }).latest;
    const pruned = (parsed as { pruned?: unknown }).pruned;
    if (typeof latest !== 'number' || !Number.isSafeInteger(latest) || latest < 0
      || typeof pruned !== 'number' || !Number.isSafeInteger(pruned) || pruned < 0 || pruned > latest) {
      throw channelError('corruption', 'reliable event log watermark is invalid');
    }
    return { latest, pruned };
  }

  #writeMeta(mutator: CommunicationMutator, latest: number, pruned: number): void {
    // Non-required, never-expiring: durable across restarts, overwritable, and
    // never collected (the store only collects rows with an expiry).
    mutator.put(this.#metaKey, new TextEncoder().encode(JSON.stringify({ latest, pruned })), { required: false, expiresAt: null });
  }

  #receiptKey(receiptId: string): string {
    // Bounded, identifier-safe, and derived from this log's own namespace.
    return `r:${shortHash(this.#namespaceKey)}:${shortHash(receiptId)}`;
  }

  #appendWithin(mutator: CommunicationMutator, payload: Uint8Array, receiptId?: string): { readonly sequence: number; readonly eventId: string } {
    if (!(payload instanceof Uint8Array)) throw channelError('invalid', 'event payload must be bytes');
    const meta = this.#readMeta(mutator);
    const sequence = meta.latest + 1;
    mutator.put(this.#eventKey(sequence), payload, { required: true });
    let pruned = meta.pruned;
    const retained = sequence - pruned;
    if (retained > this.#maxEvents) {
      const target = sequence - this.#maxEvents;
      for (let stale = pruned + 1; stale <= target; stale += 1) {
        // The row MUST exist (it is above the last pruned watermark): a failed
        // removal means the watermark must not advance, so the whole append rolls
        // back instead of claiming a retention window it did not reach.
        if (!mutator.ack(this.#eventKey(stale))) {
          throw channelError('corruption', 'reliable event log retention row is missing');
        }
      }
      pruned = target;
    }
    this.#writeMeta(mutator, sequence, pruned);
    const eventId = this.#eventId(sequence);
    if (receiptId !== undefined) {
      // The outbox receipt is written in the SAME transaction as the event row, so
      // a committed command always has a durable (sequence, eventId, payloadHash)
      // to return on an idempotent retry after a crash or lost response.
      const receipt = JSON.stringify({
        sequence, eventId,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
      });
      mutator.put(this.#receiptKey(receiptId), new TextEncoder().encode(receipt), { required: false, expiresAt: null });
    }
    return Object.freeze({ sequence, eventId });
  }

  append(payload: Uint8Array): { readonly sequence: number; readonly eventId: string } {
    return this.#store.transact(mutator => this.#appendWithin(mutator, payload));
  }

  appendWithinTransaction(payload: Uint8Array, receiptId?: string): { readonly sequence: number; readonly eventId: string } {
    return this.#appendWithin(this.#store.mutator(), payload, receiptId);
  }

  receipt(receiptId: string): { readonly sequence: number; readonly eventId: string; readonly payloadHash: string } | null {
    const record = this.#store.get(this.#receiptKey(receiptId));
    if (record === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.payload)); }
    catch { throw channelError('corruption', 'outbox receipt is unreadable'); }
    if (parsed === null || typeof parsed !== 'object') throw channelError('corruption', 'outbox receipt is invalid');
    const { sequence, eventId, payloadHash } = parsed as { sequence?: unknown; eventId?: unknown; payloadHash?: unknown };
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1
      || typeof eventId !== 'string' || typeof payloadHash !== 'string') {
      throw channelError('corruption', 'outbox receipt is invalid');
    }
    return Object.freeze({ sequence, eventId, payloadHash });
  }

  oldestSequence(): number | null {
    const meta = this.#readMeta(this.#store.mutator());
    return meta.latest === 0 ? null : meta.pruned + 1;
  }

  latestSequence(): number {
    return this.#readMeta(this.#store.mutator()).latest;
  }

  prunedThrough(): number {
    return this.#readMeta(this.#store.mutator()).pruned;
  }

  async list(fromSequence: number, limit: number): Promise<readonly { readonly sequence: number; readonly eventId: string; readonly payload: Uint8Array }[]> {
    const capped = Math.max(1, Math.min(limit, CHANNEL_EVENT_REPLAY_BATCH));
    const meta = this.#readMeta(this.#store.mutator());
    const result: { sequence: number; eventId: string; payload: Uint8Array }[] = [];
    for (let sequence = Math.max(1, fromSequence); sequence <= meta.latest && result.length < capped; sequence += 1) {
      const record = this.#store.get(this.#eventKey(sequence));
      // A hole INSIDE the retained window is corruption, never "the log ended":
      // reporting a short (or empty) replay as success would hide lost events.
      if (record === null) throw channelError('corruption', 'reliable event log has a hole inside the retained window');
      result.push({ sequence, eventId: this.#eventId(sequence), payload: new Uint8Array(record.payload) });
    }
    return Object.freeze(result);
  }

  checkpoint(consumerId: string): number {
    const record = this.#store.get(this.#checkpointKey(consumerId));
    if (record === null) return 0;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(record.payload); }
    catch { throw channelError('corruption', 'reliable event checkpoint is unreadable'); }
    const sequence = Number(text);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw channelError('corruption', 'reliable event checkpoint is invalid');
    return sequence;
  }

  ack(consumerId: string, sequence: number): { readonly acked: number } {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw channelError('invalid', 'event ack sequence is invalid');
    const key = this.#checkpointKey(consumerId);
    const acked = this.#store.transact(mutator => {
      const current = mutator.get(key);
      let prior = 0;
      if (current !== null) {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(current.payload); }
        catch { throw channelError('corruption', 'reliable event checkpoint is unreadable'); }
        const existing = Number(text);
        if (!Number.isSafeInteger(existing) || existing < 0) throw channelError('corruption', 'reliable event checkpoint is invalid');
        prior = existing;
      }
      // Monotonic: an older sequence never lowers the durable checkpoint.
      if (sequence <= prior) return prior;
      mutator.put(key, new TextEncoder().encode(String(sequence)), { required: false, expiresAt: null });
      return sequence;
    });
    return Object.freeze({ acked });
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** Host factory: one namespace-isolated log per provider plugin + topic. */
export function createReliableEventLogFactory(
  namespaceStore: (plugin: string) => CommunicationNamespaceStore | null,
): PluginReliableEventLogFactory {
  return ({ plugin, topic, major, maxEvents }) => {
    const store = namespaceStore(plugin);
    return store === null ? null : new StoreBackedReliableEventLog(store, topic, maxEvents, major);
  };
}
