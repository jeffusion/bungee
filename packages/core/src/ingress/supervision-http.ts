import { randomUUID } from 'node:crypto';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import {
  acceptAttach,
  hashSupervisionBody,
  importSupervisionCredential,
  PendingChallengeStore,
  parseSupervisionMessage,
  signSupervisionMessage,
  SupervisionAuthorityGuard,
  SupervisionCommandGuard,
  SupervisionProtocolError,
  SupervisionStatusReplayGuard,
  verifySupervisionMessage,
  type AttachMessage,
  type CommandEnvelope,
  type ControllerAuthority,
  type PendingChallenge,
  type ProcessIdentity,
  type SupervisionMessage,
  type SupervisionProcessCredential,
  type StatusMessage,
} from '../supervision';
import { AdmissionRegistryError, IngressAdmissionRegistry, type AdmissionRegistryStatus } from './admission-registry';
import { AdmissionSetError } from './admission-set';
import { parseAdmissionSet, type AdmissionSet } from './admission-set';

const ZERO_CONTROLLER_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_BODY_BYTES = 1_048_576;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 20;

type PlainObject = Record<string, unknown>;

export type IngressSupervisionServerOptions = {
  readonly credential: SupervisionProcessCredential;
  readonly registry: IngressAdmissionRegistry;
  readonly challenges?: PendingChallengeStore;
  readonly authority?: SupervisionAuthorityGuard;
  readonly commands?: SupervisionCommandGuard;
  readonly clock?: () => number;
  readonly maxBodyBytes?: number;
  readonly bodyTimeoutMs?: number;
  readonly attachGraceMs?: number;
  readonly onShutdown?: () => Promise<void> | void;
};

export type IngressStatusPayload = {
  readonly state: 'frozen' | 'attached';
  readonly registry: AdmissionRegistryStatus;
};

function optionalAdmission(value: unknown): AdmissionSet | null {
  return value === null ? null : parseAdmissionSet(value);
}

export function parseIngressStatusPayload(value: unknown): IngressStatusPayload {
  const root = plain(value);
  exact(root, ['registry', 'state']);
  if (root.state !== 'frozen' && root.state !== 'attached') {
    throw new SupervisionProtocolError('malformed_message', 'ingress status state is invalid');
  }
  const registry = plain(root.registry);
  exact(registry, ['active', 'prepared', 'retired']);
  if (!Array.isArray(registry.retired)) throw new SupervisionProtocolError('malformed_message', 'retired is invalid');
  return Object.freeze({
    state: root.state,
    registry: Object.freeze({
      active: optionalAdmission(registry.active),
      prepared: optionalAdmission(registry.prepared),
      retired: Object.freeze(registry.retired.map((item) => parseAdmissionSet(item))),
    }),
  });
}

export class IngressHttpError extends Error {
  readonly name = 'IngressHttpError';
  constructor(readonly code: 'body_too_large' | 'body_timeout' | 'invalid_json', readonly status: 400 | 408 | 413) {
    super(code);
  }
}

export class IngressDiscoveryError extends Error {
  readonly name = 'IngressDiscoveryError';

  constructor(readonly code: 'unavailable' | 'outcome_unknown', message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

function isConnectionRefused(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return false;
  seen.add(value);
  const candidate = value as { readonly code?: unknown; readonly cause?: unknown };
  return candidate.code === 'ConnectionRefused'
    || candidate.code === 'ECONNREFUSED'
    || candidate.code === 'ERR_CONNECTION_REFUSED'
    || isConnectionRefused(candidate.cause, seen);
}

export async function discoverIngressIdentity(
  baseUrl: string,
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new IngressDiscoveryError('outcome_unknown', 'ingress identity discovery timeout is invalid');
  }
  const controller = new AbortController();
  let rejectParent!: (reason: unknown) => void;
  const parentAbort = new Promise<never>((_, reject) => { rejectParent = reject; });
  const abortParent = (): void => {
    controller.abort(parentSignal?.reason);
    rejectParent(parentSignal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  };
  if (parentSignal?.aborted) abortParent();
  else parentSignal?.addEventListener('abort', abortParent, { once: true });
  let timedOut = false;
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<{ readonly response: Response; readonly body: unknown }>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new Error('identity discovery timed out'));
  }, timeoutMs);
  try {
    let response: Response;
    let responseBody: unknown;
    try {
      const result = await Promise.race([
        (async () => {
          const fetched = await send(new URL('/__supervision/identity', baseUrl), { method: 'GET', signal: controller.signal });
          return { response: fetched, body: await fetched.json() as unknown };
        })(),
        timeout,
        parentAbort,
      ]);
      response = result.response;
      responseBody = result.body;
    } catch (cause) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (timedOut || controller.signal.aborted) {
        throw new IngressDiscoveryError('outcome_unknown', 'ingress identity discovery timed out', { cause });
      }
      if (isConnectionRefused(cause)) {
        throw new IngressDiscoveryError('unavailable', 'ingress control endpoint is not listening', { cause });
      }
      throw new IngressDiscoveryError('outcome_unknown', 'ingress identity discovery failed', { cause });
    }
    if (!response.ok) throw new SupervisionProtocolError('identity_mismatch', 'ingress identity discovery was rejected');
    try {
      const value = plain(responseBody);
      exact(value, ['boot_nonce', 'process_instance_id', 'protocol', 'role']);
      if (value.protocol !== 'bungee-supervision-v1' || value.role !== 'ingress'
        || typeof value.process_instance_id !== 'string' || typeof value.boot_nonce !== 'string') {
        throw new Error('invalid ingress discovery identity');
      }
      return {
        role: 'ingress',
        process_instance_id: value.process_instance_id,
        boot_nonce: value.boot_nonce,
      };
    } catch (cause) {
      if (cause instanceof SupervisionProtocolError && cause.code === 'identity_mismatch') throw cause;
      throw new SupervisionProtocolError('identity_mismatch', 'ingress discovery identity is invalid', { cause });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    parentSignal?.removeEventListener('abort', abortParent);
  }
}

function plain(value: unknown): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SupervisionProtocolError('malformed_message', 'supervision HTTP body must be a plain object');
  }
  return value as PlainObject;
}

function exact(value: PlainObject, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SupervisionProtocolError('malformed_message', 'supervision HTTP body has unexpected fields');
  }
}

async function readJson(request: Request, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void request.body?.cancel('body_too_large');
    throw new IngressHttpError('body_too_large', 413);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new IngressHttpError('body_timeout', 408)), timeoutMs);
    });
    if (reader !== undefined) {
      while (true) {
        const result = await Promise.race([reader.read(), timeout]);
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          void reader.cancel('body_too_large');
          throw new IngressHttpError('body_too_large', 413);
        }
        chunks.push(result.value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new IngressHttpError('invalid_json', 400);
    }
  } catch (error) {
    if (error instanceof TypeError) throw new IngressHttpError('invalid_json', 400);
    throw error;
  } finally {
    if (reader !== undefined) void reader.cancel();
    if (timer !== undefined) clearTimeout(timer);
  }
}

function now(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SupervisionProtocolError('malformed_message', 'ingress clock is invalid');
  }
  return value;
}

function errorResponse(error: unknown): Response {
  if (error instanceof IngressHttpError) return Response.json({ error: error.code }, { status: error.status });
  if (error instanceof SupervisionProtocolError) {
    const status = error.code === 'invalid_mac' ? 401 : error.code === 'identity_mismatch' ? 403
      : error.code === 'request_capacity' || error.code === 'challenge_capacity' ? 429
        : error.code === 'stale_controller' || error.code === 'split_brain' || error.code === 'sequence_replay'
          || error.code === 'request_replay' || error.code === 'unattached_controller' || error.code === 'ingress_frozen'
          ? 409 : 400;
    return Response.json({ error: error.code }, { status });
  }
  if (error instanceof AdmissionRegistryError) {
    const status = error.code === 'missing' || error.code === 'frozen' ? 409
      : error.code === 'capacity' ? 429 : 400;
    return Response.json({ error: `admission_${error.code}` }, { status });
  }
  if (error instanceof AdmissionSetError) return Response.json({ error: `admission_set_${error.code}` }, { status: 400 });
  return Response.json({ error: 'supervision_failure' }, { status: 500 });
}

function publicIdentity(credential: SupervisionProcessCredential): ProcessIdentity {
  return Object.freeze({ ...credential.identity });
}

export class IngressSupervisionHttpServer {
  readonly identity: ProcessIdentity;
  readonly challenges: PendingChallengeStore;
  readonly authority: SupervisionAuthorityGuard;
  readonly commands: SupervisionCommandGuard;
  private readonly credential: SupervisionProcessCredential;
  private readonly registry: IngressAdmissionRegistry;
  private readonly clock: () => number;
  private readonly maxBodyBytes: number;
  private readonly bodyTimeoutMs: number;
  private readonly attachGraceMs: number;
  private readonly onShutdown?: () => Promise<void> | void;
  private leaseExpiresAt: number | null = null;
  private attached = false;
  private frozen = true;
  private deadline: number | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private statusSequence = 1;

  constructor(options: IngressSupervisionServerOptions) {
    this.credential = options.credential;
    this.identity = publicIdentity(options.credential);
    if (this.identity.role !== 'ingress') {
      throw new SupervisionProtocolError('identity_mismatch', 'ingress server requires an ingress credential');
    }
    this.registry = options.registry;
    this.challenges = options.challenges ?? new PendingChallengeStore();
    this.authority = options.authority ?? new SupervisionAuthorityGuard();
    this.commands = options.commands ?? new SupervisionCommandGuard(this.authority);
    this.clock = options.clock ?? (() => Date.now());
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES;
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    this.attachGraceMs = options.attachGraceMs ?? 5_000;
    this.onShutdown = options.onShutdown;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0
      || !Number.isSafeInteger(this.bodyTimeoutMs) || this.bodyTimeoutMs <= 0
      || !Number.isSafeInteger(this.attachGraceMs) || this.attachGraceMs <= 0) {
      throw new SupervisionProtocolError('malformed_message', 'supervision HTTP bounds are invalid');
    }
    this.registry.setFrozen(true);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.search !== '' || url.hash !== '') {
        throw new SupervisionProtocolError('malformed_message', 'supervision path cannot contain query or fragment');
      }
      if (url.pathname === '/__supervision/identity' && request.method === 'GET') return this.identityResponse();
      if (url.pathname === '/__supervision/status' && request.method === 'POST') return await this.statusRequest(request);
      if (url.pathname === '/__supervision/challenge' && request.method === 'POST') return await this.challenge(request);
      if (url.pathname === '/__supervision/attach' && request.method === 'POST') return await this.attach(request);
      if (url.pathname === '/__supervision/lease' && request.method === 'POST') return await this.lease(request);
      if (url.pathname === '/__supervision/command' && request.method === 'POST') return await this.command(request);
      return Response.json({ error: 'not_found' }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }

  isFrozen(): boolean {
    if (this.deadline !== null && now(this.clock) >= this.deadline) this.freezeAt(this.deadline);
    return this.frozen;
  }

  stop(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.deadline = null;
  }

  private freezeAt(deadline: number): void {
    if (this.deadline !== deadline) return;
    this.frozen = true;
    this.deadline = null;
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.registry.setFrozen(true);
  }

  private scheduleDeadline(deadline: number): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadline = deadline;
    const delay = Math.max(0, Math.min(deadline - now(this.clock), 2_147_483_647));
    this.deadlineTimer = setTimeout(() => {
      if (this.deadline !== deadline) return;
      if (now(this.clock) < deadline) this.scheduleDeadline(deadline);
      else this.freezeAt(deadline);
    }, delay);
  }

  private identityResponse(): Response {
    return Response.json({
      protocol: 'bungee-supervision-v1',
      role: this.identity.role,
      process_instance_id: this.identity.process_instance_id,
      boot_nonce: this.identity.boot_nonce,
    });
  }

  private signedStatus(payload: IngressStatusPayload, requestId: string, authority: ControllerAuthority): SupervisionMessage {
    const unsigned = {
      protocol: 'bungee-supervision-v1' as const,
      kind: 'status' as const,
      direction: 'process-to-controller' as const,
      ...this.identity,
      ...authority,
      sequence: this.statusSequence,
      request_id: requestId,
      status: payload.state,
      body_hash: hashSupervisionBody(payload),
    };
    this.statusSequence += 1;
    return signSupervisionMessage(unsigned, this.credential);
  }

  private statusResponse(requestId: string, authority: ControllerAuthority): Response {
    const frozen = this.isFrozen();
    const payload: IngressStatusPayload = {
      state: frozen ? 'frozen' : 'attached',
      registry: this.registry.status(),
    };
    return Response.json({
      message: this.signedStatus(payload, requestId, authority),
      body: payload,
    });
  }

  private async statusRequest(request: Request): Promise<Response> {
    const message = parseSupervisionMessage(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs));
    if (message.kind !== 'status' || message.status !== 'request') {
      throw new SupervisionProtocolError('malformed_message', 'status endpoint requires a status request');
    }
    verifySupervisionMessage(message, this.credential);
    if (hashSupervisionBody(null) !== message.body_hash) {
      throw new SupervisionProtocolError('malformed_message', 'status request body hash does not match');
    }
    const result = await this.commands.executeStatus(message as StatusMessage, `status:${message.request_id}`, () => this.statusResponse(message.request_id, {
      controller_epoch: message.controller_epoch,
      controller_id: message.controller_id,
    }));
    return result.result;
  }

  private async challenge(request: Request): Promise<Response> {
    const body = plain(snapshotJsonGraph(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs)));
    exact(body, ['controller_epoch', 'controller_id', 'request_id', 'sequence']);
    const pending = this.challenges.issue({
      ...this.identity,
      controller_epoch: body.controller_epoch as number,
      controller_id: body.controller_id as string,
      request_id: body.request_id as string,
      sequence: body.sequence as number,
    });
    return Response.json({ message: signSupervisionMessage(pending, this.credential) });
  }

  private async attach(request: Request): Promise<Response> {
    const message = parseSupervisionMessage(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs));
    if (message.kind !== 'attach') throw new SupervisionProtocolError('malformed_message', 'attach endpoint requires attach');
    verifySupervisionMessage(message, this.credential);
    const attachedAt = now(this.clock);
    if (attachedAt >= Number.MAX_SAFE_INTEGER - this.attachGraceMs) {
      throw new SupervisionProtocolError('malformed_message', 'attach grace deadline is out of range');
    }
    acceptAttach(message as AttachMessage, this.credential, this.challenges, this.authority);
    this.attached = true;
    this.frozen = true;
    this.leaseExpiresAt = null;
    this.registry.setFrozen(true);
    this.scheduleDeadline(attachedAt + this.attachGraceMs);
    return this.statusResponse(message.request_id, {
      controller_epoch: message.controller_epoch,
      controller_id: message.controller_id,
    });
  }

  private async lease(request: Request): Promise<Response> {
    const message = parseSupervisionMessage(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs));
    if (message.kind !== 'lease') throw new SupervisionProtocolError('malformed_message', 'lease endpoint requires lease');
    verifySupervisionMessage(message, this.credential);
    const expiry = message.lease_expires_at;
    if (expiry <= now(this.clock)) throw new SupervisionProtocolError('ingress_frozen', 'lease is already expired');
    this.authority.accept(message);
    this.frozen = false;
    this.registry.setFrozen(false);
    this.leaseExpiresAt = expiry;
    this.scheduleDeadline(expiry);
    return this.statusResponse(message.request_id, {
      controller_epoch: message.controller_epoch,
      controller_id: message.controller_id,
    });
  }

  private async command(request: Request): Promise<Response> {
    const body = plain(snapshotJsonGraph(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs)));
    exact(body, ['body', 'message']);
    const message = parseSupervisionMessage(body.message);
    if (message.kind !== 'command') throw new SupervisionProtocolError('malformed_message', 'command endpoint requires command');
    verifySupervisionMessage(message, this.credential);
    if (hashSupervisionBody(body.body) !== message.body_hash) {
      throw new SupervisionProtocolError('malformed_message', 'command body hash does not match');
    }
    if (this.isFrozen()) throw new SupervisionProtocolError('ingress_frozen', 'ingress admission is frozen');
    const result = await this.commands.execute(message as CommandEnvelope, `command:${message.request_id}`, async () => {
      const commandBody = body.body;
      if (message.method !== 'POST') throw new SupervisionProtocolError('malformed_message', 'ingress mutation must use POST');
      if (message.path === '/__supervision/prepare' || message.path === '/prepare') {
        this.registry.prepare(commandBody);
        return { operation: 'prepared', status: this.registry.status() };
      }
      if (message.path === '/__supervision/commit' || message.path === '/commit') {
        this.registry.commit(commandBody);
        return { operation: 'committed', status: this.registry.status() };
      }
      if (message.path === '/__supervision/abort' || message.path === '/abort') {
        this.registry.abort(commandBody);
        return { operation: 'aborted', status: this.registry.status() };
      }
      if (message.path === '/__supervision/release-retired' || message.path === '/release-retired') {
        this.registry.releaseRetired(commandBody);
        return { operation: 'retired-released', status: this.registry.status() };
      }
      if (message.path === '/__supervision/admission/fence' || message.path === '/admission/fence'
        || message.path === '/fence') {
        if (commandBody !== null) throw new SupervisionProtocolError('malformed_message', 'admission fence body must be null');
        return { operation: 'admission-fenced', status: this.registry.status() };
      }
      if (message.path === '/__supervision/shutdown' || message.path === '/shutdown') {
        return { operation: 'shutdown-accepted' };
      }
      throw new SupervisionProtocolError('malformed_message', 'unknown ingress command path');
    });
    if (message.path === '/__supervision/admission/fence' || message.path === '/admission/fence'
      || message.path === '/fence') {
      const fenced = result.result as { readonly status: AdmissionRegistryStatus };
      const payload: IngressStatusPayload = { state: this.isFrozen() ? 'frozen' : 'attached', registry: fenced.status };
      return Response.json({
        message: this.signedStatus(payload, message.request_id, {
          controller_epoch: message.controller_epoch, controller_id: message.controller_id,
        }),
        body: payload,
      });
    }
    const response = Response.json(result);
    if (message.path === '/__supervision/shutdown' || message.path === '/shutdown') {
      setTimeout(() => { void Promise.resolve(this.onShutdown?.()).catch(() => undefined); }, 0);
    }
    return response;
  }
}

export type IngressControllerClientOptions = {
  readonly baseUrl: string;
  readonly credential: SupervisionProcessCredential;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
};

function cancelResponseBody(response: Response): void {
  if (response.body === null) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // The body may already be locked or consumed.
  }
}

export class IngressControllerClient {
  private readonly send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly statusReplay = new SupervisionStatusReplayGuard();
  private statusRequestSequence = 1;

  constructor(private readonly options: IngressControllerClientOptions) {
    this.send = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async identity(signal?: AbortSignal): Promise<ProcessIdentity> {
    const value = await discoverIngressIdentity(this.options.baseUrl, this.send, this.timeoutMs, signal);
    if (signal?.aborted) throw signal.reason;
    if (value.role !== this.options.credential.identity.role
      || value.process_instance_id !== this.options.credential.identity.process_instance_id
      || value.boot_nonce !== this.options.credential.identity.boot_nonce) {
      throw new SupervisionProtocolError('identity_mismatch', 'ingress discovery identity is not expected');
    }
    return value;
  }

  async challenge(authority: ControllerAuthority, requestId = randomUUID(), sequence = 1, signal?: AbortSignal): Promise<PendingChallenge> {
    if (signal?.aborted) throw signal.reason;
    this.statusRequestSequence = Math.max(this.statusRequestSequence, sequence + 1);
    const body = await this.post('/__supervision/challenge', { ...authority, request_id: requestId, sequence }, signal);
    if (signal?.aborted) throw signal.reason;
    const message = this.verifyEnvelope(body);
    if (message.kind !== 'challenge') throw new SupervisionProtocolError('malformed_message', 'challenge response is invalid');
    return message;
  }

  async status(authority: ControllerAuthority, sequence = this.statusRequestSequence, signal?: AbortSignal): Promise<IngressStatusPayload> {
    if (signal?.aborted) throw signal.reason;
    const requestId = randomUUID();
    const message = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
      ...this.options.credential.identity, ...authority, sequence,
      request_id: requestId, status: 'request', body_hash: hashSupervisionBody(null),
    }, this.options.credential);
    this.statusRequestSequence = Math.max(this.statusRequestSequence, sequence + 1);
    const response = await this.post('/__supervision/status', message, signal);
    if (signal?.aborted) throw signal.reason;
    return this.verifyStatus(response, authority, requestId);
  }

  async fence(authority: ControllerAuthority, sequence: number, requestId = randomUUID(), signal?: AbortSignal): Promise<IngressStatusPayload> {
    const response = await this.command(authority, sequence, '/admission/fence', null, requestId, signal);
    if (signal?.aborted) throw signal.reason;
    return this.verifyStatus(response, authority, requestId);
  }

  async attach(challenge: PendingChallenge, authority: ControllerAuthority, sequence = 1, requestId = randomUUID(), signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    this.statusRequestSequence = Math.max(this.statusRequestSequence, sequence + 1);
    const message = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process',
      ...this.options.credential.identity, ...authority, sequence, request_id: requestId,
      challenge_nonce: challenge.challenge_nonce,
    }, this.options.credential);
    const response = await this.post('/__supervision/attach', message, signal);
    if (signal?.aborted) throw signal.reason;
    return this.verifyStatus(response, authority, requestId);
  }

  async lease(authority: ControllerAuthority, leaseExpiresAt: number, sequence: number, requestId = randomUUID(), signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    this.statusRequestSequence = Math.max(this.statusRequestSequence, sequence + 1);
    const message = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'lease', direction: 'controller-to-process',
      ...this.options.credential.identity, ...authority, sequence, request_id: requestId,
      lease_expires_at: leaseExpiresAt,
    }, this.options.credential);
    const response = await this.post('/__supervision/lease', message, signal);
    if (signal?.aborted) throw signal.reason;
    return this.verifyStatus(response, authority, requestId);
  }

  async command(authority: ControllerAuthority, sequence: number, path: string, body: unknown, requestId = randomUUID(), signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    this.statusRequestSequence = Math.max(this.statusRequestSequence, sequence + 1);
    const message = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process',
      ...this.options.credential.identity, ...authority, sequence, request_id: requestId,
      method: 'POST', path, body_hash: hashSupervisionBody(body),
    }, this.options.credential);
    const response = await this.post('/__supervision/command', { message, body }, signal);
    if (signal?.aborted) throw signal.reason;
    return response;
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'GET' }, signal);
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal);
  }

  private async request(path: string, init: RequestInit, parentSignal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const signals = [parentSignal, init.signal].filter((candidate): candidate is AbortSignal => candidate !== undefined);
    const abortSignal = (signal: AbortSignal): void => controller.abort(signal.reason);
    let cancelledRequest = false;
    const abortListeners: Array<{ readonly signal: AbortSignal; readonly listener: () => void }> = [];
    const cancellationListeners: Array<{ readonly signal: AbortSignal; readonly listener: () => void }> = [];
    for (const signal of signals) {
      const listener = (): void => {
        cancelledRequest = true;
        abortSignal(signal);
        if (response !== undefined) cancelResponseBody(response);
      };
      abortListeners.push({ signal, listener });
      if (signal.aborted) listener();
      else signal.addEventListener('abort', listener, { once: true });
    }
    const deadlineAt = Date.now() + this.timeoutMs;
    const timeoutCause = new DOMException('The operation timed out', 'TimeoutError');
    let timedOut = false;
    let response: Response | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutCause);
        if (response !== undefined) cancelResponseBody(response);
        reject(timeoutCause);
      }, Math.max(0, deadlineAt - Date.now()));
    });
    const cancelled = new Promise<never>((_, reject) => {
      const cancel = (): void => reject(parentSignal?.reason ?? init.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      cancellationListeners.push(...signals.map((signal) => ({ signal, listener: cancel })));
      for (const signal of signals) {
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      }
    });

    try {
      const send = Promise.resolve().then(() => this.send(new URL(path, this.options.baseUrl), { ...init, signal: controller.signal }));
      const sendWithCleanup = send.then((candidate) => {
        if (timedOut || cancelledRequest) cancelResponseBody(candidate);
        return candidate;
      });
      try {
        response = await Promise.race([sendWithCleanup, deadline, cancelled]);
      } catch (cause) {
        throw new Error('supervision HTTP request failed', { cause });
      }

      const json = Promise.resolve().then(() => response!.json() as Promise<unknown>);
      let body: unknown;
      try {
        body = await Promise.race([json, deadline, cancelled]);
      } catch (cause) {
        if (timedOut) throw new Error('supervision HTTP request failed', { cause });
        throw cause;
      }

      if (!response.ok) {
        const error = plain(body).error;
        throw new SupervisionProtocolError(
          typeof error === 'string' ? error as never : 'malformed_message',
          `supervision HTTP request was rejected: ${typeof error === 'string' ? error : 'unknown error'}`,
        );
      }
      return body;
    } finally {
      clearTimeout(timeoutTimer!);
      for (const { signal, listener } of abortListeners) signal.removeEventListener('abort', listener);
      for (const { signal, listener } of cancellationListeners) signal.removeEventListener('abort', listener);
    }
  }

  private verifyEnvelope(value: unknown): SupervisionMessage {
    const root = plain(value);
    exact(root, ['message']);
    const message = parseSupervisionMessage(root.message);
    verifySupervisionMessage(message, this.options.credential);
    return message;
  }

  private verifyStatus(value: unknown, authority: ControllerAuthority, requestId: string): IngressStatusPayload {
    const root = plain(value);
    exact(root, ['body', 'message']);
    const message = parseSupervisionMessage(root.message);
    if (message.kind !== 'status') throw new SupervisionProtocolError('malformed_message', 'status response is invalid');
    verifySupervisionMessage(message, this.options.credential);
    if (hashSupervisionBody(root.body) !== message.body_hash) {
      throw new SupervisionProtocolError('malformed_message', 'status body hash does not match');
    }
    const payload = parseIngressStatusPayload(root.body);
    if (message.status !== payload.state) throw new SupervisionProtocolError('malformed_message', 'status payload disagrees with status message');
    this.statusReplay.accept(message as StatusMessage, authority, requestId);
    return payload;
  }
}

export function credentialFromSerialized(value: string): SupervisionProcessCredential {
  return importSupervisionCredential(value);
}
