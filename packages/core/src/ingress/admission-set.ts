import type { Sha256Digest } from '@jeffusion/bungee-types';
import { canonicalJson } from '../config-storage/content-hash';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import { validateDigest } from '../config-storage/repository-validation';
import { isLowercaseUuid } from '../config-storage/validation';

export type AdmissionWorker = {
  /** PID is intentionally absent: it is diagnostic only, not identity/fencing. */
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly boot_nonce: string;
  readonly worker_slot: number;
  readonly private_port: number;
};

export type AdmissionSet = {
  /** PID is deliberately absent: identity/fencing uses generation, instance, boot nonce and slot. */
  readonly master_generation: string;
  readonly admission_sequence: number;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly workers: readonly AdmissionWorker[];
};

const SET_FIELDS = new Set([
  'master_generation', 'admission_sequence', 'revision', 'content_hash',
  'plugin_catalog_hash', 'workers',
]);
const WORKER_FIELDS = new Set([
  'master_generation', 'worker_instance_id', 'boot_nonce', 'worker_slot', 'private_port',
]);

export class AdmissionSetError extends Error {
  readonly name = 'AdmissionSetError';
  constructor(readonly code: 'malformed' | 'mixed_generation' | 'duplicate_slot', message: string) {
    super(message);
  }
}

function fail(message: string, code: AdmissionSetError['code'] = 'malformed'): never {
  throw new AdmissionSetError(code, message);
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail('admission set must be a plain object');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: Set<string>): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) fail('admission set has extra or missing fields');
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) >= Number.MAX_SAFE_INTEGER) fail('admission integer is invalid');
  return value as number;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !isLowercaseUuid(value)) fail('admission UUID is invalid');
  return value;
}

function digest(value: unknown): Sha256Digest {
  if (typeof value !== 'string' || !validateDigest(value)) fail('admission digest is invalid');
  return value as Sha256Digest;
}

export function parseAdmissionSet(input: unknown): AdmissionSet {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonGraph(input);
  } catch {
    fail('admission set is not a strict JSON graph');
  }
  const root = plainObject(snapshot);
  exact(root, SET_FIELDS);
  const generation = uuid(root.master_generation);
  const workersValue = root.workers;
  if (!Array.isArray(workersValue) || workersValue.length === 0) fail('workers must be non-empty');
  const workerIds = new Set<string>();
  const bootNonces = new Set<string>();
  const ports = new Set<number>();
  const workers = workersValue.map((value) => {
    const worker = plainObject(value);
    exact(worker, WORKER_FIELDS);
    const workerGeneration = uuid(worker.master_generation);
    if (workerGeneration !== generation) fail('workers have mixed master generations', 'mixed_generation');
    const slot = integer(worker.worker_slot, 0);
    const workerId = uuid(worker.worker_instance_id);
    const bootNonce = uuid(worker.boot_nonce);
    if (workerIds.has(workerId) || bootNonces.has(bootNonce)) fail('worker identity is duplicated', 'duplicate_slot');
    workerIds.add(workerId);
    bootNonces.add(bootNonce);
    const privatePort = integer(worker.private_port, 1);
    if (privatePort > 65_535) fail('private port is invalid');
    if (ports.has(privatePort)) fail('private port is duplicated', 'duplicate_slot');
    ports.add(privatePort);
    return Object.freeze({
      master_generation: workerGeneration,
      worker_instance_id: workerId,
      boot_nonce: bootNonce,
      worker_slot: slot,
      private_port: privatePort,
    });
  });
  workers.sort((left, right) => left.worker_slot - right.worker_slot);
  if (workers.some((worker, index) => worker.worker_slot !== index)) {
    fail('worker slots must be complete and sorted', 'duplicate_slot');
  }
  return Object.freeze({
    master_generation: generation,
    admission_sequence: integer(root.admission_sequence, 1),
    revision: integer(root.revision, 1),
    content_hash: digest(root.content_hash),
    plugin_catalog_hash: digest(root.plugin_catalog_hash),
    workers: Object.freeze(workers),
  });
}

export function admissionSetIdentity(set: AdmissionSet): string {
  return canonicalJson(set);
}
