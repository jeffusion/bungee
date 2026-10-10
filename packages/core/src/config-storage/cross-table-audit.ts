import type { Database } from 'bun:sqlite';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { hashConfigurationContent, hashConfigurationRequest } from './content-hash';
import type { ConfigurationOperation } from './repository-types';
import { readAllOperations, readAllWorkers } from './operation-store';
import { requireSafeInteger } from './persisted-validation';
import { ConfigRepositoryError } from './repository-types';
import { validateDigest } from './repository-validation';
import { sqliteAll } from './sqlite-query';
import { validateOperationRelations } from './operation-relations';

type StateRow = {
  readonly id: number; readonly active_revision: number; readonly schema_version: number;
  readonly created_at: number; readonly updated_at: number;
};
type RevisionRow = {
  readonly revision: number; readonly content_hash: string; readonly kind: string; readonly created_at: number;
};

const EMPTY_AGGREGATE = {
  logical_configuration: { services: [], routes: [], plugins: [] },
  plugin_activations: [],
} as const;
const INITIAL_REVISION_HASH = hashConfigurationContent(EMPTY_AGGREGATE);

export type AuditedConfigurationState = {
  readonly activeRevision: number;
  readonly activeRevisionRow: RevisionRow;
  readonly activeOperation: ConfigurationOperation | null;
  readonly activeTargetSlots: readonly number[];
};

export function auditConfigurationTables(db: Database): AuditedConfigurationState {
  const states = sqliteAll<StateRow, []>(db, `SELECT id,active_revision,schema_version,created_at,updated_at
    FROM configuration_state ORDER BY id`);
  const state = states[0];
  if (states.length !== 1 || state === undefined || state.id !== 1 || state.schema_version !== 4) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration state singleton is broken');
  }
  requireSafeInteger(state.active_revision, 'configuration_state.active_revision', 1);
  requireSafeInteger(state.created_at, 'configuration_state.created_at');
  requireSafeInteger(state.updated_at, 'configuration_state.updated_at', state.created_at);
  const revisions = sqliteAll<RevisionRow, []>(db, `SELECT revision,content_hash,kind,created_at
    FROM configuration_revisions ORDER BY revision`);
  if (revisions.length !== state.active_revision) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration revisions are not contiguous');
  }
  for (const [index, revision] of revisions.entries()) {
    requireSafeInteger(revision.revision, 'configuration_revisions.revision', 1);
    requireSafeInteger(revision.created_at, 'configuration_revisions.created_at');
    if (revision.revision !== index + 1 || !validateDigest(revision.content_hash) ||
        (revision.kind !== 'config' && revision.kind !== 'admin_state')) {
      throw new ConfigRepositoryError('schema_corrupt', 'configuration revision metadata is invalid');
    }
  }
  const initialRevision = revisions[0];
  if (initialRevision === undefined || initialRevision.content_hash !== INITIAL_REVISION_HASH ||
      initialRevision.kind !== 'config' || initialRevision.created_at !== 0) {
    throw new ConfigRepositoryError('schema_corrupt', 'initial revision identity is invalid');
  }
  const operations = readAllOperations(db);
  if (operations.length !== revisions.length - 1) {
    throw new ConfigRepositoryError('schema_corrupt', 'revision operation cardinality is invalid');
  }
  const operationsByRevision = new Map(operations.map((operation) => [operation.committed_revision, operation]));
  for (const revision of revisions.slice(1)) {
    const operation = operationsByRevision.get(revision.revision);
    if (operation === undefined || operation.expected_revision !== revision.revision - 1 ||
        operation.kind !== revision.kind || operation.created_at !== revision.created_at) {
      throw new ConfigRepositoryError('schema_corrupt', 'revision operation metadata is incoherent');
    }
  }
  const operationsByMutation = new Map(operations.map((operation) => [operation.mutation_id, operation]));
  const workersByMutation = new Map<string, ReturnType<typeof readAllWorkers>>();
  for (const worker of readAllWorkers(db)) {
    const operation = operationsByMutation.get(worker.mutation_id);
    if (operation === undefined || worker.target_revision !== operation.committed_revision ||
        worker.updated_at < operation.created_at || worker.updated_at > operation.updated_at) {
      throw new ConfigRepositoryError('schema_corrupt', 'operation worker metadata is incoherent');
    }
    workersByMutation.set(worker.mutation_id, [...(workersByMutation.get(worker.mutation_id) ?? []), worker]);
  }
  for (const operation of operations) {
    const workers = workersByMutation.get(operation.mutation_id) ?? [];
    validateOperationRelations(operation, workers);
    if (operation.committed_revision !== state.active_revision &&
        (operation.state === 'committed' || operation.state === 'publishing' || operation.state === 'draining')) {
      throw new ConfigRepositoryError('schema_corrupt', 'non-active operation is not terminal');
    }
  }
  const activeRevisionRow = revisions.at(-1);
  if (activeRevisionRow === undefined) throw new ConfigRepositoryError('schema_corrupt', 'active revision is missing');
  const activeOperation = operationsByRevision.get(state.active_revision) ?? null;
  const activeTargetSlots = activeOperation === null ? [] :
    (workersByMutation.get(activeOperation.mutation_id) ?? []).map(({ worker_slot }) => worker_slot).sort((left, right) => left - right);
  return {
    activeRevision: state.active_revision,
    activeRevisionRow, activeOperation, activeTargetSlots,
  };
}

export function verifyActiveRequestIdentity(
  audited: AuditedConfigurationState,
  aggregate: ConfigurationAggregateV2,
): void {
  const operation = audited.activeOperation;
  if (operation === null) return;
  const requestHash = hashConfigurationRequest({
    kind: operation.kind,
    expected_revision: operation.expected_revision,
    aggregate,
    target_worker_slots: audited.activeTargetSlots,
  });
  if (requestHash !== operation.request_hash) {
    throw new ConfigRepositoryError('schema_corrupt', 'active operation request hash is incoherent');
  }
}
