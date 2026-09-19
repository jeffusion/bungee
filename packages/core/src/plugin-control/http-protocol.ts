import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, hashConfigurationContent } from '../config-storage/content-hash';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import { isLowercaseUuid } from '../config-storage/validation';
import type { ControllerAuthority, SupervisionProcessCredential } from '../supervision/protocol';

export const PLUGIN_CONTROL_RPC_PROTOCOL = 'bungee-plugin-control-rpc/v1' as const;
export const PLUGIN_CONTROL_RPC_MAX_BYTES = 64 * 1024;
export const PLUGIN_CONTROL_RPC_MAX_DEADLINE_MS = 15_000;
export const PLUGIN_CONTROL_RPC_MAX_INFLIGHT = 64;
export const PLUGIN_CONTROL_RPC_SEQUENCE_WINDOW = 128;
export const PLUGIN_CONTROL_RPC_CACHE_CAPACITY = 256;
export const PLUGIN_CONTROL_HTTP_PATH = '/__bungee/internal/plugin-control/v1' as const;

export type PluginControlRpcErrorCode =
  | 'malformed_message' | 'unsupported_protocol' | 'invalid_mac' | 'identity_mismatch'
  | 'stale_controller' | 'split_brain' | 'sequence_replay' | 'request_replay'
  | 'deadline_expired' | 'deadline_too_far' | 'concurrency_limit' | 'capacity'
  | 'invalid_response' | 'cancelled' | 'action_failed' | 'response_too_large' | 'message_too_large' | 'disposed'
  | 'unavailable' | 'aborted' | 'network_error' | 'timeout' | 'http_error';

export class PluginControlRpcProtocolError extends Error {
  readonly name = 'PluginControlRpcProtocolError';

  constructor(
    readonly code: PluginControlRpcErrorCode,
    message: string = code,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

export type PluginControlRpcAuthority = ControllerAuthority;

export type PluginControlRpcWorker = {
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
};

export type PluginControlRpcCredential = {
  readonly supervision: SupervisionProcessCredential;
  readonly worker: PluginControlRpcWorker;
  readonly channel: string;
  readonly _brand: 'PluginControlRpcCredential';
};

export type PluginControlRpcCallBody = {
  readonly revision: number;
  readonly endpoint_id: string;
  readonly attempt_id: string;
  readonly method: string;
  readonly payload: unknown;
};

export type PluginControlRpcCancelBody = { readonly target_request_id: string };

type SignedFields = {
  readonly protocol: typeof PLUGIN_CONTROL_RPC_PROTOCOL;
  readonly kind: 'call' | 'cancel' | 'result';
  readonly direction: 'worker-to-controller' | 'controller-to-worker';
  readonly authority: PluginControlRpcAuthority;
  readonly worker: PluginControlRpcWorker;
  readonly sequence: number;
  readonly request_id: string;
  readonly body_hash: `sha256:${string}`;
  readonly body: unknown;
  readonly mac: `hmac-sha256:${string}`;
};

export type PluginControlRpcCall = SignedFields & {
  readonly kind: 'call';
  readonly direction: 'worker-to-controller';
  readonly deadline_at: number;
  readonly body: PluginControlRpcCallBody;
};

export type PluginControlRpcCancel = SignedFields & {
  readonly kind: 'cancel';
  readonly direction: 'worker-to-controller';
  readonly deadline_at: number;
  readonly body: PluginControlRpcCancelBody;
};

export type PluginControlRpcResultBody =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

export type PluginControlRpcResult = Omit<SignedFields, 'kind' | 'direction' | 'body'> & {
  readonly kind: 'result';
  readonly direction: 'controller-to-worker';
  readonly body: PluginControlRpcResultBody;
};

export type PluginControlRpcMessage = PluginControlRpcCall | PluginControlRpcCancel | PluginControlRpcResult;
export type PluginControlRpcUnsignedCall = Omit<PluginControlRpcCall, 'worker' | 'mac'>;
export type PluginControlRpcUnsignedCancel = Omit<PluginControlRpcCancel, 'worker' | 'mac'>;
export type PluginControlRpcUnsignedResult = Omit<PluginControlRpcResult, 'worker' | 'mac'>;
export type PluginControlRpcUnsignedMessage = PluginControlRpcUnsignedCall | PluginControlRpcUnsignedCancel | PluginControlRpcUnsignedResult;

const MAC = /^hmac-sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ERROR = /^[a-z][a-z0-9._-]{0,63}$/;
const CHANNEL = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,62}[A-Za-z0-9])?$/;
const CREDENTIALS = new WeakMap<object, true>();

export type PluginControlHttpBodyErrorCode = 'body_timeout' | 'body_aborted' | 'message_too_large';

export class PluginControlHttpBodyError extends Error {
  readonly name = 'PluginControlHttpBodyError';

  constructor(readonly code: PluginControlHttpBodyErrorCode) { super(code); }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function fail(code: PluginControlRpcErrorCode, message: string, cause?: unknown): never {
  throw new PluginControlRpcProtocolError(code, message, cause === undefined ? undefined : { cause });
}

function plain(value: unknown, field = 'message'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return fail('malformed_message', `${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('malformed_message', `${field} has unexpected or missing fields`);
  }
}

function text(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string') return fail('malformed_message', `${field} must be a string`);
  return value[field] as string;
}

function nonEmpty(value: Record<string, unknown>, field: string): string {
  const result = text(value, field);
  if (result.length === 0) return fail('malformed_message', `${field} must not be empty`);
  return result;
}

function uuid(value: Record<string, unknown>, field: string): string {
  const result = text(value, field);
  if (!isLowercaseUuid(result)) return fail('malformed_message', `${field} must be a lowercase UUID`);
  return result;
}

function integer(value: Record<string, unknown>, field: string, minimum: number): number {
  const result = value[field];
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum) {
    return fail('malformed_message', `${field} must be a safe integer`);
  }
  return result;
}

function digest(value: Record<string, unknown>, field: string): `sha256:${string}` {
  const result = text(value, field);
  if (!DIGEST.test(result)) return fail('malformed_message', `${field} is not a SHA-256 digest`);
  return result as `sha256:${string}`;
}

function safeJson(value: unknown): any {
  try {
    return snapshotJsonGraph(value);
  } catch (cause) {
    return fail('malformed_message', 'value is not safe JSON', cause);
  }
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function bodyHash(body: unknown): `sha256:${string}` {
  try { return hashConfigurationContent(body); }
  catch (cause) { return fail('malformed_message', 'body is not safe JSON', cause); }
}

function parseAuthority(value: unknown): PluginControlRpcAuthority {
  const input = plain(value, 'authority');
  exact(input, ['controller_epoch', 'controller_id'], 'authority');
  return { controller_epoch: integer(input, 'controller_epoch', 0), controller_id: uuid(input, 'controller_id') };
}

function parseWorker(value: unknown): PluginControlRpcWorker {
  const input = plain(value, 'worker');
  exact(input, ['master_generation', 'worker_instance_id', 'worker_slot', 'boot_nonce'], 'worker');
  return {
    master_generation: uuid(input, 'master_generation'),
    worker_instance_id: uuid(input, 'worker_instance_id'),
    worker_slot: integer(input, 'worker_slot', 0),
    boot_nonce: uuid(input, 'boot_nonce'),
  };
}

function parseCallBody(value: unknown): PluginControlRpcCallBody {
  const input = plain(value, 'body');
  exact(input, ['revision', 'endpoint_id', 'attempt_id', 'method', 'payload'], 'body');
  return {
    revision: integer(input, 'revision', 1), endpoint_id: nonEmpty(input, 'endpoint_id'),
    attempt_id: uuid(input, 'attempt_id'), method: nonEmpty(input, 'method'), payload: safeJson(input.payload),
  };
}

function parseCancelBody(value: unknown): PluginControlRpcCancelBody {
  const input = plain(value, 'body');
  exact(input, ['target_request_id'], 'body');
  return { target_request_id: uuid(input, 'target_request_id') };
}

function parseResultBody(value: unknown): PluginControlRpcResultBody {
  const input = plain(value, 'body');
  if (input.ok === true) {
    exact(input, ['ok', 'result'], 'result body');
    return { ok: true, result: safeJson(input.result) };
  }
  if (input.ok === false) {
    exact(input, ['ok', 'error'], 'result body');
    const error = nonEmpty(input, 'error');
    if (!SAFE_ERROR.test(error)) fail('malformed_message', 'error is not safe');
    return { ok: false, error };
  }
  return fail('malformed_message', 'result body must contain exactly one result form');
}

function validateUnsigned(value: unknown, requireWorker = true): PluginControlRpcMessage | PluginControlRpcUnsignedMessage {
  const input = plain(value);
  const kind = text(input, 'kind');
  const common = ['protocol', 'kind', 'direction', 'authority', 'worker', 'sequence', 'request_id', 'body_hash', 'body'];
  const fields = kind === 'call' || kind === 'cancel' ? [...common, 'deadline_at'] : common;
  if (!requireWorker) {
    const noWorker = fields.filter((field) => field !== 'worker');
    exact(input, noWorker, 'message');
  } else exact(input, fields, 'message');
  if (input.protocol !== PLUGIN_CONTROL_RPC_PROTOCOL) fail('unsupported_protocol', 'unsupported plugin control protocol');
  const direction = text(input, 'direction');
  if ((kind === 'call' || kind === 'cancel') && direction !== 'worker-to-controller') fail('malformed_message', 'request direction is invalid');
  if (kind === 'result' && direction !== 'controller-to-worker') fail('malformed_message', 'result direction is invalid');
  if (kind !== 'call' && kind !== 'cancel' && kind !== 'result') fail('malformed_message', 'kind is invalid');
  const result: Record<string, unknown> = {
    protocol: PLUGIN_CONTROL_RPC_PROTOCOL, kind, direction,
    authority: parseAuthority(input.authority),
    ...(requireWorker ? { worker: parseWorker(input.worker) } : {}),
    sequence: integer(input, 'sequence', 1), request_id: uuid(input, 'request_id'),
  };
  const body = kind === 'call' ? parseCallBody(input.body) : kind === 'cancel' ? parseCancelBody(input.body) : parseResultBody(input.body);
  result.body = body;
  result.body_hash = digest(input, 'body_hash');
  if (result.body_hash !== bodyHash(body)) fail('malformed_message', 'body_hash does not match body');
  if (kind === 'call' || kind === 'cancel') result.deadline_at = integer(input, 'deadline_at', 0);
  return result as unknown as PluginControlRpcMessage;
}

export function createPluginControlRpcCredential(
  supervision: SupervisionProcessCredential,
  worker: PluginControlRpcWorker,
  channel = 'default',
): PluginControlRpcCredential {
  if (typeof supervision !== 'object' || supervision === null || !(supervision.process_key instanceof Uint8Array)
    || supervision.process_key.byteLength !== 32 || supervision.identity?.role !== 'worker') {
    fail('identity_mismatch', 'worker supervision credential is invalid');
  }
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) fail('identity_mismatch', 'credential channel is invalid');
  const checkedWorker = parseWorker(worker);
  if (checkedWorker.worker_instance_id !== supervision.identity.process_instance_id
    || checkedWorker.boot_nonce !== supervision.identity.boot_nonce || channel.length === 0) {
    fail('identity_mismatch', 'worker credential identity does not match');
  }
  const credential = Object.freeze({
    supervision, worker: Object.freeze(checkedWorker), channel,
    _brand: 'PluginControlRpcCredential' as const,
  });
  CREDENTIALS.set(credential, true);
  return credential;
}

function requireCredential(value: PluginControlRpcCredential): PluginControlRpcCredential {
  if (typeof value !== 'object' || value === null || !CREDENTIALS.has(value as object)) {
    fail('identity_mismatch', 'plugin control RPC credential is not a module-issued credential');
  }
  return value;
}

export function samePluginControlRpcCredential(
  left: PluginControlRpcCredential,
  right: PluginControlRpcCredential,
): boolean {
  try {
    const a = requireCredential(left);
    const b = requireCredential(right);
    const keyEqual = constantTimeEqual(a.supervision.process_key, b.supervision.process_key);
    const workerEqual = constantTimeEqual(new TextEncoder().encode(canonicalJson(a.worker)), new TextEncoder().encode(canonicalJson(b.worker)));
    const channelEqual = constantTimeEqual(new TextEncoder().encode(a.channel), new TextEncoder().encode(b.channel));
    return keyEqual && workerEqual && channelEqual;
  } catch {
    return false;
  }
}

function assertWorker(message: { readonly worker: PluginControlRpcWorker }, credential: PluginControlRpcCredential): void {
  const checked = requireCredential(credential);
  if (canonicalJson(message.worker) !== canonicalJson(checked.worker)) fail('identity_mismatch', 'message worker identity differs');
}

function macBytes(message: PluginControlRpcMessage | PluginControlRpcUnsignedMessage, credential: PluginControlRpcCredential): Uint8Array {
  const checked = requireCredential(credential);
  return new Uint8Array(createHmac('sha256', checked.supervision.process_key as Uint8Array)
    .update(`${PLUGIN_CONTROL_RPC_PROTOCOL}\0${checked.channel}\0${canonicalJson(checked.worker)}\0${canonicalJson(message)}`, 'utf8').digest());
}

function signed(message: PluginControlRpcMessage | PluginControlRpcUnsignedMessage, credential: PluginControlRpcCredential): PluginControlRpcMessage {
  const checked = requireCredential(credential);
  const mac = `hmac-sha256:${Buffer.from(macBytes(message, checked)).toString('hex')}` as const;
  const result = freezeJson({ ...message, mac }) as PluginControlRpcMessage;
  if (new TextEncoder().encode(canonicalJson(result)).byteLength > PLUGIN_CONTROL_RPC_MAX_BYTES) {
    fail('message_too_large', 'signed message exceeds 64 KiB');
  }
  return result;
}

/** Sign input omits worker intentionally; the worker is always injected from the branded credential. */
export function signPluginControlRpcMessage(
  value: PluginControlRpcUnsignedMessage,
  credential: PluginControlRpcCredential,
): PluginControlRpcMessage {
  const checked = requireCredential(credential);
  const input = plain(value);
  if (Object.prototype.hasOwnProperty.call(input, 'worker')) {
    if (canonicalJson(parseWorker(input.worker)) !== canonicalJson(checked.worker)) fail('identity_mismatch', 'signed worker differs from credential');
    fail('malformed_message', 'signed input must not contain worker');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'mac')) fail('malformed_message', 'signed input must not contain mac');
  const unsigned = validateUnsigned({ ...input, worker: checked.worker });
  assertWorker(unsigned as PluginControlRpcMessage, checked);
  return signed(unsigned, checked);
}

export function parsePluginControlRpcMessage(value: unknown): PluginControlRpcMessage {
  let input: unknown = value;
  if (typeof value === 'string' || value instanceof Uint8Array) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (bytes.byteLength > PLUGIN_CONTROL_RPC_MAX_BYTES) fail('message_too_large', 'message exceeds 64 KiB');
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (cause) { return fail('malformed_message', 'message is not valid JSON', cause); }
  }
  const safe = safeJson(input);
  if (new TextEncoder().encode(canonicalJson(safe)).byteLength > PLUGIN_CONTROL_RPC_MAX_BYTES) fail('message_too_large', 'message exceeds 64 KiB');
  const full = plain(safe);
  const mac = text(full, 'mac');
  if (!MAC.test(mac)) fail('malformed_message', 'mac is invalid');
  const unsigned = { ...full };
  delete unsigned.mac;
  const result = validateUnsigned(unsigned) as PluginControlRpcMessage;
  return freezeJson({ ...result, mac }) as PluginControlRpcMessage;
}

export function verifyPluginControlRpcMessage(value: unknown, credential: PluginControlRpcCredential): true {
  const checked = requireCredential(credential);
  const message = parsePluginControlRpcMessage(value);
  assertWorker(message, checked);
  const { mac: _mac, ...unsigned } = message;
  const actual = Buffer.from(message.mac.slice('hmac-sha256:'.length), 'hex');
  const expected = Buffer.from(macBytes(unsigned as PluginControlRpcMessage, checked));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('invalid_mac', 'message MAC is invalid');
  return true;
}

export function createPluginControlRpcResult(
  request: PluginControlRpcCall | PluginControlRpcCancel,
  body: PluginControlRpcResultBody,
  credential: PluginControlRpcCredential,
  sequence = request.sequence,
): PluginControlRpcResult {
  const checked = requireCredential(credential);
  const safeBody = parseResultBody(body);
  const unsigned = {
    protocol: PLUGIN_CONTROL_RPC_PROTOCOL, kind: 'result' as const, direction: 'controller-to-worker' as const,
    authority: request.authority, worker: checked.worker, sequence, request_id: request.request_id,
    body_hash: bodyHash(safeBody), body: safeBody,
  } as PluginControlRpcUnsignedMessage;
  return signed(validateUnsigned(unsigned) as PluginControlRpcMessage, checked) as PluginControlRpcResult;
}

export function verifyPluginControlRpcResult(
  value: unknown,
  request: PluginControlRpcCall | PluginControlRpcCancel,
  credential: PluginControlRpcCredential,
): true {
  try {
    const result = parsePluginControlRpcMessage(value);
    if (result.kind !== 'result' || result.request_id !== request.request_id
      || result.direction !== 'controller-to-worker'
      || canonicalJson(result.authority) !== canonicalJson(request.authority)
      || canonicalJson(result.worker) !== canonicalJson(credential.worker)) {
      fail('invalid_response', 'response correlation or identity is invalid');
    }
    verifyPluginControlRpcMessage(result, credential);
    return true;
  } catch (cause) {
    if (cause instanceof PluginControlRpcProtocolError && cause.code === 'invalid_response') throw cause;
    throw new PluginControlRpcProtocolError('invalid_response', 'response is invalid', { cause });
  }
}

export function hashPluginControlRpcBody(value: unknown): `sha256:${string}` {
  return bodyHash(safeJson(value));
}

export function encodePluginControlRpcMessage(message: PluginControlRpcMessage): Uint8Array {
  return new TextEncoder().encode(canonicalJson(parsePluginControlRpcMessage(message)));
}

export function serializePluginControlRpcMessage(message: PluginControlRpcMessage): string {
  return new TextDecoder().decode(encodePluginControlRpcMessage(message));
}

export type PluginControlHttpBodyReadOptions = {
  readonly maxBytes: number;
  readonly deadlineAt: number;
  readonly wallClock?: () => number;
  readonly signal?: AbortSignal;
};

export async function readPluginControlHttpBody(
  body: ReadableStream<Uint8Array> | null,
  options: PluginControlHttpBodyReadOptions,
): Promise<Uint8Array> {
  const wallClock = options.wallClock ?? Date.now;
  if (options.signal?.aborted) throw new PluginControlHttpBodyError('body_aborted');
  if (options.maxBytes <= 0 || !Number.isSafeInteger(options.maxBytes)) throw new PluginControlHttpBodyError('message_too_large');
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failed = false;
  let readerCancelled = false;
  let terminalError: PluginControlHttpBodyError | undefined;
  const cancelReader = (reason: unknown): void => {
    if (readerCancelled) return;
    readerCancelled = true;
    startCancelPluginControlHttpBody(reader, reason);
  };

  const readNext = async () => {
    const remaining = options.deadlineAt - wallClock();
    if (remaining <= 0) {
      failed = true;
      cancelReader('body timeout');
      throw new PluginControlHttpBodyError('body_timeout');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let rejectRace!: (error: unknown) => void;
    const terminate = (error: PluginControlHttpBodyError, reason: unknown): void => {
      if (terminalError !== undefined) return;
      terminalError = error;
      failed = true;
      rejectRace(error);
      cancelReader(reason);
    };
    const aborted = new Promise<Awaited<ReturnType<typeof reader.read>>>((_, reject) => {
      rejectRace = reject;
      onAbort = () => {
        terminate(new PluginControlHttpBodyError('body_aborted'), 'body aborted');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = new Promise<Awaited<ReturnType<typeof reader.read>>>((_, reject) => {
      timer = setTimeout(() => {
        terminate(new PluginControlHttpBodyError('body_timeout'), 'body timeout');
      }, remaining);
    });
    try {
      const part = await Promise.race([reader.read(), timeout, aborted]);
      if (terminalError !== undefined) throw terminalError;
      return part;
    }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
    }
  };

  try {
    while (true) {
      const part = await readNext();
      if (terminalError !== undefined) {
        failed = true;
        throw terminalError;
      }
      if (options.deadlineAt <= wallClock()) {
        failed = true;
        cancelReader('body timeout');
        throw new PluginControlHttpBodyError('body_timeout');
      }
      if (options.signal?.aborted) {
        failed = true;
        cancelReader('body aborted');
        throw new PluginControlHttpBodyError('body_aborted');
      }
      if (part.done) break;
      total += part.value.byteLength;
      if (total > options.maxBytes) {
        failed = true;
        cancelReader('body too large');
        throw new PluginControlHttpBodyError('message_too_large');
      }
      chunks.push(part.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) cancelReader('body failed');
  }
}

export function startCancelPluginControlHttpBody(
  body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null,
  reason?: unknown,
): void {
  if (body !== null) void body.cancel(reason).catch(() => undefined);
}
