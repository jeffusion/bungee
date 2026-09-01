import type { ConfigurationAggregateV2, Sha256Digest } from '@jeffusion/bungee-types';
import { hashConfigurationContent, hashConfigurationRequest } from './content-hash';
import { snapshotJsonGraph } from './json-preflight';
import type { PluginConfigValue } from '@jeffusion/bungee-types';
import type { ConfigurationCompileOptions } from './plugin-schema';
import { ConfigRepositoryError } from './repository-types';
import { validateCommitCommand } from './repository-validation';
import { isObject, type JsonObject } from './validation';

const COMMAND_FIELDS = new Set([
  'mutation_id', 'expected_revision', 'aggregate', 'kind', 'created_at', 'target_worker_slots',
]);

export type PreparedCommitCommand = {
  readonly mutationId: string;
  readonly expectedRevision: number;
  readonly aggregate: ConfigurationAggregateV2;
  readonly kind: 'config' | 'admin_state';
  readonly createdAt: number;
  readonly targetSlots: readonly number[];
  readonly contentHash: Sha256Digest;
  readonly requestHash: Sha256Digest;
};

function commandObject(input: unknown): JsonObject {
  let snapshot: PluginConfigValue;
  try {
    snapshot = snapshotJsonGraph(input);
  } catch (error) {
    throw new ConfigRepositoryError('invalid_command', 'commit command must be plain JSON data', error);
  }
  if (!isObject(snapshot) || Object.keys(snapshot).some((key) => !COMMAND_FIELDS.has(key)) ||
      Object.keys(snapshot).length !== COMMAND_FIELDS.size) {
    throw new ConfigRepositoryError('invalid_command', 'commit command fields are invalid');
  }
  return snapshot;
}

export function prepareCommitCommand(
  input: unknown,
  compileOptions?: ConfigurationCompileOptions,
): PreparedCommitCommand {
  const command = commandObject(input);
  const aggregate = validateCommitCommand(command, compileOptions);
  const mutationId = command.mutation_id;
  const expectedRevision = command.expected_revision;
  const kind = command.kind;
  const createdAt = command.created_at;
  const targetWorkerSlots = command.target_worker_slots;
  if (typeof mutationId !== 'string' || typeof expectedRevision !== 'number' ||
      (kind !== 'config' && kind !== 'admin_state') || typeof createdAt !== 'number' ||
      !Array.isArray(targetWorkerSlots)) {
    throw new ConfigRepositoryError('invalid_command', 'commit command scalar fields are invalid');
  }
  const targetSlots = targetWorkerSlots.map((slot) => {
    if (typeof slot !== 'number') throw new ConfigRepositoryError('invalid_command', 'worker slot must be a number');
    return slot;
  }).sort((left, right) => left - right);
  return {
    mutationId, expectedRevision, aggregate, kind, createdAt, targetSlots,
    contentHash: hashConfigurationContent(aggregate),
    requestHash: hashConfigurationRequest({
      kind, expected_revision: expectedRevision, aggregate, target_worker_slots: targetSlots,
    }),
  };
}
