/**
 * Host-only generic RPC execution kernel (P4): publication validation, admission-gated
 * dispatch, bounded concurrency, cancellation/deadline bookkeeping, retirement, drain, and
 * disposal. It owns NO security policy — the host supplies a required synchronous `admit`
 * callback that resolves a logical target to an exact registered opaque endpoint, a trusted
 * callee context, and a real lease release. No default allow, no retry, no invented context.
 *
 * Hardening guarantees:
 * - The outer invoke request (and its target/caller) is snapshotted through own property
 *   descriptors: accessors, proxies, symbol/unknown keys are rejected and never invoked, so
 *   authorization and dispatch observe the same immutable metadata.
 * - Commands track the REAL business promise, not only the executor promise: fire-and-forget
 *   executors cannot release a task early, and a late `executeBusiness` closure after the
 *   executor is terminal is refused without running user code.
 * - Public rejections are always rebuilt fixed-code errors: provider/admit messages, causes,
 *   and operation ids never leak or spoof the wire error.
 * - Released endpoints drop the full record (handler/contract/runtime) and keep only a
 *   lightweight revoked identity; drain/dispose waiter slots are bounded.
 *
 * Command execution is NOT implemented here: it must go through the host `RpcCommandExecutor`.
 * Durable deduplication, transactions, and cross-system exactly-once guarantees belong to the
 * still-pending P4 journal integration; a declared `command.deduplication` intent is never
 * upgraded into a delivered guarantee.
 */
import { isProxy } from 'node:util/types';
import type { PluginServiceProcess, PluginServiceScope } from './contracts';
import {
  RPC_JSON_MAX_BYTES,
  RpcProtocolError,
  assertRpcData,
  decodeRpcJson,
  defineRpcService,
  encodeRpcJson,
  type InferRpcData,
  type RpcCallKind,
  type RpcCallPurpose,
  type RpcDataSchema,
  type RpcJson,
  type RpcMethodDefinition,
  type RpcServiceContract,
} from './wire-contract';

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROCESSES = new Set<string>(['control', 'worker', 'ingress']);
const SCOPES = new Set<string>(['global', 'binding']);
const PURPOSES = new Set<string>(['bootstrap', 'background', 'management', 'request', 'attempt']);
const DEFAULT_GLOBAL_MAX_IN_FLIGHT = 256;
const DEFAULT_ENDPOINT_MAX_IN_FLIGHT = 64;
const DEFAULT_CALLER_MAX_IN_FLIGHT = 64;
const DEFAULT_MAX_WAITERS = 256;
const DEFAULT_HARD_DEADLINE_MS = 300_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
/** Node clamps setTimeout delays above this to 1ms; reject instead of silently degrading. */
const MAX_TIMER_MS = 2_147_483_647;
const REQUEST_KEYS = ['target', 'caller', 'callerToken', 'purpose', 'input', 'operationId', 'signal', 'timeoutMs', 'deadlineAt', 'maxInputBytes', 'commandAction'] as const;
const TARGET_KEYS = ['provider', 'service', 'major', 'method'] as const;
const CALLER_KEYS = ['subject', 'scope'] as const;

/** Deployment identity bound by the external host verifier's endpoint ref. */
export interface RpcEndpointBinding {
  readonly endpoint: string;
  readonly process: PluginServiceProcess;
  readonly instance: string;
  readonly generation: number;
  readonly catalog: string;
  readonly scope: PluginServiceScope;
  readonly subject: string;
}
/** Logical call target, independent of the physical address and generation. */
export interface RpcInvokeTarget {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly method: string;
}
/** Stable caller identity; the host admission callback decides authorization. */
export interface RpcCaller {
  readonly subject: string;
  readonly scope?: PluginServiceScope;
}
/** Opaque frozen capability minted by `register`; only a WeakMap-registered handle is accepted. */
export interface RpcEndpointHandle {
  readonly __rpcEndpoint?: never;
}
/** Immutable admission input; the runtime snapshots and freezes these before calling `admit`. */
export interface RpcAdmissionRequest {
  readonly target: RpcInvokeTarget;
  readonly caller: RpcCaller;
  /** Host-private concrete caller identity; never supplied by JSON or SDK call options. */
  readonly callerToken?: object;
  readonly purpose: RpcCallPurpose;
  readonly operationId: string | null;
  readonly commandAction?: RpcCommandAction;
}
export interface RpcAdmissionGrant<TCallee = unknown> {
  readonly endpoint: RpcEndpointHandle;
  readonly callee: TCallee;
  /** Releases the real host lease; called exactly once per accepted or rejected attempt. */
  readonly release: () => void;
  /** Admission-owned lifetime identity also covers legacy internal calls without an input token. */
  readonly callerToken?: object;
  /** Trusted host permission for a bootstrap call to a registered-but-not-ready endpoint. */
  readonly allowUnready?: boolean;
  /** Host-verified existing request lease only; never enables new background work. */
  readonly allowRetired?: boolean;
}
/** Must be synchronous: admission is atomic and checked on every request. */
export type RpcAdmission<TCallee = unknown> = (request: RpcAdmissionRequest) => RpcAdmissionGrant<TCallee> | null;
/** Process-local handler context; the signal is never serialized onto the wire. */
export interface RpcHandlerContext<TCallee = unknown> {
  readonly endpoint: Readonly<RpcEndpointBinding & { readonly service: string; readonly version: number }>;
  readonly caller: Readonly<RpcCaller>;
  readonly method: string;
  readonly kind: RpcCallKind;
  readonly purpose: RpcCallPurpose;
  readonly operationId: string | null;
  readonly signal: AbortSignal;
  readonly callee: TCallee;
  /** Actual bounded invocation deadline, including caller and runtime limits. */
  readonly deadlineAt?: number;
}
/** Derives typed handler signatures from a literal contract. */
export type RpcHandlerMap<M extends Record<string, RpcMethodDefinition>, TCallee = unknown> = {
  readonly [K in keyof M]: (
    input: InferRpcData<M[K]['input']>,
    context: RpcHandlerContext<TCallee>,
  ) => InferRpcData<M[K]['output']> | Promise<InferRpcData<M[K]['output']>>;
};
export interface RpcCommandExecution<TCallee = unknown> {
  readonly contract: RpcServiceContract;
  readonly method: string;
  readonly definition: RpcMethodDefinition;
  readonly context: RpcHandlerContext<TCallee>;
  readonly operationId: string;
  readonly input: RpcJson;
  /** Starts the real provider logic once; a repeated call returns the same promise. */
  readonly executeBusiness: () => Promise<RpcJson>;
}
/**
 * Host capability and the ONLY execution path for commands. This kernel invokes `execute` once
 * and never retries. Durable deduplication, transactions, and cross-system exactly-once behavior
 * are NOT implemented here: the P4 journal/CommandExecutor integration is still pending wiring.
 */
export interface RpcCommandExecutor<TCallee = unknown> {
  execute(execution: RpcCommandExecution<TCallee>): Promise<unknown>;
  queryResult?(execution: Omit<RpcCommandExecution<TCallee>, 'executeBusiness'>): Promise<unknown>;
  reconcile?(execution: Omit<RpcCommandExecution<TCallee>, 'executeBusiness'>): Promise<unknown>;
}
export type RpcCommandAction = 'execute' | 'query-result' | 'reconcile';
export type RpcInvocationErrorCode =
  | 'unauthorized' | 'not_ready' | 'retired' | 'revoked' | 'unsupported_method' | 'wrong_purpose'
  | 'invalid_input' | 'invalid_output' | 'invalid_operation_id' | 'overloaded' | 'cancelled'
  | 'timeout' | 'unknown' | 'capability_unavailable' | 'closed' | 'failed'
  | 'conflict' | 'expired' | 'pending' | 'rejected' | 'missing' | 'storage_failure'
  | 'deadlock' | 'call_depth_exceeded';
const ERROR_MESSAGES: Record<RpcInvocationErrorCode, string> = {
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
};
/**
 * Fixed-code error. It never stores a provider/admit cause, message, or payload: the code and
 * the validated invocation's operation id are the only external data. Hosts log the original
 * exception separately.
 */
export class RpcInvocationError extends Error {
  readonly name = 'RpcInvocationError';
  readonly code: RpcInvocationErrorCode;
  readonly operationId: string | null;
  constructor(code: RpcInvocationErrorCode, operationId: string | null = null) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.operationId = operationId;
  }
}
export interface RpcRuntimeLimits {
  readonly maxEndpoints?: number;
  readonly globalMaxInFlight?: number;
  readonly endpointMaxInFlight?: number;
  readonly callerMaxInFlight?: number;
  readonly maxWaiters?: number;
  readonly hardDeadlineMs?: number;
  readonly drainTimeoutMs?: number;
}
interface ResolvedLimits {
  readonly maxEndpoints: number;
  readonly globalMaxInFlight: number;
  readonly endpointMaxInFlight: number;
  readonly callerMaxInFlight: number;
  readonly maxWaiters: number;
  readonly hardDeadlineMs: number;
  readonly drainTimeoutMs: number;
}
export interface RpcInvokeRequest {
  readonly target: RpcInvokeTarget;
  readonly caller: RpcCaller;
  /** Host-private lifetime identity, separate from the journal's stable logical caller. */
  readonly callerToken?: object;
  readonly purpose: RpcCallPurpose;
  readonly input: unknown;
  readonly operationId?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Host-owned absolute upper bound; never recomputed from a remaining duration. */
  readonly deadlineAt?: number;
  /** Narrower caller/parent header budget, combined with the method input limit. */
  readonly maxInputBytes?: number;
  /** Command control actions use the same target authorization, lease and deadline. */
  readonly commandAction?: RpcCommandAction;
}
export interface RpcRuntimeStatus {
  readonly closed: boolean;
  readonly active: number;
  readonly endpoints: number;
  readonly waiters: number;
}
export interface RpcDrainResult {
  readonly drained: boolean;
  readonly active: number;
}
export interface RpcDisposeResult {
  readonly disposed: boolean;
  readonly active: number;
}
export interface RpcRuntimeOptions<TCallee = unknown> {
  readonly admit: RpcAdmission<TCallee>;
  readonly commandExecutor?: RpcCommandExecutor<TCallee>;
  readonly hostLifetime?: AbortSignal;
  readonly limits?: RpcRuntimeLimits;
}
/** Host transport only. A rejected terminal promise never proves remote work ended. */
export interface RpcProxyExecution {
  readonly result: Promise<unknown>;
  readonly terminal: Promise<void>;
}
export interface RpcProxyRequest<TCallee = unknown> {
  readonly method: string;
  readonly input: RpcJson;
  readonly context: RpcHandlerContext<TCallee>;
  readonly commandAction?: RpcCommandAction;
}
export type RpcProxyExecutor<TCallee = unknown> = (request: RpcProxyRequest<TCallee>) => RpcProxyExecution;
type Handler = (input: RpcJson, context: RpcHandlerContext<unknown>) => unknown;
interface InvocationTracking { started: () => void; terminal: () => void }
interface EndpointRecord {
  readonly handle: RpcEndpointHandle;
  readonly runtime: object;
  readonly provider: string;
  readonly contract: RpcServiceContract;
  readonly methods: ReadonlyMap<string, RpcMethodDefinition>;
  readonly handler: ReadonlyMap<string, Handler>;
  readonly proxy: RpcProxyExecutor<unknown> | null;
  readonly binding: Readonly<RpcEndpointBinding>;
  ready: boolean;
  retiring: boolean;
  revoked: boolean;
  readonly active: Set<CallTask>;
}
type AbortReason = 'cancelled' | 'timeout' | 'closed' | 'revoked' | 'retired';
interface CallTask {
  readonly record: EndpointRecord;
  readonly caller: RpcCaller;
  readonly callerKey: string;
  readonly callerToken?: object;
  readonly kind: RpcCallKind;
  readonly purpose: RpcCallPurpose;
  readonly deadlineAt: number;
  readonly allowRetired: boolean;
  readonly operationId: string | null;
  readonly release: () => void;
  readonly controller: AbortController;
  readonly cleanups: Array<() => void>;
  abortReason: AbortReason | null;
  callerSettled: boolean;
  finished: boolean;
  delivered: boolean;
  proxyTerminal: boolean;
  onTerminal?: () => void;
  resolve: (value: RpcJson) => void;
  reject: (error: unknown) => void;
}
interface Waiter {
  check: () => boolean;
  settle: () => void;
}
const ENDPOINTS = new WeakMap<object, EndpointRecord>();
/** Revoked identity only: handle -> the runtime token that owned it. Never retains the record. */
const REVOKED = new WeakMap<object, object>();

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RpcProtocolError('invalid_contract', `invalid_contract: invalid ${label}`);
  }
  return value;
}
function timeoutLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RpcProtocolError('invalid_contract', 'invalid_contract: invalid timeout bound');
  }
  return value;
}
function resolveLimits(limits: RpcRuntimeLimits = {}): ResolvedLimits {
  return Object.freeze({
    maxEndpoints: positiveLimit(limits.maxEndpoints, 1024, 'endpoint limit'),
    globalMaxInFlight: positiveLimit(limits.globalMaxInFlight, DEFAULT_GLOBAL_MAX_IN_FLIGHT, 'global capacity'),
    endpointMaxInFlight: positiveLimit(limits.endpointMaxInFlight, DEFAULT_ENDPOINT_MAX_IN_FLIGHT, 'endpoint capacity'),
    callerMaxInFlight: positiveLimit(limits.callerMaxInFlight, DEFAULT_CALLER_MAX_IN_FLIGHT, 'caller capacity'),
    maxWaiters: positiveLimit(limits.maxWaiters, DEFAULT_MAX_WAITERS, 'waiter capacity'),
    hardDeadlineMs: timeoutLimit(limits.hardDeadlineMs, DEFAULT_HARD_DEADLINE_MS),
    drainTimeoutMs: timeoutLimit(limits.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS),
  });
}
function once(action: () => void): () => void {
  let done = false;
  return () => { if (done) return; done = true; action(); };
}
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const type = typeof value;
  if (type !== 'object' && type !== 'function') return false;
  try { return typeof (value as { then?: unknown }).then === 'function'; } catch { return false; }
}
function invalidRegistration(): RpcProtocolError {
  return new RpcProtocolError('invalid_contract', 'invalid_contract: invalid RPC endpoint registration');
}
function invalidInput(): RpcInvocationError {
  return new RpcInvocationError('invalid_input');
}
/** Never reuses a provider error, cause, message or spoofed operation id. */
function invocationFailure(error: unknown, operationId: string | null): RpcInvocationError {
  if (error !== null && typeof error === 'object' && !isProxy(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code = descriptor && 'value' in descriptor ? descriptor.value : null;
    if (typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)) {
      return new RpcInvocationError(code as RpcInvocationErrorCode, operationId);
    }
  }
  return new RpcInvocationError('failed', operationId);
}
function freezeBinding(binding: RpcEndpointBinding): Readonly<RpcEndpointBinding> {
  if (binding === null || typeof binding !== 'object') throw invalidRegistration();
  const record = binding as unknown as Record<string, unknown>;
  const endpoint = record.endpoint;
  const process = record.process;
  const instance = record.instance;
  const generation = record.generation;
  const catalog = record.catalog;
  const scope = record.scope;
  const subject = record.subject;
  if (typeof endpoint !== 'string' || !endpoint) throw invalidRegistration();
  if (typeof process !== 'string' || !PROCESSES.has(process)) throw invalidRegistration();
  if (typeof instance !== 'string' || !instance) throw invalidRegistration();
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) throw invalidRegistration();
  if (typeof catalog !== 'string') throw invalidRegistration();
  if (typeof scope !== 'string' || !SCOPES.has(scope)) throw invalidRegistration();
  if (typeof subject !== 'string' || !subject) throw invalidRegistration();
  return Object.freeze({
    endpoint, process: process as PluginServiceProcess, instance, generation, catalog,
    scope: scope as PluginServiceScope, subject,
  });
}
/**
 * Requires an exact own data-function for every declared method and nothing else: no prototype
 * fallback, accessor, symbol key, or `toJSON` path. A provider class may publish bound plain
 * functions as own properties.
 */
function validateHandler(methods: Record<string, RpcMethodDefinition>, handler: unknown): ReadonlyMap<string, Handler> {
  if (handler === null || typeof handler !== 'object') throw invalidRegistration();
  const prototype = Object.getPrototypeOf(handler);
  if (prototype !== Object.prototype && prototype !== null) throw invalidRegistration();
  const declared = Object.keys(methods);
  const allowed = new Set(declared);
  const collected = new Map<string, Handler>();
  for (const key of Reflect.ownKeys(handler)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw invalidRegistration();
    const descriptor = Object.getOwnPropertyDescriptor(handler, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw invalidRegistration();
    collected.set(key, descriptor.value as Handler);
  }
  for (const name of declared) if (!collected.has(name)) throw invalidRegistration();
  return collected;
}
/**
 * Copies own enumerable data properties without ever invoking accessors or proxy traps. Unknown
 * keys, symbols, non-enumerable properties, and non-plain objects are rejected.
 */
function snapshotPlain(source: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (source === null || typeof source !== 'object' || isProxy(source)) throw invalidInput();
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw invalidInput();
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalidInput();
    result[key] = descriptor.value;
  }
  return result;
}
function requireString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw invalidInput();
  return value;
}
function requireId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalidInput();
  return value;
}
/** Snapshots the outer invoke request and its target/caller into frozen, getter-free metadata. */
function snapshotInvokeRequest(request: unknown): RpcInvokeRequest {
  const fields = snapshotPlain(request, REQUEST_KEYS);
  const targetFields = snapshotPlain(fields.target, TARGET_KEYS);
  const target: RpcInvokeTarget = Object.freeze({
    provider: requireString(targetFields.provider),
    service: requireString(targetFields.service),
    major: requireId(targetFields.major),
    method: requireString(targetFields.method),
  });
  const callerFields = snapshotPlain(fields.caller, CALLER_KEYS);
  const subject = requireString(callerFields.subject);
  const rawScope = callerFields.scope;
  if (rawScope !== undefined && (typeof rawScope !== 'string' || !SCOPES.has(rawScope))) throw invalidInput();
  const caller: RpcCaller = Object.freeze(rawScope === undefined
    ? { subject }
    : { subject, scope: rawScope as PluginServiceScope });
  const callerToken = fields.callerToken;
  if (callerToken !== undefined && (callerToken === null || typeof callerToken !== 'object' || isProxy(callerToken))) throw invalidInput();
  const rawPurpose = fields.purpose;
  if (typeof rawPurpose !== 'string' || !PURPOSES.has(rawPurpose)) throw invalidInput();
  if (!Object.prototype.hasOwnProperty.call(fields, 'input')) throw invalidInput();
  const rawOperationId = fields.operationId;
  let operationId: string | null = null;
  if (rawOperationId !== undefined && rawOperationId !== null) {
    if (typeof rawOperationId !== 'string' || !OPERATION_ID.test(rawOperationId)) throw new RpcInvocationError('invalid_operation_id');
    operationId = rawOperationId;
  }
  const rawTimeout = fields.timeoutMs;
  if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isSafeInteger(rawTimeout) || rawTimeout < 0)) {
    throw invalidInput();
  }
  const rawDeadline = fields.deadlineAt;
  if (rawDeadline !== undefined && (typeof rawDeadline !== 'number' || !Number.isSafeInteger(rawDeadline) || rawDeadline <= 0)) throw invalidInput();
  const rawMaxInput = fields.maxInputBytes;
  if (rawMaxInput !== undefined
    && (typeof rawMaxInput !== 'number' || !Number.isSafeInteger(rawMaxInput) || rawMaxInput <= 0 || rawMaxInput > RPC_JSON_MAX_BYTES)) {
    throw invalidInput();
  }
  const rawSignal = fields.signal;
  if (rawSignal !== undefined && !(rawSignal instanceof AbortSignal)) throw invalidInput();
  const commandAction = fields.commandAction;
  if (commandAction !== undefined && commandAction !== 'execute'
    && commandAction !== 'query-result' && commandAction !== 'reconcile') throw invalidInput();
  return Object.freeze({
    target, caller, callerToken: callerToken as object | undefined, purpose: rawPurpose as RpcCallPurpose, input: fields.input, operationId,
    signal: rawSignal as AbortSignal | undefined,
    timeoutMs: rawTimeout as number | undefined,
    deadlineAt: rawDeadline as number | undefined,
    maxInputBytes: rawMaxInput as number | undefined,
    commandAction: commandAction as RpcCommandAction | undefined,
  });
}

export class RpcServiceRuntime<TCallee = unknown> {
  readonly #admit: RpcAdmission<TCallee>;
  readonly #commandExecutor: RpcCommandExecutor<TCallee> | undefined;
  readonly #hostLifetime: AbortSignal | undefined;
  readonly #limits: ResolvedLimits;
  readonly #identity: object = Object.freeze({});
  readonly #endpoints = new Set<EndpointRecord>();
  readonly #tasks = new Set<CallTask>();
  readonly #callerCounts = new Map<string, number>();
  readonly #waiters = new Set<Waiter>();
  #closed = false;

  constructor(options: RpcRuntimeOptions<TCallee>) {
    if (options === null || typeof options !== 'object' || typeof options.admit !== 'function') {
      throw new RpcProtocolError('invalid_contract', 'invalid_contract: a host admission callback is required');
    }
    this.#admit = options.admit;
    this.#commandExecutor = options.commandExecutor;
    this.#hostLifetime = options.hostLifetime;
    this.#limits = resolveLimits(options.limits);
  }

  /** Validates contract+handler, binds deployment identity, returns the opaque host-owned capability. */
  register<const M extends Record<string, RpcMethodDefinition>>(options: {
    readonly provider: string;
    readonly binding: RpcEndpointBinding;
    readonly contract: { readonly id: string; readonly version: number; readonly methods: M };
    readonly handler: RpcHandlerMap<M, TCallee>;
  }): RpcEndpointHandle {
    return this.#register(options, methods => ({ handler: validateHandler(methods, options.handler), proxy: null }));
  }

  /** Remote commands execute their journal at the provider, never again at this proxy. */
  registerProxy<const M extends Record<string, RpcMethodDefinition>>(options: {
    readonly provider: string;
    readonly binding: RpcEndpointBinding;
    readonly contract: { readonly id: string; readonly version: number; readonly methods: M };
    readonly execute: RpcProxyExecutor<TCallee>;
  }): RpcEndpointHandle {
    return this.#register(options, () => {
      const execute = options.execute;
      if (typeof execute !== 'function') throw invalidRegistration();
      return { handler: new Map(), proxy: execute as unknown as RpcProxyExecutor<unknown> };
    });
  }

  #register(options: { readonly provider: string; readonly binding: RpcEndpointBinding; readonly contract: RpcServiceContract },
    implementation: (methods: Record<string, RpcMethodDefinition>) => { handler: ReadonlyMap<string, Handler>; proxy: RpcProxyExecutor<unknown> | null }): RpcEndpointHandle {
    if (this.#closed || this.#hostLifetime?.aborted) throw new RpcInvocationError('closed');
    if (this.#endpoints.size >= this.#limits.maxEndpoints) throw new RpcInvocationError('overloaded');
    if (options === null || typeof options !== 'object') throw invalidRegistration();
    if (typeof options.provider !== 'string' || !options.provider) throw invalidRegistration();
    const contract = defineRpcService(options.contract);
    const methodTable = contract.methods as Record<string, RpcMethodDefinition>;
    const methods = new Map<string, RpcMethodDefinition>();
    for (const name of Object.keys(methodTable)) methods.set(name, methodTable[name]);
    const binding = freezeBinding(options.binding);
    const { handler, proxy } = implementation(methodTable);
    const handle: RpcEndpointHandle = Object.freeze({});
    const record: EndpointRecord = {
      handle, runtime: this, provider: options.provider, contract, methods, handler, proxy, binding,
      ready: false, retiring: false, revoked: false, active: new Set(),
    };
    ENDPOINTS.set(handle, record);
    this.#endpoints.add(record);
    return handle;
  }

  markReady(handle: RpcEndpointHandle): boolean {
    const record = this.#lookup(handle);
    if (!record || record.revoked || record.retiring) return false;
    record.ready = true;
    return true;
  }

  /** Stops new admissions immediately; already-accepted calls keep their lease until they finish. */
  retire(handle: RpcEndpointHandle): boolean {
    const record = this.#lookup(handle);
    if (!record || record.revoked) return false;
    record.retiring = true;
    return true;
  }

  /** Rejects the old reference and settles in-flight callers; late replies are never delivered. */
  revoke(handle: RpcEndpointHandle): boolean {
    const record = this.#lookup(handle);
    if (!record || record.revoked) return false;
    record.revoked = true;
    record.retiring = true;
    for (const task of [...record.active]) this.#abortTask(task, 'revoked');
    if (record.active.size === 0) this.#releaseRecord(record);
    return true;
  }

  /** Host-only entire-endpoint drain/verified peer exit proof. A single-call ACK must NOT use this. */
  confirmProxyEndpointStopped(handle: RpcEndpointHandle): boolean {
    const record = this.#lookup(handle);
    if (!record?.proxy) return false;
    this.revoke(handle);
    for (const task of [...record.active]) {
      task.proxyTerminal = true;
      if (task.callerSettled) this.#finishTask(task);
    }
    return true;
  }

  /** Small internal status; never exposed through a handler context. */
  status(): RpcRuntimeStatus {
    return Object.freeze({
      closed: this.#closed,
      active: this.#tasks.size,
      endpoints: this.#endpoints.size,
      waiters: this.#waiters.size,
    });
  }

  /**
   * Read-only registered metadata for an endpoint handle owned by this runtime. It exposes
   * only the immutable provider/binding/contract clone and never the handler, owner resource, or
   * caller context. Foreign, forged, and released handles return null. Revoked but still-active
   * records retain metadata until real work drains; admission still rejects their revocation.
   */
  endpointInfo(handle: RpcEndpointHandle): Readonly<{
    readonly provider: string;
    readonly binding: Readonly<RpcEndpointBinding>;
    readonly contract: RpcServiceContract;
  }> | null {
    const record = this.#lookup(handle);
    if (!record) return null;
    return Object.freeze({ provider: record.provider, binding: record.binding, contract: record.contract });
  }

  /** Bounded wait; a timeout reports the real active count and never claims disposal. */
  async drain(handle: RpcEndpointHandle, options: { readonly timeoutMs?: number } = {}): Promise<RpcDrainResult> {
    const record = this.#lookup(handle);
    if (!record) return Object.freeze({ drained: true, active: 0 });
    record.retiring = true;
    const timeoutMs = this.#resolveTimeout(options.timeoutMs, this.#limits.drainTimeoutMs);
    const drained = await this.#waitFor(() => record.active.size === 0, timeoutMs);
    return Object.freeze({ drained, active: record.active.size });
  }

  /** Canonical owner disposal also joins calls issued by owners without publications. */
  async drainOwner(callerSubject: string, handles: readonly RpcEndpointHandle[], options: { readonly timeoutMs?: number; readonly callerToken?: object } = {}): Promise<RpcDrainResult> {
    const records = new Set(handles.map(handle => this.#lookup(handle)).filter((record): record is EndpointRecord => record !== null));
    const ownedTasks = () => [...this.#tasks].filter(task => (task.callerKey === callerSubject
      && (options.callerToken === undefined || task.callerToken === options.callerToken)) || records.has(task.record));
    const timeoutMs = this.#resolveTimeout(options.timeoutMs, this.#limits.drainTimeoutMs);
    const drained = await this.#waitFor(() => ownedTasks().length === 0, timeoutMs);
    return Object.freeze({ drained, active: ownedTasks().length });
  }

  /** Revocation settles callers but still retains actual work, capacity and leases. */
  revokeCaller(callerSubject: string, callerToken?: object): void {
    for (const task of this.#tasks) if (task.callerKey === callerSubject
      && (callerToken === undefined || task.callerToken === callerToken)) this.#abortTask(task, 'revoked');
  }

  /** Closes admission, aborts callers, and bounded-joins real work without faking success. */
  async dispose(options: { readonly timeoutMs?: number } = {}): Promise<RpcDisposeResult> {
    this.#closed = true;
    for (const record of [...this.#endpoints]) {
      record.retiring = true;
      record.revoked = true;
    }
    for (const task of [...this.#tasks]) this.#abortTask(task, 'closed');
    for (const record of [...this.#endpoints]) if (record.active.size === 0) this.#releaseRecord(record);
    const timeoutMs = this.#resolveTimeout(options.timeoutMs, this.#limits.drainTimeoutMs);
    const disposed = await this.#waitFor(() => this.#tasks.size === 0, timeoutMs);
    return Object.freeze({ disposed, active: this.#tasks.size });
  }

  async invoke(request: RpcInvokeRequest): Promise<RpcJson> {
    return this.#invoke(request);
  }

  /** Host receiver obtains actual completion evidence, not merely the caller reply. */
  invokeTracked(request: RpcInvokeRequest): RpcProxyExecution {
    let started = false;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>(resolve => { resolveTerminal = resolve; });
    const result = this.#invoke(request, { started: () => { started = true; }, terminal: resolveTerminal });
    // A pre-admission rejection has no task or side effect to wait for.
    void result.then(() => { if (!started) resolveTerminal(); }, () => { if (!started) resolveTerminal(); });
    return Object.freeze({ result, terminal });
  }

  async #invoke(request: RpcInvokeRequest, tracking?: InvocationTracking): Promise<RpcJson> {
    if (this.#closed) throw new RpcInvocationError('closed');
    const snapshot = snapshotInvokeRequest(request);
    const { target, caller, purpose } = snapshot;
    const operationIdInput = snapshot.operationId ?? null;
    // Pre-admission cancellation must never consume admission or a host lease.
    if (snapshot.signal?.aborted) throw new RpcInvocationError('cancelled');
    if (this.#hostLifetime?.aborted) throw new RpcInvocationError('closed');
    if (snapshot.timeoutMs !== undefined && snapshot.timeoutMs <= 0) throw new RpcInvocationError('timeout');
    if (snapshot.deadlineAt !== undefined && snapshot.deadlineAt <= Date.now()) throw new RpcInvocationError('timeout');

    let grant: RpcAdmissionGrant<TCallee> | null;
    try {
      grant = this.#admit({ target, caller, callerToken: snapshot.callerToken, purpose, operationId: operationIdInput, commandAction: snapshot.commandAction });
    } catch {
      throw new RpcInvocationError('unauthorized');
    }
    if (grant === null || grant === undefined || typeof grant !== 'object'
      || typeof (grant as { release?: unknown }).release !== 'function') {
      throw new RpcInvocationError('unauthorized');
    }
    const release = once(() => {
      try { grant!.release(); } catch { /* the host lease is host-owned */ }
    });
    try {
      const resolved = this.#resolveAdmissionEndpoint(grant.endpoint);
      if (resolved === null) throw new RpcInvocationError('unauthorized');
      if (resolved === 'revoked') throw new RpcInvocationError('revoked');
      const record = resolved;
      if (record.provider !== target.provider
        || record.contract.id !== target.service
        || record.contract.version !== target.major) {
        throw new RpcInvocationError('unauthorized');
      }
      if (record.revoked) throw new RpcInvocationError('revoked');
      const allowRetired = grant.allowRetired === true && (purpose === 'request' || purpose === 'attempt');
      if (record.retiring && !allowRetired) throw new RpcInvocationError('retired');
      if (!record.ready && !(grant.allowUnready === true && purpose === 'bootstrap')) {
        throw new RpcInvocationError('not_ready');
      }
      const definition = record.methods.get(target.method);
      if (!definition) throw new RpcInvocationError('unsupported_method');
      if (!definition.purposes.includes(purpose)) throw new RpcInvocationError('wrong_purpose');
      if (snapshot.commandAction !== undefined && definition.kind !== 'command') throw new RpcInvocationError('invalid_input');
      if (definition.kind === 'command' && operationIdInput === null) throw new RpcInvocationError('invalid_operation_id');
      const grantToken = grant.callerToken;
      if (grantToken !== undefined && (grantToken === null || typeof grantToken !== 'object' || isProxy(grantToken))) throw new RpcInvocationError('unauthorized');
      const callerToken = grantToken === undefined ? snapshot.callerToken : grantToken;
      this.#assertCapacity(record, caller.subject);
      return this.#execute(record, target.method, definition, snapshot, operationIdInput, grant, release, callerToken, tracking);
    } catch (error) {
      release();
      if (error instanceof RpcInvocationError) throw error;
      throw new RpcInvocationError('failed');
    }
  }

  #execute(
    record: EndpointRecord,
    method: string,
    definition: RpcMethodDefinition,
    request: RpcInvokeRequest,
    operationIdInput: string | null,
    grant: RpcAdmissionGrant<TCallee>,
    release: () => void,
    callerToken: object | undefined,
    tracking?: InvocationTracking,
  ): Promise<RpcJson> {
    return new Promise<RpcJson>((resolve, reject) => {
      const task: CallTask = {
        record, caller: request.caller, callerKey: request.caller.subject, callerToken,
        kind: request.commandAction === 'query-result' ? 'query' : definition.kind,
        purpose: request.purpose, operationId: definition.kind === 'command' ? operationIdInput : null,
        deadlineAt: Math.min(request.deadlineAt ?? Infinity, Date.now() + Math.min(definition.timeoutMs ?? Infinity, request.timeoutMs ?? Infinity, this.#limits.hardDeadlineMs)),
        allowRetired: grant.allowRetired === true && (request.purpose === 'request' || request.purpose === 'attempt'),
        release, controller: new AbortController(), cleanups: [], abortReason: null, callerSettled: false,
        finished: false, delivered: false, proxyTerminal: false, onTerminal: tracking?.terminal, resolve, reject,
      };
      record.active.add(task);
      this.#tasks.add(task);
      this.#addCallerCount(task.callerKey, 1);
      tracking?.started();
      try {
        this.#attachCancellation(task, request);
      } catch {
        this.#finishTask(task);
        reject(new RpcInvocationError('failed'));
        return;
      }
      if (task.finished) return;
      if (this.#closed || this.#hostLifetime?.aborted) return this.#abortTask(task, 'closed');
      if (record.revoked) return this.#abortTask(task, 'revoked');
      if (record.retiring && !task.allowRetired) return this.#abortTask(task, 'retired');
      if (request.signal?.aborted) return this.#abortTask(task, 'cancelled');

      let input: RpcJson;
      try {
        input = request.commandAction === 'query-result' ? null
          : this.#validateData(definition.input, request.input, definition.maxInputBytes ?? RPC_JSON_MAX_BYTES, request.maxInputBytes);
      } catch (error) {
        task.callerSettled = true;
        reject(error instanceof RpcInvocationError ? error : new RpcInvocationError('invalid_input'));
        this.#finishTask(task);
        return;
      }
      // Re-confirm immediately before dispatch; never launch if the task was invalidated or the
      // absolute deadline already passed while this synchronous path ran.
      if (task.finished) return;
      if (this.#closed || this.#hostLifetime?.aborted) return this.#abortTask(task, 'closed');
      if (record.revoked) return this.#abortTask(task, 'revoked');
      if (record.retiring && !task.allowRetired) return this.#abortTask(task, 'retired');
      if (request.signal?.aborted) return this.#abortTask(task, 'cancelled');
      if (Date.now() >= task.deadlineAt) return this.#abortTask(task, 'timeout');

      task.delivered = true;
      if (record.proxy !== null) {
        this.#runProxy(record, method, definition, task, input, grant.callee, request.commandAction);
        return;
      }
      const actual = definition.kind === 'command'
        ? this.#runCommand(record, method, definition, task, input, task.operationId!, grant.callee, request.commandAction ?? 'execute')
        : this.#runQuery(record, method, definition, task, input, grant.callee);
      // The deadline timer cannot preempt synchronous work, so terminal delivery re-checks the
      // absolute deadline: a result that only settles past it is refused instead of delivered.
      actual.then(
        (output) => {
          if (task.callerSettled) return;
          task.callerSettled = true;
          if (Date.now() >= task.deadlineAt) task.reject(this.#deadlineError(task));
          else task.resolve(output);
        },
        (error) => {
          if (task.callerSettled) return;
          task.callerSettled = true;
          if (Date.now() >= task.deadlineAt) task.reject(this.#deadlineError(task));
          else task.reject(error);
        },
      ).finally(() => {
        try { this.#finishTask(task); } catch { /* teardown is best-effort */ }
      });
    });
  }

  #attachCancellation(task: CallTask, request: RpcInvokeRequest): void {
    const sources: ReadonlyArray<{ signal: AbortSignal | undefined; reason: AbortReason }> = [
      { signal: request.signal, reason: 'cancelled' },
      { signal: this.#hostLifetime, reason: 'closed' },
    ];
    for (const source of sources) {
      const signal = source.signal;
      if (!signal || signal.aborted) continue;
      const listener = () => { this.#abortTask(task, source.reason); };
      signal.addEventListener('abort', listener, { once: true });
      task.cleanups.push(() => signal.removeEventListener('abort', listener));
    }
    const deadlineMs = task.deadlineAt - Date.now();
    if (Number.isFinite(deadlineMs)) {
      const timer = setTimeout(() => { this.#abortTask(task, 'timeout'); }, Math.max(0, deadlineMs));
      task.cleanups.push(() => clearTimeout(timer));
    }
  }

  #runProxy(record: EndpointRecord, method: string, definition: RpcMethodDefinition, task: CallTask,
    input: RpcJson, callee: TCallee, commandAction?: RpcCommandAction): void {
    const failUnconfirmed = (): void => {
      if (!task.callerSettled) {
        task.callerSettled = true;
        task.reject(new RpcInvocationError(task.kind === 'command' ? 'unknown' : 'failed', task.operationId));
      }
      if (!task.controller.signal.aborted) task.controller.abort('proxy_terminal_unconfirmed');
      // Transport failure is not remote terminal evidence. Capacity and lease stay held.
    };
    let resultPromise: Promise<unknown> | undefined;
    let terminalPromise: Promise<void> | undefined;
    try {
      const execution = record.proxy!({ method, input, context: this.#handlerContext(record, task, method, definition, callee),
        ...(definition.kind === 'command' ? { commandAction: commandAction ?? 'execute' } : {}) });
      const result = execution.result;
      if (result instanceof Promise) { resultPromise = result; void result.catch(() => undefined); }
      const terminal = execution.terminal;
      if (terminal instanceof Promise) { terminalPromise = terminal; void terminal.catch(() => undefined); }
      if (resultPromise === undefined || terminalPromise === undefined) throw invalidRegistration();
    } catch {
      failUnconfirmed();
      return;
    }
    void resultPromise.then(
      value => {
        if (task.callerSettled) return;
        let result: RpcJson;
        try { result = this.#validateOutput(definition, value); }
        catch (error) { task.callerSettled = true; task.reject(Date.now() >= task.deadlineAt ? this.#deadlineError(task) : error); return; }
        task.callerSettled = true;
        if (Date.now() >= task.deadlineAt) task.reject(this.#deadlineError(task));
        else task.resolve(result);
      },
      error => {
        if (task.callerSettled) return;
        task.callerSettled = true;
        const failure = error instanceof RpcInvocationError ? invocationFailure(error, task.operationId)
          : new RpcInvocationError(task.kind === 'command' ? 'unknown' : 'failed', task.operationId);
        task.reject(Date.now() >= task.deadlineAt ? this.#deadlineError(task) : failure);
      },
    ).finally(() => { if (task.proxyTerminal) this.#finishTask(task); });
    void terminalPromise.then(() => {
      task.proxyTerminal = true;
      if (task.callerSettled) this.#finishTask(task);
    }, failUnconfirmed);
  }

  async #runQuery(
    record: EndpointRecord,
    method: string,
    definition: RpcMethodDefinition,
    task: CallTask,
    input: RpcJson,
    callee: TCallee,
  ): Promise<RpcJson> {
    const handler = record.handler.get(method);
    if (!handler) throw new RpcInvocationError('unsupported_method', task.operationId);
    const context = this.#handlerContext(record, task, method, definition, callee);
    let raw: unknown;
    try {
      raw = handler(input, context);
      if (isThenable(raw)) raw = await raw;
    } catch {
      // Query handlers are provider code; they cannot forge host error codes.
      throw new RpcInvocationError('failed', task.operationId);
    }
    return this.#validateOutput(definition, raw);
  }

  async #runCommand(
    record: EndpointRecord,
    method: string,
    definition: RpcMethodDefinition,
    task: CallTask,
    input: RpcJson,
    operationId: string,
    callee: TCallee,
    action: RpcCommandAction,
  ): Promise<RpcJson> {
    const executor = this.#commandExecutor;
    if (!executor) throw new RpcInvocationError('capability_unavailable', operationId);
    const handler = record.handler.get(method);
    if (!handler) throw new RpcInvocationError('unsupported_method', operationId);
    const context = this.#handlerContext(record, task, method, definition, callee);
    if (action !== 'execute') {
      const control = action === 'query-result' ? executor.queryResult : executor.reconcile;
      if (typeof control !== 'function') throw new RpcInvocationError('capability_unavailable', operationId);
      const execution = Object.freeze({ contract: record.contract, method, definition, context, operationId, input });
      let result: unknown;
      try { result = await control.call(executor, execution); }
      catch (error) { throw invocationFailure(error, operationId); }
      return this.#validateOutput(definition, result);
    }
    let executorSettled = false;
    let businessStarted = false;
    let business: Promise<RpcJson> | undefined;

    const executeBusiness = (): Promise<RpcJson> => {
      if (businessStarted) return business!;
      // The first business dispatch re-checks the absolute deadline: a synchronous executor can
      // outlive the deadline timer, so an expired closure must never run provider code.
      const expired = Date.now() >= task.deadlineAt;
      if (executorSettled || task.finished || task.controller.signal.aborted || expired) {
        const reason: RpcInvocationErrorCode = task.abortReason === 'revoked' ? 'revoked'
          : (task.abortReason === 'closed' || this.#closed ? 'closed'
            : (expired ? this.#deadlineCode(task) : 'unknown'));
        const refused: Promise<RpcJson> = Promise.reject(new RpcInvocationError(reason, operationId));
        void refused.catch(() => undefined);
        // Install the refusal as the business outcome so a fire-and-forget executor that returned
        // success is still surfaced as a failure instead of a forged success.
        businessStarted = true;
        business = refused;
        return refused;
      }
      businessStarted = true;
      let resolve!: (value: RpcJson) => void;
      let reject!: (error: unknown) => void;
      const started = new Promise<RpcJson>((accept, fail) => { resolve = accept; reject = fail; });
      business = started;
      void started.catch(() => undefined);
      void (async (): Promise<RpcJson> => {
        let raw: unknown;
        try {
          raw = await handler(input, context);
        } catch {
          // Provider handler code is untrusted: its error, cause, message, and any forged code are
          // dropped; only the fixed `failed` code and the current operation id survive.
          throw new RpcInvocationError('failed', operationId);
        }
        // Kernel output validation stays outside the provider catch so `invalid_output` is never
        // masked as a business failure.
        return this.#validateOutput(definition, raw);
      })().then(resolve, reject);
      return started;
    };

    const execution: RpcCommandExecution<TCallee> = Object.freeze({
      contract: record.contract, method, definition, context, operationId, input, executeBusiness,
    });
    const executorPromise: Promise<unknown> = (async () => {
      try {
        return await executor.execute(execution);
      } finally {
        executorSettled = true;
      }
    })();

    let executorOutput: unknown = undefined;
    let failure: RpcInvocationError | null = null;
    try {
      executorOutput = await executorPromise;
    } catch (error) {
      failure = invocationFailure(error, operationId);
    }
    // The task may only finish after any real business work it started has reached terminal.
    if (businessStarted) {
      try {
        await business;
      } catch (error) {
        if (failure === null) failure = invocationFailure(error, operationId);
      }
    }
    if (failure !== null) throw failure;
    return this.#validateOutput(definition, executorOutput);
  }

  #handlerContext(
    record: EndpointRecord,
    task: CallTask,
    method: string,
    definition: RpcMethodDefinition,
    callee: TCallee,
  ): RpcHandlerContext<TCallee> {
    return Object.freeze({
      endpoint: Object.freeze({ ...record.binding, service: record.contract.id, version: record.contract.version }),
      caller: Object.freeze({ subject: task.caller.subject, scope: task.caller.scope }),
      method, kind: definition.kind, purpose: task.purpose, operationId: task.operationId,
      signal: task.controller.signal, callee,
      deadlineAt: task.deadlineAt,
    });
  }

  #validateData(schema: RpcDataSchema, value: unknown, methodLimit: number, callerLimit?: number): RpcJson {
    const limit = Math.min(methodLimit, callerLimit ?? RPC_JSON_MAX_BYTES);
    try {
      const clone = decodeRpcJson(encodeRpcJson(value, limit), limit);
      assertRpcData(schema, clone);
      return clone;
    } catch {
      throw new RpcInvocationError('invalid_input');
    }
  }

  #validateOutput(definition: RpcMethodDefinition, raw: unknown): RpcJson {
    const limit = definition.maxOutputBytes ?? RPC_JSON_MAX_BYTES;
    try {
      const clone = decodeRpcJson(encodeRpcJson(raw, limit), limit);
      assertRpcData(definition.output, clone);
      return clone;
    } catch {
      throw new RpcInvocationError('invalid_output');
    }
  }

  #abortTask(task: CallTask, reason: AbortReason): void {
    if (task.finished) return;
    if (task.abortReason === null) task.abortReason = reason;
    if (!task.controller.signal.aborted) task.controller.abort(reason);
    if (!task.callerSettled) {
      task.callerSettled = true;
      task.reject(this.#abortError(task, reason));
    }
    // The real task (if any) keeps its count and lease until it reaches terminal.
    if (!task.delivered) this.#finishTask(task);
    else if (task.record.proxy !== null && task.proxyTerminal) this.#finishTask(task);
  }

  #abortError(task: CallTask, reason: AbortReason): RpcInvocationError {
    if (task.kind === 'command' && task.delivered) return new RpcInvocationError('unknown', task.operationId);
    switch (reason) {
      case 'timeout': return new RpcInvocationError('timeout', task.operationId);
      case 'closed': return new RpcInvocationError('closed', task.operationId);
      case 'revoked': return new RpcInvocationError('revoked', task.operationId);
      case 'retired': return new RpcInvocationError('retired', task.operationId);
      default: return new RpcInvocationError('cancelled', task.operationId);
    }
  }

  /** Deadline failure keeps the already-delivered command `unknown` contract; otherwise `timeout`. */
  #deadlineCode(task: CallTask): RpcInvocationErrorCode {
    return task.kind === 'command' && task.delivered ? 'unknown' : 'timeout';
  }

  #deadlineError(task: CallTask): RpcInvocationError {
    return new RpcInvocationError(this.#deadlineCode(task), task.operationId);
  }

  /** Deletes the full record (handler, contract, runtime reference) and keeps revoked identity only. */
  #releaseRecord(record: EndpointRecord): void {
    if (!this.#endpoints.delete(record)) return;
    ENDPOINTS.delete(record.handle);
    REVOKED.set(record.handle, this.#identity);
  }

  #finishTask(task: CallTask): void {
    if (task.finished) return;
    task.finished = true;
    for (const cleanup of task.cleanups.splice(0)) {
      try { cleanup(); } catch { /* teardown is best-effort */ }
    }
    task.record.active.delete(task);
    if (task.record.revoked && task.record.active.size === 0) this.#releaseRecord(task.record);
    this.#tasks.delete(task);
    this.#addCallerCount(task.callerKey, -1);
    try { task.release(); } catch { /* the host lease is host-owned */ }
    this.#notifyWaiters();
    task.onTerminal?.();
  }

  #assertCapacity(record: EndpointRecord, callerKey: string): void {
    if (this.#tasks.size >= this.#limits.globalMaxInFlight) throw new RpcInvocationError('overloaded');
    if (record.active.size >= this.#limits.endpointMaxInFlight) throw new RpcInvocationError('overloaded');
    if ((this.#callerCounts.get(callerKey) ?? 0) >= this.#limits.callerMaxInFlight) throw new RpcInvocationError('overloaded');
  }

  #addCallerCount(callerKey: string, delta: number): void {
    const next = (this.#callerCounts.get(callerKey) ?? 0) + delta;
    if (next <= 0) this.#callerCounts.delete(callerKey);
    else this.#callerCounts.set(callerKey, next);
  }

  /** Resolves an admitted handle; released handles only report revoked for their owning runtime. */
  #resolveAdmissionEndpoint(handle: RpcEndpointHandle): EndpointRecord | 'revoked' | null {
    if (handle === null || typeof handle !== 'object') return null;
    const record = ENDPOINTS.get(handle as object);
    if (record) return record.runtime === this ? record : null;
    const token = REVOKED.get(handle as object);
    if (!token) return null;
    return token === this.#identity ? 'revoked' : null;
  }

  #lookup(handle: RpcEndpointHandle): EndpointRecord | null {
    if (handle === null || typeof handle !== 'object') return null;
    const record = ENDPOINTS.get(handle as object);
    if (!record || record.runtime !== this) return null;
    return record;
  }

  #resolveTimeout(value: number | undefined, fallback: number): number {
    return timeoutLimit(value, fallback);
  }

  #waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    if (this.#waiters.size >= this.#limits.maxWaiters) {
      return Promise.reject(new RpcInvocationError('overloaded'));
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { check, settle: () => undefined };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: boolean): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.#waiters.delete(waiter);
        resolve(value);
      };
      waiter.settle = () => settle(true);
      this.#waiters.add(waiter);
      timer = setTimeout(() => settle(false), timeoutMs);
    });
  }

  #notifyWaiters(): void {
    if (this.#waiters.size === 0) return;
    for (const waiter of [...this.#waiters]) {
      if (waiter.check()) waiter.settle();
    }
  }
}
