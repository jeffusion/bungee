import { randomUUID } from 'node:crypto';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { hashConfigurationContent, hashConfigurationRequest } from '../content-hash';
import { auditConfigurationTables } from '../cross-table-audit';
import { replaceActiveMaterialization } from '../materialize';
import { readAllWorkers } from '../operation-records';
import { verifyRecoveryIntegrity } from '../recovery-store';
import { readRawActiveAggregate } from '../read-materialization';
import { readRepositorySnapshot } from '../repository-snapshot';
import { ConfigRepositoryError } from '../repository-types';
import { sqliteAll, sqliteGet } from '../sqlite-query';
import { migrateLegacyDirectionalAggregate, type DirectionalMigrationWarning } from '../directional-migration';
import { parseNormalizeCompileAggregate } from '../aggregate';

type RevisionRow = { readonly revision: number; readonly content_hash: string };
type StateRow = { readonly active_revision: number; readonly updated_at: number };

function migrationError(message: string): never {
  throw new ConfigRepositoryError('schema_corrupt', message);
}

function directionalConfiguration(converted: unknown): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate(converted);
  if (!result.ok) throw new ConfigRepositoryError('schema_corrupt', 'configuration is invalid after directional migration', result.errors);
  if (hashConfigurationContent(result.value) !== hashConfigurationContent(converted as ConfigurationAggregateV2)) {
    migrationError('directional migration would cause unrelated configuration normalization');
  }
  return result.value;
}

export const CONFIG_MIGRATION_V15 = {
  version: 15,
  name: 'directional_request_response_modifications',
  up(db: Database, workerCount?: number, unpublishedMigrationRevision?: number, warnings: DirectionalMigrationWarning[] = []): void {
    const raw = readRawActiveAggregate(db);
    const rawRoot = raw as ConfigurationAggregateV2;
    const converted = migrateLegacyDirectionalAggregate(rawRoot, warnings);
    const legacyFields = hashConfigurationContent(converted as ConfigurationAggregateV2) !== hashConfigurationContent(rawRoot);
    if (!legacyFields) {
      db.run('INSERT INTO schema_migrations(version,name) VALUES (?,?)', [this.version, this.name]);
      return;
    }
    const state = sqliteGet<StateRow, []>(db, 'SELECT active_revision,updated_at FROM configuration_state WHERE id=1');
    const revision = state === null ? null : sqliteGet<RevisionRow, [number]>(db,
      'SELECT revision,content_hash FROM configuration_revisions WHERE revision=?', state.active_revision);
    if (state === null || revision === null) migrationError('active configuration state or revision is missing');
    const rawAggregate = raw as ConfigurationAggregateV2;
    const rawHash = hashConfigurationContent(rawAggregate);
    if (rawHash !== revision.content_hash) migrationError('active legacy content hash does not match materialized configuration');
    verifyRecoveryIntegrity(db);
    if (sqliteGet<{ readonly count: number }, []>(db,
      "SELECT count(*) AS count FROM configuration_recoveries WHERE state IN ('scheduled','running')")?.count !== 0) {
      migrationError('active recovery prevents legacy directional rules migration');
    }
    const audited = auditConfigurationTables(db);
    const active = audited.activeOperation;
    const mergeUnpublished = active?.state === 'committed' && audited.activeRevision === unpublishedMigrationRevision;
    if (active === null || (!mergeUnpublished && active.state !== 'converged' && active.state !== 'degraded')) {
      migrationError('active operation is not terminal; legacy directional rules cannot be migrated safely');
    }
    const workers = readAllWorkers(db).filter((worker) => worker.mutation_id === active.mutation_id);
    const oldSlots = workers.map(({ worker_slot }) => worker_slot).sort((a, b) => a - b);
    const targetWorkerCount = workerCount ?? Math.max(1, oldSlots.length);
    if (!Number.isSafeInteger(targetWorkerCount) || targetWorkerCount < 1) migrationError('invalid worker count during directional rules migration');
    const slots = Array.from({ length: targetWorkerCount }, (_, slot) => slot);
    const integrity = sqliteGet<{ readonly integrity_check: string }, []>(db, 'PRAGMA integrity_check')?.integrity_check;
    if (integrity !== 'ok' || sqliteAll<Record<string, unknown>, []>(db, 'PRAGMA foreign_key_check').length !== 0) {
      migrationError('configuration database integrity check failed before directional rules migration');
    }
    const newAggregate = directionalConfiguration(converted);
    const newHash = hashConfigurationContent(newAggregate);
    const requestHash = hashConfigurationRequest({ kind: 'config', expected_revision: state.active_revision,
      aggregate: newAggregate, target_worker_slots: slots });
    if (active.request_hash !== hashConfigurationRequest({ kind: active.kind, expected_revision: active.expected_revision,
      aggregate: rawAggregate, target_worker_slots: oldSlots })) migrationError('active legacy request hash does not match its aggregate');

    if (mergeUnpublished) {
      // Earlier migrations created this revision in the same transaction.
      // Merge before publication; preserve all pre-existing history.
      replaceActiveMaterialization(db, newAggregate);
      db.run('UPDATE configuration_revisions SET content_hash=? WHERE revision=?', [newHash, audited.activeRevision]);
      db.run('UPDATE configuration_operations SET request_hash=? WHERE mutation_id=?', [
        hashConfigurationRequest({kind:active.kind, expected_revision:active.expected_revision, aggregate:newAggregate, target_worker_slots:oldSlots}),active.mutation_id]);
      db.run('INSERT INTO schema_migrations(version,name) VALUES (?,?)', [this.version, this.name]);
      if (readRepositorySnapshot(db, false, 15).content_hash !== newHash) migrationError('merged migration materialization is invalid');
      return;
    }
    replaceActiveMaterialization(db, newAggregate);
    const nextRevision = audited.activeRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) migrationError('configuration revision limit reached during directional rules migration');
    const now = Math.max(Date.now(), state.updated_at, active.updated_at);
    const mutationId = randomUUID();
    db.run('INSERT INTO configuration_revisions(revision,content_hash,kind,created_at) VALUES(?,?,\'config\',?)', [nextRevision, newHash, now]);
    db.run(`INSERT INTO configuration_operations
      (mutation_id,request_hash,expected_revision,committed_revision,kind,state,result_status,error_code,error_detail,
       drain_recovery_generation,last_drain_recovery_previous_generation,target_worker_count,created_at,updated_at)
      VALUES(?,?,?,?,'config','committed',NULL,NULL,NULL,0,NULL,?,?,?)`,
    [mutationId, requestHash, audited.activeRevision, nextRevision, slots.length, now, now]);
    for (const slot of slots) db.run(`INSERT INTO configuration_operation_workers
      (mutation_id,worker_slot,target_revision,drain_recovery_generation,attempt_no,last_begin_previous_attempt_no,
       last_begin_reason,state,applied_revision,last_error,updated_at)
      VALUES(?,?,?,0,0,NULL,NULL,'pending',NULL,NULL,?)`, [mutationId, slot, nextRevision, now]);
    if (db.run('UPDATE configuration_state SET active_revision=?,updated_at=? WHERE id=1 AND active_revision=?',
      [nextRevision, now, audited.activeRevision]).changes !== 1) migrationError('active configuration revision update failed');
    db.run('INSERT INTO schema_migrations(version,name) VALUES (?,?)', [this.version, this.name]);
    // Validate this migration's materialization without requiring later schema versions.
    const snapshot = readRepositorySnapshot(db, false, 15);
    if (snapshot.revision !== nextRevision || snapshot.content_hash !== newHash || hashConfigurationContent(snapshot.aggregate) !== newHash) {
      migrationError('new configuration snapshot failed post-migration verification');
    }
  },
} as const;
