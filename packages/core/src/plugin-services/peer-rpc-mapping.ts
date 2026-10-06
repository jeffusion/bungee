/**
 * P4 native/plugin-peer RPC DTO mapping.
 *
 * Bridges the canonical in-process kernel (`RpcServiceRuntime` /
 * `HostRpcAdapter`) and the reviewed authenticated peer link
 * (`PluginPeerRpcLink`) without inventing a second runtime, a second lease, or a
 * second command journal:
 *
 * - The caller side wraps an already-registered proxy endpoint with
 *   {@link createPluginPeerRpcProxy}: the native handler context is compiled into
 *   one exact bounded frozen call DTO plus a raw strict-JSON body, and the link's
 *   independent `result`/`terminal` pair is returned untouched.
 * - The callee side wraps the required host dispatch callback with
 *   {@link createPluginPeerRpcRequestHandler}: metadata and body are strictly
 *   decoded before any dispatch, the callback must use the real host-bound
 *   `invokeTracked`, and a native result rejection is re-encoded as a fixed-code
 *   body so the transport never has to interpret a provider error.
 *
 * Authorization is never derived here. The DTO carries only the caller's claimed
 * identity, the exact claimed target binding, and a host-compiled minimal DTO;
 * the trusted host still decides per call against the kernel-selected endpoint
 * and its own broker proof. No opaque callee frame, request, cookie, token, or
 * signal is ever default-serialized into the metadata.
 */

import { isProxy } from 'node:util/types';
import type { PluginServiceProcess, PluginServiceScope } from './contracts';
import { PEER_BODY_MAX_BYTES, PEER_HEADER_MAX_BYTES } from './peer-protocol';
import {
  PluginPeerRpcLinkError,
  type PluginPeerRpcInboundCall,
  type PluginPeerRpcLink,
  type PluginPeerRpcRequestExecution,
  type PluginPeerRpcRequestHandler,
} from './peer-rpc-link';
import {
  RpcInvocationError,
  type RpcCommandAction,
  type RpcEndpointBinding,
  type RpcInvocationErrorCode,
  type RpcInvokeRequest,
  type RpcProxyExecution,
  type RpcProxyExecutor,
  type RpcProxyRequest,
} from './rpc-runtime';
import {
  RPC_JSON_MAX_BYTES,
  assertRpcData,
  decodeRpcJson,
  encodeRpcJson,
  type RpcCallKind,
  type RpcCallPurpose,
  type RpcDataSchema,
  type RpcJson,
} from './wire-contract';

/* -------------------------------------------------------------------------- */
/* Fixed bounds, codes and errors                                              */
/* -------------------------------------------------------------------------- */

export const PEER_RPC_METADATA_VERSION = 1 as const;
/** Complete call metadata budget: half the peer header, leaving room for the signed wrapper. */
export const PEER_RPC_METADATA_MAX_BYTES = PEER_HEADER_MAX_BYTES / 2;
/** The trusted host DTO must stay minimal; it may never dominate the metadata header. */
export const PEER_RPC_HOST_METADATA_MAX_BYTES = PEER_RPC_METADATA_MAX_BYTES / 2;
/** Fixed ASCII prefix that can never begin a legal JSON value. */
export const PEER_RPC_ERROR_PREFIX = '!RPC1:';

/** Every fixed runtime error code may cross the wire; nothing else is a legal error body. */
const PEER_RPC_ERROR_CODE_LIST: readonly RpcInvocationErrorCode[] = [
  'unauthorized', 'not_ready', 'retired', 'revoked', 'unsupported_method', 'wrong_purpose',
  'invalid_input', 'invalid_output', 'invalid_operation_id', 'overloaded', 'cancelled', 'timeout',
  'unknown', 'capability_unavailable', 'closed', 'failed', 'conflict', 'expired', 'pending',
  'rejected', 'missing', 'storage_failure', 'deadlock', 'call_depth_exceeded',
];
export const PEER_RPC_ERROR_CODES: readonly RpcInvocationErrorCode[] = Object.freeze(PEER_RPC_ERROR_CODE_LIST);
const PEER_RPC_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(PEER_RPC_ERROR_CODE_LIST);

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type PluginPeerRpcMappingErrorCode = 'invalid_metadata' | 'invalid_input' | 'invalid_result';

/** Fixed-code mapping error. It never carries a peer payload, cause, or secret. */
export class PluginPeerRpcMappingError extends Error {
  readonly name = 'PluginPeerRpcMappingError';
  readonly code: PluginPeerRpcMappingErrorCode;

  constructor(code: PluginPeerRpcMappingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function invalidMetadata(): PluginPeerRpcMappingError {
  return new PluginPeerRpcMappingError('invalid_metadata', 'peer RPC call metadata is invalid');
}

function invalidInput(): PluginPeerRpcMappingError {
  return new PluginPeerRpcMappingError('invalid_input', 'peer RPC input is invalid');
}

function invalidResult(): PluginPeerRpcMappingError {
  return new PluginPeerRpcMappingError('invalid_result', 'peer RPC result is invalid');
}

/* -------------------------------------------------------------------------- */
/* Call metadata DTO                                                           */
/* -------------------------------------------------------------------------- */

/** Frozen caller identity; scope is mandatory on the wire. */
export type PeerRpcCaller = Readonly<{ readonly subject: string; readonly scope: PluginServiceScope }>;
export type PeerRpcCallTarget = Readonly<{
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly method: string;
}>;
export type PeerRpcCallMetadata = Readonly<{
  readonly version: typeof PEER_RPC_METADATA_VERSION;
  readonly target: PeerRpcCallTarget;
  readonly binding: Readonly<RpcEndpointBinding>;
  readonly caller: PeerRpcCaller;
  readonly purpose: RpcCallPurpose;
  readonly operationId: string | null;
  readonly commandAction: RpcCommandAction | null;
  readonly host: RpcJson;
}>;

const SCOPE_SCHEMA: RpcDataSchema = {
  type: 'union',
  variants: [{ type: 'literal', value: 'global' }, { type: 'literal', value: 'binding' }],
};

const PROCESS_SCHEMA: RpcDataSchema = {
  type: 'union',
  variants: [
    { type: 'literal', value: 'control' },
    { type: 'literal', value: 'worker' },
    { type: 'literal', value: 'ingress' },
  ],
};

const PURPOSE_SCHEMA: RpcDataSchema = {
  type: 'union',
  variants: [
    { type: 'literal', value: 'bootstrap' },
    { type: 'literal', value: 'background' },
    { type: 'literal', value: 'management' },
    { type: 'literal', value: 'request' },
    { type: 'literal', value: 'attempt' },
  ],
};

const COMMAND_ACTION_SCHEMA: RpcDataSchema = {
  type: 'union',
  variants: [
    { type: 'null' },
    { type: 'literal', value: 'execute' },
    { type: 'literal', value: 'query-result' },
    { type: 'literal', value: 'reconcile' },
  ],
};

const METADATA_SCHEMA: RpcDataSchema = {
  type: 'object',
  properties: {
    version: { type: 'literal', value: PEER_RPC_METADATA_VERSION },
    target: {
      type: 'object',
      properties: {
        provider: { type: 'string', minLength: 1, maxLength: 128 },
        service: { type: 'string', minLength: 1, maxLength: 128 },
        major: { type: 'number', integer: true, minimum: 1 },
        method: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    binding: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', minLength: 1, maxLength: 256 },
        process: PROCESS_SCHEMA,
        instance: { type: 'string', minLength: 1, maxLength: 256 },
        generation: { type: 'number', integer: true, minimum: 1 },
        catalog: { type: 'string', minLength: 1, maxLength: 256 },
        scope: SCOPE_SCHEMA,
        subject: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
    caller: {
      type: 'object',
      properties: {
        subject: { type: 'string', minLength: 1, maxLength: 256 },
        scope: SCOPE_SCHEMA,
      },
    },
    purpose: PURPOSE_SCHEMA,
    operationId: {
      type: 'union',
      variants: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 128 }],
    },
    commandAction: COMMAND_ACTION_SCHEMA,
    host: { type: 'json', maxBytes: PEER_RPC_HOST_METADATA_MAX_BYTES },
  },
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value as object);
  }
  return value;
}

/**
 * Clones one candidate into bounded pure JSON, then strictly validates the whole
 * shape (exact field set, enums, integer/safe-integer bounds), the byte bound of
 * the complete metadata, and the fields the schema DSL cannot express (the
 * operation-id grammar and the command-action/operation-id invariant).
 */
function validateMetadataJson(value: unknown): RpcJson {
  let json: RpcJson;
  try {
    json = decodeRpcJson(encodeRpcJson(value, PEER_RPC_METADATA_MAX_BYTES), PEER_RPC_METADATA_MAX_BYTES);
  } catch {
    throw invalidMetadata();
  }
  try {
    assertRpcData(METADATA_SCHEMA, json, PEER_RPC_METADATA_MAX_BYTES);
  } catch {
    throw invalidMetadata();
  }
  const record = json as unknown as { readonly [key: string]: RpcJson };
  const target = record.target as unknown as { readonly [key: string]: RpcJson };
  const binding = record.binding as unknown as { readonly [key: string]: RpcJson };
  if (!Number.isSafeInteger(target.major as number)) throw invalidMetadata();
  if (!Number.isSafeInteger(binding.generation as number)) throw invalidMetadata();
  const operationId = record.operationId === null ? null : record.operationId as string;
  const commandAction = record.commandAction === null ? null : record.commandAction as RpcCommandAction;
  if (operationId !== null && !OPERATION_ID.test(operationId)) throw invalidMetadata();
  // A command always carries an operation id; a query never does.
  if ((operationId === null) !== (commandAction === null)) throw invalidMetadata();
  return json;
}

function toPeerRpcCallMetadata(json: RpcJson): PeerRpcCallMetadata {
  const record = json as { readonly [key: string]: RpcJson };
  const target = record.target as { readonly [key: string]: RpcJson };
  const binding = record.binding as { readonly [key: string]: RpcJson };
  const caller = record.caller as { readonly [key: string]: RpcJson };
  const operationId = record.operationId === null ? null : record.operationId as string;
  const commandAction = record.commandAction === null ? null : record.commandAction as RpcCommandAction;
  return Object.freeze({
    version: PEER_RPC_METADATA_VERSION,
    target: Object.freeze({
      provider: target.provider as string,
      service: target.service as string,
      major: target.major as number,
      method: target.method as string,
    }),
    binding: deepFreeze({
      endpoint: binding.endpoint as string,
      process: binding.process as PluginServiceProcess,
      instance: binding.instance as string,
      generation: binding.generation as number,
      catalog: binding.catalog as string,
      scope: binding.scope as PluginServiceScope,
      subject: binding.subject as string,
    }),
    caller: deepFreeze({ subject: caller.subject as string, scope: caller.scope as PluginServiceScope }),
    purpose: record.purpose as RpcCallPurpose,
    operationId,
    commandAction,
    host: deepFreeze(record.host),
  });
}

/** Strict, bounded, frozen decode of one inbound call metadata DTO. */
export function decodePeerRpcCallMetadata(value: unknown): PeerRpcCallMetadata {
  return toPeerRpcCallMetadata(validateMetadataJson(value));
}

/** Validates one candidate and returns the bounded pure-JSON wire form. */
export function encodePeerRpcCallMetadata(metadata: unknown): RpcJson {
  return validateMetadataJson(metadata);
}

/* -------------------------------------------------------------------------- */
/* Result/body codecs                                                          */
/* -------------------------------------------------------------------------- */

export type PeerRpcDecodedResult =
  | { readonly ok: true; readonly value: RpcJson }
  | { readonly ok: false; readonly code: RpcInvocationErrorCode };

/** Encodes a native output (or a business input) as raw strict JSON within the RPC envelope. */
export function encodePeerRpcJsonBody(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(encodeRpcJson(value, RPC_JSON_MAX_BYTES));
  } catch {
    throw invalidInput();
  }
}

/** Strictly decodes one raw business input body (never an error body). */
export function decodePeerRpcInputBody(bytes: Uint8Array): RpcJson {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > PEER_BODY_MAX_BYTES) throw invalidInput();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidInput();
  }
  try {
    return decodeRpcJson(text, RPC_JSON_MAX_BYTES);
  } catch {
    throw invalidInput();
  }
}

/** Encodes one fixed native error code as the reserved non-JSON error body. */
export function encodePeerRpcErrorBody(code: RpcInvocationErrorCode): Uint8Array {
  if (!PEER_RPC_ERROR_CODE_SET.has(code)) throw invalidResult();
  return new TextEncoder().encode(PEER_RPC_ERROR_PREFIX + code);
}

/**
 * Splits one result body into a success value or a fixed error code. The reserved
 * prefix cannot start a legal JSON value, so a success payload that merely
 * *contains* the prefix stays an unambiguous success.
 */
export function decodePeerRpcResultBody(bytes: Uint8Array): PeerRpcDecodedResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PEER_BODY_MAX_BYTES) {
    throw invalidResult();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidResult();
  }
  if (text.startsWith(PEER_RPC_ERROR_PREFIX)) {
    const code = text.slice(PEER_RPC_ERROR_PREFIX.length);
    if (!PEER_RPC_ERROR_CODE_SET.has(code)) throw invalidResult();
    return Object.freeze({ ok: false as const, code: code as RpcInvocationErrorCode });
  }
  if (text.startsWith('!')) throw invalidResult();
  let value: RpcJson;
  try {
    value = decodeRpcJson(text, RPC_JSON_MAX_BYTES);
  } catch {
    throw invalidResult();
  }
  return Object.freeze({ ok: true as const, value });
}

/**
 * Reads a fixed runtime error code from an untrusted rejection without ever
 * invoking an accessor, a proxy trap, or the error's cause/message.
 */
export function resolvePeerRpcErrorCode(error: unknown): RpcInvocationErrorCode {
  return readNativeErrorCode(error) ?? 'failed';
}

function readNativeErrorCode(error: unknown): RpcInvocationErrorCode | null {
  if (error === null || typeof error !== 'object' || isProxy(error)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      && PEER_RPC_ERROR_CODE_SET.has(descriptor.value)) {
      return descriptor.value as RpcInvocationErrorCode;
    }
  } catch {
    // A hostile descriptor must not escape.
  }
  return null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const type = typeof value;
  if (type !== 'object' && type !== 'function') return false;
  try { return typeof (value as { then?: unknown }).then === 'function'; } catch { return false; }
}

/**
 * One independent guarded read per field, so an accessor or proxy trap can never
 * escape and the two link fields are never read twice.
 */
function readOnce(target: object, key: string): { readonly ok: boolean; readonly value: unknown } {
  try { return { ok: true, value: (target as Record<string, unknown>)[key] }; }
  catch { return { ok: false, value: undefined }; }
}

/** A never-settling terminal: an unproven outcome must never look like completion. */
const NEVER_TERMINAL: Promise<void> = new Promise<void>(() => undefined);

/* -------------------------------------------------------------------------- */
/* Caller side: native proxy executor over the peer link                       */
/* -------------------------------------------------------------------------- */

/** Minimal, non-opaque view handed to the trusted host metadata compiler. */
export type PluginPeerRpcHostCallContext = Readonly<{
  readonly method: string;
  readonly kind: RpcCallKind;
  readonly purpose: RpcCallPurpose;
  readonly operationId: string | null;
  readonly commandAction: RpcCommandAction | null;
  readonly caller: PeerRpcCaller;
  readonly endpoint: Readonly<RpcEndpointBinding & { readonly service: string; readonly version: number }>;
  readonly deadlineAt: number;
}>;

/**
 * Trusted host compiler. It receives the minimal per-call context and THIS
 * call's opaque admission callee frame (never a plugin option and never global
 * state), so it can read the real host-owned frame and emit only an explicitly
 * selected DTO. The opaque frame itself is never serialized by default.
 */
export type PluginPeerRpcHostMetadataCompiler<TCallee = unknown> = (
  context: PluginPeerRpcHostCallContext,
  callee: TCallee,
) => RpcJson;

/** Fully prepared, not yet sent call. Only building this is provably side-effect free. */
interface PreparedProxyCall {
  readonly metadata: RpcJson;
  readonly body: Uint8Array;
  readonly deadlineAt: number;
}

function rejectedRpcResult(error: RpcInvocationError): Promise<RpcJson> {
  const promise = Promise.reject<RpcJson>(error);
  void promise.catch(() => undefined);
  return promise;
}

/** Only a pure prepare rejection is provably not dispatched, so only it may resolve its terminal. */
function knownNotStarted(code: RpcInvocationErrorCode, operationId: string | null): RpcProxyExecution {
  return Object.freeze({
    result: rejectedRpcResult(new RpcInvocationError(code, operationId)),
    terminal: Promise.resolve(),
  });
}

/**
 * Adopts one link result field into a native result promise. Every synchronous
 * step — the thenable check, `Promise.resolve`, and the `.then` subscription —
 * is guarded, so a hostile getter, a hostile real-Promise `constructor`, or a
 * synchronous `then` throw becomes a conservative fixed code instead of
 * escaping. The caller's terminal is never touched here.
 */
function subscribeLinkResult(value: unknown, commandExecution: boolean, operationId: string | null): Promise<RpcJson> {
  const fallback = (): Promise<RpcJson> =>
    rejectedRpcResult(new RpcInvocationError(commandExecution ? 'unknown' : 'failed', operationId));
  if (!isThenable(value)) return fallback();
  let adopted: Promise<unknown>;
  try { adopted = Promise.resolve(value); }
  catch { return fallback(); }
  try {
    return adopted.then(
      (bytes: unknown) => {
        let decoded: PeerRpcDecodedResult;
        try { decoded = decodePeerRpcResultBody(bytes as Uint8Array); }
        catch { throw new RpcInvocationError('invalid_output', operationId); }
        if (decoded.ok) return decoded.value;
        throw new RpcInvocationError(decoded.code, operationId);
      },
      (error: unknown) => { throw linkFailure(error, commandExecution, operationId); },
    );
  } catch {
    return fallback();
  }
}

/**
 * Normalizes one link terminal field. A field that cannot be read, is not a
 * thenable, or throws while being adopted yields a never-settling terminal: an
 * unproven transport outcome must keep the caller lease held.
 */
function subscribeLinkTerminal(value: unknown): Promise<void> {
  if (!isThenable(value)) return NEVER_TERMINAL;
  try { return Promise.resolve(value).then((): void => undefined); }
  catch { return NEVER_TERMINAL; }
}

/**
 * Maps one link failure onto a native fixed code. A query (including a
 * `query-result` control call) is normalized to a safe fixed code; an
 * execute/reconcile command keeps `unknown` with its operation id because a
 * transport failure never proves the provider did not run.
 *
 * Only `overloaded` and `expired` are preserved for commands: the reviewed real
 * link produces them exclusively on paths where the peer explicitly did not
 * accept the call (outbound pre-admission, or the receiver rejecting before its
 * handler runs), so they are a genuine not-dispatched proof. Every other code
 * stays conservative. Do not extend this mapping to a code the real link can
 * raise after a frame entered the transport.
 */
function linkFailure(error: unknown, commandExecution: boolean, operationId: string | null): RpcInvocationError {
  const code = ((): string | null => {
    if (error === null || typeof error !== 'object' || isProxy(error)) return null;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') return descriptor.value;
    } catch {
      // A hostile descriptor must not escape.
    }
    return null;
  })();
  if (!commandExecution) {
    switch (code) {
      case 'cancelled': return new RpcInvocationError('cancelled', operationId);
      case 'timeout': return new RpcInvocationError('timeout', operationId);
      case 'expired': return new RpcInvocationError('timeout', operationId);
      case 'overloaded': return new RpcInvocationError('overloaded', operationId);
      case 'closed': return new RpcInvocationError('closed', operationId);
      default: return new RpcInvocationError('failed', operationId);
    }
  }
  switch (code) {
    case 'overloaded': return new RpcInvocationError('overloaded', operationId);
    case 'expired': return new RpcInvocationError('timeout', operationId);
    default: return new RpcInvocationError('unknown', operationId);
  }
}

function prepareProxyCall<TCallee>(
  provider: string,
  compileHostMetadata: PluginPeerRpcHostMetadataCompiler<TCallee>,
  request: RpcProxyRequest<TCallee>,
  commandAction: RpcCommandAction | null,
): PreparedProxyCall {
  const context = request.context;
  const deadlineAt = context.deadlineAt;
  if (typeof deadlineAt !== 'number' || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) throw invalidInput();
  const endpoint = context.endpoint;
  const hostContext: PluginPeerRpcHostCallContext = Object.freeze({
    method: context.method,
    kind: context.kind,
    purpose: context.purpose,
    operationId: context.operationId ?? null,
    commandAction,
    caller: Object.freeze({ subject: context.caller.subject, scope: context.caller.scope as PluginServiceScope }),
    endpoint: Object.freeze({
      endpoint: endpoint.endpoint,
      process: endpoint.process,
      instance: endpoint.instance,
      generation: endpoint.generation,
      catalog: endpoint.catalog,
      scope: endpoint.scope,
      subject: endpoint.subject,
      service: endpoint.service,
      version: endpoint.version,
    }),
    deadlineAt,
  });
  // The trusted compiler reads THIS call's opaque callee frame; nothing opaque
  // is serialized unless the compiler explicitly selects it into the DTO.
  const host = compileHostMetadata(hostContext, context.callee);
  const metadata = encodePeerRpcCallMetadata({
    version: PEER_RPC_METADATA_VERSION,
    target: { provider, service: endpoint.service, major: endpoint.version, method: context.method },
    binding: {
      endpoint: endpoint.endpoint,
      process: endpoint.process,
      instance: endpoint.instance,
      generation: endpoint.generation,
      catalog: endpoint.catalog,
      scope: endpoint.scope,
      subject: endpoint.subject,
    },
    caller: { subject: context.caller.subject, scope: context.caller.scope },
    purpose: context.purpose,
    operationId: context.operationId ?? null,
    commandAction,
    host,
  });
  const body = encodePeerRpcJsonBody(request.input);
  return { metadata, body, deadlineAt };
}

/**
 * Forwards one fully prepared call. Once `link.request` has been entered there
 * is no proof of non-dispatch, so every failure keeps a never-settling terminal
 * and the caller lease is never released early. The terminal is read once and
 * installed first, so a broken or hostile result can never abandon it.
 */
function dispatchPreparedCall(
  link: PluginPeerRpcLink,
  prepared: PreparedProxyCall,
  signal: AbortSignal,
  commandExecution: boolean,
  operationId: string | null,
): RpcProxyExecution {
  const unproven = (): RpcProxyExecution => Object.freeze({
    result: rejectedRpcResult(new RpcInvocationError(commandExecution ? 'unknown' : 'failed', operationId)),
    terminal: NEVER_TERMINAL,
  });
  let call: unknown;
  try {
    call = link.request(prepared.metadata, prepared.body, { signal, deadlineAt: prepared.deadlineAt });
  } catch {
    // The frame may already have entered the transport.
    return unproven();
  }
  if (call === null || typeof call !== 'object') return unproven();
  const terminalField = readOnce(call, 'terminal');
  const terminal = subscribeLinkTerminal(terminalField.ok ? terminalField.value : undefined);
  const resultField = readOnce(call, 'result');
  const result = resultField.ok
    ? subscribeLinkResult(resultField.value, commandExecution, operationId)
    : rejectedRpcResult(new RpcInvocationError(commandExecution ? 'unknown' : 'failed', operationId));
  return Object.freeze({ result, terminal });
}

/**
 * Builds the native `RpcProxyExecutor` that carries one registered proxy
 * endpoint over the authenticated peer link. All preparation is pure and runs
 * before any transport write; the result and terminal stay independent, and
 * only a pure prepare failure may report a resolved terminal.
 */
export function createPluginPeerRpcProxy<TCallee = unknown>(
  provider: string,
  link: PluginPeerRpcLink,
  compileHostMetadata: PluginPeerRpcHostMetadataCompiler<TCallee>,
): RpcProxyExecutor<TCallee> {
  if (typeof provider !== 'string' || provider.length === 0) throw invalidInput();
  if (link === null || typeof link !== 'object' || typeof link.request !== 'function') throw invalidInput();
  if (typeof compileHostMetadata !== 'function') throw invalidInput();
  return (request: RpcProxyRequest<TCallee>): RpcProxyExecution => {
    const context = request.context;
    const operationId = context.operationId ?? null;
    const commandAction = request.commandAction ?? null;
    // `query-result` is a read: it must never be treated as an execution retry.
    const commandExecution = context.kind === 'command'
      && (commandAction === null || commandAction === 'execute' || commandAction === 'reconcile');
    // The only provably not-dispatched rejection: nothing was built or sent.
    const prepared = ((): PreparedProxyCall | null => {
      try { return prepareProxyCall(provider, compileHostMetadata, request, commandAction); }
      catch { return null; }
    })();
    if (prepared === null) return knownNotStarted('invalid_input', operationId);
    return dispatchPreparedCall(link, prepared, context.signal, commandExecution, operationId);
  };
}

/* -------------------------------------------------------------------------- */
/* Callee side: inbound handler over the native dispatch callback              */
/* -------------------------------------------------------------------------- */

/** Exactly what a host-bound `invokeTracked` accepts: caller identity stays host-owned. */
export type PluginPeerRpcNativeRequest = Omit<RpcInvokeRequest, 'caller' | 'callerToken'>;

export type PluginPeerRpcNativeDispatch = (
  metadata: PeerRpcCallMetadata,
  request: PluginPeerRpcNativeRequest,
  call: PluginPeerRpcInboundCall,
) => RpcProxyExecution | null;

function encodeNativeResult(output: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(encodeRpcJson(output, RPC_JSON_MAX_BYTES));
  } catch {
    return encodePeerRpcErrorBody('invalid_output');
  }
}

function nativeFailureResult(error: unknown, fallback: RpcInvocationErrorCode): Uint8Array {
  return encodePeerRpcErrorBody(readNativeErrorCode(error) ?? fallback);
}

/** A provably not-dispatched parse failure: a fixed rejection with a real end. */
function parseRejection(): PluginPeerRpcRequestExecution {
  return Object.freeze({
    result: Promise.resolve(encodePeerRpcErrorBody('invalid_input')),
    terminal: Promise.resolve(),
  });
}

/** The one explicit no-dispatch signal from the host callback. */
function noDispatchRejection(): PluginPeerRpcRequestExecution {
  return Object.freeze({
    result: Promise.resolve(encodePeerRpcErrorBody('unauthorized')),
    terminal: Promise.resolve(),
  });
}

/**
 * An illegal dispatch return can never prove completion. Any identifiable
 * thenable (an erroneous async callback) has its rejection consumed, and its
 * settlement is never treated as the terminal.
 */
function invalidPairExecution(execution: unknown, fallback: RpcInvocationErrorCode): PluginPeerRpcRequestExecution {
  if (execution !== null && typeof execution === 'object' && isThenable(execution)) {
    try { void Promise.resolve(execution).then((): void => undefined, (): void => undefined); }
    catch { /* a hostile thenable must not escape */ }
  }
  return Object.freeze({
    result: Promise.resolve(encodePeerRpcErrorBody(fallback)),
    terminal: NEVER_TERMINAL,
  });
}

/**
 * Adopts the native result of a legal pair. The whole
 * `Promise.resolve(...).then(...)` span is guarded so a hostile real-Promise
 * `constructor` or a synchronous `then` throw becomes a fixed failure body
 * instead of escaping; the already-installed terminal is never touched.
 */
function handlerResult(value: unknown, fallbackCode: RpcInvocationErrorCode): Promise<Uint8Array> {
  const fallback = (): Promise<Uint8Array> => Promise.resolve(encodePeerRpcErrorBody(fallbackCode));
  if (!isThenable(value)) return fallback();
  let adopted: Promise<unknown>;
  try { adopted = Promise.resolve(value); }
  catch { return fallback(); }
  try { return adopted.then(encodeNativeResult, (error) => nativeFailureResult(error, fallbackCode)); }
  catch { return fallback(); }
}

/**
 * Builds the link `onRequest` handler. Metadata and body are strictly decoded
 * before any dispatch, so a malformed wrapper never starts work: such a parse
 * failure is a definite `invalid_input` rejection with a resolved terminal, so
 * the peer record is never left unproven. The required host callback must use
 * the real native `invokeTracked`; only an explicit `null` is a no-dispatch
 * rejection, a thrown callback propagates (fail-closed), and every other return
 * shape keeps an unproven terminal.
 */
export function createPluginPeerRpcRequestHandler(
  dispatchNative: PluginPeerRpcNativeDispatch,
): PluginPeerRpcRequestHandler {
  if (typeof dispatchNative !== 'function') throw invalidInput();
  return (call: PluginPeerRpcInboundCall, signal: AbortSignal): PluginPeerRpcRequestExecution => {
    let metadata: PeerRpcCallMetadata | null = null;
    try { metadata = decodePeerRpcCallMetadata(call.metadata); }
    catch { metadata = null; }
    if (metadata === null) return parseRejection();
    let input: RpcJson;
    try { input = decodePeerRpcInputBody(call.body); }
    catch { return parseRejection(); }
    const request: PluginPeerRpcNativeRequest = Object.freeze({
      target: metadata.target,
      purpose: metadata.purpose,
      input,
      operationId: metadata.operationId,
      ...(metadata.commandAction === null ? {} : { commandAction: metadata.commandAction }),
      signal,
      deadlineAt: call.deadlineAt,
    });
    let execution: unknown;
    try {
      execution = dispatchNative(metadata, request, call);
    } catch {
      // The callback may already have dispatched real work: fail closed and let
      // the link keep the record until a real terminal or host proof.
      throw new PluginPeerRpcLinkError('invalid_call', 'peer RPC dispatch failed');
    }
    // Only an explicit `null` is a known no-dispatch rejection.
    if (execution === null) return noDispatchRejection();
    const fallback = metadata.commandAction === 'execute' || metadata.commandAction === 'reconcile'
      ? 'unknown' : 'failed';
    // `undefined`, a function, an array, any non-object, and any thenable (an
    // async callback) are not a synchronous native pair, so none may forge a
    // terminal.
    if (execution === undefined || typeof execution !== 'object' || Array.isArray(execution) || isThenable(execution)) {
      return invalidPairExecution(execution, fallback);
    }
    // Read and install the valid terminal first: a broken or hostile result can
    // never abandon it, and it is never awaited here.
    const pair = execution as object;
    const terminalField = readOnce(pair, 'terminal');
    const terminal = terminalField.ok && isThenable(terminalField.value)
      ? terminalField.value as Promise<void>
      : NEVER_TERMINAL;
    const resultField = readOnce(pair, 'result');
    const result = resultField.ok
      ? handlerResult(resultField.value, fallback)
      : Promise.resolve(encodePeerRpcErrorBody(fallback));
    return Object.freeze({ result, terminal });
  };
}
