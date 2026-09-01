import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  ConfigRepository,
  ConfigRepositoryError,
  hashConfigurationContent,
  hashConfigurationRequest,
} from '../../src/config-storage';

const CREATED_AT = 1_700_000_000_000;
const AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: {
    auth: { enabled: true, tokens: ['literal'] },
    log_level: 'warn',
    services: [],
    routes: [],
    plugins: [],
  },
  plugin_activations: [],
};
const roots: string[] = [];
const repositories: ConfigRepository[] = [];

function openRepository(): { readonly repository: ConfigRepository; readonly dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-config-recovery-'));
  roots.push(root);
  const dbPath = join(root, 'config.db');
  const repository = ConfigRepository.open(dbPath);
  repositories.push(repository);
  return { repository, dbPath };
}

function reopen(repository: ConfigRepository, dbPath: string): ConfigRepository {
  repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
  const reopened = ConfigRepository.open(dbPath);
  repositories.push(reopened);
  return reopened;
}

function commit(repository: ConfigRepository, mutationId: string, targets: readonly number[]): void {
  const result = repository.commit({
    mutation_id: mutationId,
    expected_revision: 1,
    aggregate: AGGREGATE,
    kind: 'config',
    created_at: CREATED_AT,
    target_worker_slots: targets,
  });
  expect(result.kind).toBe('committed');
}

function expectSchemaCorrupt(action: () => unknown): void {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(ConfigRepositoryError);
  if (captured instanceof ConfigRepositoryError) expect(captured.code).toBe('schema_corrupt');
}

function corrupt(repository: ConfigRepository, sql: string): void {
  const db = repository['db'];
  db.run('PRAGMA foreign_keys=OFF');
  db.run('PRAGMA ignore_check_constraints=ON');
  db.run(sql);
  db.run('PRAGMA ignore_check_constraints=OFF');
  db.run('PRAGMA foreign_keys=ON');
}

function persistedPublicationRows(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, strict: true });
  const rows = {
    operations: db.query<Record<string, string | number | null>, []>(
      'SELECT * FROM configuration_operations ORDER BY committed_revision',
    ).all(),
    workers: db.query<Record<string, string | number | null>, []>(
      'SELECT * FROM configuration_operation_workers ORDER BY mutation_id,worker_slot',
    ).all(),
  };
  db.close(true);
  return JSON.stringify(rows);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ConfigRepository active publication recovery', () => {
  test('returns null for a fresh anonymous revision without changing its readable snapshot', () => {
    // Given
    const { repository } = openRepository();

    // When
    const active = repository.getActivePublication();

    // Then
    expect(active).toBeNull();
    expect(repository.getSnapshot()).toEqual({
      revision: 1,
      content_hash: hashConfigurationContent({
        logical_configuration: { services: [], routes: [], plugins: [] },
        plugin_activations: [],
      }),
      aggregate: {
        logical_configuration: { services: [], routes: [], plugins: [] },
        plugin_activations: [],
      },
    });
  });

  test('returns committed snapshot and sorted frozen targets and can begin recovered publication', () => {
    // Given
    const { repository, dbPath } = openRepository();
    commit(repository, 'recover-committed', [4, 1]);
    const reopened = reopen(repository, dbPath);
    const beforeRead = persistedPublicationRows(dbPath);

    // When
    const active = reopened.getActivePublication();

    // Then
    expect(active).not.toBeNull();
    if (active === null) return;
    expect(active).toEqual({
      operation: expect.objectContaining({
        mutation_id: 'recover-committed', state: 'committed', committed_revision: 2,
        target_worker_count: 2,
        request_hash: hashConfigurationRequest({
          kind: 'config', expected_revision: 1, aggregate: AGGREGATE, target_worker_slots: [1, 4],
        }),
      }),
      snapshot: {
        revision: 2,
        content_hash: hashConfigurationContent(AGGREGATE),
        aggregate: AGGREGATE,
      },
      targets: [
        {
          mutation_id: 'recover-committed', worker_slot: 1, target_revision: 2,
          drain_recovery_generation: 0, attempt_no: 0,
          last_begin_previous_attempt_no: null, last_begin_reason: null,
          state: 'pending', applied_revision: null, last_error: null, updated_at: CREATED_AT,
        },
        {
          mutation_id: 'recover-committed', worker_slot: 4, target_revision: 2,
          drain_recovery_generation: 0, attempt_no: 0,
          last_begin_previous_attempt_no: null, last_begin_reason: null,
          state: 'pending', applied_revision: null, last_error: null, updated_at: CREATED_AT,
        },
      ],
    });
    expect(persistedPublicationRows(dbPath)).toBe(beforeRead);
    expect(reopened.beginPublication(active.operation.mutation_id, CREATED_AT + 1).state).toBe('publishing');
  });

  test('reopens publishing recovery byte-equivalently without resetting persisted worker results', () => {
    // Given
    const { repository, dbPath } = openRepository();
    commit(repository, 'recover-publishing', [7, 2, 5]);
    repository.beginPublication('recover-publishing', CREATED_AT + 1);
    for (const slot of [2, 5]) repository.beginWorkerAttempt('recover-publishing', slot, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('recover-publishing', 2, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.recordWorkerResult('recover-publishing', 5, {
      kind: 'failed', attempt_no: 1, error: 'worker rejected snapshot', applied_revision: 1,
    }, CREATED_AT + 4);
    const beforeRestart = repository.getActivePublication();

    // When
    const reopened = reopen(repository, dbPath);
    const afterRestart = reopened.getActivePublication();

    // Then
    expect(JSON.stringify(afterRestart)).toBe(JSON.stringify(beforeRestart));
    expect(afterRestart?.operation).toMatchObject({ state: 'publishing', committed_revision: 2 });
    expect(afterRestart?.targets.map(({ worker_slot, state, applied_revision, last_error }) => ({
      worker_slot, state, applied_revision, last_error,
    }))).toEqual([
      { worker_slot: 2, state: 'converged', applied_revision: 2, last_error: null },
      { worker_slot: 5, state: 'failed', applied_revision: 1, last_error: 'worker rejected snapshot' },
      { worker_slot: 7, state: 'pending', applied_revision: null, last_error: null },
    ]);
  });

  test('excludes converged and degraded terminal operations', () => {
    // Given / When / Then
    for (const outcome of ['converged', 'degraded'] as const) {
      const { repository } = openRepository();
      commit(repository, `terminal-${outcome}`, [0]);
      repository.beginPublication(`terminal-${outcome}`, CREATED_AT + 1);
      repository.beginWorkerAttempt(`terminal-${outcome}`, 0, 0, 'initial', CREATED_AT + 2);
      if (outcome === 'converged') {
        repository.recordWorkerResult(`terminal-${outcome}`, 0, {
          kind: 'converged', attempt_no: 1, applied_revision: 2,
        }, CREATED_AT + 3);
        repository.markDraining(`terminal-${outcome}`, CREATED_AT + 4);
      } else {
        repository.recordWorkerResult(`terminal-${outcome}`, 0, {
          kind: 'failed', attempt_no: 1, error: 'unavailable',
        }, CREATED_AT + 3);
      }
      const terminalOutcome = outcome === 'converged'
        ? { outcome: 'converged' as const, old_workers_exited: true as const }
        : { outcome: 'degraded' as const, error_code: 'replacement_convergence_failed' as const,
          error_detail: 'unavailable' };
      repository.finalizePublication(`terminal-${outcome}`, terminalOutcome, CREATED_AT + 5);
      expect(repository.getActivePublication()).toBeNull();
    }
  });

  test('fails closed when active publication target or revision invariants are corrupted', () => {
    // Given / When / Then
    const corruptions = [
      'DELETE FROM configuration_operation_workers WHERE worker_slot=3',
      'UPDATE configuration_operation_workers SET target_revision=1 WHERE worker_slot=3',
      `INSERT INTO configuration_operation_workers
       (mutation_id,worker_slot,target_revision,state,applied_revision,last_error,updated_at)
       VALUES ('corrupt-recovery',9,2,'pending',NULL,NULL,${CREATED_AT})`,
      'UPDATE configuration_operations SET target_worker_count=3',
      'UPDATE configuration_operations SET committed_revision=1',
      `UPDATE configuration_operations
       SET request_hash='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`,
    ] as const;
    for (const sql of corruptions) {
      const { repository } = openRepository();
      commit(repository, 'corrupt-recovery', [1, 3]);
      corrupt(repository, sql);
      expectSchemaCorrupt(() => repository.getActivePublication());
    }
  });

  test('fails closed when more than one nonterminal operation is persisted', () => {
    // Given
    const { repository } = openRepository();
    commit(repository, 'historical-operation', [0]);
    repository.beginPublication('historical-operation', CREATED_AT + 1);
    repository.beginWorkerAttempt('historical-operation', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('historical-operation', 0, {
      kind: 'failed', attempt_no: 1, error: 'historical failure',
    }, CREATED_AT + 3);
    repository.finalizePublication('historical-operation', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'historical failure',
    }, CREATED_AT + 4);
    const next = repository.commit({
      mutation_id: 'active-operation', expected_revision: 2, aggregate: AGGREGATE, kind: 'config',
      created_at: CREATED_AT + 4, target_worker_slots: [1],
    });
    expect(next.kind).toBe('committed');
    corrupt(repository, `UPDATE configuration_operations SET state='publishing',result_status=NULL,error_code=NULL,error_detail=NULL
      WHERE mutation_id='historical-operation'`);
    corrupt(repository, `UPDATE configuration_operation_workers
      SET state='pending',applied_revision=NULL,last_error=NULL WHERE mutation_id='historical-operation'`);

    // When / Then
    expectSchemaCorrupt(() => repository.getActivePublication());
  });
});
