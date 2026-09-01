import type { ConfigurationAggregateV2, PluginConfigValue } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from '../config-storage/aggregate';
import { hashConfigurationContent } from '../config-storage/content-hash';
import type { JsonObject } from '../config-storage/validation';
import {
  digest,
  exactObject,
  identifier,
  invalid,
  positiveInteger,
} from './message-fields';
import { parseOperation } from './operation-parser';
import type { ConfigControlResult } from './types';

const ERROR_BASE = ['kind', 'http_status', 'code', 'outcome_unknown'] as const;
const ERROR_FIELDS = new Set(ERROR_BASE);
const STALE_FIELDS = new Set([...ERROR_BASE, 'expected_revision', 'active_revision']);
const IDEMPOTENCY_FIELDS = new Set([...ERROR_BASE, 'mutation_id']);
const PROGRESS_FIELDS = new Set([...ERROR_BASE, 'mutation_id', 'committed_revision', 'operation_state']);
const COMMIT_FIELDS = new Set(['kind', 'outcome', 'snapshot', 'operation']);
const DUPLICATE_FIELDS = new Set(['kind', 'outcome', 'operation']);
const OPERATION_FIELDS = new Set(['kind', 'operation']);
const SNAPSHOT_FIELDS = new Set(['revision', 'content_hash', 'aggregate']);

function aggregate(value: unknown): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate(value);
  if (!result.ok) invalid('result.snapshot.aggregate');
  return result.value;
}

function conflict(object: JsonObject): ConfigControlResult {
  if (object.outcome_unknown !== false) invalid('result.outcome_unknown');
  switch (object.code) {
    case 'stale_revision': {
      const parsed = exactObject(object, STALE_FIELDS, 'result');
      return {
        kind: 'error', http_status: 409, code: 'stale_revision', outcome_unknown: false,
        expected_revision: positiveInteger(parsed.expected_revision, 'result.expected_revision'),
        active_revision: positiveInteger(parsed.active_revision, 'result.active_revision'),
      };
    }
    case 'idempotency_key_reused': {
      const parsed = exactObject(object, IDEMPOTENCY_FIELDS, 'result');
      return {
        kind: 'error', http_status: 409, code: 'idempotency_key_reused', outcome_unknown: false,
        mutation_id: identifier(parsed.mutation_id, 'result.mutation_id'),
      };
    }
    case 'operation_in_progress': {
      const parsed = exactObject(object, PROGRESS_FIELDS, 'result');
      if (parsed.operation_state !== 'committed' && parsed.operation_state !== 'publishing'
          && parsed.operation_state !== 'draining') {
        invalid('result.operation_state');
      }
      return {
        kind: 'error', http_status: 409, code: 'operation_in_progress', outcome_unknown: false,
        mutation_id: identifier(parsed.mutation_id, 'result.mutation_id'),
        committed_revision: positiveInteger(parsed.committed_revision, 'result.committed_revision'),
        operation_state: parsed.operation_state,
      };
    }
    default:
      return invalid('result.code');
  }
}

function error(object: JsonObject): ConfigControlResult {
  switch (object.http_status) {
    case 409:
      return conflict(object);
    case 422: {
      const parsed = exactObject(object, ERROR_FIELDS, 'result');
      if (parsed.code !== 'invalid_configuration') invalid('result.code');
      if (parsed.outcome_unknown !== false) invalid('result.outcome_unknown');
      return { kind: 'error', http_status: 422, code: parsed.code, outcome_unknown: false };
    }
    case 503: {
      const parsed = exactObject(object, ERROR_FIELDS, 'result');
      if (parsed.code !== 'repository_unavailable' || parsed.outcome_unknown !== true) invalid('result');
      return { kind: 'error', http_status: 503, code: 'repository_unavailable', outcome_unknown: true };
    }
    default:
      return invalid('result.http_status');
  }
}

function commit(value: PluginConfigValue | undefined, object: JsonObject): ConfigControlResult {
  switch (object.outcome) {
    case 'committed': {
      const parsed = exactObject(value, COMMIT_FIELDS, 'result');
      const snapshot = exactObject(parsed.snapshot, SNAPSHOT_FIELDS, 'result.snapshot');
      const parsedAggregate = aggregate(snapshot.aggregate);
      const contentHash = digest(snapshot.content_hash, 'result.snapshot.content_hash');
      if (hashConfigurationContent(parsedAggregate) !== contentHash) invalid('result.snapshot.content_hash');
      return {
        kind: 'commit', outcome: 'committed',
        snapshot: {
          revision: positiveInteger(snapshot.revision, 'result.snapshot.revision'),
          content_hash: contentHash,
          aggregate: parsedAggregate,
        },
        operation: parseOperation(parsed.operation, 'result.operation'),
      };
    }
    case 'duplicate': {
      const parsed = exactObject(value, DUPLICATE_FIELDS, 'result');
      return { kind: 'commit', outcome: 'duplicate', operation: parseOperation(parsed.operation, 'result.operation') };
    }
    default:
      return invalid('result.outcome');
  }
}

export function parseControlResult(value: PluginConfigValue | undefined): ConfigControlResult {
  const object = exactObjectWithKind(value);
  switch (object.kind) {
    case 'error':
      return error(object);
    case 'commit':
      return commit(value, object);
    case 'operation': {
      const parsed = exactObject(value, OPERATION_FIELDS, 'result');
      return { kind: 'operation', operation: parsed.operation === null ? null : parseOperation(parsed.operation, 'result.operation') };
    }
    default:
      return invalid('result.kind');
  }
}

function exactObjectWithKind(value: PluginConfigValue | undefined): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('result');
  if (!('kind' in value)) invalid('result.kind');
  return value;
}
