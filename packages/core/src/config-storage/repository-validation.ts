import type { ConfigurationAggregateV2, Sha256Digest } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from './aggregate';
import type { ConfigurationCompileOptions } from './plugin-schema';
import { ConfigRepositoryError } from './repository-types';
import type { JsonObject } from './validation';

const MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function validateDigest(value: string): value is Sha256Digest {
  return SHA256.test(value);
}

export function validateMutationId(value: string): boolean {
  return MUTATION_ID.test(value);
}

export function validateCommitCommand(
  command: JsonObject,
  compileOptions?: ConfigurationCompileOptions,
): ConfigurationAggregateV2 {
  if (typeof command.mutation_id !== 'string' || !validateMutationId(command.mutation_id)) {
    throw new ConfigRepositoryError('invalid_command', 'mutation_id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
  }
  if (typeof command.expected_revision !== 'number' ||
      !Number.isSafeInteger(command.expected_revision) || command.expected_revision <= 0) {
    throw new ConfigRepositoryError('invalid_command', 'expected_revision must be a positive safe integer');
  }
  if (typeof command.created_at !== 'number' || !Number.isSafeInteger(command.created_at) || command.created_at < 0) {
    throw new ConfigRepositoryError('invalid_command', 'created_at must be a non-negative integer epoch millisecond');
  }
  if (command.kind !== 'config' && command.kind !== 'admin_state') {
    throw new ConfigRepositoryError('invalid_command', 'kind must be config or admin_state');
  }
  const targetSlots = new Set<number>();
  if (!Array.isArray(command.target_worker_slots)) {
    throw new ConfigRepositoryError('invalid_command', 'target_worker_slots must be an array');
  }
  for (const slot of command.target_worker_slots) {
    if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0 || targetSlots.has(slot)) {
      throw new ConfigRepositoryError('invalid_command', 'target_worker_slots must contain unique non-negative safe integers');
    }
    targetSlots.add(slot);
  }
  const result = parseNormalizeCompileAggregate(command.aggregate, compileOptions);
  if (!result.ok) throw new ConfigRepositoryError('invalid_configuration', 'configuration aggregate is invalid', result.errors);
  return result.value;
}
