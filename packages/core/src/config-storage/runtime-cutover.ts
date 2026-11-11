import type { Database } from 'bun:sqlite';
import { readActiveRevision } from './current-revision';
import { readManagementProtection } from './management-protection';
import { ConfigRepositoryError } from './repository-types';
import { readRuntimeRecoveryBudget } from './runtime-recovery-budget';
import { sqliteAll, sqliteGet } from './sqlite-query';

export const CURRENT_RUNTIME_EPOCH = '(SELECT max(runtime_epoch) FROM runtime_cutovers)';

export type RuntimeCutover = Readonly<{
  runtime_epoch: number;
  stopped_container_id: string;
  saved_revision: number;
  confirmed_at: number;
}>;

export function readRuntimeEpoch(db: Database): number {
  const row = sqliteGet<{ runtime_epoch: number }, []>(db, `SELECT ${CURRENT_RUNTIME_EPOCH} AS runtime_epoch`);
  if (row === null || !Number.isSafeInteger(row.runtime_epoch) || row.runtime_epoch < 0) {
    throw new ConfigRepositoryError('schema_corrupt', 'current runtime epoch is invalid');
  }
  return row.runtime_epoch;
}

export function isCurrentRuntimeOperation(db: Database, mutationId: string): boolean {
  return sqliteGet<{ mutation_id: string }, [string]>(db, `SELECT mutation_id FROM configuration_operations
    WHERE mutation_id=? AND runtime_epoch=${CURRENT_RUNTIME_EPOCH}`, mutationId) !== null;
}

export function verifyRuntimeCutoverCatalog(db: Database, available: ReadonlySet<string> | undefined): void {
  if (available === undefined || readRuntimeEpoch(db) === 0) return;
  const { selectedProvider } = readManagementProtection(db);
  if (selectedProvider !== null && !available.has(selectedProvider)) {
    throw new ConfigRepositoryError('invalid_configuration', 'runtime cutover requires the protected management provider');
  }
}

export function recordRuntimeCutover(db: Database, stoppedContainerId: string, now: number): RuntimeCutover {
  if (typeof stoppedContainerId !== 'string' || !/^[0-9a-f]{64}$/.test(stoppedContainerId) ||
      !Number.isSafeInteger(now) || now < 0) {
    throw new ConfigRepositoryError('invalid_command', 'runtime cutover requires a full stopped Docker container ID and confirmation time');
  }
  const prior = sqliteGet<RuntimeCutover, [string]>(db, `SELECT runtime_epoch,stopped_container_id,saved_revision,confirmed_at
    FROM runtime_cutovers WHERE stopped_container_id=?`, stoppedContainerId);
  if (prior !== null) return prior;

  const cutover = { runtime_epoch: readRuntimeEpoch(db) + 1, stopped_container_id: stoppedContainerId,
    saved_revision: readActiveRevision(db), confirmed_at: now };
  db.run(`INSERT INTO runtime_cutovers(runtime_epoch,stopped_container_id,saved_revision,confirmed_at,recovery_budget_json)
    VALUES (?,?,?,?,?)`, [cutover.runtime_epoch, cutover.stopped_container_id, cutover.saved_revision, cutover.confirmed_at,
    JSON.stringify(readRuntimeRecoveryBudget(db))]);
  db.run(`UPDATE runtime_recovery_budget SET tickets=0,ticket_id=NULL,ticket_boot_id=NULL,retry_at_ns=NULL,
    healthy_owner=NULL,healthy_boot_id=NULL,healthy_since_ns=NULL,healthy_last_ns=NULL WHERE id=1`);
  return cutover;
}

export function auditRuntimeCutovers(db: Database, activeRevision: number): void {
  const cutovers = sqliteAll<{ runtime_epoch: number; saved_revision: number }, []>(db,
    'SELECT runtime_epoch,saved_revision FROM runtime_cutovers ORDER BY runtime_epoch');
  if (cutovers.length === 0 || cutovers.some((row, index) => row.runtime_epoch !== index ||
    row.saved_revision < (cutovers[index - 1]?.saved_revision ?? 1) || row.saved_revision > activeRevision)) {
    throw new ConfigRepositoryError('schema_corrupt', 'runtime cutover sequence is invalid');
  }
}
