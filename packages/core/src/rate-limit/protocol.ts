import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { canonicalJson } from '../config-storage/content-hash';
import { isLowercaseUuid } from '../config-storage/validation';
import { RateLimitJsonError, parseRateLimitJsonWire } from './json';

export const RATE_LIMIT_PROTOCOL = 'bungee-rate-limit' as const;
export const RATE_LIMIT_VERSION = 1 as const;
export const RATE_LIMIT_MAX_BYTES = 4 * 1024;
export const RATE_LIMIT_MAX_DEADLINE_MS = 15_000;
export const RATE_LIMIT_MAX_GRACE_MS = 15_000;
export const RATE_LIMIT_MAX_POLICY_ID_BYTES = 128;
export const RATE_LIMIT_MAX_BUCKET_ID_BYTES = 160;
export const RATE_LIMIT_MAX_RPS = 1_000_000;
export const RATE_LIMIT_MAX_BURST = 1_000_000;
export const RATE_LIMIT_MAX_RETRY_AFTER_MS = 60_000;
export const RATE_LIMIT_MAX_WORKER_SLOT = 65_535;

export type RateLimitTransportSecret = Uint8Array | string;

const DOMAIN = 'bungee-rate-limit/v1/domain';
const MAC_DOMAIN = 'bungee-rate-limit/v1/message';
const BUCKET_DOMAIN = 'bungee-rate-limit/v1/bucket';
const MAC = /^hmac-sha256:[0-9a-f]{64}$/;
const BUCKET_ID = /^rlb-v1:[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIALS = new WeakMap<object, Uint8Array>();
const DISPOSED = new WeakSet<object>();
const NORMALIZED_KEYS = new WeakSet<object>();
const SERIALIZED_WIRES = new WeakMap<object, string>();
const REQUEST_FINGERPRINTS = new WeakMap<object, string>();

export type RateLimitWireCounters = {
  readonly parse?: () => void;
  readonly serialize?: () => void;
};

export type RateLimitWorkerIdentity = {
  readonly role: 'worker';
  readonly process_instance_id: string;
  readonly boot_nonce: string;
  readonly master_generation: string;
  readonly worker_slot: number;
};

export type RateLimitIngressIdentity = {
  readonly role: 'ingress';
  readonly process_instance_id: string;
  readonly boot_nonce: string;
};

export type RateLimitIdentity = RateLimitWorkerIdentity | RateLimitIngressIdentity;

export type RateLimitKeyKind = 'string' | 'number' | 'boolean' | 'ip';
export type RateLimitNormalizedKey = {
  readonly kind: RateLimitKeyKind;
  readonly value: string;
  readonly _brand: 'RateLimitNormalizedKey';
};

export type RateLimitCredential = {
  readonly identity: RateLimitIdentity;
  readonly _brand: 'RateLimitCredential';
};

export type RateLimitPolicy = {
  readonly policy_id: string;
  readonly revision: number;
  /** Requests per second. */
  readonly rps: number;
  /** Total bucket capacity, not capacity in addition to the burst. */
  readonly burst: number;
};

export type RateLimitDebitRequestBody = RateLimitPolicy & { readonly bucket_id: string };

export type RateLimitDebitRequest = {
  readonly protocol: typeof RATE_LIMIT_PROTOCOL;
  readonly version: typeof RATE_LIMIT_VERSION;
  readonly kind: 'debit_request';
  readonly worker: RateLimitWorkerIdentity;
  readonly request_id: string;
  readonly debit_id: string;
  readonly deadline_at: number;
  readonly body: RateLimitDebitRequestBody;
  readonly mac: `hmac-sha256:${string}`;
};

export type RateLimitDebitOutcome = 'consumed' | 'rate_limited';

export type RateLimitDebitResponseBody = {
  readonly allowed: boolean;
  readonly reason: RateLimitDebitOutcome;
  readonly retry_after_ms: number;
};

export type RateLimitDebitResponse = {
  readonly protocol: typeof RATE_LIMIT_PROTOCOL;
  readonly version: typeof RATE_LIMIT_VERSION;
  readonly kind: 'debit_response';
  readonly worker: RateLimitWorkerIdentity;
  readonly authority: RateLimitIngressIdentity;
  readonly request_id: string;
  readonly debit_id: string;
  readonly deadline_at: number;
  readonly body: RateLimitDebitResponseBody;
  readonly mac: `hmac-sha256:${string}`;
};

export type RateLimitProtocolErrorCode =
  | 'malformed_message' | 'unsupported_protocol' | 'invalid_mac' | 'identity_mismatch'
  | 'invalid_key_material' | 'deadline_expired' | 'deadline_too_far' | 'request_replay'
  | 'field_conflict' | 'unauthorized' | 'worker_unknown' | 'worker_prepared'
  | 'policy_conflict' | 'invalid_policy' | 'invalid_bucket' | 'capacity' | 'busy'
  | 'disposed' | 'message_too_large' | 'invalid_response';

export class RateLimitProtocolError extends Error {
  readonly name = 'RateLimitProtocolError';

  constructor(
    readonly code: RateLimitProtocolErrorCode,
    message: string = code,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

function fail(code: RateLimitProtocolErrorCode, message: string, cause?: unknown): never {
  throw new RateLimitProtocolError(code, message, cause === undefined ? undefined : { cause });
}

function utf8(value: string, field: string, maxBytes: number): Uint8Array {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return fail('malformed_message', `${field} contains a control character`);
  try {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > maxBytes) return fail('malformed_message', `${field} is too long`);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (index + 1 >= value.length) return fail('malformed_message', `${field} is not valid UTF-8`);
        const next = value.charCodeAt(index + 1);
        if (next < 0xdc00 || next > 0xdfff) return fail('malformed_message', `${field} is not valid UTF-8`);
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return fail('malformed_message', `${field} is not valid UTF-8`);
      }
    }
    return bytes;
  } catch (cause) {
    return fail('malformed_message', `${field} is not valid UTF-8`, cause);
  }
}

function plain(value: unknown, field: string): Record<string, unknown> {
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

function stringField(value: Record<string, unknown>, field: string, maxBytes = 256): string {
  if (typeof value[field] !== 'string') return fail('malformed_message', `${field} must be a string`);
  utf8(value[field] as string, field, maxBytes);
  return value[field] as string;
}

function uuidField(value: Record<string, unknown>, field: string): string {
  const result = stringField(value, field, 36);
  if (!isLowercaseUuid(result)) return fail('malformed_message', `${field} must be a lowercase UUID`);
  return result;
}

function integerField(value: Record<string, unknown>, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = value[field];
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    return fail('malformed_message', `${field} must be a bounded safe integer`);
  }
  return result;
}

function numberField(value: Record<string, unknown>, field: string, minimum: number, maximum: number): number {
  const result = value[field];
  if (typeof result !== 'number' || !Number.isFinite(result)
    || result < minimum || result > maximum) {
    return fail('invalid_policy', `${field} must be finite and bounded`);
  }
  return result;
}

function workerField(value: unknown): RateLimitWorkerIdentity {
  const input = plain(value, 'worker');
  exact(input, ['role', 'process_instance_id', 'boot_nonce', 'master_generation', 'worker_slot'], 'worker');
  if (input.role !== 'worker') return fail('identity_mismatch', 'worker role is invalid');
  return {
    role: 'worker',
    process_instance_id: uuidField(input, 'process_instance_id'),
    boot_nonce: uuidField(input, 'boot_nonce'),
    master_generation: uuidField(input, 'master_generation'),
    worker_slot: integerField(input, 'worker_slot', 0, RATE_LIMIT_MAX_WORKER_SLOT),
  };
}

function ingressField(value: unknown): RateLimitIngressIdentity {
  const input = plain(value, 'authority');
  exact(input, ['role', 'process_instance_id', 'boot_nonce'], 'authority');
  if (input.role !== 'ingress') return fail('identity_mismatch', 'authority role is invalid');
  return { role: 'ingress', process_instance_id: uuidField(input, 'process_instance_id'), boot_nonce: uuidField(input, 'boot_nonce') };
}

function policyBody(value: unknown): RateLimitDebitRequestBody {
  const input = plain(value, 'body');
  exact(input, ['bucket_id', 'policy_id', 'revision', 'rps', 'burst'], 'body');
  const bucket = stringField(input, 'bucket_id', RATE_LIMIT_MAX_BUCKET_ID_BYTES);
  if (!BUCKET_ID.test(bucket)) return fail('invalid_bucket', 'bucket_id is invalid');
  const policyId = stringField(input, 'policy_id', RATE_LIMIT_MAX_POLICY_ID_BYTES);
  if (!SAFE_TOKEN.test(policyId)) return fail('invalid_policy', 'policy_id is invalid');
  return {
    bucket_id: bucket,
    policy_id: policyId,
    revision: integerField(input, 'revision', 1, Number.MAX_SAFE_INTEGER - 1),
    rps: numberField(input, 'rps', Number.MIN_VALUE, RATE_LIMIT_MAX_RPS),
    burst: integerField(input, 'burst', 1, RATE_LIMIT_MAX_BURST),
  };
}

function responseBody(value: unknown): RateLimitDebitResponseBody {
  const input = plain(value, 'body');
  exact(input, ['allowed', 'reason', 'retry_after_ms'], 'body');
  if (typeof input.allowed !== 'boolean') return fail('malformed_message', 'allowed must be boolean');
  if (input.reason !== 'consumed' && input.reason !== 'rate_limited') return fail('malformed_message', 'reason is invalid');
  const retry = integerField(input, 'retry_after_ms', 0, RATE_LIMIT_MAX_RETRY_AFTER_MS);
  if (input.allowed !== (input.reason === 'consumed') || (input.reason === 'consumed' && retry !== 0)) {
    return fail('malformed_message', 'response outcome is inconsistent');
  }
  return { allowed: input.allowed, reason: input.reason, retry_after_ms: retry };
}

function unsignedWire(value: unknown): string {
  try {
    const wire = canonicalJson(value);
    if (new TextEncoder().encode(wire).byteLength > RATE_LIMIT_MAX_BYTES) return fail('message_too_large', 'unsigned message is too large');
    return wire;
  } catch (cause) {
    if (cause instanceof RateLimitProtocolError) throw cause;
    return fail('malformed_message', 'message is not canonical JSON', cause);
  }
}

function assertWireSize(value: unknown): void {
  try {
    if (new TextEncoder().encode(canonicalJson(value)).byteLength > RATE_LIMIT_MAX_BYTES) {
      fail('message_too_large', 'canonical message exceeds 4 KiB');
    }
  } catch (cause) {
    if (cause instanceof RateLimitProtocolError) throw cause;
    fail('malformed_message', 'message is not canonical JSON', cause);
  }
}

function parseWire(value: unknown): unknown {
  if (typeof value === 'string' || value instanceof Uint8Array) {
    try { return parseRateLimitJsonWire(value, RATE_LIMIT_MAX_BYTES); }
    catch (cause) {
      if (cause instanceof RateLimitJsonError) return fail(cause.code, 'message is not valid strict JSON', cause);
      return fail('malformed_message', 'message is not valid UTF-8 JSON', cause);
    }
  }
  assertWireSize(value);
  return value;
}

function macFor(value: unknown, key: Uint8Array, canonical?: string): `hmac-sha256:${string}` {
  const bytes = createHmac('sha256', key).update(`${MAC_DOMAIN}\0`).update(canonical ?? unsignedWire(value)).digest('hex');
  return `hmac-sha256:${bytes}`;
}

function signed<T extends object>(value: T, key: Uint8Array): T & { readonly mac: `hmac-sha256:${string}` } {
  const unsigned = unsignedWire(value);
  const result = { ...value, mac: macFor(value, key, unsigned) };
  const wire = canonicalJson(result);
  const finalBytes = new TextEncoder().encode(wire);
  if (finalBytes.byteLength > RATE_LIMIT_MAX_BYTES) return fail('message_too_large', 'signed message exceeds 4 KiB');
  const frozen = Object.freeze(result) as T & { readonly mac: `hmac-sha256:${string}` };
  SERIALIZED_WIRES.set(frozen, wire);
  return frozen;
}

export function serializeRateLimitMessage(value: unknown, counters?: RateLimitWireCounters): string {
  const cached = typeof value === 'object' && value !== null
    ? SERIALIZED_WIRES.get(value)
    : undefined;
  let wire = cached;
  if (wire === undefined) {
    try {
      wire = canonicalJson(value);
      if (new TextEncoder().encode(wire).byteLength > RATE_LIMIT_MAX_BYTES) return fail('message_too_large', 'canonical message exceeds 4 KiB');
    } catch (cause) {
      if (cause instanceof RateLimitProtocolError) throw cause;
      return fail('malformed_message', 'message is not canonical JSON', cause);
    }
  }
  counters?.serialize?.();
  return wire;
}

function verifyMac(value: Record<string, unknown>, key: Uint8Array): string {
  const mac = value.mac;
  if (typeof mac !== 'string' || !MAC.test(mac)) return fail('malformed_message', 'mac is invalid');
  const unsigned = { ...value };
  delete unsigned.mac;
  const canonical = unsignedWire(unsigned);
  const expected = Buffer.from(macFor(unsigned, key, canonical).slice('hmac-sha256:'.length), 'hex');
  const actual = Buffer.from(mac.slice('hmac-sha256:'.length), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail('invalid_mac', 'message MAC is invalid');
  return canonical;
}

function requireCredential(value: RateLimitCredential): Uint8Array {
  if (typeof value !== 'object' || value === null || !CREDENTIALS.has(value) || DISPOSED.has(value)) {
    return fail('invalid_key_material', 'rate-limit credential is disposed or invalid');
  }
  return CREDENTIALS.get(value)!;
}

function assertWorkerEqual(left: RateLimitWorkerIdentity, right: RateLimitWorkerIdentity): void {
  if (left.role !== right.role || left.process_instance_id !== right.process_instance_id
    || left.boot_nonce !== right.boot_nonce || left.master_generation !== right.master_generation
    || left.worker_slot !== right.worker_slot) return fail('identity_mismatch', 'worker identity does not match credential');
}

function assertIngressEqual(left: RateLimitIngressIdentity, right: RateLimitIngressIdentity): void {
  if (left.role !== right.role || left.process_instance_id !== right.process_instance_id
    || left.boot_nonce !== right.boot_nonce) return fail('identity_mismatch', 'response authority does not match credential');
}

function transportSecretBytes(instanceTransportSecret: RateLimitTransportSecret): Uint8Array {
  if (typeof instanceTransportSecret === 'string') {
    const bytes = new Uint8Array(Buffer.from(instanceTransportSecret, 'base64url'));
    if (bytes.byteLength !== 32 || Buffer.from(bytes).toString('base64url') !== instanceTransportSecret) {
      return fail('invalid_key_material', 'instance transport secret must be canonical 32-byte base64url');
    }
    return bytes;
  }
  if (!(instanceTransportSecret instanceof Uint8Array) || instanceTransportSecret.byteLength !== 32) {
    return fail('invalid_key_material', 'instance transport secret must be exactly 32 bytes');
  }
  return new Uint8Array(instanceTransportSecret);
}

export function deriveRateLimitDomainKey(instanceTransportSecret: RateLimitTransportSecret): Uint8Array {
  const secret = transportSecretBytes(instanceTransportSecret);
  return new Uint8Array(createHmac('sha256', secret).update(DOMAIN, 'utf8').digest());
}

export function createRateLimitCredential(
  instanceTransportSecret: RateLimitTransportSecret,
  identity: RateLimitIdentity,
): RateLimitCredential {
  const domainKey = deriveRateLimitDomainKey(instanceTransportSecret);
  const checked = identity.role === 'worker' ? workerField(identity) : ingressField(identity);
  const credential = Object.freeze({ identity: Object.freeze(checked), _brand: 'RateLimitCredential' as const });
  CREDENTIALS.set(credential, domainKey);
  return credential;
}

export function disposeRateLimitCredential(credential: RateLimitCredential): void {
  if (typeof credential !== 'object' || credential === null || !CREDENTIALS.has(credential)) {
    return fail('invalid_key_material', 'rate-limit credential is invalid');
  }
  if (DISPOSED.has(credential)) return;
  const key = CREDENTIALS.get(credential);
  if (key !== undefined) key.fill(0);
  DISPOSED.add(credential as object);
}

export function signRateLimitDebitRequest(
  input: Omit<RateLimitDebitRequest, 'protocol' | 'version' | 'kind' | 'worker' | 'mac'>,
  credential: RateLimitCredential,
): RateLimitDebitRequest {
  const key = requireCredential(credential);
  if (credential.identity.role !== 'worker') return fail('identity_mismatch', 'only worker credentials sign debit requests');
  const requestId = uuidField({ request_id: input.request_id }, 'request_id');
  const debitId = uuidField({ debit_id: input.debit_id }, 'debit_id');
  const deadline = integerField({ deadline_at: input.deadline_at }, 'deadline_at', 0);
  const body = policyBody(input.body);
  return signed({ protocol: RATE_LIMIT_PROTOCOL, version: RATE_LIMIT_VERSION, kind: 'debit_request', worker: credential.identity,
    request_id: requestId, debit_id: debitId, deadline_at: deadline, body }, key) as RateLimitDebitRequest;
}

export function parseRateLimitDebitRequest(value: unknown, counters?: RateLimitWireCounters): RateLimitDebitRequest {
  counters?.parse?.();
  const wireInput = typeof value === 'string' || value instanceof Uint8Array;
  const input = plain(parseWire(value), 'message');
  exact(input, ['protocol', 'version', 'kind', 'worker', 'request_id', 'debit_id', 'deadline_at', 'body', 'mac'], 'message');
  if (input.protocol !== RATE_LIMIT_PROTOCOL || input.version !== RATE_LIMIT_VERSION) return fail('unsupported_protocol', 'unsupported rate-limit protocol');
  if (input.kind !== 'debit_request') return fail('malformed_message', 'message kind is invalid');
  const result = { protocol: RATE_LIMIT_PROTOCOL, version: RATE_LIMIT_VERSION, kind: 'debit_request' as const,
    worker: workerField(input.worker), request_id: uuidField(input, 'request_id'), debit_id: uuidField(input, 'debit_id'),
    deadline_at: integerField(input, 'deadline_at', 0), body: policyBody(input.body), mac: stringField(input, 'mac', 80) as `hmac-sha256:${string}` };
  if (!MAC.test(result.mac)) return fail('malformed_message', 'mac is invalid');
  if (!wireInput) assertWireSize(result);
  return result;
}

export function verifyRateLimitDebitRequest(value: unknown, credential: RateLimitCredential, counters?: RateLimitWireCounters): RateLimitDebitRequest {
  const key = requireCredential(credential);
  const result = parseRateLimitDebitRequest(value, counters);
  if (credential.identity.role === 'worker') assertWorkerEqual(result.worker, credential.identity);
  const fingerprint = verifyMac(result, key);
  REQUEST_FINGERPRINTS.set(result, fingerprint);
  return result;
}

export function getRateLimitDebitRequestFingerprint(value: RateLimitDebitRequest): string {
  const cached = REQUEST_FINGERPRINTS.get(value);
  if (cached !== undefined) return cached;
  const unsigned = { ...value };
  delete (unsigned as { mac?: unknown }).mac;
  return unsignedWire(unsigned);
}

export function signRateLimitDebitResponse(
  input: Omit<RateLimitDebitResponse, 'protocol' | 'version' | 'kind' | 'authority' | 'mac'>,
  credential: RateLimitCredential,
): RateLimitDebitResponse {
  const key = requireCredential(credential);
  if (credential.identity.role !== 'ingress') return fail('identity_mismatch', 'only ingress credentials sign debit responses');
  const requestId = uuidField({ request_id: input.request_id }, 'request_id');
  const debitId = uuidField({ debit_id: input.debit_id }, 'debit_id');
  const deadline = integerField({ deadline_at: input.deadline_at }, 'deadline_at', 0);
  const worker = workerField(input.worker);
  const body = responseBody(input.body);
  return signed({ protocol: RATE_LIMIT_PROTOCOL, version: RATE_LIMIT_VERSION, kind: 'debit_response', worker,
    authority: credential.identity, request_id: requestId, debit_id: debitId, deadline_at: deadline, body }, key) as RateLimitDebitResponse;
}

export function parseRateLimitDebitResponse(value: unknown, counters?: RateLimitWireCounters): RateLimitDebitResponse {
  counters?.parse?.();
  const wireInput = typeof value === 'string' || value instanceof Uint8Array;
  const input = plain(parseWire(value), 'message');
  exact(input, ['protocol', 'version', 'kind', 'worker', 'authority', 'request_id', 'debit_id', 'deadline_at', 'body', 'mac'], 'message');
  if (input.protocol !== RATE_LIMIT_PROTOCOL || input.version !== RATE_LIMIT_VERSION) return fail('unsupported_protocol', 'unsupported rate-limit protocol');
  if (input.kind !== 'debit_response') return fail('malformed_message', 'message kind is invalid');
  const result = { protocol: RATE_LIMIT_PROTOCOL, version: RATE_LIMIT_VERSION, kind: 'debit_response' as const,
    worker: workerField(input.worker), authority: ingressField(input.authority), request_id: uuidField(input, 'request_id'),
    debit_id: uuidField(input, 'debit_id'), deadline_at: integerField(input, 'deadline_at', 0), body: responseBody(input.body),
    mac: stringField(input, 'mac', 80) as `hmac-sha256:${string}` };
  if (!MAC.test(result.mac)) return fail('malformed_message', 'mac is invalid');
  if (!wireInput) assertWireSize(result);
  return result;
}

export function verifyRateLimitDebitResponse(
  value: unknown,
  credential: RateLimitCredential,
  expectedIngress: RateLimitIngressIdentity,
  request: Pick<RateLimitDebitRequest, 'worker' | 'request_id' | 'debit_id' | 'deadline_at'>,
  counters?: RateLimitWireCounters,
): RateLimitDebitResponse {
  const key = requireCredential(credential);
  if (credential.identity.role !== 'worker') return fail('identity_mismatch', 'response client credential must be a worker credential');
  const result = parseRateLimitDebitResponse(value, counters);
  assertWorkerEqual(result.worker, credential.identity);
  assertIngressEqual(result.authority, ingressField(expectedIngress));
  if (result.worker.role !== request.worker.role || result.worker.process_instance_id !== request.worker.process_instance_id
    || result.worker.boot_nonce !== request.worker.boot_nonce || result.worker.master_generation !== request.worker.master_generation
    || result.worker.worker_slot !== request.worker.worker_slot
    || result.request_id !== request.request_id || result.debit_id !== request.debit_id
    || result.deadline_at !== request.deadline_at) {
    return fail('invalid_response', 'response correlation or worker identity is invalid');
  }
  verifyMac(result, key);
  return result;
}

export function normalizeRateLimitKey(value: string, kind?: 'string' | 'ip'): RateLimitNormalizedKey;
export function normalizeRateLimitKey(value: number, kind?: 'number'): RateLimitNormalizedKey;
export function normalizeRateLimitKey(value: boolean, kind?: 'boolean'): RateLimitNormalizedKey;
export function normalizeRateLimitKey(value: string | number | boolean, kind?: RateLimitKeyKind): RateLimitNormalizedKey {
  if (typeof value === 'string') {
    utf8(value, 'normalized_key', 2_048);
    const normalized = value.trim().normalize('NFC');
    utf8(normalized, 'normalized_key', 2_048);
    if (normalized.length === 0) return fail('invalid_bucket', 'normalized key must not be empty');
    const resolvedKind = kind ?? 'string';
    if (resolvedKind !== 'string' && resolvedKind !== 'ip') return fail('invalid_bucket', 'normalized key type is invalid');
    if (resolvedKind === 'ip' && isIP(normalized) === 0) return fail('invalid_bucket', 'normalized IP key is invalid');
    const result = Object.freeze({ kind: resolvedKind, value: normalized, _brand: 'RateLimitNormalizedKey' as const });
    NORMALIZED_KEYS.add(result);
    return result;
  }
  if (typeof value === 'number') {
    if (kind !== undefined && kind !== 'number') return fail('invalid_bucket', 'normalized key type is invalid');
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return fail('invalid_bucket', 'normalized number key is invalid');
    const result = Object.freeze({ kind: 'number' as const, value: Object.is(value, -0) ? '0' : String(value), _brand: 'RateLimitNormalizedKey' as const });
    NORMALIZED_KEYS.add(result);
    return result;
  }
  if (typeof value === 'boolean') {
    if (kind !== undefined && kind !== 'boolean') return fail('invalid_bucket', 'normalized key type is invalid');
    const result = Object.freeze({ kind: 'boolean' as const, value: String(value), _brand: 'RateLimitNormalizedKey' as const });
    NORMALIZED_KEYS.add(result);
    return result;
  }
  return fail('invalid_bucket', 'normalized key primitive is invalid');
}

function requireNormalizedKey(value: RateLimitNormalizedKey): RateLimitNormalizedKey {
  if (typeof value !== 'object' || value === null || !NORMALIZED_KEYS.has(value)
    || (value.kind !== 'string' && value.kind !== 'number' && value.kind !== 'boolean' && value.kind !== 'ip')
    || typeof value.value !== 'string') {
    return fail('invalid_bucket', 'normalized key is not a module-issued primitive');
  }
  return value;
}

export function deriveRateLimitBucketId(
  instanceTransportSecret: RateLimitTransportSecret,
  routeId: string,
  keyExpression: string,
  resolvedNormalizedKey: RateLimitNormalizedKey,
): string {
  if (!isLowercaseUuid(routeId)) return fail('invalid_bucket', 'routeId must be a lowercase UUID');
  const domainKey = deriveRateLimitDomainKey(instanceTransportSecret);
  return deriveRateLimitBucketIdFromDomainKey(domainKey, routeId, keyExpression, resolvedNormalizedKey);
}

export function deriveRateLimitBucketIdFromDomainKey(
  domainKey: Uint8Array,
  routeId: string,
  keyExpression: string,
  resolvedNormalizedKey: RateLimitNormalizedKey,
): string {
  if (!(domainKey instanceof Uint8Array) || domainKey.byteLength !== 32) return fail('invalid_key_material', 'domain key must be exactly 32 bytes');
  if (!isLowercaseUuid(routeId)) return fail('invalid_bucket', 'routeId must be a lowercase UUID');
  if (keyExpression.length === 0) return fail('invalid_bucket', 'key_expression must not be empty');
  utf8(keyExpression, 'key_expression', 1_024);
  const normalized = requireNormalizedKey(resolvedNormalizedKey);
  const message = `${BUCKET_DOMAIN}\0${routeId}\0${canonicalJson(keyExpression)}\0${canonicalJson({ kind: normalized.kind, value: normalized.value })}`;
  return `rlb-v1:${createHmac('sha256', domainKey).update(message, 'utf8').digest('hex')}`;
}

export function createRateLimitRequestInput(
  body: RateLimitDebitRequestBody,
  deadlineAt: number,
  debitId = randomUUID(),
  requestId = randomUUID(),
): Omit<RateLimitDebitRequest, 'protocol' | 'version' | 'kind' | 'worker' | 'mac'> {
  return { request_id: requestId, debit_id: debitId, deadline_at: deadlineAt, body };
}
