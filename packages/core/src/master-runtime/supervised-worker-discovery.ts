import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import { isLowercaseUuid } from '../config-storage/validation';
import { canonicalJson } from '../config-storage/content-hash';
import type { ConfigProcessIdentity } from '../config-publication/types';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  parseWorkerDescriptor,
  SupervisionProtocolError,
  type SupervisionRootKeyMaterial,
  type SupervisionProcessCredential,
  type WorkerDescriptor,
} from '../supervision';
import { WorkerControllerClient, WorkerControllerClientError, type WorkerControllerClientOptions, type WorkerStatusPayload } from './supervised-worker-client';
import type { AdmissionSet } from '../ingress';

export type WorkerDescriptorHint = {
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
  readonly control_port: number;
};

export type WorkerDiscoveryIssue = {
  readonly file: string;
  readonly kind: 'malformed' | 'tampered' | 'stale' | 'unreachable' | 'duplicate';
  readonly detail: string;
};

export type DiscoveredSupervisedWorker = {
  readonly file: string;
  readonly hint: WorkerDescriptorHint;
  readonly descriptor: WorkerDescriptor;
  readonly credential: SupervisionProcessCredential;
  readonly client: WorkerControllerClient;
  readonly status: WorkerStatusPayload;
};

export type WorkerDiscoveryOptions = {
  readonly runtimeWorkersDirectory: string;
  readonly rootKey: SupervisionRootKeyMaterial;
  readonly authority: WorkerControllerClientOptions['authority'];
  readonly client?: Omit<WorkerControllerClientOptions, 'baseUrl' | 'credential' | 'authority'>;
  readonly fetch?: typeof globalThis.fetch;
  readonly mode: 'exact-admission' | 'orphan-inventory';
  readonly expectedAdmission?: AdmissionSet;
  readonly clientFor: (identity: ConfigProcessIdentity, authority: WorkerControllerClientOptions['authority'], options: WorkerControllerClientOptions) => WorkerControllerClient;
};

function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('descriptor hint is not plain');
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isLowercaseUuid(value)) throw new Error(`${field} is invalid`);
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} is invalid`);
  return value;
}

/** Deliberately unauthenticated: this only selects the key and endpoint to authenticate next. */
export function parseWorkerDescriptorHint(value: unknown): WorkerDescriptorHint {
  const input = plain(snapshotJsonGraph(value));
  return {
    master_generation: uuid(input.master_generation, 'master_generation'),
    worker_instance_id: uuid(input.worker_instance_id, 'worker_instance_id'),
    worker_slot: integer(input.worker_slot, 'worker_slot', 0),
    boot_nonce: uuid(input.boot_nonce, 'boot_nonce'),
    control_port: integer(input.control_port, 'control_port', 1, 65_535),
  };
}

function sameIdentity(left: ConfigProcessIdentity, right: WorkerDescriptorHint): boolean {
  return left.master_generation === right.master_generation && left.worker_instance_id === right.worker_instance_id && left.worker_slot === right.worker_slot;
}

function issue(file: string, kind: WorkerDiscoveryIssue['kind'], error: unknown): WorkerDiscoveryIssue {
  return { file, kind, detail: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) };
}

function expectedWorker(options: WorkerDiscoveryOptions, hint: WorkerDescriptorHint): AdmissionSet['workers'][number] | undefined {
  return options.expectedAdmission?.workers.find((worker) => worker.master_generation === hint.master_generation
    && worker.worker_instance_id === hint.worker_instance_id && worker.worker_slot === hint.worker_slot
    && worker.boot_nonce === hint.boot_nonce);
}

function sameStatusEvidence(descriptor: WorkerDescriptor, status: WorkerStatusPayload): boolean {
  return descriptor.master_generation === status.master_generation && descriptor.worker_instance_id === status.worker_instance_id
    && descriptor.worker_slot === status.worker_slot && descriptor.boot_nonce === status.boot_nonce
    && descriptor.pid === status.pid && descriptor.control_port === status.control_port
    && descriptor.phase === status.phase && descriptor.frozen === status.frozen
    && descriptor.private_port === status.private_port && descriptor.revision === status.revision
    && descriptor.content_hash === status.content_hash && descriptor.plugin_catalog_hash === status.plugin_catalog_hash
    && canonicalJson(descriptor.evidence) === canonicalJson(status.evidence);
}

export async function discoverSupervisedWorkers(options: WorkerDiscoveryOptions): Promise<{
  readonly workers: readonly DiscoveredSupervisedWorker[];
  readonly issues: readonly WorkerDiscoveryIssue[];
}> {
  if (options.mode === 'exact-admission' && options.expectedAdmission === undefined) {
    throw new Error('exact-admission discovery requires expectedAdmission');
  }
  if (options.mode === 'orphan-inventory' && options.expectedAdmission !== undefined) {
    throw new Error('orphan-inventory discovery does not accept expectedAdmission');
  }
  const issues: WorkerDiscoveryIssue[] = [];
  let names: string[];
  try { names = (await readdir(options.runtimeWorkersDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name); }
  catch (error) { return { workers: [], issues: [issue(options.runtimeWorkersDirectory, 'unreachable', error)] }; }
  const hints: Array<{ file: string; hint: WorkerDescriptorHint; raw: unknown }> = [];
  for (const name of names.sort()) {
    const file = join(options.runtimeWorkersDirectory, name);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      hints.push({ file, hint: parseWorkerDescriptorHint(raw), raw });
    }
    catch (error) { issues.push(issue(file, 'malformed', error)); }
  }
  const authenticated: Array<{ file: string; hint: WorkerDescriptorHint; descriptor: WorkerDescriptor; credential: SupervisionProcessCredential; identity: ConfigProcessIdentity }> = [];
  for (const candidate of hints) {
    const { file, hint } = candidate;
    try {
      const identity: ConfigProcessIdentity = { master_generation: hint.master_generation, worker_instance_id: hint.worker_instance_id, worker_slot: hint.worker_slot };
      const seed = deriveWorkerSupervisionSeed(options.rootKey, identity.master_generation, identity.worker_instance_id, identity.worker_slot);
      const credential = deriveWorkerSupervisionCredential(seed, hint.boot_nonce);
      const descriptor = parseWorkerDescriptor(candidate.raw, credential);
      if (!sameIdentity(identity, descriptor) || descriptor.boot_nonce !== hint.boot_nonce || descriptor.control_port !== hint.control_port) {
        throw new SupervisionProtocolError('malformed_message', 'descriptor identity does not match hint');
      }
      authenticated.push({ file, hint, descriptor, credential, identity });
    } catch (error) {
      const tampered = error instanceof SupervisionProtocolError && error.code === 'invalid_mac';
      const malformed = error instanceof SupervisionProtocolError && error.code === 'malformed_message';
      issues.push(issue(file, tampered ? 'tampered' : malformed ? 'malformed' : 'unreachable', error));
    }
  }
  const selected = authenticated.filter((candidate) => {
    if (options.mode === 'orphan-inventory' || expectedWorker(options, candidate.hint) !== undefined) return true;
    issues.push(issue(candidate.file, 'stale', 'worker is not an exact member of the active admission set'));
    return false;
  });
  const duplicateIds = new Set(selected.filter((entry, index) => selected.some((other, otherIndex) => otherIndex !== index
    && other.identity.master_generation === entry.identity.master_generation
    && other.identity.worker_instance_id === entry.identity.worker_instance_id)).map((entry) => `${entry.identity.master_generation}:${entry.identity.worker_instance_id}`));
  const duplicateSlots = new Set(selected.filter((entry, index) => selected.some((other, otherIndex) => otherIndex !== index
    && other.identity.master_generation === entry.identity.master_generation && other.identity.worker_slot === entry.identity.worker_slot)).map((entry) => `${entry.identity.master_generation}:${entry.identity.worker_slot}`));
  const duplicatePorts = new Set(selected.filter((entry, index) => selected.some((other, otherIndex) => otherIndex !== index
    && other.identity.master_generation === entry.identity.master_generation && other.descriptor.control_port === entry.descriptor.control_port)).map((entry) => `${entry.identity.master_generation}:${entry.descriptor.control_port}`));
  const workers: DiscoveredSupervisedWorker[] = [];
  for (const candidate of selected) {
    const { file, hint, credential, identity } = candidate;
    try {
      const duplicate = duplicateIds.has(`${identity.master_generation}:${identity.worker_instance_id}`)
        || duplicateSlots.has(`${identity.master_generation}:${identity.worker_slot}`)
        || duplicatePorts.has(`${identity.master_generation}:${candidate.descriptor.control_port}`);
      if (duplicate && options.mode === 'exact-admission') {
        issues.push(issue(file, 'duplicate', 'worker identity, slot, or control port is duplicated'));
        continue;
      }
      if (duplicate) issues.push(issue(file, 'duplicate', 'worker identity, slot, or control port is duplicated'));
      const client = options.clientFor(identity, options.authority, {
        ...options.client, fetch: options.fetch ?? options.client?.fetch,
        baseUrl: `http://127.0.0.1:${candidate.descriptor.control_port}`, credential, authority: options.authority,
      });
      const status = await client.attach();
      let liveDescriptor: WorkerDescriptor;
      try {
        const liveRaw = JSON.parse(await readFile(file, 'utf8')) as unknown;
        const liveHint = parseWorkerDescriptorHint(liveRaw);
        liveDescriptor = parseWorkerDescriptor(liveRaw, credential);
        if (!sameIdentity(identity, liveHint) || liveHint.boot_nonce !== hint.boot_nonce || liveHint.control_port !== candidate.descriptor.control_port) {
          throw new SupervisionProtocolError('malformed_message', 'descriptor changed while attaching');
        }
      } catch (error) {
        throw error instanceof SupervisionProtocolError ? error : new SupervisionProtocolError('malformed_message', 'live descriptor is invalid', { cause: error });
      }
      if (status.worker_instance_id !== identity.worker_instance_id || status.worker_slot !== identity.worker_slot
        || status.master_generation !== identity.master_generation || status.boot_nonce !== hint.boot_nonce
        || status.control_port !== candidate.descriptor.control_port || !sameStatusEvidence(liveDescriptor, status)) throw new SupervisionProtocolError('malformed_message', 'online status identity does not match descriptor');
      const expected = options.expectedAdmission === undefined ? undefined : expectedWorker(options, hint);
      const ready = status.evidence.message;
      if (status.phase !== 'serving' || status.evidence.kind !== 'ready' || ready?.status !== 'config-ready'
        || ready.master_generation !== status.master_generation || ready.worker_instance_id !== status.worker_instance_id
        || ready.worker_slot !== status.worker_slot || ready.boot_nonce !== status.boot_nonce || ready.pid !== status.pid
        || ready.revision !== status.revision || ready.content_hash !== status.content_hash
        || ready.plugin_catalog_hash !== status.plugin_catalog_hash || ready.private_port !== status.private_port
        || (expected !== undefined && (status.private_port !== expected.private_port || status.revision !== options.expectedAdmission?.revision
          || status.content_hash !== options.expectedAdmission?.content_hash
          || status.plugin_catalog_hash !== options.expectedAdmission?.plugin_catalog_hash))) {
        issues.push(issue(file, 'stale', 'worker is not serving with complete config-ready evidence'));
        continue;
      }
      workers.push({ file, hint, descriptor: liveDescriptor, credential, client, status });
    } catch (error) {
      const tampered = error instanceof SupervisionProtocolError && error.code === 'invalid_mac';
      const malformed = error instanceof SupervisionProtocolError && error.code === 'malformed_message'
        || error instanceof WorkerControllerClientError && (error.code === 'protocol' || error.code === 'response_too_large');
      issues.push(issue(file, tampered ? 'tampered' : malformed ? 'malformed' : 'unreachable', error));
    }
  }
  return { workers, issues };
}
