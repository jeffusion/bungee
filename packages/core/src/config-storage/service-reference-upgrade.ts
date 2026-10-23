import type { Database } from 'bun:sqlite';
import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import { randomUUID } from 'node:crypto';
import { readActiveAggregate } from './read-materialization';
import { auditConfigurationTables, verifyActiveRequestIdentity } from './cross-table-audit';
import { hashConfigurationContent, hashConfigurationRequest } from './content-hash';
import { commitTransaction } from './commit-transaction';
import { prepareCommitCommand } from './prepared-command';
import { readManagementProtection } from './management-protection';
import { beginPublication, markDraining, finalizePublication } from './operation-store';
import { ConfigRepositoryError, type ConfigRepositoryOptions } from './repository-types';
import { verifyRepositoryIntegrity, readRepositorySnapshot } from './repository-snapshot';

/** Runs inside the schema migration transaction, never as a runtime format fallback. */
export function convertServiceReferenceRevision(db: Database, options: ConfigRepositoryOptions): void {
  const unfinished = db.query<{kind:string;identity:string;state:string},[]>(`
    SELECT 'publication' AS kind,mutation_id AS identity,state FROM configuration_operations
      WHERE state IN ('committed','publishing','draining')
    UNION ALL SELECT 'retirement',mutation_id,state FROM configuration_retirements WHERE state<>'released'
    UNION ALL SELECT 'recovery',recovery_id,state FROM configuration_recoveries
      WHERE state IN ('scheduled','running') OR (state='stopped'
        AND target_revision=(SELECT active_revision FROM configuration_state WHERE id=1)
        AND recovery_sequence=(SELECT max(recovery_sequence) FROM configuration_recoveries
          WHERE target_revision=(SELECT active_revision FROM configuration_state WHERE id=1)))
    LIMIT 1`).get();
  if (unfinished) throw new ConfigRepositoryError('migration_failed',
    `service reference upgrade cannot resume ${unfinished.kind} ${unfinished.identity} (${unfinished.state}); finish it with the previous executable before upgrading`);

  verifyRepositoryIntegrity(db);
  const audited = auditConfigurationTables(db);
  const aggregate = readActiveAggregate(db);
  // SQL converted only the old Route column. Reconstruct that exact pre-upgrade
  // identity to verify the current hash and operation before creating a revision.
  const previous = {
    ...aggregate,
    logical_configuration: { ...aggregate.logical_configuration,
      routes: aggregate.logical_configuration.routes.map(route => {
        if (!route.service_references) return route;
        const { service_references, ...rest } = route;
        if (service_references.length !== 1) throw new ConfigRepositoryError('migration_failed', 'unexpected route references during upgrade');
        return { ...rest, service_id: service_references[0]!.service_id };
      }),
    },
  } as unknown as ConfigurationAggregate;
  const previousHash = hashConfigurationContent(previous);
  if (previousHash !== audited.activeRevisionRow.content_hash) {
    throw new ConfigRepositoryError('schema_corrupt', 'pre-upgrade configuration content hash does not match');
  }
  verifyActiveRequestIdentity(audited, previous);
  if (hashConfigurationContent(aggregate) === previousHash) return;
  const snapshot = {revision: audited.activeRevision, content_hash: previousHash, aggregate: previous};
  const operationId = randomUUID(), now = Math.max(Date.now(), audited.activeOperation?.updated_at ?? 0);
  const prepared = prepareCommitCommand({mutation_id: operationId, expected_revision: snapshot.revision,
    aggregate, kind: 'config', created_at: now, target_worker_slots: []});
  const provider = readManagementProtection(db).selectedProvider;
  const command = { ...prepared, managementProvider: provider,
    requestHash: hashConfigurationRequest({ kind: prepared.kind, expected_revision: prepared.expectedRevision,
      aggregate: prepared.aggregate, target_worker_slots: [], management_provider: provider }) };
  const result = commitTransaction(db, command, options, snapshot);
  if (result.kind !== 'committed') throw new ConfigRepositoryError('migration_failed', `service reference revision commit failed (${result.kind})`);
  beginPublication(db, operationId, now);
  markDraining(db, operationId, now);
  finalizePublication(db, operationId, {outcome:'converged',old_workers_exited:true}, now);
  // Include materialization, request identity, and hash auditing in the same rollback boundary.
  readRepositorySnapshot(db);
}
