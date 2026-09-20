import { randomUUID } from 'node:crypto';
import type { Server } from 'bun';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import { parseConfigMasterMessage } from '../config-publication/master-messages';
import type {
  ConfigProcessIdentity,
  DrainWorkerCommand,
  StartWorkerCommand,
} from '../config-publication/types';
import type { ConfigWorkerRuntimeController, ConfigWorkerRuntimeMessage, ConfigWorkerRuntimeResult } from '../config-publication/worker-runtime-contract';
import {
  acceptAttach,
  hashSupervisionBody,
  PendingChallengeStore,
  parseSupervisionMessage,
  signSupervisionMessage,
  SupervisionAuthorityGuard,
  SupervisionCommandGuard,
  SupervisionProtocolError,
  verifySupervisionMessage,
  type AttachMessage,
  type CommandEnvelope,
  type ControllerAuthority,
  type PendingChallenge,
  type ProcessIdentity,
  type StatusMessage,
  type SupervisionMessage,
  type SupervisionProcessCredential,
} from './protocol';
import {
  normalizeWorkerRuntimeSnapshotBody,
  type WorkerRuntimeSnapshot,
  type WorkerRuntimeSnapshotInput,
  type WorkerRuntimeSnapshotProvider,
} from './worker-runtime-snapshot';
import {
  removeWorkerDescriptor,
  writeWorkerDescriptor,
  type WorkerDescriptorBody,
  type WorkerDescriptorFs,
  type WorkerDescriptorPhase,
  type WorkerDescriptorWriteOptions,
} from './worker-descriptor';
import { parseStrictJson } from './strict-json';

const DEFAULT_BODY_BYTES = 1_048_576;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_ATTACH_GRACE_MS = 5_000;
const DEFAULT_STARTUP_WATCHDOG_MS = 30_000;
const MAX_RUNTIME_RESPONSE_BYTES = 256 * 1024;

type PlainObject = Record<string, unknown>;
type WorkerServer = Pick<Server<unknown>, 'port' | 'stop'>;

export type WorkerStatusEvidence = {
  readonly kind: 'candidate' | 'ready' | 'apply-failed' | 'drained';
  readonly message?: ConfigWorkerRuntimeMessage;
};

export type WorkerStatusPayload = {
  readonly schema: 'bungee-worker-status-v1';
  readonly role: 'worker';
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
  readonly pid: number;
  readonly control_port: number;
  readonly master_control_port: number;
  readonly phase: WorkerDescriptorPhase;
  readonly frozen: boolean;
  readonly private_port: number | null;
  readonly revision: number | null;
  readonly content_hash: string | null;
  readonly plugin_catalog_hash: string | null;
  readonly started_at: number;
  readonly snapshot_hash: `sha256:${string}`;
  readonly authority: ControllerAuthority;
  readonly request_correlation: string;
  readonly replay: { readonly sequence: number; readonly request_id: string };
  readonly evidence: WorkerStatusEvidence;
};

export type WorkerSupervisionHttpServerOptions = {
  readonly credential: SupervisionProcessCredential;
  readonly identity: ConfigProcessIdentity;
  readonly runtime: ConfigWorkerRuntimeController;
  readonly controlPort?: number;
  readonly masterControlPort: number;
  readonly descriptorPath?: string;
  readonly descriptorFs?: WorkerDescriptorFs;
  readonly descriptorPlatform?: NodeJS.Platform | string;
  readonly clock?: () => number;
  readonly maxBodyBytes?: number;
  readonly bodyTimeoutMs?: number;
  readonly attachGraceMs?: number;
  readonly startupWatchdogMs?: number;
  readonly onStartupTimeout?: () => void | Promise<void>;
  readonly onShutdown?: () => void | Promise<void>;
  /** Injected synchronous provider; runtime state is never read by this transport. */
  readonly runtimeSnapshotProvider?: WorkerRuntimeSnapshotProvider;
};

export type WorkerControllerAuthorityListener = (authority: ControllerAuthority | null) => void;

function plain(value: unknown): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SupervisionProtocolError('malformed_message', 'worker supervision body must be a plain object');
  }
  return value as PlainObject;
}

function exact(value: PlainObject, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SupervisionProtocolError('malformed_message', 'worker supervision body has unexpected fields');
  }
}

function parseUniqueJson(text: string): unknown {
  return parseStrictJson(text);
}

async function readJson(request: Request, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void request.body?.cancel('body_too_large');
    throw new WorkerHttpError('body_too_large', 413);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WorkerHttpError('body_timeout', 408)), timeoutMs);
    });
    if (reader !== undefined) {
      while (true) {
        const result = await Promise.race([reader.read(), timeout]);
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          void reader.cancel('body_too_large');
          throw new WorkerHttpError('body_too_large', 413);
        }
        chunks.push(result.value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new WorkerHttpError('invalid_json', 400); }
  } catch (error) {
    if (error instanceof TypeError) throw new WorkerHttpError('invalid_json', 400);
    throw error;
  } finally {
    if (reader !== undefined) void reader.cancel();
    if (timer !== undefined) clearTimeout(timer);
  }
}

class WorkerHttpError extends Error {
  constructor(readonly code: 'body_too_large' | 'body_timeout' | 'invalid_json', readonly status: 400 | 408 | 413) {
    super(code);
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof WorkerHttpError) return Response.json({ error: error.code }, { status: error.status });
  if (error instanceof SupervisionProtocolError) {
    const status = error.code === 'invalid_mac' ? 401
      : error.code === 'identity_mismatch' ? 403
        : error.code === 'request_capacity' || error.code === 'challenge_capacity' ? 429
          : error.code === 'stale_controller' || error.code === 'split_brain' || error.code === 'sequence_replay'
            || error.code === 'request_replay' || error.code === 'unattached_controller'
              || error.code === 'ingress_frozen' || error.code === 'worker_frozen' || error.code === 'worker_not_ready'
                ? 409 : 400;
    return Response.json({ error: error.code }, { status });
  }
  return Response.json({ error: 'supervision_failure' }, { status: 500 });
}

function identityFromCredential(credential: SupervisionProcessCredential): ProcessIdentity {
  return Object.freeze({ ...credential.identity });
}

function sameIdentity(left: ConfigProcessIdentity, right: ConfigProcessIdentity): boolean {
  return left.master_generation === right.master_generation
    && left.worker_instance_id === right.worker_instance_id
    && left.worker_slot === right.worker_slot;
}

export class WorkerSupervisionHttpServer {
  readonly identity: ProcessIdentity;
  readonly challenges: PendingChallengeStore;
  readonly authority: SupervisionAuthorityGuard;
  readonly commands: SupervisionCommandGuard;
  private readonly credential: SupervisionProcessCredential;
  private readonly workerIdentity: ConfigProcessIdentity;
  private readonly runtime: ConfigWorkerRuntimeController;
  private readonly clock: () => number;
  private readonly maxBodyBytes: number;
  private readonly bodyTimeoutMs: number;
  private readonly attachGraceMs: number;
  private readonly startupWatchdogMs: number;
  private readonly descriptorPath?: string;
  private readonly descriptorWriteOptions: WorkerDescriptorWriteOptions;
  private readonly onStartupTimeout?: () => void | Promise<void>;
  private readonly onShutdown?: () => void | Promise<void>;
  private readonly runtimeSnapshotProvider?: WorkerRuntimeSnapshotProvider;
  private readonly authorityListeners = new Set<WorkerControllerAuthorityListener>();
  private controlPort: number;
  private readonly masterControlPort: number;
  private controlServer: WorkerServer | null = null;
  private phase: WorkerDescriptorPhase = 'candidate';
  private frozen = true;
  private leaseDeadline: number | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private statusSequence = 1;
  private startedAt: number;
  private privatePort: number | null = null;
  private revision: number | null = null;
  private contentHash: string | null = null;
  private pluginCatalogHash: string | null = null;
  private evidence: WorkerStatusEvidence = { kind: 'candidate' };
  private descriptorDirty = false;
  private publishedAuthority: ControllerAuthority | null = null;
  private terminating = false;

  constructor(options: WorkerSupervisionHttpServerOptions) {
    this.credential = options.credential;
    this.identity = identityFromCredential(options.credential);
    this.workerIdentity = { ...options.identity };
    this.runtime = options.runtime;
    this.controlPort = options.controlPort ?? 0;
    this.masterControlPort = options.masterControlPort;
    this.clock = options.clock ?? (() => Date.now());
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES;
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    this.attachGraceMs = options.attachGraceMs ?? DEFAULT_ATTACH_GRACE_MS;
    this.startupWatchdogMs = options.startupWatchdogMs ?? DEFAULT_STARTUP_WATCHDOG_MS;
    this.descriptorPath = options.descriptorPath;
    this.descriptorWriteOptions = { fs: options.descriptorFs, platform: options.descriptorPlatform };
    this.onStartupTimeout = options.onStartupTimeout;
    this.onShutdown = options.onShutdown;
    this.runtimeSnapshotProvider = options.runtimeSnapshotProvider;
    this.startedAt = this.now();
    this.challenges = new PendingChallengeStore({ clock: this.clock });
    this.authority = new SupervisionAuthorityGuard();
    this.commands = new SupervisionCommandGuard(this.authority);
    if (this.identity.role !== 'worker' || !sameIdentity(this.workerIdentity, {
      master_generation: this.workerIdentity.master_generation,
      worker_instance_id: this.identity.process_instance_id,
      worker_slot: this.workerIdentity.worker_slot,
    })) throw new SupervisionProtocolError('identity_mismatch', 'worker server identity is invalid');
    if (!Number.isSafeInteger(this.controlPort) || this.controlPort < 0 || this.controlPort > 65_535
      || !Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0
      || !Number.isSafeInteger(this.bodyTimeoutMs) || this.bodyTimeoutMs <= 0
      || !Number.isSafeInteger(this.attachGraceMs) || this.attachGraceMs <= 0
      || !Number.isSafeInteger(this.startupWatchdogMs) || this.startupWatchdogMs <= 0) {
      throw new SupervisionProtocolError('malformed_message', 'worker supervision bounds are invalid');
    }
    if (!Number.isSafeInteger(this.masterControlPort) || this.masterControlPort < 1 || this.masterControlPort > 65_535) {
      throw new SupervisionProtocolError('malformed_message', 'master control port is invalid');
    }
  }

  get port(): number { return this.controlPort; }
  get currentPhase(): WorkerDescriptorPhase { return this.phase; }
  isFrozen(): boolean { this.expireLease(); return this.frozen; }

  currentControllerAuthorityIfLeased(): ControllerAuthority | null {
    this.expireLease();
    const authority = this.leasedAuthority();
    return authority === null ? null : { ...authority };
  }

  subscribeControllerAuthority(listener: WorkerControllerAuthorityListener): () => void {
    this.authorityListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.authorityListeners.delete(listener);
    };
  }

  async listen(): Promise<number> {
    if (this.controlServer !== null) return this.controlPort;
    this.controlServer = Bun.serve({ hostname: '127.0.0.1', port: this.controlPort, reusePort: false, fetch: (request) => this.fetch(request) });
    const boundPort = this.controlServer.port;
    if (boundPort === undefined) throw new Error('worker supervision control port is unavailable');
    this.controlPort = boundPort;
    if (!Number.isSafeInteger(this.controlPort) || this.controlPort <= 0) throw new Error('worker supervision control port is invalid');
    try {
      await this.updateDescriptor();
    } catch (error) {
      try { await this.controlServer.stop(true); }
      finally {
        this.controlServer = null;
        if (this.descriptorPath !== undefined) await removeWorkerDescriptor(this.descriptorPath, this.descriptorWriteOptions);
      }
      throw error;
    }
    this.startupTimer = setTimeout(() => {
      if (this.phase === 'candidate') void Promise.resolve(this.onStartupTimeout?.()).catch(() => undefined);
    }, this.startupWatchdogMs);
    return this.controlPort;
  }

  async stop(): Promise<void> {
    this.terminating = true;
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
    this.startupTimer = null;
    this.leaseTimer = null;
    this.phase = 'stopped';
    this.frozen = true;
    this.leaseDeadline = null;
    this.publishAuthorityIfChanged();
    this.authorityListeners.clear();
    await this.refreshDescriptorBestEffort();
    try { if (this.controlServer !== null) await this.controlServer.stop(true); }
    finally {
      this.controlServer = null;
      if (this.descriptorPath !== undefined) await removeWorkerDescriptor(this.descriptorPath, this.descriptorWriteOptions);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.search !== '' || url.hash !== '') throw new SupervisionProtocolError('malformed_message', 'supervision path cannot contain query or fragment');
      if (url.pathname === '/__supervision/identity' && request.method === 'GET') return this.identityResponse();
      if (url.pathname === '/__supervision/status' && request.method === 'POST') return await this.statusRequest(request);
      if (url.pathname === '/__supervision/runtime' && request.method === 'POST') return await this.runtimeRequest(request);
      if (url.pathname === '/__supervision/challenge' && request.method === 'POST') return await this.challenge(request);
      if (url.pathname === '/__supervision/attach' && request.method === 'POST') return await this.attach(request);
      if (url.pathname === '/__supervision/lease' && request.method === 'POST') return await this.lease(request);
      if (url.pathname === '/__supervision/command' && request.method === 'POST') return await this.command(request);
      return Response.json({ error: 'not_found' }, { status: 404 });
    } catch (error) { return errorResponse(error); }
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new SupervisionProtocolError('malformed_message', 'worker clock is invalid');
    return value;
  }

  private identityResponse(): Response {
    return Response.json({ protocol: 'bungee-supervision-v1', role: 'worker', process_instance_id: this.identity.process_instance_id,
      boot_nonce: this.identity.boot_nonce, master_generation: this.workerIdentity.master_generation,
      worker_instance_id: this.workerIdentity.worker_instance_id, worker_slot: this.workerIdentity.worker_slot,
      control_port: this.controlPort });
  }

  private facts(): Omit<WorkerStatusPayload, 'snapshot_hash' | 'authority' | 'request_correlation' | 'replay' | 'evidence'> {
    return { schema: 'bungee-worker-status-v1', role: 'worker', ...this.workerIdentity,
      boot_nonce: this.identity.boot_nonce, pid: process.pid, control_port: this.controlPort,
      master_control_port: this.masterControlPort,
      phase: this.phase, frozen: this.isFrozen(), private_port: this.privatePort, revision: this.revision,
      content_hash: this.contentHash, plugin_catalog_hash: this.pluginCatalogHash, started_at: this.startedAt };
  }

  private async updateDescriptor(): Promise<void> {
    if (this.descriptorPath === undefined || this.controlPort <= 0) return;
    const facts = this.facts();
    const { schema: _schema, role: _role, ...descriptorFacts } = facts;
    const body: WorkerDescriptorBody = { schema: 'bungee-worker-descriptor-v1', role: 'worker', ...descriptorFacts, evidence: this.evidence };
    await writeWorkerDescriptor(this.descriptorPath, body, this.credential.process_key, this.descriptorWriteOptions);
    this.descriptorDirty = false;
  }

  private async refreshDescriptorBestEffort(): Promise<void> {
    try {
      await this.updateDescriptor();
    } catch {
      this.descriptorDirty = true;
    }
  }

  private signedStatus(authority: ControllerAuthority, requestId: string): { readonly message: SupervisionMessage; readonly body: WorkerStatusPayload } {
    const sequence = this.statusSequence++;
    const facts = this.facts();
    const bodyWithoutHash = { ...facts, authority, request_correlation: requestId, replay: { sequence, request_id: requestId }, evidence: this.evidence };
    const body = { ...bodyWithoutHash, snapshot_hash: hashSupervisionBody(bodyWithoutHash) } as WorkerStatusPayload;
    const message = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
      ...this.identity, ...authority, sequence, request_id: requestId, status: this.frozen ? 'frozen' : this.phase,
      body_hash: hashSupervisionBody(body) }, this.credential);
    return { message, body };
  }

  private statusResponse(authority: ControllerAuthority, requestId: string): Response {
    const signed = this.signedStatus(authority, requestId);
    return Response.json(signed);
  }

  private async statusRequest(request: Request): Promise<Response> {
    const message = parseSupervisionMessage(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs));
    if (message.kind !== 'status' || message.status !== 'request') throw new SupervisionProtocolError('malformed_message', 'status endpoint requires a status request');
    verifySupervisionMessage(message, this.credential);
    if (message.body_hash !== hashSupervisionBody(null)) throw new SupervisionProtocolError('malformed_message', 'status request body hash does not match');
    this.authority.assertAuthority(message);
    return this.statusResponse({ controller_epoch: message.controller_epoch, controller_id: message.controller_id }, message.request_id);
  }

  private runtimeSnapshotInput(): WorkerRuntimeSnapshotInput {
    if (this.phase !== 'serving' || this.isFrozen() || this.privatePort === null || this.revision === null
      || this.contentHash === null || this.pluginCatalogHash === null || this.runtimeSnapshotProvider === undefined) {
      throw new SupervisionProtocolError('worker_not_ready', 'worker runtime snapshot is unavailable');
    }
    return {
      ...this.workerIdentity,
      boot_nonce: this.identity.boot_nonce,
      pid: process.pid,
      private_port: this.privatePort,
      revision: this.revision,
      content_hash: this.contentHash,
      plugin_catalog_hash: this.pluginCatalogHash,
      captured_at: this.now(),
    };
  }

  private runtimeResponse(authority: ControllerAuthority, requestId: string): Response {
    const input = this.runtimeSnapshotInput();
    let body = this.runtimeSnapshotProvider!(input);
    const sign = (value: WorkerRuntimeSnapshot): { readonly message: SupervisionMessage; readonly body: WorkerRuntimeSnapshot } => ({
      message: signSupervisionMessage({
        protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
        ...this.identity, ...authority, sequence: this.statusSequence++, request_id: requestId,
        status: 'runtime', body_hash: hashSupervisionBody(value),
      }, this.credential),
      body: value,
    });
    let response = sign(body);
    let payload = JSON.stringify(response);
    if (Buffer.byteLength(payload, 'utf8') > MAX_RUNTIME_RESPONSE_BYTES) {
      body = normalizeWorkerRuntimeSnapshotBody({
        schema: 'bungee-worker-runtime-snapshot-v1', ...input,
        result: { kind: 'overflow', reason: 'payload_bytes', upstream_count: body.result.kind === 'complete'
          ? body.result.records.length : body.result.upstream_count },
      });
      response = sign(body);
      payload = JSON.stringify(response);
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_RUNTIME_RESPONSE_BYTES) {
      throw new SupervisionProtocolError('malformed_message', 'runtime snapshot response exceeds maximum size');
    }
    return new Response(payload, { headers: { 'content-type': 'application/json' } });
  }

  private async runtimeRequest(request: Request): Promise<Response> {
    const message = parseSupervisionMessage(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs));
    if (message.kind !== 'status' || message.status !== 'request') {
      throw new SupervisionProtocolError('malformed_message', 'runtime endpoint requires a status request');
    }
    verifySupervisionMessage(message, this.credential);
    if (message.body_hash !== hashSupervisionBody(null)) {
      throw new SupervisionProtocolError('malformed_message', 'runtime request body hash does not match');
    }
    this.runtimeSnapshotInput();
    return this.commands.executeStatusReadOnly(
      message as StatusMessage,
      () => this.runtimeResponse(
        { controller_epoch: message.controller_epoch, controller_id: message.controller_id },
        message.request_id,
      ),
    );
  }

  private async challenge(request: Request): Promise<Response> {
    const body = plain(snapshotJsonGraph(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs)));
    exact(body, ['controller_epoch', 'controller_id', 'request_id', 'sequence']);
    const pending = this.challenges.issue({ ...this.identity, controller_epoch: body.controller_epoch as number,
      controller_id: body.controller_id as string, request_id: body.request_id as string, sequence: body.sequence as number });
    return Response.json({ message: signSupervisionMessage(pending, this.credential) });
  }

  private async attach(request: Request): Promise<Response> {
    const message = parseSupervisionMessage(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs));
    if (message.kind !== 'attach') throw new SupervisionProtocolError('malformed_message', 'attach endpoint requires attach');
    verifySupervisionMessage(message, this.credential);
    if (this.terminating) throw new SupervisionProtocolError('worker_frozen', 'worker supervision is terminating');
    acceptAttach(message as AttachMessage, this.credential, this.challenges, this.authority);
    this.frozen = true;
    this.leaseDeadline = null;
    this.scheduleLease(this.now() + this.attachGraceMs);
    this.publishAuthorityIfChanged();
    await this.refreshDescriptorBestEffort();
    return this.statusResponse({ controller_epoch: message.controller_epoch, controller_id: message.controller_id }, message.request_id);
  }

  private async lease(request: Request): Promise<Response> {
    const message = parseSupervisionMessage(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs));
    if (message.kind !== 'lease') throw new SupervisionProtocolError('malformed_message', 'lease endpoint requires lease');
    verifySupervisionMessage(message, this.credential);
    if (this.terminating) throw new SupervisionProtocolError('worker_frozen', 'worker supervision is terminating');
    if (message.lease_expires_at <= this.now()) throw new SupervisionProtocolError('worker_frozen', 'lease is already expired');
    this.authority.accept(message);
    this.frozen = false;
    this.scheduleLease(message.lease_expires_at);
    this.publishAuthorityIfChanged();
    await this.refreshDescriptorBestEffort();
    return this.statusResponse({ controller_epoch: message.controller_epoch, controller_id: message.controller_id }, message.request_id);
  }

  private async command(request: Request): Promise<Response> {
    const root = plain(snapshotJsonGraph(await readJson(request, this.maxBodyBytes, this.bodyTimeoutMs)));
    exact(root, ['body', 'message']);
    const message = parseSupervisionMessage(root.message);
    if (message.kind !== 'command') throw new SupervisionProtocolError('malformed_message', 'command endpoint requires command');
    verifySupervisionMessage(message, this.credential);
    if (hashSupervisionBody(root.body) !== message.body_hash) throw new SupervisionProtocolError('malformed_message', 'command body hash does not match');
    const authority = { controller_epoch: message.controller_epoch, controller_id: message.controller_id };
    const execute = message.path === '/shutdown' ? this.commands.executeShutdown.bind(this.commands) : this.commands.execute.bind(this.commands);
    const result = await execute(message as CommandEnvelope, `worker:${message.request_id}`, async () => {
      if (message.path !== '/shutdown' && this.isFrozen()) throw new SupervisionProtocolError('worker_frozen', 'worker supervision is frozen');
      const commandResult = await this.executeCommand(message.path, root.body);
      this.evidence = commandResult.evidence;
      this.isFrozen();
      const response = this.signedStatus(authority, message.request_id);
      if (message.path === '/shutdown') {
        // The signed ACK is created before the callback can close the control listener.
        setTimeout(() => { void Promise.resolve(this.onShutdown?.()).catch(() => undefined); }, 0);
      } else {
        await this.refreshDescriptorBestEffort();
      }
      return response;
    });
    return Response.json(result.result);
  }

  private async executeCommand(path: string, value: unknown): Promise<{ readonly runtime?: ConfigWorkerRuntimeResult; readonly evidence: WorkerStatusEvidence }> {
    if (this.terminating && path !== '/shutdown') {
      throw new SupervisionProtocolError('worker_frozen', 'worker supervision is terminating');
    }
    if (path === '/start') {
      const parsed = parseConfigMasterMessage(value);
      if (!('command' in parsed) || (parsed.command !== 'start-config-worker' && parsed.command !== 'start-current-config-worker')) throw new SupervisionProtocolError('malformed_message', 'start requires a start worker command');
      if (!sameIdentity(parsed, this.workerIdentity)) throw new SupervisionProtocolError('identity_mismatch', 'start command worker identity does not match');
      const result = await this.runtime.apply(parsed);
      if (this.terminating) return { runtime: result, evidence: this.evidence };
      if (result.ok && result.message.status === 'config-ready') {
        this.phase = 'serving'; this.privatePort = result.message.private_port;
        this.revision = result.message.revision; this.contentHash = result.message.content_hash;
        this.pluginCatalogHash = result.message.plugin_catalog_hash;
        if (this.startupTimer !== null) clearTimeout(this.startupTimer);
        this.startupTimer = null;
        return { runtime: result, evidence: { kind: 'ready', message: result.message } };
      }
      return result.ok
        ? { runtime: result, evidence: { kind: 'apply-failed', message: result.message } }
        : { runtime: result, evidence: this.evidence };
    }
    if (path === '/drain') {
      const parsed = parseConfigMasterMessage(value);
      if (!('command' in parsed) || parsed.command !== 'drain-worker') throw new SupervisionProtocolError('malformed_message', 'drain requires a drain worker command');
      if (!sameIdentity(parsed, this.workerIdentity)) throw new SupervisionProtocolError('identity_mismatch', 'drain command worker identity does not match');
      this.phase = 'draining';
      const result = await this.runtime.apply(parsed);
      if (this.terminating) return { runtime: result, evidence: this.evidence };
      if (result.ok && result.message.status === 'worker-drained') return { runtime: result, evidence: { kind: 'drained', message: result.message } };
      return result.ok
        ? { runtime: result, evidence: { kind: 'apply-failed', message: result.message } }
        : { runtime: result, evidence: this.evidence };
    }
    if (path === '/shutdown') {
      const body = plain(value); exact(body, []);
      this.terminating = true;
      this.phase = 'stopped';
      if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
      this.leaseTimer = null;
      this.leaseDeadline = null;
      this.frozen = true;
      this.publishAuthorityIfChanged();
      return { evidence: this.evidence };
    }
    throw new SupervisionProtocolError('malformed_message', 'unknown worker command path');
  }

  private scheduleLease(deadline: number): void {
    if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
    this.leaseDeadline = deadline;
    const delay = Math.max(0, Math.min(deadline - this.now(), 2_147_483_647));
    this.leaseTimer = setTimeout(() => this.expireLease(), delay);
  }

  private expireLease(): void {
    if (this.leaseDeadline === null) return;
    if (this.now() < this.leaseDeadline) {
      this.scheduleLease(this.leaseDeadline);
      return;
    }
    this.leaseDeadline = null;
    this.leaseTimer = null;
    this.frozen = true;
    this.publishAuthorityIfChanged();
    void this.refreshDescriptorBestEffort().catch(() => undefined);
  }

  private leasedAuthority(): ControllerAuthority | null {
    const authority = this.authority.snapshot().authority;
    return this.phase === 'stopped' || this.frozen || this.leaseDeadline === null || authority === null || this.now() >= this.leaseDeadline
      ? null : { ...authority };
  }

  private publishAuthorityIfChanged(): void {
    const next = this.leasedAuthority();
    const previous = this.publishedAuthority;
    if (previous === null ? next === null : next !== null
      && previous.controller_epoch === next.controller_epoch && previous.controller_id === next.controller_id) return;
    this.publishedAuthority = next === null ? null : { ...next };
    for (const listener of [...this.authorityListeners]) {
      try { listener(next === null ? null : { ...next }); } catch { /* observers cannot affect supervision */ }
    }
  }
}
