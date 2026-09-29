import { randomUUID } from 'node:crypto';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { hashConfigurationContent, hashConfigurationRequest } from '../content-hash';
import { auditConfigurationTables } from '../cross-table-audit';
import { replaceActiveMaterialization } from '../materialize';
import { readAllWorkers } from '../operation-records';
import { verifyRecoveryIntegrity } from '../recovery-store';
import { readRawActiveAggregate } from '../read-materialization';
import { ConfigRepositoryError } from '../repository-types';
import { sqliteAll, sqliteGet } from '../sqlite-query';
import { parseNormalizeCompileAggregate } from '../aggregate';
import { readRepositorySnapshot } from '../repository-snapshot';

type RevisionRow = { readonly revision: number; readonly content_hash: string };
type StateRow = { readonly active_revision: number; readonly updated_at: number };

function migrationError(message: string): never {
  throw new ConfigRepositoryError('schema_corrupt', message);
}

function validTimeouts(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  const allowed = new Set(['connect_ms', 'send_ms', 'read_ms']);
  return entries.every(([key, duration]) => allowed.has(key) &&
    typeof duration === 'number' && Number.isFinite(duration) && duration > 0);
}

function withoutServiceTimeouts(value: unknown): ConfigurationAggregateV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) migrationError('active legacy aggregate is malformed');
  const aggregate = value as { logical_configuration?: { services?: unknown[] } };
  const services = aggregate.logical_configuration?.services;
  if (!Array.isArray(services)) migrationError('active legacy services are malformed');
  let found = false;
  const stripped = services.map((service) => {
    if (typeof service !== 'object' || service === null || Array.isArray(service)) migrationError('legacy service is malformed');
    const record = service as Record<string, unknown>;
    if (!Object.hasOwn(record, 'timeouts')) return record;
    found = true;
    if (!validTimeouts(record.timeouts)) migrationError('legacy Service.timeouts must contain only positive connect_ms/send_ms/read_ms values');
    const { timeouts: _timeouts, ...rest } = record;
    return rest;
  });
  if (!found) migrationError('legacy timeout migration was requested without Service.timeouts');
  const logical = aggregate.logical_configuration as Record<string, unknown>;
  const result = parseNormalizeCompileAggregate({ ...value as object,
    logical_configuration: { ...logical, services: stripped } });
  if (!result.ok) throw new ConfigRepositoryError('schema_corrupt', 'legacy configuration is invalid after removing Service.timeouts', result.errors);
  const normalized = result.value;
  const expected = { ...value as object,
    logical_configuration: { ...logical, services: stripped } };
  if (hashConfigurationContent(normalized) !== hashConfigurationContent(expected as unknown as ConfigurationAggregateV2)) {
    migrationError('legacy timeout migration would cause unrelated configuration normalization');
  }
  return normalized;
}

export const CONFIG_MIGRATION_V11 = {
  version: 11,
  name: 'remove_legacy_service_timeouts',
  up(db: Database, workerCount?: number,
    faultInjection?: (stage: 'during_v11_after_materialization') => void): void {
    const raw = readRawActiveAggregate(db);
    const rawRoot = raw as { logical_configuration?: { services?: unknown[] } };
    const legacyFields = (rawRoot.logical_configuration?.services ?? []).some((service) =>
      typeof service === 'object' && service !== null && !Array.isArray(service) && Object.hasOwn(service, 'timeouts'));
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
    const audited = auditConfigurationTables(db);
    const active = audited.activeOperation;
    if (active === null || active.state !== 'converged') migrationError('active operation is not converged; legacy timeouts cannot be migrated safely');
    const workers = readAllWorkers(db).filter((worker) => worker.mutation_id === active.mutation_id);
    const oldSlots = workers.map(({ worker_slot }) => worker_slot).sort((a, b) => a - b);
    if (oldSlots.length === 0) migrationError('active operation has no worker slots');
    if (!Number.isSafeInteger(workerCount) || workerCount === undefined || workerCount < 1) {
      migrationError('a valid startup workerCount is required to migrate legacy Service.timeouts');
    }
    const slots = Array.from({ length: workerCount }, (_, slot) => slot);
    if (sqliteGet<{ readonly count: number }, []>(db,
      "SELECT count(*) AS count FROM configuration_recoveries WHERE state IN ('scheduled','running')")?.count !== 0) {
      migrationError('active recovery prevents legacy timeout migration');
    }
    const integrity = sqliteGet<{ readonly integrity_check: string }, []>(db, 'PRAGMA integrity_check')?.integrity_check;
    if (integrity !== 'ok' || sqliteAll<Record<string, unknown>, []>(db, 'PRAGMA foreign_key_check').length !== 0) {
      migrationError('configuration database integrity check failed before timeout migration');
    }
    const newAggregate = withoutServiceTimeouts(raw);
    const newHash = hashConfigurationContent(newAggregate);
    const requestHash = hashConfigurationRequest({ kind: 'config', expected_revision: state.active_revision,
      aggregate: newAggregate, target_worker_slots: slots });
    if (active.request_hash !== hashConfigurationRequest({ kind: active.kind, expected_revision: active.expected_revision,
      aggregate: rawAggregate, target_worker_slots: oldSlots })) migrationError('active legacy request hash does not match its aggregate');

    replaceActiveMaterialization(db, newAggregate);
    faultInjection?.('during_v11_after_materialization');
    const nextRevision = audited.activeRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) migrationError('configuration revision limit reached during timeout migration');
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
    const snapshot = readRepositorySnapshot(db);
    if (snapshot.revision !== nextRevision || snapshot.content_hash !== newHash ||
      hashConfigurationContent(snapshot.aggregate) !== newHash) {
      migrationError('new configuration snapshot failed post-migration verification');
    }
  },
} as const;
