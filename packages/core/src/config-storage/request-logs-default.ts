import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { commitTransaction } from './commit-transaction';
import { hashConfigurationRequest } from './content-hash';
import { readManagementProtection } from './management-protection';
import { finalizeOfflineOperation } from './operation-store';
import { prepareCommitCommand } from './prepared-command';
import { readPublicationRecoveryBarrier } from './recovery-store';
import { readRepositorySnapshot, verifyRepositoryIntegrity } from './repository-snapshot';
import { ConfigRepositoryError, type ConfigRepositoryOptions } from './repository-types';
import { sqliteGet } from './sqlite-query';
import { readUnsettledWorkerLaunches } from './worker-launch-store';

const PLUGIN = 'request-logs';

export function settleRequestLogsDefault(db: Database, options: ConfigRepositoryOptions, revision: number): void {
  if (!options.compileOptions?.availablePlugins?.has(PLUGIN)) return;
  db.run(`INSERT INTO configuration_request_logs_default (id,settled_revision) VALUES(1,?)
    ON CONFLICT(id) DO NOTHING`, [revision]);
}

/** Runs in the storage transaction once the catalog and publication fence permit it. */
export function applyRequestLogsDefault(
  db: Database, options: ConfigRepositoryOptions, targetWorkerSlots?: readonly number[],
): boolean {
  if (!options.compileOptions?.availablePlugins?.has(PLUGIN)) return false;
  const state = sqliteGet<{ updated_at: number }, []>(db, `SELECT updated_at FROM configuration_state WHERE id=1
    AND NOT EXISTS (SELECT 1 FROM configuration_request_logs_default WHERE id=1)`);
  if (state === null) return false;
  verifyRepositoryIntegrity(db);
  const snapshot = readRepositorySnapshot(db);
  let settledRevision = snapshot.revision;
  if (!snapshot.aggregate.plugin_activations.some(activation => activation.plugin_name === PLUGIN)) {
    // Recovery may need to run before the installation catalog is available again.
    const unfinished = sqliteGet<{ unfinished: number }, []>(db, `SELECT 1 AS unfinished FROM configuration_operations
        WHERE state IN ('committed','publishing','draining') OR (state='pending' AND committed_revision=(
          SELECT active_revision FROM configuration_state WHERE id=1))
      UNION ALL SELECT 1 FROM configuration_retirements WHERE state<>'released'
      UNION ALL SELECT 1 FROM configuration_recoveries WHERE state='stopped' AND recovery_sequence=(
        SELECT max(recovery_sequence) FROM configuration_recoveries WHERE target_revision=(
          SELECT active_revision FROM configuration_state WHERE id=1))
      LIMIT 1`);
    if (unfinished !== null || readPublicationRecoveryBarrier(db) !== null || readUnsettledWorkerLaunches(db).length > 0) return false;

    const aggregate = { ...snapshot.aggregate,
      plugin_activations: [...snapshot.aggregate.plugin_activations, { plugin_name: PLUGIN }],
    };
    const operationId = randomUUID();
    const now = Math.max(Date.now(), state.updated_at);
    const prepared = prepareCommitCommand({ mutation_id: operationId, expected_revision: snapshot.revision,
      aggregate, kind: 'config', created_at: now, target_worker_slots: targetWorkerSlots ?? [] });
    const provider = readManagementProtection(db).selectedProvider;
    const command = { ...prepared, managementProvider: provider,
      requestHash: hashConfigurationRequest({ kind: prepared.kind, expected_revision: prepared.expectedRevision,
        aggregate: prepared.aggregate, target_worker_slots: prepared.targetSlots, management_provider: provider }),
    };
    const result = commitTransaction(db, command, options, snapshot);
    if (result.kind !== 'committed') {
      throw new ConfigRepositoryError('migration_failed', `request logs activation revision commit failed (${result.kind})`);
    }
    if (targetWorkerSlots === undefined) finalizeOfflineOperation(db, operationId, now);
    settledRevision = readRepositorySnapshot(db).revision;
  }
  settleRequestLogsDefault(db, options, settledRevision);
  return settledRevision !== snapshot.revision;
}
