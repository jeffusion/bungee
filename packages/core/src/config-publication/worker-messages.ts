import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from '../config-storage/aggregate';
import type { JsonObject } from '../config-storage/validation';
import {
  boundedError,
  canonicalPlugins,
  digest,
  exactObject,
  exactRoot,
  identifier,
  invalid,
  nonnegativeInteger,
  positiveInteger,
  privatePort,
  PROCESS_IDENTITY_FIELDS,
  processIdentity,
  publicationIdentity,
  snapshotMessage,
} from './message-fields';
import type { ConfigWorkerMessage } from './types';

const READY_FIELDS = new Set([
  'status', ...PROCESS_IDENTITY_FIELDS, 'pid', 'revision', 'content_hash',
  'plugin_catalog_hash', 'private_port', 'plugin_runtime_generation', 'required_plugins', 'serving_plugins',
  'publication',
]);
const FAILED_FIELDS = new Set([
  'status', ...PROCESS_IDENTITY_FIELDS, 'pid', 'target_revision', 'target_content_hash',
  'target_plugin_catalog_hash', 'serving_revision', 'serving_content_hash', 'failed_plugins', 'error',
  'publication',
]);
const DRAINED_FIELDS = new Set([
  'status', ...PROCESS_IDENTITY_FIELDS, 'pid', 'revision', 'content_hash',
  'plugin_catalog_hash', 'publication',
]);
const COMMIT_FIELDS = new Set(['command', ...PROCESS_IDENTITY_FIELDS, 'request_id', 'mutation']);
const MUTATION_FIELDS = new Set(['mutation_id', 'expected_revision', 'kind', 'aggregate']);
const GET_FIELDS = new Set(['command', ...PROCESS_IDENTITY_FIELDS, 'request_id', 'mutation_id']);

function aggregate(value: unknown): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate(value);
  if (!result.ok) invalid('mutation.aggregate');
  return result.value;
}

function ready(root: JsonObject): ConfigWorkerMessage {
  exactRoot(root, READY_FIELDS);
  return {
    status: 'config-ready',
    ...processIdentity(root),
    pid: positiveInteger(root.pid, 'pid'),
    revision: positiveInteger(root.revision, 'revision'),
    content_hash: digest(root.content_hash, 'content_hash'),
    plugin_catalog_hash: digest(root.plugin_catalog_hash, 'plugin_catalog_hash'),
    private_port: privatePort(root.private_port, 'private_port'),
    plugin_runtime_generation: nonnegativeInteger(root.plugin_runtime_generation, 'plugin_runtime_generation'),
    required_plugins: canonicalPlugins(root.required_plugins, 'required_plugins'),
    serving_plugins: canonicalPlugins(root.serving_plugins, 'serving_plugins'),
    publication: root.publication === null ? null : publicationIdentity(root.publication, 'publication'),
  };
}

function failed(root: JsonObject): ConfigWorkerMessage {
  exactRoot(root, FAILED_FIELDS);
  const servingRevision = root.serving_revision === null
    ? null : positiveInteger(root.serving_revision, 'serving_revision');
  const servingHash = root.serving_content_hash === null
    ? null : digest(root.serving_content_hash, 'serving_content_hash');
  if ((servingRevision === null) !== (servingHash === null)) invalid('serving_revision');
  return {
    status: 'config-apply-failed',
    ...processIdentity(root),
    pid: positiveInteger(root.pid, 'pid'),
    target_revision: positiveInteger(root.target_revision, 'target_revision'),
    target_content_hash: digest(root.target_content_hash, 'target_content_hash'),
    target_plugin_catalog_hash: digest(root.target_plugin_catalog_hash, 'target_plugin_catalog_hash'),
    serving_revision: servingRevision,
    serving_content_hash: servingHash,
    failed_plugins: canonicalPlugins(root.failed_plugins, 'failed_plugins'),
    error: boundedError(root.error, 'error'),
    publication: root.publication === null ? null : publicationIdentity(root.publication, 'publication'),
  };
}

function commit(root: JsonObject): ConfigWorkerMessage {
  exactRoot(root, COMMIT_FIELDS);
  const mutation = exactObject(root.mutation, MUTATION_FIELDS, 'mutation');
  const kind = mutation.kind === 'config' || mutation.kind === 'admin_state'
    ? mutation.kind : invalid('mutation.kind');
  return {
    command: 'commit-config',
    ...processIdentity(root),
    request_id: identifier(root.request_id, 'request_id'),
    mutation: {
      mutation_id: identifier(mutation.mutation_id, 'mutation.mutation_id'),
      expected_revision: positiveInteger(mutation.expected_revision, 'mutation.expected_revision'),
      kind,
      aggregate: aggregate(mutation.aggregate),
    },
  };
}

export function parseConfigWorkerMessage(input: unknown): ConfigWorkerMessage {
  const root = snapshotMessage(input);
  switch (root.command ?? root.status) {
    case 'config-ready':
      return ready(root);
    case 'config-apply-failed':
      return failed(root);
    case 'worker-drained':
      exactRoot(root, DRAINED_FIELDS);
      return {
        status: 'worker-drained', ...processIdentity(root),
        pid: positiveInteger(root.pid, 'pid'), revision: positiveInteger(root.revision, 'revision'),
        content_hash: digest(root.content_hash, 'content_hash'),
        plugin_catalog_hash: digest(root.plugin_catalog_hash, 'plugin_catalog_hash'),
        publication: root.publication === null ? null : publicationIdentity(root.publication, 'publication'),
      };
    case 'commit-config':
      return commit(root);
    case 'get-config-operation':
      exactRoot(root, GET_FIELDS);
      return {
        command: 'get-config-operation', ...processIdentity(root), request_id: identifier(root.request_id, 'request_id'),
        mutation_id: identifier(root.mutation_id, 'mutation_id'),
      };
    default:
      return invalid('command');
  }
}
