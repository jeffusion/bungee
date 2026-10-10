import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
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
import { verifySchemaFingerprint } from '../../src/config-storage/schema-fingerprint';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

setDefaultTimeout(STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

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
  const trigger = db.query<{sql:string}, []>("SELECT sql FROM sqlite_schema WHERE name='configuration_serving_snapshots_immutable_update'").get()?.sql;
  if (!trigger) throw new Error('serving immutability trigger missing');
  db.run('DROP TRIGGER configuration_serving_snapshots_immutable_update');
  db.run('PRAGMA ignore_check_constraints=ON');
  db.run('UPDATE configuration_serving_snapshots SET aggregate_json=?', [aggregateJson]);
  db.run('PRAGMA ignore_check_constraints=OFF');
  db.run(trigger);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('configuration serving snapshot baseline', () => {
  test('creates one current baseline and rejects a UTF-16 database', () => {
    const fresh=openRepository();
    expect(fresh.getDatabase().query('SELECT version,name FROM schema_migrations').all()).toEqual([{version:1,name:'current_storage_baseline'}]);
    expect(() => verifySchemaFingerprint(fresh.getDatabase())).not.toThrow();
    const directory=mkdtempSync(join(tmpdir(),'bungee-utf16-')); roots.push(directory);
    const path=join(directory,'config.db'); const db=new Database(path);
    db.exec("PRAGMA encoding='UTF-16'; CREATE TABLE sentinel(id INTEGER)"); db.close();
    expectError(() => ConfigRepository.open(path),'connection_invariant');
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
    const guards=db.query<{name:string;sql:string},[]>("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='configuration_revisions'").all();
    for(const guard of guards)db.run(`DROP TRIGGER ${guard.name}`);
    db.run('UPDATE configuration_revisions SET content_hash=? WHERE revision=1', [CATALOG_B]);
    for(const guard of guards)db.run(guard.sql);
    db.run('PRAGMA ignore_check_constraints=OFF');
    db.run('PRAGMA foreign_keys=ON');
    expectError(() => repository.getServingSnapshot({
      revision: value.revision, content_hash: value.content_hash, plugin_catalog_hash: CATALOG_A,
    }), 'serving_snapshot_corrupt');
  });
});
