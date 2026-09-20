import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, hashConfigurationContent } from '../config-storage/content-hash';
import { validateDigest } from '../config-storage/repository-validation';
import { isLowercaseUuid } from '../config-storage/validation';

export const SUPERVISION_PROTOCOL = 'bungee-supervision-v1';
export const MAX_SUPERVISION_INTEGER = Number.MAX_SAFE_INTEGER;

export type SupervisionRole = 'ingress' | 'worker';
export type SupervisionDirection = 'controller-to-process' | 'process-to-controller';
export type SupervisionRootKeyMaterial = Uint8Array;
export type SupervisionMac = `hmac-sha256:${string}`;

/** A worker-scoped handoff; unlike a process credential it cannot sign messages. */
export type WorkerSupervisionSeed = {
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly seed: Readonly<Uint8Array>;
  readonly seed_binding: Readonly<Uint8Array>;
};

const WORKER_SEED_DOMAIN = 'bungee-supervision/v1/worker-seed';
const WORKER_CREDENTIAL_DOMAIN = 'bungee-supervision/v1/worker-credential';
const VALID_WORKER_SEEDS = new WeakSet<object>();

export type ProcessIdentity = {
  readonly role: SupervisionRole;
  readonly process_instance_id: string;
  readonly boot_nonce: string;
};

export type SupervisionProcessCredential = {
  readonly identity: ProcessIdentity;
  readonly process_key: Readonly<Uint8Array>;
};

export type ControllerAuthority = {
  readonly controller_epoch: number;
  readonly controller_id: string;
};

type MessageBase = ProcessIdentity & ControllerAuthority & {
  readonly protocol: typeof SUPERVISION_PROTOCOL;
  readonly kind: SupervisionMessageKind;
  readonly direction: SupervisionDirection;
  readonly sequence: number;
  readonly request_id: string;
  readonly mac: SupervisionMac;
};

export type SupervisionMessageKind = 'challenge' | 'attach' | 'lease' | 'status' | 'command';

export type ChallengeMessage = MessageBase & {
  readonly kind: 'challenge';
  readonly challenge_nonce: string;
  readonly expires_at: number;
};
export type AttachMessage = MessageBase & {
  readonly kind: 'attach';
  readonly challenge_nonce: string;
};
export type LeaseMessage = MessageBase & {
  readonly kind: 'lease';
  readonly lease_expires_at: number;
};
export type StatusMessage = MessageBase & {
  readonly kind: 'status';
  readonly status: string;
  readonly body_hash: `sha256:${string}`;
};
export type CommandEnvelope = MessageBase & {
  readonly kind: 'command';
  readonly method: string;
  readonly path: string;
  readonly body_hash: `sha256:${string}`;
};

export type SupervisionMessage = ChallengeMessage | AttachMessage | LeaseMessage | StatusMessage | CommandEnvelope;
export type UnsignedSupervisionMessage =
  | Omit<ChallengeMessage, 'mac'>
  | Omit<AttachMessage, 'mac'>
  | Omit<LeaseMessage, 'mac'>
  | Omit<StatusMessage, 'mac'>
  | Omit<CommandEnvelope, 'mac'>;

export type SupervisionProtocolErrorCode =
  | 'malformed_message'
  | 'unsupported_protocol'
  | 'invalid_mac'
  | 'identity_mismatch'
  | 'challenge_expired'
  | 'challenge_replayed'
  | 'challenge_mismatch'
  | 'challenge_capacity'
  | 'stale_controller'
  | 'split_brain'
  | 'unattached_controller'
  | 'sequence_replay'
  | 'request_replay'
  | 'request_capacity'
  | 'ingress_frozen'
  | 'status_correlation_mismatch'
  | 'worker_frozen'
  | 'worker_not_ready'
  | 'invalid_key_material';

export class SupervisionProtocolError extends Error {
  readonly name = 'SupervisionProtocolError';

  constructor(
    readonly code: SupervisionProtocolErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

type PlainObject = Record<string, unknown>;

const ROLE = new Set<SupervisionRole>(['ingress', 'worker']);
const MAC = /^hmac-sha256:[0-9a-f]{64}$/;
const CHALLENGE_NONCE = /^[0-9a-f]{64}$/;
const METHOD = /^[A-Z][A-Z0-9_-]{0,15}$/;

function error(code: SupervisionProtocolErrorCode, message: string): never {
  throw new SupervisionProtocolError(code, `invalid supervision message: ${message}`);
}

function malformed(message: string): never {
  return error('malformed_message', message);
}

function object(value: unknown): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed('expected an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return malformed('expected a plain object');
  return value as PlainObject;
}

function exactKeys(value: PlainObject, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    malformed('unexpected or missing field');
  }
}

function stringField(value: PlainObject, key: string): string {
  if (typeof value[key] !== 'string') return malformed(`${key} must be a string`);
  return value[key] as string;
}

function uuidField(value: PlainObject, key: string): string {
  const candidate = stringField(value, key);
  if (!isLowercaseUuid(candidate)) return malformed(`${key} must be a lowercase UUID`);
  return candidate;
}

function roleField(value: PlainObject): SupervisionRole {
  const role = stringField(value, 'role');
  if (!ROLE.has(role as SupervisionRole)) return malformed('role must be ingress or worker');
  return role as SupervisionRole;
}

function directionField(value: PlainObject): SupervisionDirection {
  const direction = stringField(value, 'direction');
  if (direction !== 'controller-to-process' && direction !== 'process-to-controller') {
    return malformed('direction is invalid');
  }
  return direction;
}

function integerField(value: PlainObject, key: string, minimum: number): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate)
    || candidate < minimum || candidate >= MAX_SUPERVISION_INTEGER) {
    return malformed(`${key} must be below Number.MAX_SAFE_INTEGER`);
  }
  return candidate;
}

function macField(value: PlainObject): SupervisionMac {
  const mac = stringField(value, 'mac');
  if (!MAC.test(mac)) return malformed('mac is invalid');
  return mac as SupervisionMac;
}

function challengeNonceField(value: PlainObject): string {
  const nonce = stringField(value, 'challenge_nonce');
  if (!CHALLENGE_NONCE.test(nonce)) return malformed('challenge_nonce is invalid');
  return nonce;
}

function validateUnsigned(value: unknown): UnsignedSupervisionMessage {
  const input = object(value);
  const kind = stringField(input, 'kind') as SupervisionMessageKind;
  const common = [
    'protocol', 'kind', 'direction', 'role', 'process_instance_id', 'boot_nonce',
    'controller_epoch', 'controller_id', 'sequence', 'request_id',
  ];
  const fields = kind === 'challenge' ? [...common, 'challenge_nonce', 'expires_at']
    : kind === 'attach' ? [...common, 'challenge_nonce']
      : kind === 'lease' ? [...common, 'lease_expires_at']
        : kind === 'status' ? [...common, 'status', 'body_hash']
          : kind === 'command' ? [...common, 'method', 'path', 'body_hash']
            : malformed('kind is invalid');
  exactKeys(input, fields);
  if (input.protocol !== SUPERVISION_PROTOCOL) {
    throw new SupervisionProtocolError('unsupported_protocol', 'unsupported supervision protocol');
  }
  const direction = directionField(input);
  const expectedDirection = kind === 'attach' || kind === 'lease' || kind === 'command'
    ? 'controller-to-process' : 'process-to-controller';
  if (direction !== expectedDirection) malformed(`${kind} has the wrong direction`);
  roleField(input);
  uuidField(input, 'process_instance_id');
  uuidField(input, 'boot_nonce');
  integerField(input, 'controller_epoch', 0);
  uuidField(input, 'controller_id');
  integerField(input, 'sequence', 1);
  uuidField(input, 'request_id');
  if (kind === 'challenge') {
    challengeNonceField(input);
    integerField(input, 'expires_at', 0);
  }
  if (kind === 'attach') challengeNonceField(input);
  if (kind === 'lease') integerField(input, 'lease_expires_at', 0);
  if (kind === 'status') {
    const status = stringField(input, 'status');
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(status)) malformed('status is invalid');
    if (!validateDigest(stringField(input, 'body_hash'))) malformed('body_hash is invalid');
  }
  if (kind === 'command') {
    const method = stringField(input, 'method');
    const path = stringField(input, 'path');
    const bodyHash = stringField(input, 'body_hash');
    if (!METHOD.test(method)) malformed('method is invalid');
    if (!isCanonicalSupervisionPath(path)) malformed('path is not a canonical ASCII supervision path');
    if (!validateDigest(bodyHash)) malformed('body_hash is invalid');
  }
  return input as unknown as UnsignedSupervisionMessage;
}

export function isCanonicalSupervisionPath(path: string): boolean {
  if (typeof path !== 'string' || path === '' || !path.startsWith('/') || path.length > 4096) return false;
  if (path === '/') return true;
  const segments = path.slice(1).split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..'
    && /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/.test(segment));
}

export function parseSupervisionMessage(value: unknown): SupervisionMessage {
  const input = object(value);
  const unsigned = { ...input };
  delete unsigned.mac;
  validateUnsigned(unsigned);
  macField(input);
  return input as unknown as SupervisionMessage;
}

function requireRootKey(value: SupervisionRootKeyMaterial): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new SupervisionProtocolError('invalid_key_material', 'root key material must be exactly 32 bytes');
  }
  return value;
}

function requireCredential(value: SupervisionProcessCredential): SupervisionProcessCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !Object.prototype.hasOwnProperty.call(value, 'identity')
    || !Object.prototype.hasOwnProperty.call(value, 'process_key')) {
    throw new SupervisionProtocolError('invalid_key_material', 'process credential is invalid');
  }
  const identity = requireIdentity(value.identity);
  if (!(value.process_key instanceof Uint8Array) || value.process_key.byteLength !== 32) {
    throw new SupervisionProtocolError('invalid_key_material', 'process credential key must be exactly 32 bytes');
  }
  return { identity, process_key: value.process_key };
}

function freezeCredential(identity: ProcessIdentity, processKey: Uint8Array): SupervisionProcessCredential {
  return Object.freeze({ identity: Object.freeze(identity), process_key: processKey });
}

function requireIdentity(identity: unknown): ProcessIdentity {
  if (typeof identity !== 'object' || identity === null) malformed('expected process identity');
  const value = identity as unknown as PlainObject;
  exactKeys(value, ['role', 'process_instance_id', 'boot_nonce']);
  return {
    role: roleField(value),
    process_instance_id: uuidField(value, 'process_instance_id'),
    boot_nonce: uuidField(value, 'boot_nonce'),
  };
}

function assertIdentity(message: ProcessIdentity, expected: ProcessIdentity): void {
  const identity = requireIdentity(expected);
  if (message.role !== identity.role || message.process_instance_id !== identity.process_instance_id
    || message.boot_nonce !== identity.boot_nonce) {
    throw new SupervisionProtocolError('identity_mismatch', 'message identity does not match expected process identity');
  }
}

/**
 * Derive the sole per-process key from the caller-owned stable root key. The
 * future master composition must pass the 32-byte value parsed from the
 * existing BUNGEE_PLUGIN_SECRETS_KEY source; this layer never persists or
 * forwards that root value to a child.
 */
export function deriveSupervisionProcessKey(
  rootKeyMaterial: SupervisionRootKeyMaterial,
  instanceId: string,
  role: SupervisionRole,
  processInstanceId: string,
  bootNonce: string,
): SupervisionProcessCredential {
  requireRootKey(rootKeyMaterial);
  if (!isLowercaseUuid(instanceId) || !ROLE.has(role)) malformed('key derivation identity is invalid');
  if (!isLowercaseUuid(processInstanceId) || !isLowercaseUuid(bootNonce)) {
    malformed('key derivation process identity is invalid');
  }
  const context = [SUPERVISION_PROTOCOL, instanceId, role, processInstanceId, bootNonce].join('\0');
  const digest = createHmac('sha256', rootKeyMaterial).update(context, 'utf8').digest();
  const processKey = new Uint8Array(digest);
  return freezeCredential({ role, process_instance_id: processInstanceId, boot_nonce: bootNonce }, processKey);
}

/** Derives only the seed bound to one future worker identity. The root never leaves this function. */
export function deriveWorkerSupervisionSeed(
  rootKeyMaterial: SupervisionRootKeyMaterial,
  masterGeneration: string,
  workerInstanceId: string,
  workerSlot: number,
): WorkerSupervisionSeed {
  const root = requireRootKey(rootKeyMaterial);
  if (!isLowercaseUuid(masterGeneration) || !isLowercaseUuid(workerInstanceId)
    || !Number.isSafeInteger(workerSlot) || workerSlot < 0) {
    malformed('worker seed identity is invalid');
  }
  const context = [WORKER_SEED_DOMAIN, masterGeneration, workerInstanceId, workerSlot].join('\0');
  const seed = new Uint8Array(createHmac('sha256', root).update(context, 'utf8').digest());
  const seedValue = Object.freeze({
    master_generation: masterGeneration,
    worker_instance_id: workerInstanceId,
    worker_slot: workerSlot,
    seed,
    seed_binding: new Uint8Array(createHmac('sha256', seed)
      .update([WORKER_SEED_DOMAIN, 'binding', masterGeneration, workerInstanceId, workerSlot].join('\0'), 'utf8').digest()),
  });
  VALID_WORKER_SEEDS.add(seedValue);
  return seedValue;
}

function requireWorkerSeed(value: WorkerSupervisionSeed): WorkerSupervisionSeed {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !VALID_WORKER_SEEDS.has(value)) {
    throw new SupervisionProtocolError('invalid_key_material', 'worker supervision seed is invalid');
  }
  const candidate = value as WorkerSupervisionSeed;
  if (!isLowercaseUuid(candidate.master_generation) || !isLowercaseUuid(candidate.worker_instance_id)
    || !Number.isSafeInteger(candidate.worker_slot) || candidate.worker_slot < 0
    || !(candidate.seed instanceof Uint8Array) || candidate.seed.byteLength !== 32
    || !(candidate.seed_binding instanceof Uint8Array) || candidate.seed_binding.byteLength !== 32) {
    throw new SupervisionProtocolError('invalid_key_material', 'worker supervision seed is invalid');
  }
  const expected = createHmac('sha256', candidate.seed as Uint8Array)
    .update([WORKER_SEED_DOMAIN, 'binding', candidate.master_generation, candidate.worker_instance_id, candidate.worker_slot].join('\0'), 'utf8')
    .digest();
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(candidate.seed_binding))) {
    throw new SupervisionProtocolError('invalid_key_material', 'worker supervision seed identity binding is invalid');
  }
  return candidate;
}

export function deriveWorkerSupervisionCredential(
  seed: WorkerSupervisionSeed,
  bootNonce: string,
): SupervisionProcessCredential {
  const checked = requireWorkerSeed(seed);
  if (!isLowercaseUuid(bootNonce)) malformed('worker credential boot identity is invalid');
  const identity: ProcessIdentity = {
    role: 'worker', process_instance_id: checked.worker_instance_id, boot_nonce: bootNonce,
  };
  const context = [WORKER_CREDENTIAL_DOMAIN, checked.master_generation, checked.worker_instance_id,
    checked.worker_slot, bootNonce].join('\0');
  const processKey = new Uint8Array(createHmac('sha256', checked.seed as Uint8Array)
    .update(context, 'utf8').digest());
  return freezeCredential(identity, processKey);
}

function macBytes(message: UnsignedSupervisionMessage, credential: SupervisionProcessCredential): Uint8Array {
  return new Uint8Array(createHmac('sha256', requireCredential(credential).process_key as Uint8Array)
    .update(canonicalJson(message), 'utf8').digest());
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64url(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    malformed(`${field} must be unpadded base64url`);
  }
  const decoded = new Uint8Array(Buffer.from(value, 'base64url'));
  if (base64url(decoded) !== value) malformed(`${field} has a non-canonical base64url encoding`);
  return decoded;
}

export function serializeSupervisionCredential(credential: SupervisionProcessCredential): string {
  const checked = requireCredential(credential);
  const payload = canonicalJson({
    identity: checked.identity,
    process_key: base64url(checked.process_key),
  });
  return base64url(new TextEncoder().encode(payload));
}

export function serializeWorkerSupervisionSeed(seed: WorkerSupervisionSeed): string {
  const checked = requireWorkerSeed(seed);
  return base64url(new TextEncoder().encode(canonicalJson({
    version: 1,
    master_generation: checked.master_generation,
    worker_instance_id: checked.worker_instance_id,
    worker_slot: checked.worker_slot,
    seed: base64url(checked.seed as Uint8Array),
    seed_binding: base64url(checked.seed_binding as Uint8Array),
  })));
}

export function importWorkerSupervisionSeed(serialized: string): WorkerSupervisionSeed {
  const bytes = decodeBase64url(serialized, 'worker supervision seed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new SupervisionProtocolError('malformed_message', 'worker supervision seed JSON is invalid', { cause });
  }
  const payload = object(parsed);
  exactKeys(payload, ['version', 'master_generation', 'worker_instance_id', 'worker_slot', 'seed', 'seed_binding']);
  if (payload.version !== 1) malformed('worker supervision seed version is invalid');
  const seed: WorkerSupervisionSeed = {
    master_generation: payload.master_generation as string,
    worker_instance_id: payload.worker_instance_id as string,
    worker_slot: payload.worker_slot as number,
    seed: decodeBase64url(payload.seed, 'seed'),
    seed_binding: decodeBase64url(payload.seed_binding, 'seed_binding'),
  };
  const checked = Object.freeze({ ...seed, seed: new Uint8Array(seed.seed), seed_binding: new Uint8Array(seed.seed_binding) });
  VALID_WORKER_SEEDS.add(checked);
  return requireWorkerSeed(checked);
}

export function importSupervisionCredential(serialized: string): SupervisionProcessCredential {
  const bytes = decodeBase64url(serialized, 'credential');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new SupervisionProtocolError('malformed_message', 'credential JSON is invalid', { cause });
  }
  const payload = object(parsed);
  exactKeys(payload, ['identity', 'process_key']);
  const identity = requireIdentity(payload.identity);
  const processKey = decodeBase64url(payload.process_key, 'process_key');
  if (processKey.byteLength !== 32) malformed('process_key must be exactly 32 bytes');
  return freezeCredential(identity, processKey);
}

/** Stable data-plane credential; the root is consumed only by this derivation. */
export function deriveWorkerTransportSecret(
  rootKeyMaterial: SupervisionRootKeyMaterial,
  instanceId: string,
): string {
  const root = requireRootKey(rootKeyMaterial);
  if (!isLowercaseUuid(instanceId)) malformed('transport derivation instance identity is invalid');
  return Buffer.from(createHmac('sha256', root)
    .update(`bungee-transport-v1\0${instanceId}`, 'utf8').digest()).toString('base64url');
}

function macText(bytes: Uint8Array): SupervisionMac {
  return `hmac-sha256:${Buffer.from(bytes).toString('hex')}` as SupervisionMac;
}

export function signSupervisionMessage(
  message: UnsignedSupervisionMessage,
  credential: SupervisionProcessCredential,
): SupervisionMessage {
  const unsigned = validateUnsigned(message);
  const checked = requireCredential(credential);
  assertIdentity(unsigned, checked.identity);
  return { ...unsigned, mac: macText(macBytes(unsigned, checked)) } as SupervisionMessage;
}

export function verifySupervisionMessage(
  value: unknown,
  credential: SupervisionProcessCredential,
): true {
  const message = parseSupervisionMessage(value);
  const checked = requireCredential(credential);
  assertIdentity(message, checked.identity);
  const { mac: _mac, ...unsigned } = message;
  const expected = macBytes(unsigned as UnsignedSupervisionMessage, checked);
  const actual = Buffer.from(message.mac.slice('hmac-sha256:'.length), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, Buffer.from(expected))) {
    throw new SupervisionProtocolError('invalid_mac', 'supervision message MAC is invalid');
  }
  return true;
}

export function isValidSupervisionMessage(
  value: unknown,
  credential: SupervisionProcessCredential,
): boolean {
  try {
    verifySupervisionMessage(value, credential);
    return true;
  } catch {
    return false;
  }
}

export function hashSupervisionBody(body: unknown): `sha256:${string}` {
  return hashConfigurationContent(body);
}

function randomChallengeNonce(): string {
  return randomBytes(32).toString('hex');
}

export type PendingChallenge = Omit<ChallengeMessage, 'mac'>;

type ChallengeIssue = Omit<PendingChallenge, 'protocol' | 'kind' | 'direction' | 'challenge_nonce' | 'expires_at'>;

export type PendingChallengeStoreOptions = {
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly capacity?: number;
};

function clockValue(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_SUPERVISION_INTEGER) {
    malformed('clock must return a non-negative safe integer');
  }
  return value;
}

export class PendingChallengeStore {
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly retired = new Map<string, 'expired' | 'replayed'>();

  constructor(options: PendingChallengeStoreOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? 30_000;
    this.capacity = options.capacity ?? 256;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs >= MAX_SUPERVISION_INTEGER
      || !Number.isSafeInteger(this.capacity) || this.capacity <= 0) {
      throw new SupervisionProtocolError('malformed_message', 'challenge store bounds are invalid');
    }
  }

  issue(input: ChallengeIssue): PendingChallenge {
    const identity = requireIdentity({
      role: input.role,
      process_instance_id: input.process_instance_id,
      boot_nonce: input.boot_nonce,
    });
    const authority = validateAuthorityFields(input);
    const now = clockValue(this.clock);
    this.expire(now);
    if (this.pending.size >= this.capacity) {
      throw new SupervisionProtocolError('challenge_capacity', 'pending challenge capacity is exhausted');
    }
    if (now >= MAX_SUPERVISION_INTEGER - this.ttlMs) {
      throw new SupervisionProtocolError('malformed_message', 'challenge expiration is out of range');
    }
    const challenge = {
      protocol: SUPERVISION_PROTOCOL,
      kind: 'challenge' as const,
      direction: 'process-to-controller' as const,
      ...identity,
      ...authority,
      sequence: input.sequence,
      request_id: input.request_id,
      challenge_nonce: randomChallengeNonce(),
      expires_at: now + this.ttlMs,
    } satisfies PendingChallenge;
    validateUnsigned(challenge);
    this.pending.set(challenge.challenge_nonce, challenge);
    return challenge;
  }

  consume(attach: Pick<AttachMessage, 'challenge_nonce' | 'role' | 'process_instance_id' | 'boot_nonce'
    | 'controller_epoch' | 'controller_id'>): PendingChallenge {
    const challenge = this.peek(attach);
    this.consumePeeked(challenge);
    return challenge;
  }

  peek(attach: Pick<AttachMessage, 'challenge_nonce' | 'role' | 'process_instance_id' | 'boot_nonce'
    | 'controller_epoch' | 'controller_id'>): PendingChallenge {
    const nonce = validateChallengeNonce(attach.challenge_nonce);
    const now = clockValue(this.clock);
    this.expire(now);
    const challenge = this.pending.get(nonce);
    if (challenge === undefined) {
      const retired = this.retired.get(nonce);
      if (retired === 'expired') throw new SupervisionProtocolError('challenge_expired', 'challenge has expired');
      if (retired === 'replayed') throw new SupervisionProtocolError('challenge_replayed', 'challenge was already consumed');
      throw new SupervisionProtocolError('challenge_mismatch', 'challenge nonce is unknown');
    }
    if (challenge.role !== attach.role || challenge.process_instance_id !== attach.process_instance_id
      || challenge.boot_nonce !== attach.boot_nonce || challenge.controller_epoch !== attach.controller_epoch
      || challenge.controller_id !== attach.controller_id) {
      throw new SupervisionProtocolError('identity_mismatch', 'attach does not match challenge identity');
    }
    return challenge;
  }

  /** Commit only a challenge returned by peek; acceptAttach is the public transition. */
  consumePeeked(challenge: PendingChallenge): void {
    if (this.pending.get(challenge.challenge_nonce) !== challenge) {
      throw new SupervisionProtocolError('challenge_mismatch', 'challenge is no longer pending');
    }
    this.pending.delete(challenge.challenge_nonce);
    this.remember(challenge.challenge_nonce, 'replayed');
  }

  get size(): number {
    return this.pending.size;
  }

  private expire(now: number): void {
    for (const [nonce, challenge] of this.pending) {
      if (now >= challenge.expires_at) {
        this.pending.delete(nonce);
        this.remember(nonce, 'expired');
      }
    }
  }

  private remember(nonce: string, state: 'expired' | 'replayed'): void {
    this.retired.delete(nonce);
    this.retired.set(nonce, state);
    while (this.retired.size > this.capacity) {
      const oldest = this.retired.keys().next().value;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }
}

function validateChallengeNonce(value: string): string {
  if (typeof value !== 'string' || !CHALLENGE_NONCE.test(value)) malformed('challenge_nonce is invalid');
  return value;
}

function validateAuthorityFields(value: ControllerAuthority): ControllerAuthority {
  const input = value as unknown as PlainObject;
  return {
    controller_epoch: integerField(input, 'controller_epoch', 0),
    controller_id: uuidField(input, 'controller_id'),
  };
}

export function validateControllerAuthority(
  message: ControllerAuthority,
  current: ControllerAuthority | null,
): 'accepted' | 'idempotent' {
  const next = validateAuthorityFields(message);
  if (current !== null) {
    const previous = validateAuthorityFields(current);
    if (next.controller_epoch < previous.controller_epoch) {
      throw new SupervisionProtocolError('stale_controller', 'controller epoch is stale');
    }
    if (next.controller_epoch === previous.controller_epoch && next.controller_id !== previous.controller_id) {
      throw new SupervisionProtocolError('split_brain', 'controller epoch has multiple controller IDs');
    }
    if (next.controller_epoch === previous.controller_epoch) return 'idempotent';
  }
  return 'accepted';
}

function replayKey(message: Pick<SupervisionMessage, 'role' | 'process_instance_id' | 'boot_nonce'
  | 'controller_epoch' | 'controller_id' | 'direction'>): string {
  return [message.controller_epoch, message.controller_id, message.direction,
    message.role, message.process_instance_id, message.boot_nonce].join('\0');
}

export type SupervisionGuardSnapshot = {
  readonly authority: ControllerAuthority | null;
  readonly sequences: ReadonlyMap<string, number>;
};

/** Verifies status evidence without changing the process authority guard. */
export class SupervisionStatusReplayGuard {
  private authority: ControllerAuthority | null = null;
  private sequence = 0;

  accept(message: StatusMessage, expected: ControllerAuthority, requestId: string): void {
    if (message.controller_epoch !== expected.controller_epoch || message.controller_id !== expected.controller_id) {
      throw new SupervisionProtocolError('stale_controller', 'status authority does not match the expected authority');
    }
    if (message.request_id !== requestId) {
      throw new SupervisionProtocolError('status_correlation_mismatch', 'status response does not match its request');
    }
    if (this.authority === null || expected.controller_epoch > this.authority.controller_epoch) {
      this.authority = { ...expected };
      this.sequence = 0;
    } else {
      validateControllerAuthority(expected, this.authority);
    }
    if (message.sequence <= this.sequence) {
      throw new SupervisionProtocolError('sequence_replay', 'status sequence is not monotonic');
    }
    this.sequence = message.sequence;
  }
}

type GuardMessage = Pick<SupervisionMessage, 'kind' | 'role' | 'process_instance_id' | 'boot_nonce'
  | 'controller_epoch' | 'controller_id' | 'direction' | 'sequence'>;

type GuardTransition = {
  readonly authority: ControllerAuthority;
  readonly sequences: Map<string, number>;
};

/** Accept messages only after MAC verification; authority changes and sequence resets commit together. */
export class SupervisionAuthorityGuard {
  private authority: ControllerAuthority | null = null;
  private sequences = new Map<string, number>();

  accept(message: GuardMessage): void {
    if (message.kind === 'attach') malformed('attach must use acceptAttach');
    this.commit(this.prepare(message, false));
  }

  private prepareAttach(message: GuardMessage): GuardTransition {
    if (message.kind !== 'attach') malformed('only attach may advance controller authority');
    return this.prepare(message, true);
  }

  private prepare(message: GuardMessage, allowEpochAdvance: boolean): GuardTransition {
    if (!allowEpochAdvance) this.assertAuthority(message);
    else validateControllerAuthority(message, this.authority);
    const nextAuthority = { controller_epoch: message.controller_epoch, controller_id: message.controller_id };
    const switching = this.authority === null || message.controller_epoch > this.authority.controller_epoch;
    if (switching && !allowEpochAdvance) {
      throw new SupervisionProtocolError('unattached_controller', 'only attach may advance controller authority');
    }
    const nextSequences = switching ? new Map<string, number>() : new Map(this.sequences);
    const key = replayKey(message);
    const last = nextSequences.get(key);
    if (last !== undefined && message.sequence <= last) {
      throw new SupervisionProtocolError('sequence_replay', 'supervision sequence is not monotonic');
    }
    nextSequences.set(key, message.sequence);
    return { authority: nextAuthority, sequences: nextSequences };
  }

  private commit(transition: GuardTransition): void {
    this.authority = transition.authority;
    this.sequences = transition.sequences;
  }

  snapshot(): SupervisionGuardSnapshot {
    return { authority: this.authority, sequences: new Map(this.sequences) };
  }

  assertAuthority(message: ControllerAuthority): void {
    const result = validateControllerAuthority(message, this.authority);
    if (this.authority === null || message.controller_epoch > this.authority.controller_epoch) {
      throw new SupervisionProtocolError('unattached_controller', 'controller authority has not been attached');
    }
    void result;
  }

  acceptAttach(
    message: AttachMessage,
    credential: SupervisionProcessCredential,
    challenges: PendingChallengeStore,
  ): PendingChallenge {
    verifySupervisionMessage(message, credential);
    const challenge = challenges.peek(message);
    const transition = this.prepareAttach(message);
    challenges.consumePeeked(challenge);
    this.commit(transition);
    return challenge;
  }
}

/** The only attach transition: no await occurs between verification, peek, and commit. */
export function acceptAttach(
  message: AttachMessage,
  credential: SupervisionProcessCredential,
  challenges: PendingChallengeStore,
  authority: SupervisionAuthorityGuard,
): PendingChallenge {
  return authority.acceptAttach(message, credential, challenges);
}

export type CommandExecutionResult<Result> = {
  readonly kind: 'settled';
  readonly result_lookup_key: string;
  readonly result: Result;
};

type RequestRecord<Result> = {
  readonly epoch: number;
  readonly controller_id: string;
  readonly fingerprint: string;
  readonly result_lookup_key: string;
  readonly promise: Promise<CommandExecutionResult<Result>>;
};

export type SupervisionCommandGuardOptions = { readonly capacity?: number };

export class SupervisionCommandGuard {
  private readonly requests = new Map<string, RequestRecord<unknown>>();
  private readonly authority: SupervisionAuthorityGuard;
  private readonly capacity: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    authority: SupervisionAuthorityGuard = new SupervisionAuthorityGuard(),
    options: SupervisionCommandGuardOptions = {},
  ) {
    this.authority = authority;
    this.capacity = options.capacity ?? 256;
    if (!Number.isSafeInteger(this.capacity) || this.capacity <= 0) {
      throw new SupervisionProtocolError('malformed_message', 'command request capacity is invalid');
    }
  }

  execute<Result>(
    message: CommandEnvelope,
    resultLookupKey: string,
    action: () => Result | PromiseLike<Result>,
  ): Promise<CommandExecutionResult<Result>> {
    return this.executeInternal(message, resultLookupKey, action, false);
  }

  /** Shutdown is authenticated and replay-guarded, but must not wait for a mutating command. */
  executeShutdown<Result>(
    message: CommandEnvelope,
    resultLookupKey: string,
    action: () => Result | PromiseLike<Result>,
  ): Promise<CommandExecutionResult<Result>> {
    if (message.path !== '/shutdown') malformed('shutdown command path is invalid');
    return this.executeInternal(message, resultLookupKey, action, true);
  }

  private executeInternal<Result>(
    message: CommandEnvelope,
    resultLookupKey: string,
    action: () => Result | PromiseLike<Result>,
    bypassTail: boolean,
  ): Promise<CommandExecutionResult<Result>> {
    if (message.direction !== 'controller-to-process') malformed('controller command has wrong direction');
    if (typeof resultLookupKey !== 'string' || resultLookupKey.length === 0) malformed('result lookup key is invalid');
    this.authority.assertAuthority(message);
    this.clearOldEpochRequests();
    const key = requestKey(message);
    const fingerprint = commandFingerprint(message);
    const existing = this.requests.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new SupervisionProtocolError('request_replay', 'request_id was reused for another command');
      }
      return existing.promise as Promise<CommandExecutionResult<Result>>;
    }
    if (this.requests.size >= this.capacity) {
      throw new SupervisionProtocolError('request_capacity', 'command request capacity is exhausted');
    }
    this.authority.accept(message);
    let resolvePromise!: (result: CommandExecutionResult<Result>) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<CommandExecutionResult<Result>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.requests.set(key, {
      epoch: message.controller_epoch,
      controller_id: message.controller_id,
      fingerprint,
      result_lookup_key: resultLookupKey,
      promise: promise as Promise<CommandExecutionResult<unknown>>,
    });
    if (bypassTail) {
      let immediate: Result | PromiseLike<Result>;
      try {
        immediate = action();
      } catch (error) {
        rejectPromise(error);
        return promise;
      }
      void Promise.resolve(immediate).then(
        (result) => resolvePromise({ kind: 'settled', result_lookup_key: resultLookupKey, result }),
        rejectPromise,
      );
      return promise;
    }
    const operation = this.tail.then(action);
    this.tail = operation.then(() => undefined, () => undefined);
    void operation.then(
      (result) => resolvePromise({ kind: 'settled', result_lookup_key: resultLookupKey, result }),
      rejectPromise,
    );
    return promise;
  }

  executeStatus<Result>(
    message: StatusMessage,
    resultLookupKey: string,
    action: () => Result | PromiseLike<Result>,
  ): Promise<CommandExecutionResult<Result>> {
    if (message.direction !== 'process-to-controller' || message.status !== 'request') malformed('status request is invalid');
    this.authority.assertAuthority(message);
    this.clearOldEpochRequests();
    const key = requestKey(message);
    const fingerprint = canonicalJson({ status: message.status, body_hash: message.body_hash });
    const existing = this.requests.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new SupervisionProtocolError('request_replay', 'request_id was reused for another status request');
      return existing.promise as Promise<CommandExecutionResult<Result>>;
    }
    if (this.requests.size >= this.capacity) throw new SupervisionProtocolError('request_capacity', 'command request capacity is exhausted');
    this.authority.accept(message);
    let resolvePromise!: (result: CommandExecutionResult<Result>) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<CommandExecutionResult<Result>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.requests.set(key, {
      epoch: message.controller_epoch, controller_id: message.controller_id, fingerprint,
      result_lookup_key: resultLookupKey, promise: promise as Promise<CommandExecutionResult<unknown>>,
    });
    const operation = this.tail.then(action);
    this.tail = operation.then(() => undefined, () => undefined);
    void operation.then(
      (result) => resolvePromise({ kind: 'settled', result_lookup_key: resultLookupKey, result }),
      rejectPromise,
    );
    return promise;
  }

  /**
   * Read-only status work keeps the authority/sequence fence but deliberately
   * retains no replay result. Mutating commands must continue using execute().
   */
  executeStatusReadOnly<Result>(
    message: StatusMessage,
    action: () => Result | PromiseLike<Result>,
  ): Promise<Result> {
    if (message.direction !== 'process-to-controller' || message.status !== 'request') malformed('status request is invalid');
    this.authority.accept(message);
    const operation = this.tail.then(action);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private clearOldEpochRequests(): void {
    const authority = this.authority.snapshot().authority;
    if (authority === null) return;
    for (const [key, request] of this.requests) {
      if (request.epoch !== authority.controller_epoch || request.controller_id !== authority.controller_id) {
        this.requests.delete(key);
      }
    }
  }
}

function requestKey(message: Pick<CommandEnvelope, 'controller_epoch' | 'controller_id' | 'request_id'>): string {
  return `${message.controller_epoch}\0${message.controller_id}\0${message.request_id}`;
}

function commandFingerprint(message: CommandEnvelope): string {
  const { mac: _mac, sequence: _sequence, ...unsigned } = message;
  return canonicalJson(unsigned);
}

/** Contract: controller sends for each process and direction are serialized independently. */
export class SupervisionSendQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  enqueue<Result>(
    identity: ProcessIdentity,
    direction: SupervisionDirection,
    send: () => Result | PromiseLike<Result>,
  ): Promise<Result> {
    const checked = requireIdentity(identity);
    const key = `${direction}\0${checked.role}\0${checked.process_instance_id}\0${checked.boot_nonce}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const operation = previous.then(send);
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void operation.then(
      () => { if (this.tails.get(key) === tail) this.tails.delete(key); },
      () => { if (this.tails.get(key) === tail) this.tails.delete(key); },
    );
    return operation;
  }
}
