import type { PluginConfigValue, Sha256Digest } from '@jeffusion/bungee-types';
import { JsonSnapshotError, snapshotJsonGraph } from '../config-storage/json-preflight';
import { isPluginName } from '../config-storage/plugin-name';
import { validateDigest, validateMutationId } from '../config-storage/repository-validation';
import { isObject, type JsonObject } from '../config-storage/validation';
import { isLowercaseUuid } from '../config-storage/validation';
import { ConfigPublicationMessageError } from './types';
import type { ConfigProcessIdentity, ConfigPublicationIdentity } from './types';

const PUBLICATION_FIELDS = new Set(['mutation_id', 'attempt_no', 'drain_recovery_generation']);
export const PROCESS_IDENTITY_FIELDS = [
  'master_generation', 'worker_instance_id', 'worker_slot',
] as const;

export function snapshotMessage(input: unknown): JsonObject {
  let snapshot: PluginConfigValue;
  try {
    snapshot = snapshotJsonGraph(input);
  } catch (error) {
    if (error instanceof JsonSnapshotError) {
      throw new ConfigPublicationMessageError('unsafe_message', '', error);
    }
    throw error;
  }
  if (!isObject(snapshot)) invalid('');
  return snapshot;
}

export function invalid(path: string): never {
  throw new ConfigPublicationMessageError('invalid_message', path);
}

export function exactObject(
  value: PluginConfigValue | undefined,
  fields: ReadonlySet<string>,
  path: string,
): JsonObject {
  if (!isObject(value)) invalid(path);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) invalid(path);
  return value;
}

export function exactRoot(root: JsonObject, fields: ReadonlySet<string>): void {
  const keys = Object.keys(root);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) invalid('');
}

export function literal<T extends string>(value: PluginConfigValue | undefined, expected: T, path: string): T {
  if (value !== expected) invalid(path);
  return expected;
}

export function nonnegativeInteger(value: PluginConfigValue | undefined, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(path);
  return value;
}

export function positiveInteger(value: PluginConfigValue | undefined, path: string): number {
  const parsed = nonnegativeInteger(value, path);
  if (parsed === 0) invalid(path);
  return parsed;
}

export function privatePort(value: PluginConfigValue | undefined, path: string): number {
  const parsed = positiveInteger(value, path);
  if (parsed > 65_535) invalid(path);
  return parsed;
}

export function digest(value: PluginConfigValue | undefined, path: string): Sha256Digest {
  if (typeof value !== 'string' || !validateDigest(value)) invalid(path);
  return value;
}

export function identifier(value: PluginConfigValue | undefined, path: string): string {
  if (typeof value !== 'string' || !validateMutationId(value)) invalid(path);
  return value;
}

function canonicalUuid(value: PluginConfigValue | undefined, path: string): string {
  if (typeof value !== 'string' || !isLowercaseUuid(value)) invalid(path);
  return value;
}

export function processIdentity(value: JsonObject, path = ''): ConfigProcessIdentity {
  const prefix = path.length === 0 ? '' : `${path}.`;
  return {
    master_generation: canonicalUuid(value.master_generation, `${prefix}master_generation`),
    worker_instance_id: canonicalUuid(value.worker_instance_id, `${prefix}worker_instance_id`),
    worker_slot: nonnegativeInteger(value.worker_slot, `${prefix}worker_slot`),
  };
}

export function sameProcessIdentity(left: ConfigProcessIdentity, right: ConfigProcessIdentity): boolean {
  return left.master_generation === right.master_generation
    && left.worker_instance_id === right.worker_instance_id
    && left.worker_slot === right.worker_slot;
}

export function samePublicationIdentity(
  left: ConfigPublicationIdentity | null,
  right: ConfigPublicationIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.mutation_id === right.mutation_id
    && left.attempt_no === right.attempt_no
    && left.drain_recovery_generation === right.drain_recovery_generation;
}

export function publicationIdentity(
  value: PluginConfigValue | undefined,
  path: string,
): ConfigPublicationIdentity {
  const publication = exactObject(value, PUBLICATION_FIELDS, path);
  return {
    mutation_id: identifier(publication.mutation_id, `${path}.mutation_id`),
    attempt_no: positiveInteger(publication.attempt_no, `${path}.attempt_no`),
    drain_recovery_generation: nonnegativeInteger(
      publication.drain_recovery_generation,
      `${path}.drain_recovery_generation`,
    ),
  };
}

export function canonicalPlugins(value: PluginConfigValue | undefined, path: string): readonly string[] {
  if (!Array.isArray(value)) invalid(path);
  let previous: string | undefined;
  const plugins: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isPluginName(candidate) ||
        (previous !== undefined && candidate <= previous)) invalid(path);
    plugins.push(candidate);
    previous = candidate;
  }
  return Object.freeze(plugins);
}

export function boundedError(value: PluginConfigValue | undefined, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() !== value) invalid(path);
  return value;
}
