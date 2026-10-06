/** Public same-process plugin services. Cross-process callers require the host RPC adapter. */
import type { PluginServiceDeclarations, PluginServiceProcess } from './plugin-services/contracts';
import { assertSupportedServiceDeclarations, isCrossProcessSelfSnapshot } from './plugin-services/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HostRpcAdapter, RpcServiceError, type HostRpcAdapterOptions, type HostRpcLifecycleIdentity, type HostRpcOwnerHandle, type HostRpcInvocationContext, type HostRpcLeaseRequest, type HostRpcLeaseGrant, type HostRpcHandlerFrame } from './plugin-services/host-rpc';
import type { RpcCallPurpose, RpcMethodDefinition } from './plugin-services/wire-contract';
import type { HostChannelOperation, HostChannelOwnerHandle, PluginChannelCapabilities, PluginChannelOwnerInput, PluginEventServices, PluginSnapshotServices, PluginStreamServices } from './plugin-services/channels';
export { defineRpcService } from './plugin-services/wire-contract';
export { RpcServiceError } from './plugin-services/host-rpc';
export { HostSnapshotStore, type HostSnapshotStoreOptions } from './plugin-services/snapshot-store';
export type { AsyncRpcClient, HostRpcCommandCapabilities, RpcCallOptions, RpcServiceErrorCode } from './plugin-services/host-rpc';
export type { RpcHandlerMap, RpcHandlerContext } from './plugin-services/rpc-runtime';
export type { RpcDataSchema, RpcMethodDefinition, InferRpcData } from './plugin-services/wire-contract';
export type { PluginServiceDeclarations, PluginServicePublication, PluginServiceConsumption, PluginServiceProcess, PluginServiceKind, PluginServiceScope } from './plugin-services/contracts';
export type {
  PluginStreamServices, PluginSnapshotServices, PluginEventServices, PluginStreamContract, PluginSnapshotContract,
  PluginEventContract, PluginChannelPublication, PluginStreamReadInput, PluginStreamWriteInput, PluginStreamDuplexInput,
  PluginSnapshotView, PluginSnapshotStatus, PluginEventPublisher, PluginChannelCapabilities, HostChannelPublicationView,
  PluginSnapshotVersionSource, HostSnapshotStoreOptionsView,
} from './plugin-services/channels';
export type { PluginChannelDuplexSession, PluginChannelDuplexResult } from './plugin-services/peer-channel-hub';

const CHANNEL_KINDS = new Set(['events', 'snapshot', 'stream']);

export interface PluginServices {
  /** Explicit owner-bound background invocation; never inherits a stale/request frame. */
  runBackground?<T>(run: () => T): T;
  onDispose(cleanup: () => void): void;
  publish<T extends object>(serviceId: string, contractVersion: number, implementation: T): void;
  consume<T extends object>(provider: string, serviceId: string, contractVersion: number): Readonly<T>;
  /** Typed asynchronous data-only services, when the host communication runtime is configured. */
  readonly rpc?: Pick<HostRpcOwnerHandle, 'publish' | 'consume'>;
  /** Bounded, cancelable chunked byte channels over the authenticated peer link. */
  readonly stream?: PluginStreamServices;
  /** Transient notifications and durable at-least-once topics. */
  readonly events?: PluginEventServices;
  /** Versioned immutable snapshots with digest verification. */
  readonly snapshot?: PluginSnapshotServices;
  /** Explicit deployment capabilities for the channel lanes (checked before declaring work). */
  readonly channelCapabilities?: PluginChannelCapabilities;
}

export interface PluginServiceCommunications extends Omit<HostRpcAdapterOptions, 'process' | 'enterHostHandlerFrame'> {
  /** Real process/owner identity supplied by the runtime, never invented by the plugin. */
  readonly identity: (plugin: string, scope: string) => HostRpcLifecycleIdentity;
  /**
   * Trusted host hook, called for one declared RPC consumption before the
   * adapter resolves its route. It lets the host register the native remote
   * proxy for the consumer's own contract so `resolvePlacement` can select it.
   * A host that does not implement remote routing simply omits it.
   */
  readonly ensureRemoteRoute?: (input: {
    readonly plugin: string;
    readonly scope: string;
    readonly provider: string;
    readonly contract: { readonly id: string; readonly version: number; readonly methods: Record<string, RpcMethodDefinition> };
  }) => void;
  /**
   * Host-owned event/snapshot/stream adapter. It is created by the same process
   * composition that owns the peer link, so channel work rides the one
   * authenticated transport and the canonical owner lifecycle.
   */
  readonly channels?: (input: PluginChannelOwnerInput) => HostChannelOwnerHandle;
}
export interface PluginServiceInvocation {
  readonly purpose: RpcCallPurpose;
  /** Exact pre-admission lease returned by this host; request/attempt require it. */
  readonly lease?: () => void;
  readonly callee?: unknown;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}
interface LeaseProof { readonly retained: ReadonlySet<Owner>; released: boolean }
interface InvocationFrame extends HostRpcInvocationContext { readonly proof?: LeaseProof; readonly callee?: unknown; readonly ownerAuthority?: Owner; readonly peerAuthenticated?: boolean }
interface RpcReference { readonly owner: Owner }

type Owner = {
  plugin: string; scope: string; dependencies: Readonly<Record<string, string>>;
  ready: boolean; retiring: boolean; revoked: boolean; cleaning: boolean; leases: number;
  pending: Set<Promise<unknown>>; waiters: Array<() => void>; cleanups: Set<() => void>;
  consumed: Set<Owner>;
  rpcConsumed: Map<string, RpcReference>;
  rpc?: HostRpcOwnerHandle;
  channels?: HostChannelOwnerHandle;
};
type Publication = { owner: Owner; id: string; version: number; kind: 'local' | 'rpc'; implementation?: object };

/** Cleanup failed after the context was fully revoked; runtime teardown must still run. */
export class PluginServiceCleanupError extends AggregateError {
  constructor(failures: readonly unknown[]) { super(failures, 'Plugin service cleanup failed'); }
}

export class PluginServiceHost {
  readonly rpc?: HostRpcAdapter;
  private readonly frames = new AsyncLocalStorage<InvocationFrame>();
  private readonly leaseProofs = new WeakMap<() => void, LeaseProof>();
  private readonly liveInvocations = new WeakSet<object>();
  private readonly ownerTokens = new WeakSet<object>();
  private readonly disposals = new WeakMap<Owner, Promise<void>>();
  private readonly communications?: PluginServiceCommunications;
  constructor(readonly process: PluginServiceProcess = 'worker', communications?: PluginServiceCommunications) {
    this.communications = communications;
    if (communications) this.rpc = new HostRpcAdapter({
      ...communications, process,
      enterHostHandlerFrame: (hostFrame, run) => this.runHostHandlerFrame(hostFrame, run),
    });
  }
  private contracts?: ReadonlyMap<string, PluginServiceDeclarations>;
  setDeclarations(contracts: ReadonlyMap<string, PluginServiceDeclarations>): void {
    for (const declarations of contracts.values()) assertSupportedServiceDeclarations(declarations);
    this.contracts = new Map(contracts);
  }
  /** Trusted host view of the declared service graph; never exposed to plugins. */
  serviceDeclarations(): ReadonlyMap<string, PluginServiceDeclarations> { return this.contracts ?? new Map(); }
  private owners = new Map<string, Owner>();
  private contexts = new WeakMap<PluginServices, Owner>();
  private publications = new Map<string, Publication>();
  private key(plugin: string, scope: string): string { return `${plugin}\0${scope}`; }
  private publicationKey(plugin: string, scope: string, id: string, version: number): string {
    return `${plugin}\0${scope}\0${id}\0${version}`;
  }
  isReady(plugin: string, scope = 'global'): boolean {
    const owner = this.owners.get(this.key(plugin, scope));
    return !!owner?.ready && !owner.retiring && !owner.revoked;
  }
  /** Trusted runtime entry; not exposed through PluginServices. */
  runInInvocation<T>(context: PluginServices, invocation: PluginServiceInvocation, run: () => T): T {
    const owner = this.contexts.get(context);
    if (!owner || owner.revoked || this.owners.get(this.key(owner.plugin, owner.scope)) !== owner) throw new RpcServiceError('unauthorized');
    const proof = invocation.lease === undefined ? undefined : this.leaseProofs.get(invocation.lease);
    if (invocation.purpose === 'request' || invocation.purpose === 'attempt') {
      if (!proof || proof.released || !proof.retained.has(owner)) throw new RpcServiceError('unauthorized');
    } else if (owner.retiring) throw new RpcServiceError('retired');
    const frame: InvocationFrame = Object.freeze({ ...invocation, proof, token: Object.freeze({}) });
    this.liveInvocations.add(frame.token);
    return this.frames.run(frame, () => {
      try {
        const result = run();
        if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
          return Promise.resolve(result).finally(() => this.liveInvocations.delete(frame.token)) as T;
        }
        this.liveInvocations.delete(frame.token);
        return result;
      } catch (error) { this.liveInvocations.delete(frame.token); throw error; }
    });
  }
  /** Broker-only entry after physical-peer and per-call identity projection. */
  runPeerInvocation<T>(purpose: 'request' | 'attempt', callee: unknown, run: () => T): T {
    const frame: InvocationFrame = Object.freeze({purpose, callee, peerAuthenticated: true, token: Object.freeze({})});
    this.liveInvocations.add(frame.token);
    return this.frames.run(frame, () => {
      try {
        const result = run();
        if (result && typeof (result as any).then === 'function') return Promise.resolve(result).finally(() => this.liveInvocations.delete(frame.token)) as T;
        this.liveInvocations.delete(frame.token); return result;
      } catch (error) { this.liveInvocations.delete(frame.token); throw error; }
    });
  }
  /** Read by the trusted callee resolver to carry management/request authority. */
  currentInvocation(): Readonly<HostRpcInvocationContext & { readonly callee?: unknown }> | null {
    const frame = this.frames.getStore();
    return frame === undefined || !this.liveInvocations.has(frame.token) ? null : Object.freeze({ purpose: frame.purpose, token: frame.token, signal: frame.signal, deadlineAt: frame.deadlineAt, callee: frame.callee });
  }
  /**
   * Enters one live host-handler frame bound to the exact published owner, so a
   * native RPC handler shares the SAME trusted invocation store as local
   * dispatch. The frame is live only for the handler's real duration; a stale
   * (settled) frame is therefore never observable.
   */
  private runHostHandlerFrame(host: HostRpcHandlerFrame, run: () => unknown): unknown {
    const owner = host.ownerToken !== null && this.ownerTokens.has(host.ownerToken) ? host.ownerToken as Owner : undefined;
    const frame: InvocationFrame = Object.freeze({
      purpose: host.purpose,
      token: Object.freeze({}),
      ...(host.signal === undefined ? {} : { signal: host.signal }),
      ...(host.deadlineAt === undefined ? {} : { deadlineAt: host.deadlineAt }),
      ...(owner === undefined ? {} : { ownerAuthority: owner }),
    });
    this.liveInvocations.add(frame.token);
    const settle = (): void => { this.liveInvocations.delete(frame.token); };
    return this.frames.run(frame, () => {
      try {
        const result = run();
        if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
          return Promise.resolve(result).finally(settle);
        }
        settle();
        return result;
      } catch (error) { settle(); throw error; }
    });
  }
  createContext(plugin: string, scope = 'global', dependencies: Readonly<Record<string, string>> = {}): PluginServices {
    const key = this.key(plugin, scope);
    if (this.owners.has(key)) throw new Error(`Service context already exists: ${plugin}/${scope}`);
    const declarations = this.contracts?.get(plugin);
    if (!this.rpc && (declarations?.provides?.some(service => service.process === this.process && service.kind === 'rpc')
      || declarations?.consumes?.some(service => service.process === this.process && service.kind === 'rpc'))) {
      throw new RpcServiceError('capability_unavailable');
    }
    const channelProvider = declarations?.provides?.some(service => service.process === this.process && CHANNEL_KINDS.has(service.kind ?? 'local')) === true;
    const channelConsumer = declarations?.consumes?.some(service => service.process === this.process && CHANNEL_KINDS.has(service.kind ?? 'local')) === true;
    // A declared channel provider or required consumer without the host channel
    // adapter is refused here (capability_unavailable), never silently degraded.
    if ((channelProvider || channelConsumer) && this.communications?.channels === undefined) {
      throw new RpcServiceError('capability_unavailable');
    }
    const owner: Owner = { plugin, scope, dependencies: Object.freeze({ ...dependencies }), consumed: new Set(), rpcConsumed: new Map(), ready: false, retiring: false, revoked: false, cleaning: false, leases: 0, pending: new Set(), waiters: [], cleanups: new Set() };
    this.owners.set(key, owner);
    this.ownerTokens.add(owner);
    try {
      if (this.rpc) {
        owner.rpc = this.rpc.createOwner({
          token: owner, plugin, scope, dependencies: owner.dependencies,
          declarations: this.contracts?.get(plugin) ?? {}, lifecycle: this.communications!.identity(plugin, scope),
          getLifecycleState: () => ({ ready: owner.ready, retiring: owner.retiring, revoked: owner.revoked }),
          acquireLease: request => this.acquireRpcLease(owner, request),
          resolveInvocationContext: () => this.currentInvocation(),
          registerPublication: publication => {
            const publicationKey = this.publicationKey(plugin, scope, publication.id, publication.version);
            if (this.publications.has(publicationKey)) throw new RpcServiceError('invalid_registration');
            this.publications.set(publicationKey, { owner, id: publication.id, version: publication.version, kind: 'rpc' });
          },
          registerConsumption: (declaration, providerToken) => {
            const referenceKey = this.publicationKey(declaration.plugin, 'global', declaration.id, declaration.version);
            if (providerToken) {
              const provider = [...this.owners.values()].find(candidate => candidate === providerToken);
              if (!provider || provider.revoked) throw new RpcServiceError('unavailable');
              owner.rpcConsumed.set(referenceKey, { owner: provider });
            } else owner.rpcConsumed.delete(referenceKey);
          },
        });
      }
      if (this.communications?.channels !== undefined && (channelProvider || channelConsumer)) {
        owner.channels = this.communications.channels({
          plugin, scope, declarations: this.contracts?.get(plugin) ?? {},
          dependencies: owner.dependencies,
          lifecycle: this.communications.identity(plugin, scope),
          getLifecycleState: () => ({ ready: owner.ready, retiring: owner.retiring, revoked: owner.revoked }),
          trackPending: (pending: Promise<unknown>) => {
            owner.pending.add(pending);
            void pending.finally(() => { owner.pending.delete(pending); this.notify(owner); }).catch(() => {});
          },
          beginOperation: (options) => this.beginChannelOperation(plugin, scope, options),
        });
      }
    } catch (error) { this.owners.delete(key); throw error; }
    const assertActive = (target = owner) => {
      if (target.revoked || (target.retiring && !target.cleaning && !owner.cleaning && target.leases === 0 && target.pending.size === 0)) throw new Error(`Plugin service handle revoked: ${target.plugin}`);
    };
    const wrap = (value: unknown, provider: Owner, receiver?: object): any => {
      if (typeof value === 'function') return (...args: unknown[]) => {
        assertActive(); assertActive(provider);
        const guardArgument = (arg: unknown): unknown => {
          if (typeof arg === 'function') return (...callbackArgs: unknown[]) => {
            assertActive(); assertActive(provider);
            const result = Reflect.apply(arg, undefined, callbackArgs);
            if (result && typeof result.then === 'function') {
              const pending = Promise.resolve(result);
              owner.pending.add(pending); provider.pending.add(pending);
              void pending.finally(() => { owner.pending.delete(pending); provider.pending.delete(pending); this.notify(owner); this.notify(provider); }).catch(() => {});
              return pending;
            }
            return result;
          };
          if (Array.isArray(arg)) return Object.freeze(arg.map(guardArgument));
          if (arg && typeof arg === 'object') return Object.freeze(Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, guardArgument(value)])));
          return arg;
        };
        const guarded = args.map(guardArgument);
        const result = Reflect.apply(value, receiver, guarded);
        if (result && typeof result.then === 'function') {
          const pending = Promise.resolve(result).then(output => { assertActive(); assertActive(provider); return wrap(output, provider); });
          owner.pending.add(pending); provider.pending.add(pending);
          void pending.finally(() => { owner.pending.delete(pending); provider.pending.delete(pending); this.notify(owner); this.notify(provider); }).catch(() => {});
          return pending;
        }
        return wrap(result, provider);
      };
      if (Array.isArray(value)) return Object.freeze(value.map(item => wrap(item, provider)));
      if (value && typeof value === 'object') {
        // A fresh facade prevents access to implementation identity or mutable provider fields.
        const facade: Record<string, unknown> = {};
        for (const key of Object.keys(value)) Object.defineProperty(facade, key, {
          enumerable: true, get: () => { assertActive(); assertActive(provider); return wrap((value as any)[key], provider, value as object); },
        });
        return Object.freeze(facade);
      }
      return value;
    };
    const consume = <T extends object>(provider: string, id: string, version: number): Readonly<T> => {
      assertActive();
      const declaration = this.contracts?.get(plugin)?.consumes?.find(value => value.plugin === provider && value.id === id && value.version === version && value.process === this.process);
      if (this.contracts && !declaration) throw new Error(`Undeclared plugin service consumption: ${plugin} -> ${provider}/${id}`);
      if (declaration?.kind && declaration.kind !== 'local') throw new Error('Non-local services require their asynchronous host adapter');
      if (provider === plugin || !Object.hasOwn(owner.dependencies, provider)) throw new Error(`Undeclared plugin service dependency: ${plugin} -> ${provider}`);
      const targetScope = 'global';
      const publication = this.publications.get(this.publicationKey(provider, targetScope, id, version));
      if (!publication || !publication.owner.ready || publication.owner.retiring || publication.owner.revoked) {
        if ([...this.publications.values()].some(value => value.owner.plugin === provider && value.owner.scope === targetScope && value.id === id && value.version !== version)) throw new Error(`Plugin service contract mismatch: ${provider}/${id}`);
        throw new Error(`Plugin service not ready: ${provider}/${id}`);
      }
      owner.consumed.add(publication.owner);
      return wrap(publication.implementation, publication.owner);
    };
    const context: PluginServices = Object.freeze({
      runBackground: <T>(run: () => T): T => {
        if (this.contexts.get(context) !== owner || this.owners.get(key) !== owner
          || !owner.ready || owner.retiring || owner.revoked) throw new RpcServiceError('retired');
        const release = this.acquireLease(plugin, scope);
        try {
          const result = this.runInInvocation(context, { purpose: 'background' }, run);
          if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
            return Promise.resolve(result).finally(release) as T;
          }
          release();
          return result;
        } catch (error) { release(); throw error; }
      },
      onDispose: (cleanup: () => void) => { assertActive(); owner.cleanups.add(cleanup); },
      publish: <T extends object>(id: string, version: number, implementation: T) => {
        assertActive();
        const candidates = this.contracts?.get(plugin)?.provides?.filter(value => value.id === id && value.version === version && value.process === this.process);
        const declaration = candidates?.[0];
        if (this.contracts && !declaration) throw new Error(`Undeclared plugin service publication: ${plugin}/${id}`);
        if (declaration?.kind && declaration.kind !== 'local') throw new Error('Non-local services require their asynchronous host adapter');
        if (owner.scope !== 'global') throw new Error('Only global providers may publish global services');
        if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid service contract version');
        const publicationKey = this.publicationKey(plugin, owner.scope, id, version);
        if (this.publications.has(publicationKey)) throw new Error(`Service already published: ${plugin}/${id}`);
        this.publications.set(publicationKey, { owner, id, version, implementation, kind: 'local' });
      },
      consume: <T extends object>(provider: string, id: string, version: number): Readonly<T> => consume<T>(provider, id, version),
      rpc: owner.rpc === undefined ? undefined : (() => {
        const ownerHandle = owner.rpc!;
        const prepare = (provider: string, contract: { readonly id: string; readonly version: number; readonly methods: Record<string, RpcMethodDefinition> }): void => {
          try { this.communications?.ensureRemoteRoute?.({ plugin, scope: owner.scope, provider, contract }); }
          catch { /* an unroutable remote declaration stays unavailable, never guessed */ }
        };
        return Object.freeze({
          publish: ownerHandle.publish,
          consume: <const M extends Record<string, RpcMethodDefinition>>(provider: string, contract: { readonly id: string; readonly version: number; readonly methods: M }) => {
            prepare(provider, contract);
            return ownerHandle.consume(provider, contract);
          },
        });
      })(),
      stream: owner.channels?.stream,
      events: owner.channels?.events,
      snapshot: owner.channels?.snapshot,
      channelCapabilities: owner.channels?.capabilities,
    });
    this.contexts.set(context, owner);
    return context;
  }
  markReady(plugin: string, scope = 'global', expectedContext?: PluginServices): void {
    const owner = this.requireOwner(plugin, scope, expectedContext);
    if (owner.retiring || owner.revoked) throw new Error(`Plugin service disposed: ${plugin}`);
    for (const publication of this.contracts?.get(plugin)?.provides ?? []) {
      if (publication.kind === 'rpc' && publication.process === this.process && (publication.scope ?? 'global') === (scope === 'global' ? 'global' : 'binding')
        && this.publications.get(this.publicationKey(plugin, scope, publication.id, publication.version))?.kind !== 'rpc') throw new RpcServiceError('not_ready');
    }
    owner.rpc?.markReady();
    owner.channels?.markReady();
    owner.ready = true;
  }
  retire(plugin: string, scope = 'global', expectedContext?: PluginServices): void {
    const owner = this.requireOwner(plugin, scope, expectedContext);
    owner.retiring = true;
    owner.rpc?.retire();
    try { owner.channels?.retire(); } catch { /* host-owned */ }
  }
  /**
   * Host-only: retires admission for EVERY live owner at once. It is wired to
   * the real drain admission point, so after it no new bootstrap/background work
   * is admitted while every already-accepted lease, result and terminal keeps
   * draining normally (nothing is revoked here).
   */
  retireAll(): void {
    for (const owner of this.owners.values()) {
      if (owner.revoked) continue;
      owner.retiring = true;
      try { owner.rpc?.retire(); } catch { /* host-owned */ }
      try { owner.channels?.retire(); } catch { /* host-owned */ }
    }
  }
  /**
   * Host-only: begins ONE channel operation for an owner. It applies the exact
   * same invocation-frame rules as an RPC call (management only from a
   * management frame, request/attempt only with a live retained lease proof, no
   * new work while retiring, bootstrap-only before ready) and holds a real
   * owner lease for the operation's whole lifetime, so owner disposal can never
   * race a live lane task. `null` refuses the operation.
   */
  beginChannelOperation(
    plugin: string,
    scope = 'global',
    incoming?: {
      readonly purpose?: RpcCallPurpose;
      readonly deadlineAt?: number;
      readonly signal?: AbortSignal;
      readonly authenticated?: boolean;
      /**
       * Host-managed background work: the operation runs in an EXPLICIT
       * independent background context and deliberately ignores any frame the
       * caller happens to be inside (typically a closed bootstrap/init closure).
       */
      readonly background?: boolean;
    },
  ): HostChannelOperation | null {
    const owner = this.owners.get(this.key(plugin, scope));
    if (!owner || owner.revoked) return null;
    if (this.owners.get(this.key(plugin, scope)) !== owner) return null;
    const stored = this.frames.getStore();
    let frame: InvocationFrame | undefined;
    if (incoming?.background === true) {
      // Explicit Host background context: no inherited purpose/deadline/signal.
      frame = undefined;
    } else {
      // A stale (already settled) frame is REFUSED: a finished invocation must
      // never be reused as fresh authority nor laundered into another purpose.
      // Legitimate background work either runs outside a frame or asks for the
      // explicit Host background context above.
      if (stored !== undefined && !this.liveInvocations.has(stored.token)) return null;
      frame = stored;
    }
    const leaseBound = frame !== undefined
      && (frame.purpose === 'request' || frame.purpose === 'attempt')
      && ((frame.proof !== undefined && !frame.proof.released && frame.proof.retained.has(owner))
        || frame.ownerAuthority === owner);
    if (frame !== undefined && (frame.purpose === 'request' || frame.purpose === 'attempt') && !leaseBound) return null;
    // A peer-authenticated inbound channel request carries the caller host's real
    // purpose, but only request/attempt/background may cross that boundary: a peer
    // may never claim management or bootstrap authority for a provider lease.
    const peerPurpose = frame === undefined && incoming?.authenticated === true
        && (incoming.purpose === 'request' || incoming.purpose === 'attempt' || incoming.purpose === 'background')
      ? incoming.purpose
      : undefined;
    const purpose = frame?.purpose ?? peerPurpose ?? 'background';
    const requestBound = leaseBound || peerPurpose === 'request' || peerPurpose === 'attempt';
    // Retirement refuses NEW work; already-accepted request/attempt work finishes.
    if (owner.retiring && !requestBound) return null;
    if (!owner.ready && !requestBound && purpose !== 'bootstrap') return null;
    const deadlineAt = minDefined(frame?.deadlineAt, incoming?.deadlineAt);
    const signal = combineAbortSignals(frame?.signal, incoming?.signal);
    owner.leases += 1;
    let released = false;
    const release = () => { if (released) return; released = true; owner.leases -= 1; this.notify(owner); };
    return Object.freeze({
      purpose,
      ...(signal === undefined ? {} : { signal }),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      release,
    });
  }

  /** Capture before admission; release only after all consumers finish old-request processing. */
  acquireLease(plugin: string, scope = 'global'): () => void {
    const owner = this.requireOwner(plugin, scope);
    if (!owner.ready || owner.retiring || owner.revoked) throw new Error(`Plugin service not ready: ${plugin}`);
    const retained = new Set<Owner>();
    const retain = (target: Owner): void => {
      if (retained.has(target)) return;
      if (!target.ready || target.retiring || target.revoked) throw new Error(`Plugin service not ready: ${target.plugin}`);
      retained.add(target);
      for (const provider of this.dependencyOwners(target)) retain(provider);
      for (const provider of target.consumed) if (provider.ready && !provider.retiring && !provider.revoked) retain(provider);
      // A declared in-process channel provider is an exact required
      // reference too, and its ready provider owner enters the lease proof so a
      // request/attempt frame can authorize real channel work on it.
      for (const provider of this.channelDependencyOwners(target)) {
        if (provider.ready && !provider.retiring && !provider.revoked) retain(provider);
      }
      for (const reference of target.rpcConsumed.values()) retain(reference.owner);
    };
    retain(owner);
    for (const target of retained) target.leases++;
    let released = false;
    const proof: LeaseProof = { retained, released: false };
    const release = () => { if (released) return; released = true; proof.released = true; for (const target of retained) { target.leases--; this.notify(target); } };
    this.leaseProofs.set(release, proof);
    return release;
  }

  references(plugin: string): ReadonlyArray<{ plugin: string; scope: string; leases: number }> {
    return [...this.owners.values()].filter(o => !o.revoked && (o.plugin === plugin || [...this.dependencyOwners(o), ...this.consumedOwners(o)].some(provider => provider.plugin === plugin)))
      .map(o => Object.freeze({ plugin: o.plugin, scope: o.scope, leases: o.leases }));
  }
  /** Stop admission immediately, preserve acquired handles until leases and calls drain. */
  dispose(plugin: string, scope = 'global', expectedContext?: PluginServices): Promise<void> {
    let owner: Owner;
    try { owner = this.requireOwner(plugin, scope, expectedContext); } catch (error) { return Promise.reject(error); }
    const existing = this.disposals.get(owner);
    if (existing) return existing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const task = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    // Install before cleanup can synchronously re-enter disposal.
    this.disposals.set(owner, task);
    void this.disposeOwner(owner).then(() => {
      this.disposals.delete(owner); resolve();
    }, error => { this.disposals.delete(owner); reject(error); });
    return task;
  }
  private async disposeOwner(owner: Owner): Promise<void> {
    const { plugin, scope } = owner;
    const hasPublications = [...this.publications.values()].some(publication => publication.owner === owner);
    if (hasPublications) {
      const dependents = [...this.owners.values()].filter(candidate => candidate !== owner && !candidate.revoked && (this.dependencyOwners(candidate).includes(owner) || this.consumedOwners(candidate).includes(owner)));
      if (dependents.length) throw new Error(`Plugin service provider is referenced: ${plugin} <- ${dependents.map(candidate => `${candidate.plugin}/${candidate.scope}`).join(', ')}`);
    }
    owner.retiring = true;
    owner.rpc?.retire();
    try { owner.channels?.retire(); } catch { /* host-owned */ }
    if (owner.leases || owner.pending.size) await new Promise<void>(resolve => owner.waiters.push(resolve));
    if (owner.channels) {
      try { await owner.channels.dispose(); } catch { /* provider release is best-effort here */ }
    }
    if (owner.rpc) {
      const result = await owner.rpc.dispose();
      if (!result.drained) throw new RpcServiceError('timeout');
    }
    // Cleanup may invoke its cached unsubscribe handle after drain, before final revocation.
    owner.cleaning = true;
    const failures: unknown[] = [];
    try {
      for (const cleanup of owner.cleanups) { try { cleanup(); } catch (error) { failures.push(error); } }
    } finally {
      owner.cleanups.clear(); owner.consumed.clear(); owner.rpcConsumed.clear(); owner.cleaning = false;
      owner.revoked = true; owner.ready = false;
      for (const [key, publication] of this.publications) if (publication.owner === owner) this.publications.delete(key);
      if (this.owners.get(this.key(plugin, scope)) === owner) this.owners.delete(this.key(plugin, scope));
    }
    if (failures.length) throw new PluginServiceCleanupError(failures);
  }
  /** Actual local provider owners, not activation edges to another process/binding. */
  private dependencyOwners(owner: Owner): Owner[] {
    const result = new Set<Owner>();
    for (const dependency of Object.keys(owner.dependencies)) {
      const declarations = this.contracts?.get(owner.plugin)?.consumes?.filter(service => service.plugin === dependency && service.process === this.process);
      if (declarations?.length) {
        for (const service of declarations) {
          // RPC providers are retained through `rpcConsumed`/`acquireRpcLease`,
          // never here. A local channel provider (events/snapshot/stream) IS a
          // real provider owner, so a request/attempt lease must retain it too,
          // or `beginChannelOperation` would refuse exact in-process channel work.
          if ((service.kind ?? 'local') === 'rpc') continue;
          const provider = this.owners.get(this.key(dependency, 'global'));
          if (provider) result.add(provider);
        }
      } else {
        const provider = this.owners.get(this.key(dependency, 'global'));
        if (provider) result.add(provider);
      }
    }
    return [...result];
  }
  /** Local providers of this owner's declared channel consumptions. */
  private channelDependencyOwners(owner: Owner): Owner[] {
    const result = new Set<Owner>();
    for (const service of this.contracts?.get(owner.plugin)?.consumes ?? []) {
      if (service.process !== this.process) continue;
      if (!CHANNEL_KINDS.has(service.kind ?? 'local')) continue;
      if (typeof service.plugin !== 'string' || !service.plugin) continue;
      if (isCrossProcessSelfSnapshot(owner.plugin, service, this.contracts?.get(owner.plugin) ?? {})) continue;
      if (!Object.hasOwn(owner.dependencies, service.plugin)) continue;
      const provider = this.owners.get(this.key(service.plugin, 'global'));
      if (provider) result.add(provider);
    }
    return [...result];
  }
  /** Consumers release all actual references before providers. */
  disposalOrder(): ReadonlyArray<{ plugin: string; scope: string }> {
    const visited = new Set<Owner>(), visiting = new Set<Owner>(), ordered: Owner[] = [];
    const visit = (owner: Owner): void => {
      if (visited.has(owner)) return;
      if (visiting.has(owner)) throw new Error('Plugin service reference cycle during disposal');
      visiting.add(owner);
      for (const provider of [...this.dependencyOwners(owner), ...this.consumedOwners(owner)]) if (!provider.revoked) visit(provider);
      visiting.delete(owner); visited.add(owner); ordered.push(owner);
    };
    for (const owner of this.owners.values()) visit(owner);
    return ordered.reverse().map(owner => Object.freeze({ plugin: owner.plugin, scope: owner.scope }));
  }
  private requireOwner(plugin: string, scope: string, expectedContext?: PluginServices): Owner {
    const owner = this.owners.get(this.key(plugin, scope));
    if (!owner) throw new Error(`Missing plugin service context: ${plugin}/${scope}`);
    if (expectedContext && this.contexts.get(expectedContext) !== owner) throw new Error(`Stale plugin service context: ${plugin}/${scope}`);
    return owner;
  }
  private notify(owner: Owner): void {
    if (!owner.leases && !owner.pending.size) for (const resolve of owner.waiters.splice(0)) resolve();
  }
  private consumedOwners(owner: Owner): Owner[] {
    return [...new Set([...owner.consumed, ...[...owner.rpcConsumed.values()].map(reference => reference.owner)])];
  }
  /** Each real RPC task borrows the canonical owner until actual business work settles. */
  private acquireRpcLease(owner: Owner, request: HostRpcLeaseRequest): HostRpcLeaseGrant {
    if (owner.revoked || this.owners.get(this.key(owner.plugin, owner.scope)) !== owner) throw new RpcServiceError('revoked');
    const frame = this.frames.getStore();
    if (frame && !this.liveInvocations.has(frame.token)) throw new RpcServiceError('unauthorized');
    if (request.purpose === 'management' && frame?.purpose !== 'management') throw new RpcServiceError('unauthorized');
    const existing = (request.purpose === 'request' || request.purpose === 'attempt')
      && frame?.purpose === request.purpose && ((frame.proof !== undefined && !frame.proof.released && frame.proof.retained.has(owner)) || (request.role === 'callee' && frame.peerAuthenticated === true));
    if ((request.purpose === 'request' || request.purpose === 'attempt') && !existing) throw new RpcServiceError('unauthorized');
    if (owner.retiring && !existing) throw new RpcServiceError('retired');
    if (!owner.ready && request.purpose !== 'bootstrap') throw new RpcServiceError('not_ready');
    owner.leases++;
    let released = false;
    return { allowRetired: existing, release: () => { if (released) return; released = true; owner.leases--; this.notify(owner); } };
  }
}

/** Smallest defined deadline, or undefined when neither side has one. */
function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

/** Combines local and peer-provided abort signals without dropping either. */
function combineAbortSignals(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
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

export const TOKEN_METERING_SERVICE_ID = 'token-metering.v1';
export const TOKEN_METERING_CONTRACT_VERSION = 1;
export type TokenMeteringSource = 'official' | 'estimated' | 'partial' | 'none';
export type TokenMeteringAuthority = 'official' | 'local' | 'heuristic' | 'partial' | 'none';
export interface TokenMeteringResult {
  readonly requestId: string; readonly attemptId: string; readonly routeId: string; readonly upstreamId: string;
  readonly keyId?: string | null;
  readonly provider: string; readonly model?: string; readonly pricingProvider?: string;
  readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number;
  readonly inputSource: TokenMeteringSource; readonly outputSource: TokenMeteringSource;
  readonly inputAuthority: TokenMeteringAuthority; readonly outputAuthority: TokenMeteringAuthority;
  readonly complete: boolean; readonly observationIncomplete: boolean;
  readonly outcome: 'completed' | 'failed' | 'aborted'; readonly finishedAtMs: number; readonly settlementVersion: number;
}
export interface TokenMeteringSubscription {
  /** Omit for degradable all-request reporting; required consumers bind their admitted request. */
  readonly requestId?: string;
  readonly required?: boolean;
  readonly onResult: (result: TokenMeteringResult) => void | Promise<void>;
  readonly onFailure?: (error: unknown, result: TokenMeteringResult) => void | Promise<void>;
}
export interface TokenMeteringService {
  /** Final completion boundary: await this request's required settlement/failure callbacks before releasing its host lease. */
  drainRequest(requestId: string): Promise<void>;
  subscribe(subscription: TokenMeteringSubscription): () => void;
  prepareAttempt(input: Readonly<{ requestId: string; attemptId: string; routeId: string; upstreamId: string; url: string; body: unknown }>): Readonly<{ supported: boolean; provider?: string; model?: string; pricingProvider?: string }>;
  /** Consumer calls before request admission to pin demand; framework init also captures report subscriptions. */
  prepareRequest(requestId: string): boolean;
}

export const TOKEN_PRICING_SERVICE_ID = 'token-stats.pricing.v1';
export const TOKEN_PRICING_CONTRACT_VERSION = 1;
/** Costs are quantized to safe integer nanoUSD (1 USD = 1e9 nanoUSD); unknown remains null. */
export interface TokenPricingService {
  canPrice(input: Readonly<{ model?: string; pricingProvider?: string }>): Promise<boolean>;
  price(result: TokenMeteringResult): Promise<Readonly<{ costUsd: number | null; costNanoUsd: number | null }>>;
}
