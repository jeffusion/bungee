import { logger } from '../logger';
import type { AtomicReadSetResolver } from '../plugin-state/client';
/**
 * Same-process host RPC adapter (P4): lets the canonical `PluginServiceHost`
 * lifecycle own RPC publications/consumption without a second plugin framework
 * and without faking a wire transport.
 *
 * The parent injects the trusted owner token, endpoint identity, required
 * placement/callee/journal callbacks, and the real host lease callback. Real
 * cross-process transport is NOT implemented: the required placement resolver
 * returns an exact endpoint registered in the exposed runtime, `ambiguous`, or
 * `null` meaning "use the explicit local channel". Commands run only through the
 * accepted runtime kernel. Journal-backed policies require `CommandJournal`;
 * application-owned `none` commands may execute without a journal and expose no
 * journal result/reconciliation capability. Caller identity, purpose, scope,
 * leases, and deadlines are host decisions; plugin call options may only carry
 * `signal`/`timeoutMs`/`operationId`, snapshotted without invoking accessors.
 *
 * Command binding errors are mapped once by the kernel to its fixed-code
 * `RpcInvocationError` (own `code`, no cause/message/raw operation id); the
 * client rebuilds a fresh public `RpcServiceError` from that code and the
 * validated operation id of the current call. No error instance is reused.
 */
import { assertSupportedServiceDeclarations, isCrossProcessSelfService } from './contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isProxy } from 'node:util/types';
import type {
  PluginServiceConsumption,
  PluginServiceDeclarations,
  PluginServiceProcess,
  PluginServicePublication,
  PluginServiceScope,
} from './contracts';
import {
  RpcServiceRuntime,
  type RpcAdmissionGrant,
  type RpcAdmissionRequest,
  type RpcCaller,
  type RpcCommandAction,
  type RpcCommandExecution,
  type RpcCommandExecutor,
  type RpcDrainResult,
  type RpcEndpointBinding,
  type RpcEndpointHandle,
  type RpcHandlerContext,
  type RpcHandlerMap,
  type RpcInvocationErrorCode,
  type RpcInvokeRequest,
  type RpcRuntimeLimits,
  type RpcRuntimeStatus,
} from './rpc-runtime';
import {
  type CommandAtomicPlanner,
  type CommandExternalExecutor,
  type CommandJournal,
} from './command-journal';
import type { AsyncCommandJournal } from '../plugin-state/client';
import {
  defineRpcService,
  assertRpcData,
  encodeRpcJson,
  decodeRpcJson,
  RPC_JSON_MAX_BYTES,
  type RpcCallPurpose,
  type InferRpcData,
  type RpcCommandPolicy,
  type RpcJson,
  type RpcMethodDefinition,
} from './wire-contract';

/* -------------------------------------------------------------------------- */
/* Fixed-code public errors                                                    */
/* -------------------------------------------------------------------------- */

export type RpcServiceErrorCode =
  | RpcInvocationErrorCode
  | 'undeclared'
  | 'unavailable'
  | 'ambiguous_placement'
  | 'invalid_registration';

const SERVICE_ERROR_MESSAGES: Record<RpcServiceErrorCode, string> = {
  unauthorized: 'RPC call is not authorized',
  not_ready: 'RPC endpoint is not ready',
  retired: 'RPC endpoint is retiring',
  revoked: 'RPC endpoint generation was revoked',
  unsupported_method: 'RPC method is not published',
  wrong_purpose: 'RPC method is not published for this purpose',
  invalid_input: 'RPC input is not valid',
  invalid_output: 'RPC output is not valid',
  invalid_operation_id: 'RPC command operation id is invalid',
  overloaded: 'RPC runtime is at capacity',
  cancelled: 'RPC call was cancelled',
  timeout: 'RPC call deadline exceeded',
  unknown: 'RPC command outcome is unknown',
  capability_unavailable: 'RPC command execution is unavailable',
  closed: 'RPC runtime is closed',
  failed: 'RPC call failed',
  conflict: 'RPC command identity conflicts with an existing record',
  expired: 'RPC command result has expired',
  pending: 'RPC command is still pending',
  rejected: 'RPC command was rejected',
  missing: 'RPC command has no stored result',
  storage_failure: 'RPC command storage failed',
  deadlock: 'RPC call chain would deadlock',
  call_depth_exceeded: 'RPC call depth exceeded',
  undeclared: 'RPC service is not declared by the manifest',
  unavailable: 'RPC service is unavailable',
  ambiguous_placement: 'RPC service placement is ambiguous',
  invalid_registration: 'RPC registration is invalid',
};

const SERVICE_ERROR_CODES = new Set<RpcServiceErrorCode>(Object.keys(SERVICE_ERROR_MESSAGES) as RpcServiceErrorCode[]);

/** Fixed-code error. It never carries a provider cause, message, or payload. */
export class RpcServiceError extends Error {
  readonly name = 'RpcServiceError';
  readonly code: RpcServiceErrorCode;
  readonly operationId: string | null;

  constructor(code: RpcServiceErrorCode, operationId: string | null = null) {
    super(SERVICE_ERROR_MESSAGES[code]);
    this.code = code;
    this.operationId = operationId;
  }
}

function ownStringProperty(target: unknown, name: string): string | null {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return null;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(target, name); } catch { return null; }
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') return null;
  return descriptor.value;
}

/**
 * Rebuilds a fresh public error from the kernel's fixed code and the validated
 * operation id of THIS call. It never reuses the incoming instance, never reads
 * its operation id, and never reads a cause or message.
 */
export function toRpcServiceError(error: unknown, operationId: string | null): RpcServiceError {
  const raw = ownStringProperty(error, 'code');
  const code = raw !== null && SERVICE_ERROR_CODES.has(raw as RpcServiceErrorCode)
    ? raw as RpcServiceErrorCode
    : 'failed';
  return new RpcServiceError(code, operationId);
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface RpcCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly operationId?: string;
}

export type RpcCommandClientExtras<D extends RpcMethodDefinition> = D extends { readonly command: RpcCommandPolicy }
  ? {
      /** Durable committed result query; runs through the same runtime lease/deadline as execute. */
      queryResult(operationId: string): Promise<InferRpcData<D['output']>>;
      /** Explicit host-authorized reconciliation for an unknown command outcome. */
      reconcile(operationId: string, input: InferRpcData<D['input']>): Promise<InferRpcData<D['output']>>;
    }
  : Record<never, never>;

export type RpcMethodClient<D extends RpcMethodDefinition> =
  ((input: InferRpcData<D['input']>, options?: RpcCallOptions) => Promise<InferRpcData<D['output']>>)
  & RpcCommandClientExtras<D>;

/** Public plugin-facing RPC client derived from a literal contract. */
export type AsyncRpcClient<M extends Record<string, RpcMethodDefinition>> = {
  readonly [K in keyof M]: RpcMethodClient<M[K]>;
};

/** Logical placement identity, independent of any physical address or generation. */
export interface HostRpcServiceDescriptor {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly kind: 'rpc';
  readonly process: PluginServiceProcess;
  readonly scope: PluginServiceScope;
}

/** Physical endpoint identity supplied by the trusted host for one owner instance. */
export interface HostRpcLifecycleIdentity {
  readonly endpoint: string;
  readonly instance: string;
  readonly generation: number;
  readonly catalog: string;
  /** Trusted callee subject; never derived from plugin input. */
  readonly subject: string;
}

/** Canonical owner lifecycle view; the adapter never keeps a second copy. */
export interface HostRpcLifecycleState {
  readonly ready: boolean;
  readonly retiring: boolean;
  readonly revoked: boolean;
}

/** Host-minted invocation frame; the real principal lives in the host callee frame. */
export interface HostRpcInvocationContext {
  readonly purpose: RpcCallPurpose;
  /** Opaque host correlation token; the leaf only trusts the required resolver. */
  readonly token: object;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export interface HostRpcLeaseRequest {
  readonly role: 'caller' | 'callee';
  readonly plugin: string;
  readonly scope: string;
  readonly state: HostRpcLifecycleState;
  readonly purpose: RpcCallPurpose;
  readonly operationId: string | null;
  /** Logical target provider. */
  readonly provider: string;
}

export interface HostRpcLeaseGrant {
  readonly release: () => void;
  /** Host-verified existing request lease; only honored for request/attempt. */
  readonly allowRetired?: boolean;
}

export type HostRpcAcquireLease = (request: HostRpcLeaseRequest) => HostRpcLeaseGrant;

export interface HostRpcMethodCapability {
  /** Synchronous private-state CAS planner for a `local-transaction` command. */
  readonly atomic?: CommandAtomicPlanner;
  /** Explicit bounded read set for the production storage Worker. */
  readonly atomicReadSet?: AtomicReadSetResolver;
  /** Reconcile capability for an `external-contract` command. */
  readonly external?: CommandExternalExecutor;
}

export type HostRpcCommandCapabilities<M extends Record<string, RpcMethodDefinition>> = {
  readonly [K in keyof M]?: HostRpcMethodCapability;
};

/** Everything the canonical host exposes for one owner to use RPC services. */
export interface HostRpcOwnerInput {
  readonly token: object;
  readonly plugin: string;
  /** Canonical owner scope: `'global'` or a trusted binding scope key. */
  readonly scope: string;
  readonly declarations: PluginServiceDeclarations;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly lifecycle: HostRpcLifecycleIdentity;
  /** Canonical lifecycle source of truth; the adapter copies nothing. */
  readonly getLifecycleState: () => HostRpcLifecycleState;
  readonly acquireLease: HostRpcAcquireLease;
  readonly registerPublication?: (publication: PluginServicePublication) => void;
  readonly registerConsumption?: (consumption: PluginServiceConsumption, localProviderToken?: object) => void;
  readonly onDispose?: (cleanup: () => void) => void;
  readonly canCall?: (target: { readonly provider: string; readonly service: string; readonly major: number; readonly method: string }) => boolean;
  /** Required host invocation-frame resolver; null for plain plugin background calls. */
  readonly resolveInvocationContext: () => HostRpcInvocationContext | null;
}

/** Trusted peer broker input. This capability is never part of PluginServices. */
export interface HostRpcRemoteCallerInput extends HostRpcOwnerInput {
  readonly process: PluginServiceProcess;
  /** Must verify the current authenticated peer frame and logical caller authority. */
  readonly authorizeIncoming: (request: RpcAdmissionRequest, endpoint: NonNullable<ReturnType<RpcServiceRuntime['endpointInfo']>>) => boolean;
}

export interface HostRpcRemoteCallerHandle {
  invokeTracked(request: Omit<RpcInvokeRequest, 'caller' | 'callerToken'>): ReturnType<RpcServiceRuntime['invokeTracked']>;
  dispose(): Promise<RpcDrainResult>;
}

/** Exact placement delegated to the host. `null` means "use the explicit local channel". */
export type HostRpcPlacementResolution =
  | { readonly kind: 'endpoint'; readonly endpoint: RpcEndpointHandle }
  | { readonly kind: 'ambiguous' }
  | null
  | undefined;

export interface HostRpcPlacementRequest {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly method: string;
  readonly scope: PluginServiceScope;
  readonly bindingScope?: string;
  readonly caller: RpcCaller;
  readonly purpose?: RpcCallPurpose;
}

export type HostRpcPlacementResolver = (request: HostRpcPlacementRequest) => HostRpcPlacementResolution;

export interface HostRpcJournalRequest {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly method: string;
  readonly scope: PluginServiceScope;
  /** Binding scope key when `scope` is `binding`; keeps two bindings apart. */
  readonly bindingScope?: string;
  readonly policy: RpcCommandPolicy;
  readonly atomic?: CommandAtomicPlanner;
  /** Explicit bounded read set for the production storage Worker. */
  readonly atomicReadSet?: AtomicReadSetResolver;
  readonly external?: CommandExternalExecutor;
}

/** Host-owned durable journal factory; `null` refuses commands for this key. */
export type HostRpcJournalResolver = (request: HostRpcJournalRequest) => AsyncCommandJournal | CommandJournal | null;

/** Trusted opaque callee context resolver. */
export type HostRpcCalleeResolver = (request: RpcAdmissionRequest, publication: HostRpcServiceDescriptor) => unknown;

/**
 * Host-provided frame for one admitted native RPC handler. It lets the SAME
 * `PluginServiceHost` invocation store the real purpose/deadline/cancellation
 * for the duration of the handler, bound to the exact published owner, so a
 * channel operation started inside a native handler is authorized by the real
 * frame (never downgraded to `background`, never given a forged purpose).
 */
export interface HostRpcHandlerFrame {
  readonly purpose: RpcCallPurpose;
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
  /** Exact published owner the call targets; `null` for a remote (peer) route. */
  readonly ownerToken: object | null;
  readonly operationId: string | null;
}

export interface HostRpcJournalCleanupFailure {
  readonly operationId: string;
  readonly code: string;
}
export interface HostRpcAdapterOptions {
  /** Resource cleanup reports separately and never replaces a business outcome. */
  readonly onJournalCleanupFailure?: (failure:HostRpcJournalCleanupFailure)=>void;
  readonly process: PluginServiceProcess;
  readonly limits?: RpcRuntimeLimits;
  readonly hostLifetime?: AbortSignal;
  readonly maxCallDepth?: number;
  /** Required host placement authority. */
  readonly resolvePlacement: HostRpcPlacementResolver;
  /** Required host journal authority. */
  readonly resolveJournal: HostRpcJournalResolver;
  /** Required trusted opaque callee frame authority. */
  readonly resolveCallee: HostRpcCalleeResolver;
  /**
   * Host callback that enters the exact published owner's trusted invocation
   * frame for one native handler call. The canonical `PluginServiceHost` wires
   * it to its OWN invocation store, so a native RPC handler shares one
   * purpose/deadline/cancel resolver with local dispatch and channel work.
   */
  readonly enterHostHandlerFrame?: (frame: HostRpcHandlerFrame, run: () => unknown) => unknown;
}

export interface HostRpcPublication {
  readonly descriptor: HostRpcServiceDescriptor;
}

/** Host-only readonly directory entry for one real registered publication. */
export interface HostRpcPublicationView {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly scope: PluginServiceScope;
  readonly scopeKey: string;
  readonly ready: boolean;
  readonly lifecycle: HostRpcLifecycleIdentity;
  /** The kernel-selected binding of the exact endpoint handle; never re-derived. */
  readonly binding: RpcEndpointBinding;
}

export interface HostRpcOwnerHandle {
  readonly owner: HostRpcOwnerInput;
  publish<const M extends Record<string, RpcMethodDefinition>>(
    contract: { readonly id: string; readonly version: number; readonly methods: M },
    handlers: RpcHandlerMap<M, unknown>,
    capabilities?: HostRpcCommandCapabilities<M>,
  ): HostRpcPublication;
  consume<const M extends Record<string, RpcMethodDefinition>>(
    provider: string,
    contract: { readonly id: string; readonly version: number; readonly methods: M },
  ): AsyncRpcClient<M>;
  /** Canonical host hook: ready maps to kernel `markReady`. */
  markReady(): void;
  /** Canonical host hook: retirement maps to kernel `retire`. */
  retire(): void;
  /**
   * Canonical host hook: disposal maps to kernel `revoke` + bounded `drain`.
   * Returns the REAL drain verdict; `drained: false` is reported, never hidden.
   */
  dispose(): Promise<RpcDrainResult>;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

const SEP = '\0';
const DEFAULT_MAX_CALL_DEPTH = 32;
const CALL_OPTION_KEYS = ['signal', 'timeoutMs', 'operationId'] as const;
const EMPTY_OPTIONS: RpcCallOptions = Object.freeze({});

interface ActiveFrame {
  readonly purpose: RpcCallPurpose;
  readonly depth: number;
  readonly chain: readonly string[];
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/** Host frame inheritance only: purpose, call chain, deadline, and cancellation. */
const FRAME_STORE = new AsyncLocalStorage<ActiveFrame>();

interface RegisteredPublication {
  readonly key: string;
  readonly handle: RpcEndpointHandle;
  readonly provider: string;
  readonly scopeKey: string;
  readonly scope: PluginServiceScope;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly ownerState: OwnerState;
}

interface OwnerState {
  readonly owner: HostRpcOwnerInput;
  readonly plugin: string;
  readonly scope: string;
  readonly scopeKind: PluginServiceScope;
  readonly callerSubject: string;
  readonly lifecycle: HostRpcLifecycleIdentity;
  readonly publications: Set<RegisteredPublication>;
  readonly process: PluginServiceProcess;
  readonly local: boolean;
  readonly authorizeIncoming?: HostRpcRemoteCallerInput['authorizeIncoming'];
  /** RPC capability revocation, independent of eventual resource reclamation. */
  revoked: boolean;
  released: boolean;
}

interface CalleeInfo {
  readonly provider: string;
  readonly scopeKey: string;
  readonly scope: PluginServiceScope;
  readonly frame: unknown;
  /** Exact published owner token, or `null` for a remote (peer) route. */
  readonly ownerToken: object | null;
}

type Handler = (input: unknown, context: RpcHandlerContext<unknown>) => unknown;

type RouteResolution =
  | { readonly kind: 'publication'; readonly publication: RegisteredPublication }
  | { readonly kind: 'remote'; readonly handle: RpcEndpointHandle }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'missing' };

const CALLEE_INFO = new WeakMap<object, CalleeInfo>();

/** Reads the trusted opaque callee frame the host resolver produced for an admitted call. */
export function readHostRpcCalleeFrame(callee: unknown): unknown {
  if (callee === null || typeof callee !== 'object') return null;
  return CALLEE_INFO.get(callee as object)?.frame ?? null;
}

function publicationKey(provider: string, scopeKey: string, service: string, major: number): string {
  return `${provider}${SEP}${scopeKey}${SEP}${service}${SEP}${major}`;
}

function scopeKindOf(scope: string): PluginServiceScope {
  return scope === 'global' ? 'global' : 'binding';
}

function callerSubjectFor(plugin: string, scope: string): string {
  return scope === 'global' ? plugin : `${plugin}@${scope}`;
}

function normalizeOperationId(operationId: unknown): string {
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
    throw new RpcServiceError('invalid_operation_id');
  }
  return operationId;
}

/** Combines cancellation signals without depending on `AbortSignal.any` being present. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0];
  const native = (AbortSignal as unknown as { any?: (values: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return native.call(AbortSignal, [...signals]);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) { abort(); break; }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function requirePurpose(definition: RpcMethodDefinition, purpose: RpcCallPurpose): RpcCallPurpose {
  if (!definition.purposes.includes(purpose)) throw new RpcServiceError('wrong_purpose');
  return purpose;
}

/** Own-descriptor snapshot of the trusted lifecycle identity; no accessor ever runs. */
function snapshotLifecycle(value: unknown): HostRpcLifecycleIdentity {
  if (value === null || typeof value !== 'object' || isProxy(value)) throw new RpcServiceError('invalid_registration');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RpcServiceError('invalid_registration');
  const read = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new RpcServiceError('invalid_registration');
    }
    return descriptor.value;
  };
  const allowed = new Set(['endpoint', 'instance', 'generation', 'catalog', 'subject']);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new RpcServiceError('invalid_registration');
  }
  const endpoint = read('endpoint');
  const instance = read('instance');
  const generation = read('generation');
  const catalog = read('catalog');
  const subject = read('subject');
  if (typeof endpoint !== 'string' || !endpoint || typeof instance !== 'string' || !instance
    || !Number.isSafeInteger(generation) || (generation as number) < 1
    || typeof catalog !== 'string' || typeof subject !== 'string' || !subject) {
    throw new RpcServiceError('invalid_registration');
  }
  return Object.freeze({ endpoint, instance, generation: generation as number, catalog, subject });
}

/** Own-descriptor snapshot of a dependencies record; accessors are rejected, never invoked. */
function snapshotDependencies(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || isProxy(value)) throw new RpcServiceError('invalid_registration');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RpcServiceError('invalid_registration');
  const result: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new RpcServiceError('invalid_registration');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw new RpcServiceError('invalid_registration');
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

/**
 * Copies own enumerable data-function properties only. Accessors, proxies,
 * prototype methods, symbol keys, and unknown keys are rejected before any value
 * is read, so no plugin getter ever runs.
 */
function snapshotHandlers(methods: Record<string, RpcMethodDefinition>, handler: unknown): Map<string, Handler> {
  if (handler === null || typeof handler !== 'object' || isProxy(handler)) throw new RpcServiceError('invalid_registration');
  const prototype = Object.getPrototypeOf(handler);
  if (prototype !== Object.prototype && prototype !== null) throw new RpcServiceError('invalid_registration');
  const allowed = new Set(Object.keys(methods));
  const collected = new Map<string, Handler>();
  for (const key of Reflect.ownKeys(handler)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new RpcServiceError('invalid_registration');
    const descriptor = Object.getOwnPropertyDescriptor(handler, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new RpcServiceError('invalid_registration');
    }
    collected.set(key, descriptor.value as Handler);
  }
  for (const name of allowed) if (!collected.has(name)) throw new RpcServiceError('invalid_registration');
  return collected;
}

/**
 * Snapshots one command capability through own descriptors only. Proxies, accessors,
 * unknown keys, and non-function planner/reconcile values are rejected before any
 * value is read, so no plugin getter ever runs and no mutable capability object is
 * retained.
 */
function snapshotCapability(value: unknown): HostRpcMethodCapability {
  if (value === null || typeof value !== 'object' || isProxy(value)) throw new RpcServiceError('invalid_registration');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RpcServiceError('invalid_registration');
  let atomic: CommandAtomicPlanner | undefined;
  let atomicReadSet: AtomicReadSetResolver | undefined;
  let external: CommandExternalExecutor | undefined;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (key !== 'atomic' && key !== 'atomicReadSet' && key !== 'external')) throw new RpcServiceError('invalid_registration');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new RpcServiceError('invalid_registration');
    }
    if (key === 'atomicReadSet') {
      if (typeof descriptor.value !== 'function') throw new RpcServiceError('invalid_registration');
      atomicReadSet = descriptor.value as AtomicReadSetResolver;
    } else if (key === 'atomic') {
      if (typeof descriptor.value !== 'function') throw new RpcServiceError('invalid_registration');
      atomic = descriptor.value as CommandAtomicPlanner;
    } else {
      external = snapshotExternal(descriptor.value);
    }
  }
  const record: { atomic?: CommandAtomicPlanner; atomicReadSet?: AtomicReadSetResolver; external?: CommandExternalExecutor } = {};
  if (atomic !== undefined) record.atomic = atomic;
  if (atomicReadSet !== undefined) record.atomicReadSet = atomicReadSet;
  if (external !== undefined) record.external = external;
  return Object.freeze(record);
}

/** Snapshots the `external.reconcile` function without retaining the plugin's object. */
function snapshotExternal(value: unknown): CommandExternalExecutor {
  if (value === null || typeof value !== 'object' || isProxy(value)) throw new RpcServiceError('invalid_registration');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RpcServiceError('invalid_registration');
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'reconcile') throw new RpcServiceError('invalid_registration');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'reconcile');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new RpcServiceError('invalid_registration');
  }
  return Object.freeze({ reconcile: descriptor.value as CommandExternalExecutor['reconcile'] });
}

/**
 * Descriptor-safe snapshot of the command capabilities record. Every key must name a
 * declared command method; accessors, proxies, symbol keys, unknown/non-command
 * methods, and unknown capability fields are rejected before `register`, so a failed
 * snapshot can never leave a ghost endpoint. The snapshot is frozen and independent
 * of the plugin's mutable objects.
 */
function snapshotCapabilities(
  methodTable: Record<string, RpcMethodDefinition>,
  value: unknown,
): Readonly<Record<string, HostRpcMethodCapability>> | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || isProxy(value)) throw new RpcServiceError('invalid_registration');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RpcServiceError('invalid_registration');
  const record: Record<string, HostRpcMethodCapability> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(methodTable, key)) throw new RpcServiceError('invalid_registration');
    const definition = methodTable[key];
    if (definition === undefined || definition.kind !== 'command') throw new RpcServiceError('invalid_registration');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new RpcServiceError('invalid_registration');
    }
    if (descriptor.value === undefined) continue;
    record[key] = snapshotCapability(descriptor.value);
  }
  return Object.freeze(record);
}

/** Snapshots plugin call options without invoking accessors or accepting unknown keys. */
function snapshotCallOptions(options: RpcCallOptions | undefined): RpcCallOptions {
  if (options === undefined) return EMPTY_OPTIONS;
  if (options === null || typeof options !== 'object' || isProxy(options)) throw new RpcServiceError('invalid_input');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) throw new RpcServiceError('invalid_input');
  const result: { signal?: AbortSignal; timeoutMs?: number; operationId?: string } = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !(CALL_OPTION_KEYS as readonly string[]).includes(key)) {
      throw new RpcServiceError('invalid_input');
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new RpcServiceError('invalid_input');
    }
    (result as Record<string, unknown>)[key] = descriptor.value;
  }
  if (result.signal !== undefined && !(result.signal instanceof AbortSignal)) throw new RpcServiceError('invalid_input');
  if (result.timeoutMs !== undefined
    && (typeof result.timeoutMs !== 'number' || !Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 0)) {
    throw new RpcServiceError('invalid_input');
  }
  if (result.operationId !== undefined && typeof result.operationId !== 'string') throw new RpcServiceError('invalid_input');
  return Object.freeze(result);
}

function defineContract<const M extends Record<string, RpcMethodDefinition>>(
  contract: { readonly id: string; readonly version: number; readonly methods: M },
): { readonly id: string; readonly version: number; readonly methods: M } {
  try {
    return defineRpcService(contract) as unknown as { readonly id: string; readonly version: number; readonly methods: M };
  } catch {
    throw new RpcServiceError('invalid_registration');
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class HostRpcAdapter {
  readonly runtime: RpcServiceRuntime<unknown>;
  readonly #options: HostRpcAdapterOptions;
  readonly #process: PluginServiceProcess;
  readonly #maxCallDepth: number;
  readonly #ownersByToken = new WeakMap<object, OwnerState>();
  readonly #ownersByCaller = new Map<string, OwnerState>();
  readonly #publications = new Map<string, RegisteredPublication>();
  readonly #capabilities = new Map<string, Readonly<Record<string, HostRpcMethodCapability>>>();
  #closed = false;

  constructor(options: HostRpcAdapterOptions) {
    if (options === null || typeof options !== 'object' || typeof options.process !== 'string') {
      throw new RpcServiceError('invalid_registration');
    }
    if (typeof options.resolvePlacement !== 'function' || typeof options.resolveJournal !== 'function'
      || typeof options.resolveCallee !== 'function') {
      throw new RpcServiceError('invalid_registration');
    }
    this.#options = options;
    this.#process = options.process;
    this.#maxCallDepth = Number.isSafeInteger(options.maxCallDepth) && (options.maxCallDepth as number) > 0
      ? options.maxCallDepth as number : DEFAULT_MAX_CALL_DEPTH;
    this.runtime = new RpcServiceRuntime<unknown>({
      admit: (request) => this.#admit(request),
      commandExecutor: this.#commandExecutor(),
      hostLifetime: options.hostLifetime,
      limits: options.limits,
    });
  }

  status(): RpcRuntimeStatus {
    return this.runtime.status();
  }

  /**
   * Host-only readonly directory of this adapter's *real* registered
   * publications: the kernel-selected binding (endpoint/process/instance/
   * generation/catalog/scope/subject) of the exact endpoint handle, its owner
   * lifecycle identity and its current readiness. It is a plain snapshot for
   * host decision making (peer routing/validation); it grants nothing, exposes
   * no SDK surface and is never exposed through `PluginServices`.
   */
  publicationView(): readonly HostRpcPublicationView[] {
    const view: HostRpcPublicationView[] = [];
    for (const publication of this.#publications.values()) {
      const info = this.runtime.endpointInfo(publication.handle);
      if (info === null) continue;
      const lifecycle = publication.ownerState.lifecycle;
      const state = publication.ownerState.owner.getLifecycleState();
      view.push(Object.freeze({
        provider: publication.provider,
        service: publication.contractId,
        major: publication.contractVersion,
        scope: publication.scope,
        scopeKey: publication.scopeKey,
        ready: state.ready && !state.retiring && !state.revoked,
        lifecycle: Object.freeze({
          endpoint: lifecycle.endpoint, instance: lifecycle.instance,
          generation: lifecycle.generation, catalog: lifecycle.catalog, subject: lifecycle.subject,
        }),
        binding: info.binding,
      }));
    }
    return Object.freeze(view);
  }

  /** Closes the process runtime; the parent awaits this in the canonical shutdown. */
  async dispose(options: { readonly timeoutMs?: number } = {}) {
    this.#closed = true;
    return this.runtime.dispose(options);
  }

  /* ------------------------------ owners ---------------------------------- */

  createOwner(input: HostRpcOwnerInput): HostRpcOwnerHandle {
    return this.#ownerHandle(this.#createOwnerState(input, this.#process, true));
  }

  /** Imports an authenticated concrete caller, not a plugin instance or SDK facade. */
  createRemoteCaller(input: HostRpcRemoteCallerInput): HostRpcRemoteCallerHandle {
    if (!['control', 'worker', 'ingress'].includes(input?.process) || typeof input?.authorizeIncoming !== 'function') {
      throw new RpcServiceError('invalid_registration');
    }
    const authorize = input.authorizeIncoming;
    const state = this.#createOwnerState(input, input.process, false, authorize);
    return Object.freeze({
      invokeTracked: (request: Omit<RpcInvokeRequest, 'caller' | 'callerToken'>) => this.runtime.invokeTracked({
        ...request, caller: Object.freeze({ subject: state.callerSubject, scope: state.scopeKind }), callerToken: state.owner.token,
      }),
      dispose: () => this.#disposeOwner(state),
    });
  }

  #createOwnerState(input: HostRpcOwnerInput, process: PluginServiceProcess, local: boolean,
    authorizeIncoming?: HostRpcRemoteCallerInput['authorizeIncoming']): OwnerState {
    if (this.#closed) throw new RpcServiceError('closed');
    if (input === null || typeof input !== 'object' || input.token === null || typeof input.token !== 'object') {
      throw new RpcServiceError('invalid_registration');
    }
    if (typeof input.plugin !== 'string' || !input.plugin || typeof input.scope !== 'string' || !input.scope) {
      throw new RpcServiceError('invalid_registration');
    }
    if (typeof input.getLifecycleState !== 'function' || typeof input.acquireLease !== 'function'
      || typeof input.resolveInvocationContext !== 'function') {
      throw new RpcServiceError('invalid_registration');
    }
    if (this.#ownersByToken.has(input.token)) throw new RpcServiceError('invalid_registration');
    const callerSubject = callerSubjectFor(input.plugin, input.scope);
    if (local && this.#ownersByCaller.has(callerSubject)) throw new RpcServiceError('invalid_registration');
    const state: OwnerState = {
      owner: input,
      plugin: input.plugin,
      scope: input.scope,
      scopeKind: scopeKindOf(input.scope),
      callerSubject,
      lifecycle: snapshotLifecycle(input.lifecycle),
      publications: new Set(),
      process, local, authorizeIncoming,
      revoked: false,
      released: false,
    };
    // Fail closed before any publication: dependency records must be snapshot-clean.
    snapshotDependencies(input.dependencies);
    if (Object.hasOwn(input, 'optionalDependencies')) throw new RpcServiceError('invalid_registration');
    try { assertSupportedServiceDeclarations(input.declarations); } catch { throw new RpcServiceError('invalid_registration'); }
    this.#ownersByToken.set(input.token, state);
    if (local) this.#ownersByCaller.set(callerSubject, state);
    return state;
  }

  #ownerHandle(state: OwnerState): HostRpcOwnerHandle {
    return Object.freeze({
      owner: state.owner,
      publish: <const M extends Record<string, RpcMethodDefinition>>(
        contract: { readonly id: string; readonly version: number; readonly methods: M },
        handlers: RpcHandlerMap<M, unknown>,
        capabilities?: HostRpcCommandCapabilities<M>,
      ) => this.#publish(state, contract, handlers, capabilities),
      consume: <const M extends Record<string, RpcMethodDefinition>>(
        provider: string,
        contract: { readonly id: string; readonly version: number; readonly methods: M },
      ) => this.#consume(state, provider, contract),
      markReady: () => { this.#markReady(state); },
      retire: () => { this.#retire(state); },
      dispose: () => this.#disposeOwner(state),
    });
  }

  #markReady(state: OwnerState): void {
    if (state.revoked || state.released || this.#closed) throw new RpcServiceError('closed');
    for (const publication of state.publications) this.runtime.markReady(publication.handle);
  }

  #retire(state: OwnerState): void {
    if (state.released) return;
    for (const publication of state.publications) this.runtime.retire(publication.handle);
  }

  /** Revoke + REAL bounded drain. Resources are dropped only after a drained verdict. */
  async #disposeOwner(state: OwnerState): Promise<RpcDrainResult> {
    if (state.released) return Object.freeze({ drained: true, active: 0 });
    state.revoked = true;
    this.runtime.revokeCaller(state.callerSubject, state.owner.token);
    for (const publication of state.publications) this.runtime.revoke(publication.handle);
    const result = await this.runtime.drainOwner(state.callerSubject, [...state.publications].map(publication => publication.handle), { callerToken: state.owner.token });
    if (result.drained) this.#releaseOwner(state);
    return result;
  }

  /** Drops publication/capability/owner mapping so the same logical owner can be recreated. */
  #releaseOwner(state: OwnerState): void {
    for (const publication of state.publications) {
      this.#publications.delete(publication.key);
      this.#capabilities.delete(publication.key);
    }
    state.publications.clear();
    state.released = true;
    if (this.#ownersByCaller.get(state.callerSubject) === state) this.#ownersByCaller.delete(state.callerSubject);
  }

  /* ---------------------------- publications ------------------------------ */

  #publish<const M extends Record<string, RpcMethodDefinition>>(
    state: OwnerState,
    contractInput: { readonly id: string; readonly version: number; readonly methods: M },
    handlers: RpcHandlerMap<M, unknown>,
    capabilities?: HostRpcCommandCapabilities<M>,
  ): HostRpcPublication {
    const lifecycleState = state.owner.getLifecycleState();
    if (state.revoked || state.released || this.#closed || lifecycleState.revoked || lifecycleState.retiring) {
      throw new RpcServiceError('closed');
    }
    const contract = defineContract(contractInput);
    if (this.#matchPublication(state, contract.id, contract.version) === null) throw new RpcServiceError('undeclared');
    const key = publicationKey(state.plugin, state.scope, contract.id, contract.version);
    // Duplicate detection happens BEFORE register so no ghost endpoint is created.
    if (this.#publications.has(key)) throw new RpcServiceError('invalid_registration');
    const methodTable = contract.methods as Record<string, RpcMethodDefinition>;
    const collected = snapshotHandlers(methodTable, handlers);
    // Snapshot capabilities BEFORE `register`: a hostile accessor must fail closed with
    // zero endpoints and no parent publication callback, never leave a ghost endpoint.
    const capabilityRecord = snapshotCapabilities(methodTable, capabilities);
    const wrapped: Record<string, Handler> = {};
    for (const [name, definition] of Object.entries(methodTable)) {
      const chainKey = `${state.plugin}${SEP}${state.scope}${SEP}${contract.id}${SEP}${contract.version}${SEP}${name}`;
      wrapped[name] = this.#wrapHandler(collected.get(name) as Handler, definition, chainKey);
    }
    const binding: RpcEndpointBinding = {
      endpoint: state.lifecycle.endpoint,
      process: this.#process,
      instance: state.lifecycle.instance,
      generation: state.lifecycle.generation,
      catalog: state.lifecycle.catalog,
      scope: state.scopeKind,
      subject: state.lifecycle.subject,
    };
    let handle: RpcEndpointHandle;
    try {
      handle = this.runtime.register({
        provider: state.plugin,
        binding,
        contract,
        handler: wrapped as unknown as RpcHandlerMap<M, unknown>,
      });
    } catch {
      throw new RpcServiceError('invalid_registration');
    }
    const descriptor: HostRpcServiceDescriptor = Object.freeze({
      provider: state.plugin, service: contract.id, major: contract.version, kind: 'rpc',
      process: this.#process, scope: state.scopeKind,
    });
    const publication: RegisteredPublication = {
      key, handle, provider: state.plugin, scopeKey: state.scope, scope: state.scopeKind,
      contractId: contract.id, contractVersion: contract.version, ownerState: state,
    };
    this.#publications.set(key, publication);
    state.publications.add(publication);
    if (capabilityRecord !== null && Object.keys(capabilityRecord).length > 0) {
      this.#capabilities.set(key, capabilityRecord);
    }
    try {
      state.owner.registerPublication?.({
        id: contract.id, version: contract.version, kind: 'rpc', process: this.#process, scope: 'global',
      });
    } catch {
      // Roll back completely: no ghost endpoint, no reservation, no capability.
      this.runtime.revoke(handle);
      this.#publications.delete(key);
      this.#capabilities.delete(key);
      state.publications.delete(publication);
      throw new RpcServiceError('invalid_registration');
    }
    return Object.freeze({ descriptor });
  }

  #wrapHandler(original: Handler, definition: RpcMethodDefinition, chainKey: string): Handler {
    // Commands are framed once by `#commandExecutor` for the whole journal capability
    // (execute/query/reconcile); framing the business handler again here would inflate
    // depth and could manufacture false same-method cycles.
    if (definition.kind === 'command') return original;
    return (input, context) => this.#runInFrame(context, chainKey, () => original(input, context));
  }

  /** Runs `run` inside one inherited host frame: purpose, chain, deadline, cancellation. */
  #runInFrame(context: RpcHandlerContext<unknown>, chainKey: string, run: () => unknown): unknown {
    const parent = FRAME_STORE.getStore() ?? null;
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > this.#maxCallDepth) throw new RpcServiceError('call_depth_exceeded', context.operationId);
    const actualDeadline = typeof context.deadlineAt === 'number' ? context.deadlineAt : Number.POSITIVE_INFINITY;
    const frame: ActiveFrame = Object.freeze({
      purpose: context.purpose,
      depth,
      chain: Object.freeze([...(parent?.chain ?? []), chainKey]),
      deadlineAt: parent === null ? actualDeadline : Math.min(parent.deadlineAt, actualDeadline),
      // A nested call must also abort when the parent call is cancelled.
      signal: parent === null ? context.signal : anySignal([parent.signal, context.signal]),
    });
    const enter = this.#options.enterHostHandlerFrame;
    if (enter === undefined) return FRAME_STORE.run(frame, run);
    // The canonical host enters its OWN live invocation frame for the exact
    // published owner, so channel work and nested local dispatch inside this
    // handler inherit the real purpose/deadline/cancel and the exact owner
    // authority instead of being re-interpreted as an unauthenticated background
    // task. `ownerToken` is host-private (`CALLEE_INFO`), never a payload field.
    const info = context.callee !== null && typeof context.callee === 'object'
      ? CALLEE_INFO.get(context.callee as object)
      : undefined;
    const hostFrame: HostRpcHandlerFrame = {
      purpose: frame.purpose,
      ...(Number.isFinite(frame.deadlineAt) ? { deadlineAt: frame.deadlineAt } : {}),
      signal: frame.signal,
      ownerToken: info?.ownerToken ?? null,
      operationId: context.operationId ?? null,
    };
    return FRAME_STORE.run(frame, () => enter(hostFrame, run));
  }

  /* ----------------------------- consumption ------------------------------ */

  #consume<const M extends Record<string, RpcMethodDefinition>>(
    state: OwnerState,
    provider: string,
    contractInput: { readonly id: string; readonly version: number; readonly methods: M },
  ): AsyncRpcClient<M> {
    if (state.released || this.#closed) throw new RpcServiceError('closed');
    if (typeof provider !== 'string' || !provider) throw new RpcServiceError('invalid_registration');
    const contract = defineContract(contractInput);
    const declaration = this.#matchConsumption(state, provider, contract.id, contract.version);
    if (declaration === null) throw new RpcServiceError('undeclared');
    if (!isCrossProcessSelfService(state.plugin, declaration, state.owner.declarations) && (provider === state.plugin || !Object.hasOwn(state.owner.dependencies, provider))) throw new RpcServiceError('undeclared');
    const scopeKey = 'global';
    const firstMethod = Object.keys(contract.methods as Record<string, RpcMethodDefinition>)[0];
    const route = this.#resolveRoute(state, { provider, service: contract.id, major: contract.version, method: firstMethod }, scopeKey);
    if (route.kind === 'ambiguous') throw new RpcServiceError('ambiguous_placement');
    if (route.kind === 'missing') {
      throw new RpcServiceError('unavailable');
    }
    state.owner.registerConsumption?.(declaration, route.kind === 'publication' ? route.publication.ownerState.owner.token : undefined);
    const methodTable = contract.methods as Record<string, RpcMethodDefinition>;
    const client: Record<string, unknown> = {};
    for (const [method, definition] of Object.entries(methodTable)) {
      client[method] = this.#makeMethodClient(state, provider, contract, method, definition);
    }
    return Object.freeze(client) as AsyncRpcClient<M>;
  }

  #makeMethodClient<const M extends Record<string, RpcMethodDefinition>>(
    state: OwnerState,
    provider: string,
    contract: { readonly id: string; readonly version: number; readonly methods: M },
    method: string,
    definition: RpcMethodDefinition,
  ): unknown {
    const target = { provider, service: contract.id, major: contract.version, method };
    const invoke = (action: RpcCommandAction | undefined, input: unknown, operationId: string | null, options: RpcCallOptions) =>
      this.#invokeAction(state, target, definition, action, input, operationId, options);
    const call = async (input: unknown, options?: RpcCallOptions): Promise<unknown> => {
      const snapshot = snapshotCallOptions(options);
      const operationId = this.#operationId(definition, snapshot);
      return invoke(definition.kind === 'command' ? 'execute' : undefined, input, operationId, snapshot);
    };
    if (definition.kind !== 'command') return call;
    const queryResult = (operationId: string): Promise<unknown> =>
      invoke('query-result', null, normalizeOperationId(operationId), EMPTY_OPTIONS);
    const reconcile = (operationId: string, input: unknown): Promise<unknown> =>
      invoke('reconcile', input, normalizeOperationId(operationId), EMPTY_OPTIONS);
    return Object.assign(call, { queryResult, reconcile });
  }

  #operationId(definition: RpcMethodDefinition, options: RpcCallOptions): string | null {
    const raw = options.operationId;
    if (definition.kind === 'query') {
      if (raw !== undefined) throw new RpcServiceError('invalid_operation_id');
      return null;
    }
    if (raw === undefined) throw new RpcServiceError('invalid_operation_id');
    return normalizeOperationId(raw);
  }

  async #invokeAction(
    state: OwnerState,
    target: { readonly provider: string; readonly service: string; readonly major: number; readonly method: string },
    definition: RpcMethodDefinition,
    action: RpcCommandAction | undefined,
    input: unknown,
    operationId: string | null,
    options: RpcCallOptions,
  ): Promise<RpcJson> {
    if (state.revoked || state.released || this.#closed) throw new RpcServiceError('closed', operationId);
    // The manifest consumption and its canonical dependency record are re-validated on
    // every call: a removed declaration or dependency is refused.
    const scopeKey = this.#targetScope(state, target);
    if (scopeKey === null) throw new RpcServiceError('undeclared', operationId);
    const parent = FRAME_STORE.getStore() ?? null;
    if (parent !== null && parent.chain.includes(`${target.provider}${SEP}${scopeKey}${SEP}${target.service}${SEP}${target.major}${SEP}${target.method}`)) {
      throw new RpcServiceError('deadlock');
    }
    // Enforce the consumer contract's own input schema/byte bound before the provider
    // sees the call. `query-result` carries only the null control DTO, never business input.
    if (action !== 'query-result') {
      try {
        const limit = definition.maxInputBytes ?? RPC_JSON_MAX_BYTES;
        input = decodeRpcJson(encodeRpcJson(input, limit), limit);
        assertRpcData(definition.input, input, limit);
      } catch {
        throw new RpcServiceError('invalid_input', operationId);
      }
    }
    const caller = Object.freeze({ subject: state.callerSubject, scope: state.scopeKind });
    // Resolve the host invocation frame exactly once; purpose and request share that snapshot.
    const invocation = state.owner.resolveInvocationContext();
    const purpose = this.#selectPurpose(state, definition, invocation);
    const route = this.#resolveRoute(state, target, scopeKey, purpose);
    if (route.kind === 'ambiguous') throw new RpcServiceError('ambiguous_placement');
    if (route.kind === 'missing') throw new RpcServiceError('unavailable');
    const request = this.#buildRequest(target, caller, purpose, input, operationId, action, options, parent, invocation, state.owner.token);
    try {
      const result = await this.runtime.invoke(request);
      try { assertRpcData(definition.output, result, definition.maxOutputBytes); }
      catch { throw new RpcServiceError('invalid_output', operationId); }
      return result;
    } catch (error) {
      throw toRpcServiceError(error, operationId);
    }
  }

  /** Purpose is inherited, never rank-converted; the method must explicitly allow it. */
  #selectPurpose(state: OwnerState, definition: RpcMethodDefinition, invocation: HostRpcInvocationContext | null): RpcCallPurpose {
    const parent = FRAME_STORE.getStore() ?? null;
    if (parent !== null) return requirePurpose(definition, parent.purpose);
    if (invocation !== null) return requirePurpose(definition, invocation.purpose);
    const ready = state.owner.getLifecycleState().ready;
    return requirePurpose(definition, ready ? 'background' : 'bootstrap');
  }

  #buildRequest(
    target: { readonly provider: string; readonly service: string; readonly major: number; readonly method: string },
    caller: RpcCaller,
    purpose: RpcCallPurpose,
    input: unknown,
    operationId: string | null,
    action: RpcCommandAction | undefined,
    options: RpcCallOptions,
    parent: ActiveFrame | null,
    invocation: HostRpcInvocationContext | null,
    callerToken: object,
  ) {
    let timeoutMs = options.timeoutMs;
    const deadlineAt = Math.min(parent?.deadlineAt ?? Infinity, invocation?.deadlineAt ?? Infinity);
    if (parent !== null && Number.isFinite(parent.deadlineAt)) {
      const remaining = Math.floor(parent.deadlineAt - Date.now());
      timeoutMs = timeoutMs === undefined ? remaining : Math.min(timeoutMs, remaining);
    }
    if (invocation?.deadlineAt !== undefined) {
      const remaining = Math.floor(invocation.deadlineAt - Date.now());
      timeoutMs = timeoutMs === undefined ? remaining : Math.min(timeoutMs, remaining);
    }
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new RpcServiceError('timeout', operationId);
    }
    const explicitSignal = options.signal;
    const parentSignal = parent?.signal;
    let signal = explicitSignal === undefined
      ? parentSignal
      : parentSignal === undefined ? explicitSignal : anySignal([explicitSignal, parentSignal]);
    if (invocation?.signal !== undefined) signal = signal === undefined ? invocation.signal : anySignal([signal, invocation.signal]);
    const request: {
      target: { provider: string; service: string; major: number; method: string };
      caller: RpcCaller;
      callerToken: object;
      purpose: RpcCallPurpose;
      input: unknown;
      operationId?: string;
      commandAction?: RpcCommandAction;
      signal?: AbortSignal;
      timeoutMs?: number;
      deadlineAt?: number;
    } = {
      target: { provider: target.provider, service: target.service, major: target.major, method: target.method },
      caller,
      callerToken,
      purpose,
      input,
    };
    if (operationId !== null) request.operationId = operationId;
    if (action !== undefined) request.commandAction = action;
    if (signal !== undefined) request.signal = signal;
    if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
    if (Number.isFinite(deadlineAt)) request.deadlineAt = deadlineAt;
    return request;
  }

  /* ------------------------------- routing -------------------------------- */

  #matchPublication(state: OwnerState, id: string, version: number): PluginServicePublication | null {
    return state.owner.declarations.provides?.find((value) =>
      value.id === id && value.version === version
      && (value.kind ?? 'local') === 'rpc'
      && value.process === this.#process
      && (value.scope ?? 'global') === 'global' && state.scope === 'global') ?? null;
  }

  #matchConsumption(state: OwnerState, provider: string, id: string, version: number): PluginServiceConsumption | null {
    return state.owner.declarations.consumes?.find((value) =>
      value.plugin === provider && value.id === id && value.version === version
      && (value.kind ?? 'local') === 'rpc'
      && value.process === state.process) ?? null;
  }

  #targetScope(
    state: OwnerState,
    target: { readonly provider: string; readonly service: string; readonly major: number },
  ): string | null {
    const consumption = state.owner.declarations.consumes?.find((value) =>
      value.plugin === target.provider && value.id === target.service && value.version === target.major
      && (value.kind ?? 'local') === 'rpc' && value.process === state.process) ?? null;
    if (consumption === null) return null;
    if (!isCrossProcessSelfService(state.plugin, consumption, state.owner.declarations) && (target.provider === state.plugin || !Object.hasOwn(state.owner.dependencies, target.provider))) return null;
    return 'global';
  }

  /** Host placement authority runs first; `null` opts into the explicit local channel. */
  #resolveRoute(
    state: OwnerState,
    target: { readonly provider: string; readonly service: string; readonly major: number; readonly method: string },
    scopeKey: string,
    purpose?: RpcCallPurpose,
  ): RouteResolution {
    let placement: HostRpcPlacementResolution;
    try {
      placement = this.#options.resolvePlacement({
        provider: target.provider,
        service: target.service,
        major: target.major,
        method: target.method,
        scope: scopeKey === 'global' ? 'global' : 'binding',
        ...(scopeKey === 'global' ? {} : { bindingScope: scopeKey }),
        caller: Object.freeze({ subject: state.callerSubject, scope: state.scopeKind }),
        purpose,
      });
    } catch {
      return { kind: 'missing' };
    }
    if (placement !== null && placement !== undefined) {
      if (placement.kind === 'ambiguous') return { kind: 'ambiguous' };
      return { kind: 'remote', handle: placement.endpoint };
    }
    const publication = this.#publications.get(publicationKey(target.provider, scopeKey, target.service, target.major));
    return publication === undefined ? { kind: 'missing' } : { kind: 'publication', publication };
  }

  /* ----------------------------- admission -------------------------------- */

  #admit(request: RpcAdmissionRequest): RpcAdmissionGrant<unknown> | null {
    if (this.#closed) return null;
    const state = request.callerToken === undefined ? this.#ownersByCaller.get(request.caller.subject)
      : this.#ownersByToken.get(request.callerToken);
    if (state === undefined || state.revoked || state.released) return null;
    if (state.callerSubject !== request.caller.subject
      || (request.caller.scope !== undefined && state.scopeKind !== request.caller.scope)) return null;
    const callerState = state.owner.getLifecycleState();
    if (callerState.revoked) return null;
    if (state.owner.canCall !== undefined && !state.owner.canCall({ ...request.target })) return null;
    if (!callerState.ready && request.purpose !== 'bootstrap') return null;
    const target = { ...request.target };
    const scopeKey = this.#targetScope(state, target);
    if (scopeKey === null) return null;
    const route = this.#resolveRoute(state, target, scopeKey, request.purpose);
    if (route.kind === 'ambiguous' || route.kind === 'missing') return null;
    const publication = route.kind === 'publication' ? route.publication : null;
    const endpoint = route.kind === 'publication' ? route.publication.handle : route.handle;
    // The callee publication is built from the REAL kernel-bound endpoint identity, never
    // from the adapter process or a plugin-supplied location. A foreign/unconfirmable
    // endpoint, or one whose provider/service/major/scope disagrees with the requested
    // target, is refused before any lease or callee frame is produced.
    const info = this.runtime.endpointInfo(endpoint);
    if (info === null) return null;
    if (info.provider !== target.provider || info.contract.id !== target.service || info.contract.version !== target.major) {
      return null;
    }
    const scope = info.binding.scope;
    if ((scopeKey === 'global') !== (scope === 'global')) return null;
    if (!state.local) {
      try { if (state.authorizeIncoming?.(request, info) !== true) return null; }
      catch { return null; }
      if (state.revoked || state.released || this.#closed) return null;
    }
    const provider = info.provider;
    // Logical clients can be relocated without retaining an unrelated local provider.
    const consumption = this.#matchConsumption(state, target.provider, target.service, target.major)!;
    state.owner.registerConsumption?.(consumption, publication?.ownerState.owner.token);
    // Resolve the trusted callee frame before any lease so a throwing host
    // resolver cannot leak leases.
    const hostFrame = this.#options.resolveCallee(
      request,
      Object.freeze({ provider, service: target.service, major: target.major, kind: 'rpc', process: info.binding.process, scope }),
    );
    // Caller lease holds the issuing owner for the whole call lifespan.
    let callerRelease: () => void = () => undefined;
    try {
      const lease = state.owner.acquireLease({
        role: 'caller', plugin: state.plugin, scope: state.scope, state: callerState,
        purpose: request.purpose, operationId: request.operationId, provider: target.provider,
      });
      if (lease === null || typeof lease !== 'object' || typeof lease.release !== 'function') return null;
      callerRelease = once(() => { try { lease.release(); } catch { /* host-owned */ } });
    } catch { return null; }
    // Callee lease holds the provider (local only). A callee the kernel will refuse
    // (revoked / retiring without an existing-lease proof / unready non-bootstrap)
    // is NOT leased here, so the kernel reports the exact state instead of a lease error.
    let calleeRelease: (() => void) | null = null;
    let allowRetired = false;
    if (publication !== null) {
      const calleeState = publication.ownerState.owner.getLifecycleState();
      const runnable = calleeState.revoked ? false
        : calleeState.retiring ? (request.purpose === 'request' || request.purpose === 'attempt')
          : (calleeState.ready || request.purpose === 'bootstrap');
      if (runnable) {
        try {
          const lease = publication.ownerState.owner.acquireLease({
            role: 'callee', plugin: publication.provider, scope: publication.scopeKey, state: calleeState,
            purpose: request.purpose, operationId: request.operationId, provider: target.provider,
          });
          if (lease === null || typeof lease !== 'object' || typeof lease.release !== 'function') {
            callerRelease();
            return null;
          }
          calleeRelease = once(() => { try { lease.release(); } catch { /* host-owned */ } });
          allowRetired = lease.allowRetired === true
            && (request.purpose === 'request' || request.purpose === 'attempt');
        } catch { callerRelease(); return null; }
      }
    }
    const callee = Object.freeze({});
    CALLEE_INFO.set(callee, { provider, scopeKey, scope, frame: hostFrame, ownerToken: publication?.ownerState.owner.token ?? null });
    const release = once(() => {
      try { calleeRelease?.(); } catch { /* host-owned */ }
      try { callerRelease(); } catch { /* host-owned */ }
    });
    // A host callback can synchronously dispose this capability before a task exists.
    // Recheck after every admission callback has returned, before handing the kernel a grant.
    if (state.revoked || state.released || this.#closed) { release(); return null; }
    return {
      endpoint, callee, release, callerToken: state.owner.token,
      allowUnready: request.purpose === 'bootstrap',
      allowRetired,
    };
  }

  /* ------------------------------ commands -------------------------------- */

  #commandExecutor(): RpcCommandExecutor<unknown> {
    const run = async (
      execution: Omit<RpcCommandExecution<unknown>, 'executeBusiness'>,
      action: RpcCommandAction,
    ): Promise<unknown> => {
      const callee = execution.context.callee;
      const info = callee !== null && typeof callee === 'object' ? CALLEE_INFO.get(callee as object) : undefined;
      if (info === undefined) throw new RpcServiceError('capability_unavailable', execution.operationId);
      const chainKey = `${info.provider}${SEP}${info.scopeKey}${SEP}${execution.contract.id}${SEP}${execution.contract.version}${SEP}${execution.method}`;
      const journal = this.#journalFor(info, execution);
      // Application-owned CAS/idempotency (e.g. a budget ledger or credential
      // version fence) has one transaction authority. No parallel journal is
      // created for an explicitly non-deduplicated command.
      if (journal === null && execution.definition.command?.deduplication === 'none') {
        if (action !== 'execute') throw new RpcServiceError('capability_unavailable', execution.operationId);
        return this.#runInFrame(execution.context, chainKey, () => (execution as RpcCommandExecution<unknown>).executeBusiness());
      }
      if (journal === null) throw new RpcServiceError('capability_unavailable', execution.operationId);
      // Every journal action (execute/query/reconcile) runs inside the real RPC frame so
      // the business handler and any nested external-reconcile RPC inherit purpose,
      // chain, deadline, and cancellation. Commands are framed once here, not in #wrapHandler.
      try {
        return await this.#runInFrame(execution.context, chainKey, () => {
          if (action === 'execute') return journal.execute(execution as RpcCommandExecution<unknown>);
          if (action === 'query-result') return journal.query(execution.operationId, execution.context.caller);
          return journal.reconcile(execution);
        });
      } finally {
        if ('close' in journal) {
          // Capability release is resource cleanup, separate from the acknowledged command.
          // A stuck or failed cleanup must not replace success, unknown, or its operation ID.
          void Promise.resolve().then(()=>journal.close()).catch(error=>{
            const rawCode=ownStringProperty(error,'code');
            const code=rawCode!==null&&['worker_failed','request_timeout','request_failed','close_unconfirmed','cleanup_overloaded','queue_full','result_unknown','storage_failure'].includes(rawCode)?rawCode:'failed';
            const failure=Object.freeze({operationId:execution.operationId,code});
            try{logger.error(failure,'Host RPC journal cleanup failed');}catch{/* Reporting cannot change the command outcome. */}
            try{this.#options.onJournalCleanupFailure?.(failure);}catch{/* Host reporting is independent of business completion. */}
          });
        }
      }

    };
    return {
      execute: (execution) => run(execution, 'execute'),
      queryResult: (execution) => run(execution, 'query-result'),
      reconcile: (execution) => run(execution, 'reconcile'),
    };
  }

  #journalFor(
    info: CalleeInfo,
    execution: Omit<RpcCommandExecution<unknown>, 'executeBusiness'>,
  ): AsyncCommandJournal | CommandJournal | null {
    const policy = execution.definition.command;
    if (policy === undefined) throw new RpcServiceError('capability_unavailable', execution.operationId);
    const capability = this.#capabilities.get(
      publicationKey(info.provider, info.scopeKey, execution.contract.id, execution.contract.version),
    )?.[execution.method];
    try {
      return this.#options.resolveJournal({
        provider: info.provider,
        service: execution.contract.id,
        major: execution.contract.version,
        method: execution.method,
        scope: info.scope,
        ...(info.scope === 'binding' ? { bindingScope: info.scopeKey } : {}),
        policy,
        ...(capability?.atomic === undefined ? {} : { atomic: capability.atomic }),
        ...(capability?.atomicReadSet === undefined ? {} : { atomicReadSet: capability.atomicReadSet }),
        ...(capability?.external === undefined ? {} : { external: capability.external }),
      }) ?? null;
    } catch {
      throw new RpcServiceError('capability_unavailable', execution.operationId);
    }
  }
}

function once(action: () => void): () => void {
  let done = false;
  return () => { if (done) return; done = true; action(); };
}
