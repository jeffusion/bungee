import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from '../config-storage/aggregate';
import { hashConfigurationContent } from '../config-storage/content-hash';
import type { JsonObject } from '../config-storage/validation';
import { parseControlResult } from './control-result-parser';
import {
  digest,
  exactRoot,
  identifier,
  invalid,
  literal,
  positiveInteger,
  canonicalPlugins,
  PROCESS_IDENTITY_FIELDS,
  processIdentity,
  publicationIdentity,
  snapshotMessage,
} from './message-fields';
import type { ConfigMasterMessage } from './types';

const START_FIELDS = new Set([
  'command', ...PROCESS_IDENTITY_FIELDS, 'revision', 'content_hash', 'plugin_catalog_hash',
  'aggregate', 'activated_plugin_names', 'publication',
]);
const DRAIN_FIELDS = new Set([
  'command', ...PROCESS_IDENTITY_FIELDS, 'revision', 'content_hash', 'plugin_catalog_hash', 'publication',
]);
const RESPONSE_FIELDS = new Set(['status', ...PROCESS_IDENTITY_FIELDS, 'request_id', 'result']);
const HEARTBEAT_FIELDS = new Set([
  'command', ...PROCESS_IDENTITY_FIELDS, 'master_pid', 'sequence',
]);

function aggregate(value: unknown): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate(value);
  if (!result.ok) invalid('aggregate');
  return result.value;
}

function start(root: JsonObject): ConfigMasterMessage {
  exactRoot(root, START_FIELDS);
  const parsedAggregate = aggregate(root.aggregate);
  const contentHash = digest(root.content_hash, 'content_hash');
  if (hashConfigurationContent(parsedAggregate) !== contentHash) invalid('content_hash');
  const activatedPluginNames = canonicalPlugins(root.activated_plugin_names, 'activated_plugin_names');
  const aggregateActivatedPluginNames = parsedAggregate.plugin_activations.map(({ plugin_name }) => plugin_name);
  if (activatedPluginNames.length !== aggregateActivatedPluginNames.length
    || activatedPluginNames.some((name, index) => name !== aggregateActivatedPluginNames[index])) {
    invalid('activated_plugin_names');
  }
  const base = {
    ...processIdentity(root),
    revision: positiveInteger(root.revision, 'revision'),
    content_hash: contentHash,
    plugin_catalog_hash: digest(root.plugin_catalog_hash, 'plugin_catalog_hash'),
    aggregate: parsedAggregate,
    activated_plugin_names: activatedPluginNames,
  };
  if (root.command === 'start-config-worker') {
    return {
      command: literal(root.command, 'start-config-worker', 'command'),
      ...base,
      publication: publicationIdentity(root.publication, 'publication'),
    };
  }
  if (root.command === 'start-current-config-worker' && root.publication === null) {
    return { command: 'start-current-config-worker', ...base, publication: null };
  }
  return invalid('publication');
}

export function parseConfigMasterMessage(input: unknown): ConfigMasterMessage {
  const root = snapshotMessage(input);
  switch (root.command ?? root.status) {
    case 'start-config-worker':
    case 'start-current-config-worker':
      return start(root);
    case 'drain-worker':
      exactRoot(root, DRAIN_FIELDS);
      return {
        command: 'drain-worker', ...processIdentity(root),
        revision: positiveInteger(root.revision, 'revision'),
        content_hash: digest(root.content_hash, 'content_hash'),
        plugin_catalog_hash: digest(root.plugin_catalog_hash, 'plugin_catalog_hash'),
        publication: root.publication === null ? null : publicationIdentity(root.publication, 'publication'),
      };
    case 'master-heartbeat':
      exactRoot(root, HEARTBEAT_FIELDS);
      return {
        command: 'master-heartbeat', ...processIdentity(root),
        master_pid: positiveInteger(root.master_pid, 'master_pid'),
        sequence: positiveInteger(root.sequence, 'sequence'),
      };
    case 'config-control-response':
      exactRoot(root, RESPONSE_FIELDS);
      return { status: 'config-control-response', ...processIdentity(root), request_id: identifier(root.request_id, 'request_id'), result: parseControlResult(root.result) };
    default:
      return invalid('command');
  }
}
