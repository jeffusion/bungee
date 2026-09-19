import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2, Sha256Digest } from '@jeffusion/bungee-types';
import {
  ConfigRepository,
  ConfigRepositoryError,
  canonicalJson,
  hashConfigurationContent,
  hashConfigurationRequest,
  type ConfigRepositoryOptions,
  type RepositorySnapshot,
} from '../../src/config-storage';
import { CONFIG_MIGRATION_V1 } from '../../src/config-storage/migrations/v1';
import { CONFIG_MIGRATION_V2 } from '../../src/config-storage/migrations/v2';
import { CONFIG_MIGRATION_V3 } from '../../src/config-storage/migrations/v3';
import { CONFIG_MIGRATION_V4 } from '../../src/config-storage/migrations/v4';
import { CONFIG_MIGRATION_V5 } from '../../src/config-storage/migrations/v5';
import { CONFIG_MIGRATION_V6 } from '../../src/config-storage/migrations/v6';
import { CONFIG_MIGRATION_V7 } from '../../src/config-storage/migrations/v7';
import { CONFIG_MIGRATION_V8 } from '../../src/config-storage/migrations/v8';
import { CONFIG_MIGRATION_V10 } from '../../src/config-storage/migrations/v10';
import { verifySchemaFingerprint } from '../../src/config-storage/schema-fingerprint';

const EMPTY_AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: { services: [], routes: [], plugins: [] },
  plugin_activations: [],
};
const CATALOG_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Sha256Digest;
const CATALOG_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Sha256Digest;
const MAX_AGGREGATE_BYTES = 1_048_576;

const roots: string[] = [];
const repositories: ConfigRepository[] = [];

function openRepository(options: ConfigRepositoryOptions = {}): ConfigRepository {
  const root = mkdtempSync(join(tmpdir(), 'bungee-serving-snapshot-'));
  roots.push(root);
  const repository = ConfigRepository.open(join(root, 'config.db'), options);
  repositories.push(repository);
  return repository;
}

function snapshot(repository: ConfigRepository): RepositorySnapshot {
  return repository.getSnapshot();
}

function expectError(action: () => unknown, code: ConfigRepositoryError['code']): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ConfigRepositoryError);
  if (error instanceof ConfigRepositoryError) expect(error.code).toBe(code);
}

function mutateServingRow(repository: ConfigRepository, aggregateJson: string): void {
  const db = repository.getDatabase();
  db.run('DROP TRIGGER configuration_serving_snapshots_immutable_update');
  db.run('PRAGMA ignore_check_constraints=ON');
  db.run('UPDATE configuration_serving_snapshots SET aggregate_json=?', [aggregateJson]);
  db.run('PRAGMA ignore_check_constraints=OFF');
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('configuration serving snapshot migration', () => {
  test('upgrades a fixed V9 schema without regenerating it from CONFIG_MIGRATION_V9', () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-fixed-v9-'));
    roots.push(root);
    const path = join(root, 'config.db');
    const db = new Database(path, { create: true, readwrite: true, strict: true });
    db.transaction(() => {
      CONFIG_MIGRATION_V1.up(db); CONFIG_MIGRATION_V2.up(db); CONFIG_MIGRATION_V3.up(db); CONFIG_MIGRATION_V4.up(db);
      CONFIG_MIGRATION_V5.up(db); CONFIG_MIGRATION_V6.up(db); CONFIG_MIGRATION_V7.up(db); CONFIG_MIGRATION_V8.up(db);
      db.run(`CREATE TABLE configuration_recoveries (
      recovery_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(recovery_sequence > 0),
      recovery_id TEXT NOT NULL UNIQUE CHECK(length(recovery_id)=36 AND substr(recovery_id,9,1)='-' AND substr(recovery_id,14,1)='-' AND substr(recovery_id,19,1)='-' AND substr(recovery_id,24,1)='-' AND replace(recovery_id,'-','') NOT GLOB '*[^0-9a-f]*'),
      source_mutation_id TEXT NOT NULL,
      target_revision INTEGER NOT NULL CHECK(target_revision > 0 AND target_revision <= 9007199254740991),
      trigger TEXT NOT NULL CHECK(trigger IN ('automatic','manual')),
      state TEXT NOT NULL CHECK(state IN ('scheduled','running','succeeded','stopped')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0 AND attempt_count <= 6),
      max_attempts INTEGER NOT NULL CHECK(max_attempts=6),
      next_retry_at INTEGER CHECK(next_retry_at IS NULL OR
        (next_retry_at >= 0 AND next_retry_at <= 9007199254740991)),
      final_reason_code TEXT CHECK(final_reason_code IS NULL OR final_reason_code IN
  ('target_serving','already_serving','deterministic_worker_rejection','deterministic_protocol_failure',
   'deterministic_control_failure','retry_exhausted','revision_superseded','safety_outcome_unknown')),
      final_reason_detail TEXT,
      created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
      updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= 9007199254740991),
      FOREIGN KEY(source_mutation_id) REFERENCES configuration_operations(mutation_id),
      FOREIGN KEY(target_revision) REFERENCES configuration_revisions(revision),
      CHECK((state='scheduled' AND final_reason_code IS NULL AND final_reason_detail IS NULL) OR
            (state='running' AND next_retry_at IS NULL AND final_reason_code IS NULL AND final_reason_detail IS NULL) OR
            (state='succeeded' AND
             ((final_reason_code='already_serving' AND attempt_count=0) OR
              (final_reason_code='target_serving' AND attempt_count > 0)) AND next_retry_at IS NULL) OR
            (state='stopped' AND final_reason_code IN
              ('deterministic_worker_rejection','deterministic_protocol_failure','deterministic_control_failure',
               'revision_superseded') AND next_retry_at IS NULL) OR
            (state='stopped' AND final_reason_code='retry_exhausted' AND attempt_count=6 AND next_retry_at IS NULL) OR
            (state='stopped' AND final_reason_code='safety_outcome_unknown' AND attempt_count > 0 AND next_retry_at IS NULL)),
      CHECK(state <> 'scheduled' OR next_retry_at IS NULL OR next_retry_at > updated_at),
      CHECK(state <> 'scheduled' OR attempt_count < 6),
      CHECK(state <> 'running' OR attempt_count > 0),
      CHECK(final_reason_detail IS NULL OR
        (length(final_reason_detail) <= 512 AND length(trim(final_reason_detail)) > 0))
    ) STRICT`);
    db.run(`CREATE UNIQUE INDEX configuration_recoveries_active_target_revision
      ON configuration_recoveries(target_revision) WHERE state IN ('scheduled','running')`);
    db.run(`CREATE TRIGGER configuration_recoveries_sequence_update_guard
      BEFORE UPDATE OF recovery_sequence ON configuration_recoveries
      BEGIN
        SELECT RAISE(ABORT,'recovery sequence is immutable');
      END`);
    db.run(`CREATE TRIGGER configuration_recoveries_sequence_insert_guard
      BEFORE INSERT ON configuration_recoveries
      WHEN NEW.recovery_sequence != -1
      BEGIN
        SELECT RAISE(ABORT,'recovery sequence is database assigned');
      END`);
    db.run(`CREATE TRIGGER configuration_recoveries_no_delete
      BEFORE DELETE ON configuration_recoveries
      BEGIN
        SELECT RAISE(ABORT,'configuration recovery cannot be deleted');
      END`);
    db.run(`CREATE TRIGGER configuration_operations_terminal_immutable_update
      BEFORE UPDATE ON configuration_operations
      WHEN OLD.state IN ('converged','degraded')
      BEGIN
        SELECT RAISE(ABORT,'terminal configuration operations are immutable');
      END`);
    db.run(`CREATE TRIGGER configuration_operations_terminal_immutable_delete
      BEFORE DELETE ON configuration_operations
      WHEN OLD.state IN ('converged','degraded')
      BEGIN
        SELECT RAISE(ABORT,'terminal configuration operations are immutable');
      END`);
      const contentHash = db.query<{ content_hash: string }, [number]>(
        'SELECT content_hash FROM configuration_revisions WHERE revision=?').get(1)?.content_hash;
      if (contentHash === undefined) throw new Error('fixed V9 fixture revision is missing');
      db.run('INSERT INTO configuration_revisions(revision,content_hash,kind,created_at) VALUES (2,?,?,?)', [contentHash, 'config', 4]);
      db.run('UPDATE configuration_state SET active_revision=2 WHERE id=1');
      const requestHash = hashConfigurationRequest({ kind: 'config', expected_revision: 1,
        aggregate: EMPTY_AGGREGATE, target_worker_slots: [0] });
      db.run(`INSERT INTO configuration_operations
        (mutation_id,request_hash,expected_revision,committed_revision,kind,target_worker_count,state,result_status,error_code,error_detail,drain_recovery_generation,last_drain_recovery_previous_generation,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['fixed-v9-operation', requestHash, 1, 2, 'config', 1, 'degraded', 202, 'replacement_convergence_failed', 'fixed v9 failure', 0, null, 4, 4]);
      db.run(`INSERT INTO configuration_operation_workers
        (mutation_id,worker_slot,target_revision,drain_recovery_generation,attempt_no,last_begin_previous_attempt_no,last_begin_reason,state,applied_revision,last_error,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ['fixed-v9-operation', 0, 2, 0, 1, 0, 'initial', 'failed', null, 'worker failed', 4]);
      db.run(`INSERT INTO configuration_recoveries
        (recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,next_retry_at,final_reason_code,final_reason_detail,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ['33333333-3333-4333-8333-333333333333', 'fixed-v9-operation', 2, 'automatic', 'scheduled', 0, 6, null, null, null, 5, 5]);
      db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [9, 'durable_configuration_recoveries']);
    }).immediate();
    const operationBytes = db.query<Record<string, unknown>, [string]>(
      'SELECT * FROM configuration_operations WHERE mutation_id=?').get('fixed-v9-operation');
    const recoveryBytes = db.query<Record<string, unknown>, [string]>(
      'SELECT * FROM configuration_recoveries WHERE recovery_id=?').get('33333333-3333-4333-8333-333333333333');
    db.close(true);
    const repository = ConfigRepository.open(path);
    repositories.push(repository);
    expect(repository.getDatabase().query<{ version: number; name: string }, []>('SELECT version,name FROM schema_migrations ORDER BY version').all().at(-1))
      .toEqual({ version: 10, name: 'fatal_configuration_recovery_marker' });
    expect(repository.getDatabase().query<Record<string, unknown>, [string]>(
      'SELECT * FROM configuration_operations WHERE mutation_id=?').get('fixed-v9-operation')).toEqual(operationBytes);
    expect(repository.getDatabase().query<Record<string, unknown>, [string]>(
      'SELECT * FROM configuration_recoveries WHERE recovery_id=?').get('33333333-3333-4333-8333-333333333333')).toEqual(recoveryBytes);
    expect(() => verifySchemaFingerprint(repository.getDatabase())).not.toThrow();
    expect(repository.getDatabase().query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get('configuration_recoveries')?.sql).toContain('fatal_source_failure');
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const reopened = ConfigRepository.open(path);
    repositories.push(reopened);
    expect(reopened.getCurrentRecovery()?.state).toBe('scheduled');
    expect(reopened.getDatabase().query<Record<string, unknown>, [string]>(
      'SELECT * FROM configuration_recoveries WHERE recovery_id=?').get('33333333-3333-4333-8333-333333333333')).toEqual(recoveryBytes);
  });

  test('fresh schema includes v10 and rejects a UTF-16 v7 fixture before running v8', () => {
    const fresh = openRepository();
    const freshDb = fresh.getDatabase();
    expect(freshDb.query<{ version: number; name: string }, []>(
      'SELECT version,name FROM schema_migrations ORDER BY version',
    ).all()).toHaveLength(10);
    expect(freshDb.query<{ name: string; sql: string }, []>(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name='configuration_serving_snapshots'",
    ).get()?.sql).toContain('STRICT');
    expect(() => verifySchemaFingerprint(freshDb)).not.toThrow();

    const root = mkdtempSync(join(tmpdir(), 'bungee-serving-utf16-v7-'));
    roots.push(root);
    const path = join(root, 'config.db');
    const db = new Database(path, { create: true, readwrite: true, strict: true });
    db.run("PRAGMA encoding='UTF-16'");
    db.transaction(() => {
      CONFIG_MIGRATION_V1.up(db);
      CONFIG_MIGRATION_V2.up(db);
      CONFIG_MIGRATION_V3.up(db);
      CONFIG_MIGRATION_V4.up(db);
      CONFIG_MIGRATION_V5.up(db);
      CONFIG_MIGRATION_V6.up(db);
      CONFIG_MIGRATION_V7.up(db);
    }).immediate();
    db.close(true);
    expectError(() => ConfigRepository.open(path), 'connection_invariant');

    const inspector = new Database(path, { readonly: true, strict: true });
    expect(inspector.query<{ encoding: string }, []>('PRAGMA encoding').get()?.encoding).not.toBe('UTF-8');
    expect(inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM schema_migrations').get()?.count).toBe(7);
    expect(inspector.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='configuration_serving_snapshots'",
    ).get()?.count).toBe(0);
    inspector.close(true);
  });

  test('regresses the v8 table, key, FK, index, and immutability DDL', () => {
    const repository = openRepository();
    const db = repository.getDatabase();
    expect(db.query<{ wr: number; strict: number }, [string]>(
      'SELECT wr,strict FROM pragma_table_list(?)',
    ).get('configuration_serving_snapshots')).toEqual({ wr: 1, strict: 1 });
    const primaryKey = db.query<{ name: string }, [string]>(
      "SELECT name FROM pragma_index_list(?) WHERE origin='pk'",
    ).get('configuration_serving_snapshots')?.name;
    if (primaryKey === undefined) throw new Error('serving snapshot primary key is missing');
    expect(db.query<{ seq: number; name: string }, [string]>(
      'SELECT seqno AS seq,name FROM pragma_index_info(?) ORDER BY seqno',
    ).all(primaryKey)).toEqual([
      { seq: 0, name: 'revision' }, { seq: 1, name: 'content_hash' }, { seq: 2, name: 'plugin_catalog_hash' },
    ]);
    expect(db.query<{ unique: number; name: string }, [string, string]>(
      'SELECT "unique",name FROM pragma_index_list(?) WHERE name=?',
    ).get('configuration_revisions', 'configuration_revisions_revision_content_hash')).toEqual({
      unique: 1, name: 'configuration_revisions_revision_content_hash',
    });
    expect(db.query<{ seq: number; table: string; from: string; to: string }, [string]>(
      'SELECT seq,"table","from","to" FROM pragma_foreign_key_list(?) ORDER BY seq',
    ).all('configuration_serving_snapshots')).toEqual([
      { seq: 0, table: 'configuration_revisions', from: 'revision', to: 'revision' },
      { seq: 1, table: 'configuration_revisions', from: 'content_hash', to: 'content_hash' },
    ]);
    expect(db.query<{ name: string; sql: string }, [string]>(
      'SELECT name,sql FROM sqlite_master WHERE type=\'trigger\' AND tbl_name=? ORDER BY name',
    ).all('configuration_serving_snapshots')).toEqual([
      { name: 'configuration_serving_snapshots_immutable_delete', sql: expect.stringContaining('RAISE(ABORT') },
      { name: 'configuration_serving_snapshots_immutable_update', sql: expect.stringContaining('RAISE(ABORT') },
    ]);
  });

  test('upgrades a UTF-8 v7 fixture through v8 and fingerprints the result', () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-serving-v7-upgrade-'));
    roots.push(root);
    const path = join(root, 'config.db');
    const db = new Database(path, { create: true, readwrite: true, strict: true });
    db.transaction(() => {
      CONFIG_MIGRATION_V1.up(db);
      CONFIG_MIGRATION_V2.up(db);
      CONFIG_MIGRATION_V3.up(db);
      CONFIG_MIGRATION_V4.up(db);
      CONFIG_MIGRATION_V5.up(db);
      CONFIG_MIGRATION_V6.up(db);
      CONFIG_MIGRATION_V7.up(db);
    }).immediate();
    db.close(true);

    const repository = ConfigRepository.open(path);
    repositories.push(repository);
    expect(repository.getDatabase().query<{ version: number }, []>('SELECT version FROM schema_migrations').all()).toHaveLength(10);
    expect(() => verifySchemaFingerprint(repository.getDatabase())).not.toThrow();
  });
});

describe('configuration serving snapshots', () => {
  test('remains catalog-neutral across reopen and permits catalog-only keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-serving-catalog-neutral-'));
    roots.push(root);
    const path = join(root, 'config.db');
    const catalogA: ConfigRepositoryOptions = { compileOptions: { pluginSchemas: new Map([['foo', []]]) } };
    const first = ConfigRepository.open(path, catalogA);
    repositories.push(first);
    const aggregate: ConfigurationAggregateV2 = {
      logical_configuration: {
        services: [], routes: [],
        plugins: [{ id: '40000000-0000-4000-8000-000000000001', position: 0, name: 'foo', enabled: true }],
      },
      plugin_activations: [{ plugin_name: 'foo' }],
    };
    const committed = first.commit({
      mutation_id: 'catalog-neutral', expected_revision: 1, aggregate, kind: 'config',
      created_at: 1_700_000_000_001, target_worker_slots: [],
    });
    expect(committed.kind).toBe('committed');
    if (committed.kind !== 'committed') return;
    first.appendServingSnapshot(committed.snapshot, CATALOG_A);
    first.close();
    repositories.splice(repositories.indexOf(first), 1);

    const second = ConfigRepository.open(path, { compileOptions: { pluginSchemas: new Map() } });
    repositories.push(second);
    second.appendServingSnapshot(committed.snapshot, CATALOG_A);
    second.appendServingSnapshot(committed.snapshot, CATALOG_B);
    expect(second.getServingSnapshot({
      revision: committed.snapshot.revision,
      content_hash: committed.snapshot.content_hash,
      plugin_catalog_hash: CATALOG_A,
    })).toEqual(committed.snapshot);
    expect(second.getServingSnapshot({
      revision: committed.snapshot.revision,
      content_hash: committed.snapshot.content_hash,
      plugin_catalog_hash: CATALOG_B,
    })).toEqual(committed.snapshot);
  });

  test('round-trips, is idempotent, and permits catalog-only keys', () => {
    const repository = openRepository();
    const value = snapshot(repository);
    repository.appendServingSnapshot(value, CATALOG_A);
    repository.appendServingSnapshot(value, CATALOG_A);
    repository.appendServingSnapshot(value, CATALOG_B);

    expect(repository.getServingSnapshot({
      revision: value.revision, content_hash: value.content_hash, plugin_catalog_hash: CATALOG_A,
    })).toEqual(value);
    expect(repository.getServingSnapshot({
      revision: value.revision, content_hash: value.content_hash, plugin_catalog_hash: CATALOG_B,
    })).toEqual(value);
    expect(repository.getDatabase().query<{ count: number }, []>(
      'SELECT count(*) AS count FROM configuration_serving_snapshots',
    ).get()?.count).toBe(2);
    expect(repository.getServingSnapshot({
      revision: value.revision, content_hash: value.content_hash, plugin_catalog_hash:
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as Sha256Digest,
    })).toBeNull();
  });

  test('rejects invalid digests, oversized aggregates, and revision/hash mismatches', () => {
    const repository = openRepository();
    const value = snapshot(repository);
    expectError(() => repository.appendServingSnapshot(value, 'sha256:bad' as Sha256Digest), 'invalid_configuration');
    const oversized: ConfigurationAggregateV2 = {
      logical_configuration: { auth: { enabled: true, tokens: ['x'.repeat(1_100_000)] }, services: [], routes: [], plugins: [] },
      plugin_activations: [],
    };
    expectError(() => repository.appendServingSnapshot({
      revision: 1, content_hash: hashConfigurationContent(oversized), aggregate: oversized,
    }, CATALOG_A), 'invalid_configuration');
    expectError(() => repository.appendServingSnapshot({
      ...value, content_hash: CATALOG_A,
    }, CATALOG_A), 'invalid_configuration');
    expectError(() => repository.appendServingSnapshot({
      ...value, revision: 99,
    }, CATALOG_A), 'invalid_configuration');
    expect(() => repository.getDatabase().run(`INSERT INTO configuration_serving_snapshots
      (revision,content_hash,plugin_catalog_hash,aggregate_json) VALUES (99,?,?,?)`, [
      value.content_hash, CATALOG_A, canonicalJson(EMPTY_AGGREGATE),
    ])).toThrow();
  });

  test('validates lookup keys before querying and counts UTF-8 bytes at the 1 MiB boundary', () => {
    const repository = openRepository();
    const value = snapshot(repository);
    expectError(() => repository.getServingSnapshot({
      revision: 0, content_hash: value.content_hash, plugin_catalog_hash: CATALOG_A,
    }), 'invalid_configuration');
    expectError(() => repository.getServingSnapshot({
      revision: value.revision, content_hash: 'sha256:bad' as Sha256Digest, plugin_catalog_hash: CATALOG_A,
    }), 'invalid_configuration');
    expectError(() => repository.getServingSnapshot({
      revision: value.revision, content_hash: value.content_hash, plugin_catalog_hash: 'sha256:bad' as Sha256Digest,
    }), 'invalid_configuration');

    const base: ConfigurationAggregateV2 = {
      logical_configuration: { auth: { enabled: true, tokens: [''] }, services: [], routes: [], plugins: [] },
      plugin_activations: [],
    };
    const remaining = MAX_AGGREGATE_BYTES - new TextEncoder().encode(canonicalJson(base)).byteLength;
    const token = '😀'.repeat(Math.floor(remaining / 4)) + 'x'.repeat(remaining % 4);
    const boundary: ConfigurationAggregateV2 = {
      ...base,
      logical_configuration: { ...base.logical_configuration, auth: { enabled: true, tokens: [token] } },
    };
    const boundaryHash = hashConfigurationContent(boundary);
    repository.getDatabase().run(`INSERT INTO configuration_revisions
      (revision,content_hash,kind,created_at) VALUES (2,?,'config',1)`, [boundaryHash]);
    expect(() => repository.appendServingSnapshot({
      revision: 2, content_hash: boundaryHash, aggregate: boundary,
    }, CATALOG_A)).not.toThrow();
    const oversized: ConfigurationAggregateV2 = {
      ...boundary,
      logical_configuration: { ...boundary.logical_configuration, auth: { enabled: true, tokens: [token + 'x'] } },
    };
    expectError(() => repository.appendServingSnapshot({
      revision: 2, content_hash: hashConfigurationContent(oversized), aggregate: oversized,
    }, CATALOG_B), 'invalid_configuration');
  });

  test('rejects changed data for an existing key and blocks UPDATE and DELETE', () => {
    const repository = openRepository();
    const value = snapshot(repository);
    repository.appendServingSnapshot(value, CATALOG_A);
    const alternate = canonicalJson({
      logical_configuration: { log_level: 'debug', services: [], routes: [], plugins: [] },
      plugin_activations: [],
    });
    mutateServingRow(repository, alternate);
    expectError(() => repository.appendServingSnapshot(value, CATALOG_A), 'serving_snapshot_corrupt');

    const second = openRepository();
    const secondValue = snapshot(second);
    second.appendServingSnapshot(secondValue, CATALOG_A);
    expect(() => second.getDatabase().run(
      'UPDATE configuration_serving_snapshots SET aggregate_json=?', [canonicalJson(EMPTY_AGGREGATE)],
    )).toThrow();
    expect(() => second.getDatabase().run('DELETE FROM configuration_serving_snapshots')).toThrow();
  });

  for (const [name, aggregateJson] of [
    ['malformed JSON', '{'],
    ['noncanonical JSON', '{"plugin_activations":[],"logical_configuration":{"services":[],"routes":[],"plugins":[]}}'],
    ['normalization drift', canonicalJson({
      logical_configuration: { services: [{ id: '10000000-0000-4000-8000-000000000001', name: 'service', endpoints: [{
        id: '30000000-0000-4000-8000-000000000001', target: 'https://example.com', plugins: [],
      }], plugins: [] }], routes: [], plugins: [] }, plugin_activations: [],
    })],
    ['hash mismatch', canonicalJson({
      logical_configuration: { log_level: 'debug', services: [], routes: [], plugins: [] }, plugin_activations: [],
    })],
  ] as const) {
    test(`fails closed on ${name} without exposing aggregate data`, () => {
      const repository = openRepository();
      const value = snapshot(repository);
      repository.appendServingSnapshot(value, CATALOG_A);
      mutateServingRow(repository, aggregateJson);
      let error: unknown;
      try {
        repository.getServingSnapshot({ revision: value.revision, content_hash: value.content_hash, plugin_catalog_hash: CATALOG_A });
      } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ConfigRepositoryError);
      if (error instanceof ConfigRepositoryError) {
        expect(error.code).toBe('serving_snapshot_corrupt');
        expect(error.message).not.toContain(aggregateJson);
      }
    });
  }

  test('detects a revision row hash mismatch while returning null for a missing row', () => {
    const repository = openRepository();
    const value = snapshot(repository);
    repository.appendServingSnapshot(value, CATALOG_A);
    const db = repository.getDatabase();
    db.run('PRAGMA foreign_keys=OFF');
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run('UPDATE configuration_revisions SET content_hash=? WHERE revision=1', [CATALOG_B]);
    db.run('PRAGMA ignore_check_constraints=OFF');
    db.run('PRAGMA foreign_keys=ON');
    expectError(() => repository.getServingSnapshot({
      revision: value.revision, content_hash: value.content_hash, plugin_catalog_hash: CATALOG_A,
    }), 'serving_snapshot_corrupt');
  });
});
