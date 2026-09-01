import type { PluginConfigValue } from '@jeffusion/bungee-types';
import type { ConfigurationOperation } from '../config-storage/repository-types';
import {
  digest,
  exactObject,
  identifier,
  invalid,
  nonnegativeInteger,
  positiveInteger,
} from './message-fields';

const OPERATION_FIELDS = new Set([
  'mutation_id', 'request_hash', 'expected_revision', 'committed_revision', 'kind',
  'target_worker_count', 'drain_recovery_generation',
  'last_drain_recovery_previous_generation', 'created_at', 'updated_at', 'state',
  'result_status', 'error_code', 'error_detail',
]);

function errorDetail(value: PluginConfigValue | undefined, path: string): string {
  if (typeof value !== 'string' || value.length > 512 || value.trim().length === 0) invalid(path);
  return value;
}

function recoveryMetadata(object: ReturnType<typeof exactObject>, path: string) {
  const generation = nonnegativeInteger(
    object.drain_recovery_generation,
    `${path}.drain_recovery_generation`,
  );
  const previous = object.last_drain_recovery_previous_generation === null
    ? null
    : nonnegativeInteger(
      object.last_drain_recovery_previous_generation,
      `${path}.last_drain_recovery_previous_generation`,
    );
  if ((generation === 0) !== (previous === null)
      || (generation > 0 && previous !== generation - 1)) {
    invalid(`${path}.drain_recovery_generation`);
  }
  return { generation, previous };
}

export function parseOperation(value: PluginConfigValue | undefined, path: string): ConfigurationOperation {
  const object = exactObject(value, OPERATION_FIELDS, path);
  const expectedRevision = positiveInteger(object.expected_revision, `${path}.expected_revision`);
  const committedRevision = positiveInteger(object.committed_revision, `${path}.committed_revision`);
  const createdAt = nonnegativeInteger(object.created_at, `${path}.created_at`);
  const updatedAt = nonnegativeInteger(object.updated_at, `${path}.updated_at`);
  if (updatedAt < createdAt) invalid(`${path}.updated_at`);
  let kind: 'config' | 'admin_state';
  if (object.kind === 'config') kind = 'config';
  else if (object.kind === 'admin_state') kind = 'admin_state';
  else invalid(`${path}.kind`);
  const recovery = recoveryMetadata(object, path);
  const base = {
    mutation_id: identifier(object.mutation_id, `${path}.mutation_id`),
    request_hash: digest(object.request_hash, `${path}.request_hash`),
    expected_revision: expectedRevision,
    committed_revision: committedRevision,
    kind,
    target_worker_count: nonnegativeInteger(object.target_worker_count, `${path}.target_worker_count`),
    drain_recovery_generation: recovery.generation,
    last_drain_recovery_previous_generation: recovery.previous,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  switch (object.state) {
    case 'committed':
    case 'publishing':
    case 'draining':
      if (object.result_status !== null || object.error_code !== null || object.error_detail !== null
          || (recovery.generation > 0 && object.state !== 'draining')) invalid(`${path}.state`);
      return { ...base, state: object.state, result_status: null, error_code: null, error_detail: null };
    case 'converged':
      if (object.result_status !== 200 || object.error_code !== null || object.error_detail !== null
          || recovery.generation !== 0) invalid(`${path}.state`);
      return { ...base, state: 'converged', result_status: 200, error_code: null, error_detail: null };
    case 'degraded': {
      if (object.result_status !== 202
          || (object.error_code !== 'replacement_convergence_failed'
              && object.error_code !== 'old_worker_drain_failed')) invalid(`${path}.state`);
      if (object.error_code === 'replacement_convergence_failed' && recovery.generation !== 0) {
        invalid(`${path}.state`);
      }
      return {
        ...base,
        state: 'degraded',
        result_status: 202,
        error_code: object.error_code,
        error_detail: errorDetail(object.error_detail, `${path}.error_detail`),
      };
    }
    default:
      return invalid(`${path}.state`);
  }
}
