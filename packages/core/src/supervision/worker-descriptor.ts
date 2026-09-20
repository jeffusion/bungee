import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import { canonicalJson } from '../config-storage/content-hash';
import { validateDigest } from '../config-storage/repository-validation';
import { isLowercaseUuid } from '../config-storage/validation';
import { parseConfigWorkerMessage } from '../config-publication/worker-messages';
import type { ConfigWorkerRuntimeMessage } from '../config-publication/worker-runtime-contract';
import type { SupervisionMac, SupervisionProcessCredential } from './protocol';
import { SupervisionProtocolError } from './protocol';

export type WorkerDescriptorPhase = 'candidate' | 'serving' | 'draining' | 'stopped';

export type WorkerDescriptorEvidence = {
  readonly kind: 'candidate' | 'ready' | 'apply-failed' | 'drained';
  readonly message?: ConfigWorkerRuntimeMessage;
};

export type WorkerDescriptorBody = {
  readonly schema: 'bungee-worker-descriptor-v1';
  readonly role: 'worker';
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
  /** Diagnostic only. Discovery requires descriptor PID === online signed status PID, never AdmissionSet PID. */
  readonly pid: number;
  readonly control_port: number;
  readonly master_control_port?: number;
  readonly phase: WorkerDescriptorPhase;
  readonly frozen: boolean;
  readonly private_port: number | null;
  readonly revision: number | null;
  readonly content_hash: string | null;
  readonly plugin_catalog_hash: string | null;
  readonly started_at: number;
  readonly evidence: WorkerDescriptorEvidence;
};

export type WorkerDescriptor = WorkerDescriptorBody & { readonly descriptor_mac: SupervisionMac };

export type WorkerDescriptorFile = {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type WorkerDescriptorFs = {
  mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<WorkerDescriptorFile>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
};

export type WorkerDescriptorWriteOptions = {
  readonly fs?: WorkerDescriptorFs;
  readonly platform?: NodeJS.Platform | string;
};

const nodeFs: WorkerDescriptorFs = { mkdir, chmod, open, rename, rm };
const DESCRIPTOR_KEYS = [
  'boot_nonce', 'content_hash', 'control_port', 'descriptor_mac', 'frozen', 'master_generation',
  'phase', 'pid', 'plugin_catalog_hash', 'private_port', 'revision', 'role', 'schema',
  'started_at', 'worker_instance_id', 'worker_slot', 'evidence',
] as const;
const DESCRIPTOR_KEYS_WITH_MASTER_CONTROL = [...DESCRIPTOR_KEYS, 'master_control_port'] as const;
const PHASES = new Set<WorkerDescriptorPhase>(['candidate', 'serving', 'draining', 'stopped']);

let descriptorQueue = Promise.resolve();

function enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
  const next = descriptorQueue.then(operation);
  descriptorQueue = next.then(() => undefined, () => undefined);
  return next;
}

function fail(message: string): never {
  throw new SupervisionProtocolError('malformed_message', `worker descriptor ${message}`);
}

function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail('must be a plain object');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail('has unexpected fields');
}

function text(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string') fail(`${key} must be a string`);
  return value[key] as string;
}

function integer(value: Record<string, unknown>, key: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    fail(`${key} is invalid`);
  }
  return candidate;
}

function nullableInteger(value: Record<string, unknown>, key: string): number | null {
  return value[key] === null ? null : integer(value, key, 1, 65_535);
}

function mac(body: WorkerDescriptorBody, key: Readonly<Uint8Array>): SupervisionMac {
  return `hmac-sha256:${createHmac('sha256', key as Uint8Array)
    .update(canonicalJson(body), 'utf8').digest('hex')}` as SupervisionMac;
}

function credentialKey(value: SupervisionProcessCredential | Readonly<Uint8Array>): Readonly<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  const credential = value as SupervisionProcessCredential;
  if (credential === null || typeof credential !== 'object' || !(credential.process_key instanceof Uint8Array)
    || credential.process_key.byteLength !== 32) fail('credential is invalid');
  return credential.process_key;
}

function isDirectorySyncOptional(error: unknown, platform: NodeJS.Platform | string): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { readonly code?: unknown }).code : undefined;
  return platform === 'win32' && (code === 'EPERM' || code === 'EISDIR' || code === 'ENOTSUP' || code === 'EINVAL');
}

export function parseWorkerDescriptorEvidence(value: unknown): WorkerDescriptorEvidence {
  const input = plain(value);
  const kind = text(input, 'kind') as WorkerDescriptorEvidence['kind'];
  if (kind === 'candidate') {
    exact(input, ['kind']);
    return { kind };
  }
  if (kind !== 'ready' && kind !== 'apply-failed' && kind !== 'drained') fail('evidence kind is invalid');
  exact(input, ['kind', 'message']);
  const message = parseConfigWorkerMessage(input.message);
  const expected = kind === 'ready' ? 'config-ready' : kind === 'apply-failed' ? 'config-apply-failed' : 'worker-drained';
  if (!('status' in message) || message.status !== expected) fail('evidence message does not match kind');
  return { kind, message };
}

export function signWorkerDescriptor(body: WorkerDescriptorBody, key: Readonly<Uint8Array>): WorkerDescriptor {
  return { ...body, descriptor_mac: mac(body, key) };
}

export function parseWorkerDescriptor(
  value: unknown,
  credential: SupervisionProcessCredential | Readonly<Uint8Array>,
): WorkerDescriptor {
  let input: Record<string, unknown>;
  try { input = plain(snapshotJsonGraph(value)); }
  catch (error) {
    if (error instanceof SupervisionProtocolError) throw error;
    throw new SupervisionProtocolError('malformed_message', 'worker descriptor JSON is unsafe', { cause: error });
  }
  exact(input, input.master_control_port === undefined ? DESCRIPTOR_KEYS : DESCRIPTOR_KEYS_WITH_MASTER_CONTROL);
  if (input.schema !== 'bungee-worker-descriptor-v1' || input.role !== 'worker') fail('schema or role is invalid');
  const masterGeneration = text(input, 'master_generation');
  const workerInstanceId = text(input, 'worker_instance_id');
  const bootNonce = text(input, 'boot_nonce');
  if (!isLowercaseUuid(masterGeneration) || !isLowercaseUuid(workerInstanceId) || !isLowercaseUuid(bootNonce)) fail('identity is invalid');
  const workerSlot = integer(input, 'worker_slot', 0);
  const pid = integer(input, 'pid', 1);
  const controlPort = integer(input, 'control_port', 1, 65_535);
  const masterControlPort = input.master_control_port === undefined ? undefined : integer(input, 'master_control_port', 1, 65_535);
  const phase = text(input, 'phase') as WorkerDescriptorPhase;
  if (!PHASES.has(phase)) fail('phase is invalid');
  if (typeof input.frozen !== 'boolean') fail('frozen is invalid');
  const privatePort = nullableInteger(input, 'private_port');
  const revision = input.revision === null ? null : integer(input, 'revision', 1);
  const contentHash = input.content_hash === null ? null : text(input, 'content_hash');
  const pluginCatalogHash = input.plugin_catalog_hash === null ? null : text(input, 'plugin_catalog_hash');
  if ((revision === null) !== (contentHash === null) || (revision === null) !== (pluginCatalogHash === null)) fail('revision and digests must be consistently nullable');
  if (contentHash !== null && !validateDigest(contentHash)) fail('content_hash is invalid');
  if (pluginCatalogHash !== null && !validateDigest(pluginCatalogHash)) fail('plugin_catalog_hash is invalid');
  const startedAt = integer(input, 'started_at', 0);
  const evidence = parseWorkerDescriptorEvidence(input.evidence);
  const descriptorMac = text(input, 'descriptor_mac');
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(descriptorMac)) fail('descriptor_mac is invalid');
  const body: WorkerDescriptorBody = {
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: masterGeneration,
    worker_instance_id: workerInstanceId, worker_slot: workerSlot, boot_nonce: bootNonce, pid,
    control_port: controlPort, ...(masterControlPort === undefined ? {} : { master_control_port: masterControlPort }), phase, frozen: input.frozen, private_port: privatePort, revision,
    content_hash: contentHash, plugin_catalog_hash: pluginCatalogHash, started_at: startedAt, evidence,
  };
  if (!(credential instanceof Uint8Array)) {
    const processCredential = credential as SupervisionProcessCredential;
    if (processCredential.identity.role !== 'worker' || processCredential.identity.process_instance_id !== workerInstanceId
      || processCredential.identity.boot_nonce !== bootNonce) fail('credential identity does not match');
  }
  const expected = mac(body, credentialKey(credential));
  const actual = Buffer.from(descriptorMac.slice('hmac-sha256:'.length), 'hex');
  if (!timingSafeEqual(actual, Buffer.from(expected.slice('hmac-sha256:'.length), 'hex'))) {
    throw new SupervisionProtocolError('invalid_mac', 'worker descriptor MAC is invalid');
  }
  return Object.freeze({ ...body, descriptor_mac: descriptorMac as SupervisionMac });
}

export function verifyWorkerDescriptor(
  value: unknown,
  credential: SupervisionProcessCredential | Readonly<Uint8Array>,
): value is WorkerDescriptor {
  try { parseWorkerDescriptor(value, credential); return true; } catch { return false; }
}

async function writeWorkerDescriptorNow(
  path: string,
  body: WorkerDescriptorBody,
  key: Readonly<Uint8Array>,
  options: WorkerDescriptorWriteOptions,
): Promise<WorkerDescriptor> {
  const fs = options.fs ?? nodeFs;
  const platform = options.platform ?? process.platform;
  const directory = dirname(path);
  const temporary = join(directory, `.${body.worker_instance_id}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const descriptor = signWorkerDescriptor(body, key);
    const file = await fs.open(temporary, 'w', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(descriptor)}\n`, 'utf8');
      await file.chmod(0o600);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, path);
    renamed = true;
    let directoryHandle: WorkerDescriptorFile | undefined;
    try { directoryHandle = await fs.open(directory, 'r'); }
    catch (error) {
      if (!isDirectorySyncOptional(error, platform)) throw error;
      directoryHandle = undefined;
    }
    if (directoryHandle !== undefined) {
      try {
        try { await directoryHandle.sync(); }
        catch (error) {
          if (!isDirectorySyncOptional(error, platform)) throw error;
        }
      } finally { await directoryHandle.close(); }
    }
    return descriptor;
  } finally {
    if (!renamed) {
      try { await fs.rm(temporary, { force: true }); } catch { /* cleanup is best effort */ }
    }
  }
}

export function writeWorkerDescriptor(
  path: string,
  body: WorkerDescriptorBody,
  key: Readonly<Uint8Array>,
  options: WorkerDescriptorWriteOptions = {},
): Promise<WorkerDescriptor> {
  return enqueue(() => writeWorkerDescriptorNow(path, body, key, options));
}

export function removeWorkerDescriptor(path: string, options: WorkerDescriptorWriteOptions = {}): Promise<void> {
  return enqueue(async () => {
    try { await (options.fs ?? nodeFs).rm(path, { force: true }); } catch { /* best effort on shutdown */ }
  });
}
