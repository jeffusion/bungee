import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, ConfigRepositoryError } from '../../src/config-storage';
import { CONFIG_MIGRATION_V1 } from '../../src/config-storage/migrations/v1';
import { CONFIG_MIGRATION_V2 } from '../../src/config-storage/migrations/v2';
import { CONFIG_MIGRATION_V3 } from '../../src/config-storage/migrations/v3';
import { CONFIG_SCHEMA_V1_STATEMENTS } from '../../src/config-storage/schema-v1';

const roots: string[] = [];
const repositories: ConfigRepository[] = [];
const VALUE: ConfigurationAggregateV2 = {
  logical_configuration: {
    auth: { enabled: true, tokens: ['literal'] }, services: [], routes: [], plugins: [],
  },
  plugin_activations: [],
};

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-config-schema-'));
  roots.push(root);
  return join(root, 'config.db');
}

function createCommitted(): string {
  const dbPath = databasePath();
  const repository = ConfigRepository.open(dbPath);
  repository.commit({
    mutation_id: 'audit', expected_revision: 1, aggregate: VALUE, kind: 'config',
    created_at: 1_700_000_000_000, target_worker_slots: [0],
  });
  repository.close();
  return dbPath;
}

function expectCorruptOpen(dbPath: string): void {
  expectSchemaCorrupt(() => ConfigRepository.open(dbPath));
}

function expectSchemaCorrupt(action: () => unknown): void {
  let captured: unknown;
  try {
    const result = action();
    if (result instanceof ConfigRepository) result.close();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(ConfigRepositoryError);
  if (captured instanceof ConfigRepositoryError) expect(captured.code).toBe('schema_corrupt');
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ConfigRepository initialized schema fingerprint', () => {
  test('enforces the exact body parser limit grammar and safe integer boundary in SQLite', () => {
    // Given
    const dbPath = databasePath();
    const repository = ConfigRepository.open(dbPath);
    repository.close();
    const db = new Database(dbPath, { readwrite: true, strict: true });
    const valid = [
      '1b', '2kb', '50mb', '1gb',
      '9007199254740991b', '9007199254740991kb', '9007199254740991mb', '9007199254740991gb',
    ] as const;
    const invalid = [
      '1kmb', '1bb', '12kgb', '9007199254740992b', '0b', '01kb', '1KB', ' 1kb', '1kb ', '1.5mb', '',
    ] as const;

    // When / Then
    for (const value of valid) {
      expect(db.run('UPDATE settings SET body_parser_limit=? WHERE id=1', [value]).changes).toBe(1);
    }
    for (const value of invalid) {
      expect(() => db.run('UPDATE settings SET body_parser_limit=? WHERE id=1', [value])).toThrow();
      db.run('DELETE FROM settings WHERE id=1');
      expect(() => db.run('INSERT INTO settings(id,body_parser_limit) VALUES (1,?)', [value])).toThrow();
      db.run('INSERT INTO settings(id,body_parser_limit) VALUES (1,NULL)');
    }
    db.close(true);
  });

  test('rejects unexpected triggers, views, and explicit indexes on open', () => {
    // Given / When / Then
    for (const statement of [
      `CREATE TRIGGER block_state BEFORE UPDATE ON configuration_state BEGIN SELECT RAISE(ABORT,'blocked'); END`,
      'CREATE VIEW operation_view AS SELECT mutation_id FROM configuration_operations',
      'CREATE INDEX unexpected_revision_kind ON configuration_revisions(kind)',
    ]) {
      const dbPath = createCommitted();
      const db = new Database(dbPath, { readwrite: true, strict: true });
      db.run(statement);
      db.close(true);
      expectCorruptOpen(dbPath);
    }
  });

  test('preserves quoted SQL literal semantics in the schema fingerprint', () => {
    // Given
    const dbPath = databasePath();
    const repository = ConfigRepository.open(dbPath);
    repository.close();
    const db = new Database(dbPath, { readwrite: true, strict: true });
    db.run('PRAGMA foreign_keys=OFF');
    db.run('DROP TABLE configuration_operations');
    const operationStatement = CONFIG_SCHEMA_V1_STATEMENTS.find((statement) =>
      statement.startsWith('CREATE TABLE configuration_operations'));
    if (operationStatement === undefined) throw new Error('operation schema statement missing');
    db.run(operationStatement.replaceAll("'degraded'", "'DEGRADED'"));
    db.close(true);

    // When / Then
    expectCorruptOpen(dbPath);
  });

  test('rejects an unexpected trigger before every mutation without firing it or writing rows', () => {
    // Given
    const actions = ['commit', 'begin', 'record', 'finalize'] as const;

    // When / Then
    for (const action of actions) {
      const dbPath = databasePath();
      const repository = ConfigRepository.open(dbPath);
      repositories.push(repository);
      repository.commit({
        mutation_id: 'trigger-r2', expected_revision: 1, aggregate: VALUE, kind: 'config',
        created_at: 1_700_000_000_000, target_worker_slots: [0],
      });
      if (action === 'record' || action === 'finalize') {
        repository.beginPublication('trigger-r2', 1_700_000_000_001);
        repository.beginWorkerAttempt('trigger-r2', 0, 0, 'initial', 1_700_000_000_001);
      }
      const db = repository['db'];
      db.run(`CREATE TRIGGER unexpected_effect BEFORE UPDATE ON configuration_operations
        BEGIN SELECT RAISE(ABORT,'trigger fired'); END`);
      const mutation = action === 'commit'
        ? () => repository.commit({
          mutation_id: 'trigger-r3', expected_revision: 2, aggregate: VALUE, kind: 'config',
          created_at: 1_700_000_000_002, target_worker_slots: [1],
        })
        : action === 'begin'
          ? () => repository.beginPublication('trigger-r2', 1_700_000_000_002)
          : action === 'record'
            ? () => repository.recordWorkerResult('trigger-r2', 0, {
              kind: 'failed', attempt_no: 1, error: 'blocked',
            }, 1_700_000_000_002)
            : () => repository.finalizePublication('trigger-r2', {
              outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'blocked',
            }, 1_700_000_000_002);
      expectSchemaCorrupt(mutation);
      expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_revisions').get()?.count).toBe(2);
    }
  });

  test('rejects a same-name replacement worker table with weak columns and constraints', () => {
    // Given
    const dbPath = createCommitted();
    const db = new Database(dbPath, { readwrite: true, strict: true });
    db.run('PRAGMA foreign_keys=OFF');
    db.run('DROP TABLE configuration_operation_workers');
    db.run('CREATE TABLE configuration_operation_workers(x INTEGER) STRICT');
    db.close(true);

    // When / Then
    expectCorruptOpen(dbPath);
  });

  test('rejects missing unique indexes, changed foreign keys, and weakened checks', () => {
    // Given
    const mutations = [
      `PRAGMA foreign_keys=OFF; ALTER TABLE services RENAME TO services_old;
       CREATE TABLE services (id TEXT PRIMARY KEY,position INTEGER NOT NULL,name TEXT NOT NULL,policy_json TEXT NOT NULL) STRICT;
       INSERT INTO services SELECT * FROM services_old; DROP TABLE services_old`,
      `PRAGMA foreign_keys=OFF; ALTER TABLE routes RENAME TO routes_old;
       CREATE TABLE routes (id TEXT PRIMARY KEY, position INTEGER, path TEXT, service_id TEXT, policy_json TEXT) STRICT;
       INSERT INTO routes SELECT * FROM routes_old; DROP TABLE routes_old`,
      `PRAGMA foreign_keys=OFF; ALTER TABLE settings RENAME TO settings_old;
       CREATE TABLE settings (id INTEGER PRIMARY KEY,log_level TEXT,body_parser_limit TEXT,auth_json TEXT,logging_json TEXT) STRICT;
       INSERT INTO settings SELECT * FROM settings_old; DROP TABLE settings_old`,
    ] as const;

    // When / Then
    for (const sql of mutations) {
      const dbPath = createCommitted();
      const db = new Database(dbPath, { readwrite: true, strict: true });
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) db.run(statement);
      db.close(true);
      expectCorruptOpen(dbPath);
    }
  });
});

describe('ConfigRepository cross-table audit', () => {
  test('rejects a later commit after the open connection is corrupted', () => {
    // Given
    const dbPath = databasePath();
    const repository = ConfigRepository.open(dbPath);
    repositories.push(repository);
    repository.commit({
      mutation_id: 'first', expected_revision: 1, aggregate: VALUE, kind: 'config',
      created_at: 1_700_000_000_000, target_worker_slots: [0],
    });
    const db = repository['db'];
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run("UPDATE configuration_operations SET request_hash='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'");
    db.run('PRAGMA ignore_check_constraints=OFF');

    // When / Then
    expect(() => repository.commit({
      mutation_id: 'second', expected_revision: 2, aggregate: VALUE, kind: 'config',
      created_at: 1_700_000_000_001, target_worker_slots: [0],
    })).toThrow(ConfigRepositoryError);
  });

  test('rejects revision gaps, orphan revisions, and operation/revision metadata mismatches', () => {
    // Given
    const mutations = [
      'UPDATE configuration_revisions SET revision=3 WHERE revision=2; UPDATE configuration_state SET active_revision=3',
      `INSERT INTO configuration_revisions(revision,content_hash,kind,created_at)
       SELECT 3,content_hash,kind,created_at FROM configuration_revisions WHERE revision=2;
       UPDATE configuration_state SET active_revision=3`,
      "UPDATE configuration_operations SET kind='admin_state'",
      'UPDATE configuration_operations SET created_at=1700000000001,updated_at=1700000000001',
      'UPDATE configuration_operations SET expected_revision=2',
      "UPDATE configuration_operations SET request_hash='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    ] as const;

    // When / Then
    for (const sql of mutations) {
      const dbPath = createCommitted();
      const db = new Database(dbPath, { readwrite: true, strict: true });
      db.run('PRAGMA foreign_keys=OFF');
      db.run('PRAGMA ignore_check_constraints=ON');
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) db.run(statement);
      db.close(true);
      expectCorruptOpen(dbPath);
    }
  });

  test('rejects incoherent operation or worker fields', () => {
    // Given
    const mutations = [
      "UPDATE configuration_operations SET state='converged',result_status=NULL",
      "UPDATE configuration_operations SET state='committed',result_status=200",
      'UPDATE configuration_operations SET target_worker_count=2',
      'UPDATE configuration_operation_workers SET target_revision=1',
      "UPDATE configuration_operation_workers SET state='converged',applied_revision=NULL",
      "UPDATE configuration_operation_workers SET state='pending',last_error='shadow'",
      'DELETE FROM configuration_operation_workers',
      "UPDATE configuration_operation_workers SET state='failed',last_error='   '",
      `UPDATE configuration_operations SET state='degraded',result_status=202,
       error_code='replacement_convergence_failed',error_detail='failed';
       UPDATE configuration_operation_workers SET attempt_no=1,last_begin_previous_attempt_no=0,
       last_begin_reason='initial',state='converged',applied_revision=2,last_error=NULL`,
      `INSERT INTO configuration_operation_workers
       (mutation_id,worker_slot,target_revision,attempt_no,last_begin_previous_attempt_no,last_begin_reason,
        state,applied_revision,last_error,updated_at)
       VALUES ('missing',9,2,0,NULL,NULL,'pending',NULL,NULL,1700000000000)`,
    ] as const;

    // When / Then
    for (const sql of mutations) {
      const dbPath = createCommitted();
      const db = new Database(dbPath, { readwrite: true, strict: true });
      db.run('PRAGMA foreign_keys=OFF');
      db.run('PRAGMA ignore_check_constraints=ON');
      db.run(sql);
      db.close(true);
      expectCorruptOpen(dbPath);
    }
  });

  test('keeps configuration state anonymous with only its v4 columns and singleton guards', () => {
    // Given
    const dbPath = databasePath();
    const repository = ConfigRepository.open(dbPath);
    repositories.push(repository);

    // When
    const committed = repository.commit({
      mutation_id: 'setup', expected_revision: 1,
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
      kind: 'config', created_at: 1_700_000_000_000, target_worker_slots: [0],
    });

    // Then
    expect(committed.kind).toBe('committed');
    const db = repository['db'];
    expect(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('configuration_state') ORDER BY cid").all()).toEqual([
      { name: 'id' }, { name: 'schema_version' }, { name: 'active_revision' },
      { name: 'created_at' }, { name: 'updated_at' },
    ]);
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='configuration_state' ORDER BY name",
    ).all()).toEqual([
      { name: 'configuration_state_singleton_id_immutable' },
      { name: 'configuration_state_singleton_no_delete' },
      { name: 'configuration_state_singleton_no_replace' },
    ]);
  });

  test('retains the exact singleton guards after repository initialization', () => {
    // Given
    const dbPath = databasePath();
    const repository = ConfigRepository.open(dbPath);
    repositories.push(repository);

    // When
    const triggers = repository['db'].query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='configuration_state' ORDER BY name",
    ).all();

    // Then
    expect(triggers).toEqual([
      { name: 'configuration_state_singleton_id_immutable' },
      { name: 'configuration_state_singleton_no_delete' },
      { name: 'configuration_state_singleton_no_replace' },
    ]);
  });

  for (const attack of [
    {
      name: 'DELETE',
      run(db: Database) {
        db.run('DELETE FROM configuration_state WHERE id=1');
      },
    },
    {
      name: 'DELETE followed by INSERT',
      run(db: Database) {
        db.transaction(() => {
          db.run('DELETE FROM configuration_state WHERE id=1');
          db.run(`INSERT INTO configuration_state
            (id,schema_version,active_revision)
            VALUES (1,4,2)`);
        }).immediate();
      },
    },
    {
      name: 'INSERT OR REPLACE',
      run(db: Database) {
        db.run(`INSERT OR REPLACE INTO configuration_state
          (id,schema_version,active_revision)
          VALUES (1,4,2)`);
      },
    },
    {
      name: 'id move followed by state row insertion',
      run(db: Database) {
        db.run('PRAGMA ignore_check_constraints=ON');
        try {
          db.transaction(() => {
            db.run('UPDATE configuration_state SET id=2 WHERE id=1');
            db.run(`INSERT INTO configuration_state
            (id,schema_version,active_revision)
            VALUES (1,4,2)`);
          }).immediate();
        } finally {
          db.run('PRAGMA ignore_check_constraints=OFF');
        }
      },
    },
  ] as const) {
    test(`rejects singleton reset through ${attack.name} and preserves state`, () => {
      // Given
      const dbPath = createCommitted();
      const db = new Database(dbPath, { readwrite: true, strict: true });
      const readState = () => db.query<{
        id: number; schema_version: number; active_revision: number;
      }, []>(`SELECT id,schema_version,active_revision
        FROM configuration_state`).get();
      const before = readState();

      // When / Then
      expect(() => attack.run(db)).toThrow();
      expect(readState()).toEqual(before);
      db.close(true);
      const repository = ConfigRepository.open(dbPath);
      expect(repository.getSnapshot()).toMatchObject({ revision: 2 });
      repository.close();
    });
  }

  test('audits every configuration state row instead of accepting an extra hidden row', () => {
    // Given
    const dbPath = databasePath();
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
    db.transaction(() => {
      CONFIG_MIGRATION_V1.up(db);
      CONFIG_MIGRATION_V2.up(db);
      db.run('PRAGMA ignore_check_constraints=ON');
      db.run(`INSERT INTO configuration_state
        (id,schema_version,active_revision,bootstrap_mode,bootstrap_completed_revision)
        SELECT 2,schema_version,active_revision,bootstrap_mode,bootstrap_completed_revision
        FROM configuration_state WHERE id=1`);
      db.run('PRAGMA ignore_check_constraints=OFF');
      CONFIG_MIGRATION_V3.up(db);
    }).immediate();
    db.close(true);

    // When / Then
    expectCorruptOpen(dbPath);
  });

  test('rejects invalid persisted global scalar domains even when checks are bypassed', () => {
    // Given / When / Then
    for (const assignment of ["log_level='INFO'", "body_parser_limit='01kb'", "body_parser_limit='9007199254740992b'"]) {
      const dbPath = createCommitted();
      const db = new Database(dbPath, { readwrite: true, strict: true });
      db.run('PRAGMA ignore_check_constraints=ON');
      db.run(`UPDATE settings SET ${assignment}`);
      db.run('PRAGMA ignore_check_constraints=OFF');
      db.close(true);
      expectCorruptOpen(dbPath);
    }
  });
});
