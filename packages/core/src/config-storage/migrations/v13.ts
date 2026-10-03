import { randomUUID } from 'node:crypto';
import { PLUGIN_DURABLE_STATE_SCHEMA_SQL } from '../../plugin-durable-state';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { hashConfigurationContent, hashConfigurationRequest } from '../content-hash';
import { auditConfigurationTables } from '../cross-table-audit';
import { replaceActiveMaterialization } from '../materialize';
import { readAllWorkers } from '../operation-records';
import { verifyRecoveryIntegrity } from '../recovery-store';
import { readActiveAggregate, readRawActiveAggregate } from '../read-materialization';
import { ConfigRepositoryError } from '../repository-types';
import { sqliteAll, sqliteGet } from '../sqlite-query';
import { parseNormalizeCompileAggregate } from '../aggregate';

/** Historical credential schema only; active credentials belong to authentication plugins. */
const LEGACY_API_KEY_SCHEMA_SQL = `
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK(domain IN ('management', 'data')),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE CHECK(length(digest) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  credential_version INTEGER NOT NULL CHECK(credential_version > 0)
) STRICT;
CREATE INDEX api_keys_domain ON api_keys(domain);
`;

type RevisionRow = { readonly revision: number; readonly content_hash: string };
type StateRow = { readonly active_revision: number; readonly updated_at: number };

function migrationError(message: string): never {
  throw new ConfigRepositoryError('schema_corrupt', message);
}

function withoutLegacyAuth(value: ConfigurationAggregateV2): ConfigurationAggregateV2 {
  const logical = value.logical_configuration;
  const {auth: _auth, ...rest} = logical;
  const routes = logical.routes.map(route => { const {auth: _routeAuth, ...clean} = route; return clean; });
  const result = parseNormalizeCompileAggregate({...value, logical_configuration:{...rest,routes}});
  if (!result.ok) throw new ConfigRepositoryError('schema_corrupt', 'configuration is invalid after removing legacy auth', result.errors);
  return result.value;
}

export const CONFIG_MIGRATION_V13 = {
  version: 13,
  name: 'independent_credentials_and_plugin_durable_state',
  up(db: Database, workerCount?: number, unpublishedMigrationRevision?: number): void {
    db.exec(LEGACY_API_KEY_SCHEMA_SQL);
    db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
    const raw = readRawActiveAggregate(db);
    const rawRoot = raw as ConfigurationAggregateV2;
    const legacyFields = Object.hasOwn(rawRoot.logical_configuration, 'auth') || rawRoot.logical_configuration.routes.some(route => Object.hasOwn(route, 'auth'));
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
      migrationError('active recovery prevents legacy authentication migration');
    }
    const audited = auditConfigurationTables(db);
    const active = audited.activeOperation;
    const mergeUnpublished = active?.state === 'committed' && audited.activeRevision === unpublishedMigrationRevision;
    if (active === null || (!mergeUnpublished && active.state !== 'converged' && active.state !== 'degraded')) {
      migrationError('active operation is not terminal; legacy authentication cannot be migrated safely');
    }
    const workers = readAllWorkers(db).filter((worker) => worker.mutation_id === active.mutation_id);
    const oldSlots = workers.map(({ worker_slot }) => worker_slot).sort((a, b) => a - b);
    const targetWorkerCount = workerCount ?? Math.max(1, oldSlots.length);
    if (!Number.isSafeInteger(targetWorkerCount) || targetWorkerCount < 1) migrationError('invalid worker count during authentication migration');
    const slots = Array.from({ length: targetWorkerCount }, (_, slot) => slot);
    const integrity = sqliteGet<{ readonly integrity_check: string }, []>(db, 'PRAGMA integrity_check')?.integrity_check;
    if (integrity !== 'ok' || sqliteAll<Record<string, unknown>, []>(db, 'PRAGMA foreign_key_check').length !== 0) {
      migrationError('configuration database integrity check failed before authentication migration');
    }
    const newAggregate = withoutLegacyAuth(rawAggregate);
    const newHash = hashConfigurationContent(newAggregate);
    const requestHash = hashConfigurationRequest({ kind: 'config', expected_revision: state.active_revision,
      aggregate: newAggregate, target_worker_slots: slots });
    if (active.request_hash !== hashConfigurationRequest({ kind: active.kind, expected_revision: active.expected_revision,
      aggregate: rawAggregate, target_worker_slots: oldSlots })) migrationError('active legacy request hash does not match its aggregate');

    if (mergeUnpublished) {
      // v11 created this revision in the same uncommitted migration transaction.
      // Merge auth removal before it becomes observable; preserve all pre-existing history.
      replaceActiveMaterialization(db, newAggregate);
      db.run('UPDATE configuration_revisions SET content_hash=? WHERE revision=?', [newHash, audited.activeRevision]);
      db.run('UPDATE configuration_operations SET request_hash=? WHERE mutation_id=?', [
        hashConfigurationRequest({kind:active.kind, expected_revision:active.expected_revision, aggregate:newAggregate, target_worker_slots:oldSlots}),active.mutation_id]);
      db.run('INSERT INTO schema_migrations(version,name) VALUES (?,?)', [this.version, this.name]);
      if (hashConfigurationContent(readActiveAggregate(db)) !== newHash) migrationError('merged migration materialization is invalid');
      return;
    }
    replaceActiveMaterialization(db, newAggregate);
    const nextRevision = audited.activeRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) migrationError('configuration revision limit reached during authentication migration');
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
    const materialized = readActiveAggregate(db);
    if (hashConfigurationContent(materialized) !== newHash) {
      migrationError('new configuration snapshot failed post-migration verification');
    }
  },
} as const;
