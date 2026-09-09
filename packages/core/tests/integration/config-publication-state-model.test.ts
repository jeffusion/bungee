import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, ConfigRepositoryError } from '../../src/config-storage';

const CREATED_AT = 1_700_000_000_000;
const AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: {
    auth: { enabled: true, tokens: ['literal'] }, services: [], routes: [], plugins: [],
  },
  plugin_activations: [],
};
const roots: string[] = [];
const repositories: ConfigRepository[] = [];

function open(): { readonly repository: ConfigRepository; readonly dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-publication-state-'));
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

function commit(repository: ConfigRepository, mutationId: string, slots: readonly number[] = [0]): void {
  expect(repository.commit({
    mutation_id: mutationId,
    expected_revision: 1,
    aggregate: AGGREGATE,
    kind: 'config',
    created_at: CREATED_AT,
    target_worker_slots: slots,
  }).kind).toBe('committed');
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrow(ConfigRepositoryError);
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigRepositoryError) expect(error.code).toBe('invalid_operation');
  }
}

function expectCorrupt(action: () => unknown): void {
  expect(action).toThrow(ConfigRepositoryError);
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigRepositoryError) expect(error.code).toBe('schema_corrupt');
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable worker publication attempts', () => {
  test('retries a failed target with attempt fencing and rejects a late prior-attempt result', () => {
    const { repository } = open();
    commit(repository, 'retry');
    repository.beginPublication('retry', CREATED_AT + 1);

    expect(repository.beginWorkerAttempt('retry', 0, 0, 'initial', CREATED_AT + 2)).toMatchObject({
      state: 'pending', attempt_no: 1, last_begin_previous_attempt_no: 0, last_begin_reason: 'initial',
    });
    expect(repository.recordWorkerResult('retry', 0, {
      kind: 'failed', attempt_no: 1, error: 'startup failed', applied_revision: 1,
    }, CREATED_AT + 3)).toMatchObject({ state: 'failed', attempt_no: 1 });
    expect(repository.beginWorkerAttempt('retry', 0, 1, 'retry', CREATED_AT + 4)).toMatchObject({
      state: 'pending', attempt_no: 2, applied_revision: null, last_error: null,
    });
    expectInvalid(() => repository.recordWorkerResult('retry', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 5));
    expect(repository.recordWorkerResult('retry', 0, {
      kind: 'converged', attempt_no: 2, applied_revision: 2,
    }, CREATED_AT + 5)).toMatchObject({ state: 'converged', attempt_no: 2 });
  });

  test('makes begin commands restart-idempotent without incrementing another attempt', () => {
    const { repository, dbPath } = open();
    commit(repository, 'begin-idempotent');
    repository.beginPublication('begin-idempotent', CREATED_AT + 1);
    const first = repository.beginWorkerAttempt('begin-idempotent', 0, 0, 'initial', CREATED_AT + 2);
    const reopened = reopen(repository, dbPath);

    const repeated = reopened.beginWorkerAttempt('begin-idempotent', 0, 0, 'initial', CREATED_AT + 3);

    expect(repeated).toEqual(first);
    expect(repeated.attempt_no).toBe(1);
  });

  test('fences pending, failed, and converged rows on master recovery and remains reopen-idempotent', () => {
    for (const terminal of ['pending', 'failed', 'converged'] as const) {
      const { repository, dbPath } = open();
      const mutationId = `recover-${terminal}`;
      commit(repository, mutationId);
      repository.beginPublication(mutationId, CREATED_AT + 1);
      repository.beginWorkerAttempt(mutationId, 0, 0, 'initial', CREATED_AT + 2);
      if (terminal === 'failed') {
        repository.recordWorkerResult(mutationId, 0, {
          kind: 'failed', attempt_no: 1, error: 'failed', applied_revision: 1,
        }, CREATED_AT + 3);
      } else if (terminal === 'converged') {
        repository.recordWorkerResult(mutationId, 0, {
          kind: 'converged', attempt_no: 1, applied_revision: 2,
        }, CREATED_AT + 3);
      }
      const recovered = repository.beginWorkerAttempt(mutationId, 0, 1, 'master_recovery', CREATED_AT + 4);
      expect(recovered).toMatchObject({ state: 'pending', attempt_no: 2, applied_revision: null, last_error: null });
      const reopened = reopen(repository, dbPath);
      expect(reopened.beginWorkerAttempt(mutationId, 0, 1, 'master_recovery', CREATED_AT + 5)).toEqual(recovered);
    }
  });

  test('accepts exact duplicate terminal results but rejects conflicting, stale, and future results', () => {
    const { repository, dbPath } = open();
    commit(repository, 'result-idempotent');
    repository.beginPublication('result-idempotent', CREATED_AT + 1);
    repository.beginWorkerAttempt('result-idempotent', 0, 0, 'initial', CREATED_AT + 2);
    const first = repository.recordWorkerResult('result-idempotent', 0, {
      kind: 'failed', attempt_no: 1, error: 'bounded failure', applied_revision: 1,
    }, CREATED_AT + 3);
    const reopened = reopen(repository, dbPath);

    expect(reopened.recordWorkerResult('result-idempotent', 0, {
      kind: 'failed', attempt_no: 1, error: 'bounded failure', applied_revision: 1,
    }, CREATED_AT + 2)).toEqual(first);
    expectInvalid(() => reopened.recordWorkerResult('result-idempotent', 0, {
      kind: 'failed', attempt_no: 1, error: 'different failure', applied_revision: 1,
    }, CREATED_AT + 4));
    expectInvalid(() => reopened.recordWorkerResult('result-idempotent', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 4));
    expectInvalid(() => reopened.recordWorkerResult('result-idempotent', 0, {
      kind: 'failed', attempt_no: 2, error: 'future',
    }, CREATED_AT + 4));
  });

  test('rejects attempt overflow and fails closed on malformed persisted attempt metadata', () => {
    const { repository, dbPath } = open();
    commit(repository, 'attempt-corrupt');
    repository.beginPublication('attempt-corrupt', CREATED_AT + 1);
    const db = repository['db'];
    expect(() => db.run(`UPDATE configuration_operation_workers SET attempt_no=9007199254740992`)).toThrow();
    expect(() => db.run(`UPDATE configuration_operation_workers SET attempt_no=1,
      last_begin_previous_attempt_no=0,last_begin_reason='unknown'`)).toThrow();
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run(`UPDATE configuration_operation_workers SET attempt_no=${Number.MAX_SAFE_INTEGER},
      last_begin_previous_attempt_no=${Number.MAX_SAFE_INTEGER - 1},last_begin_reason='master_recovery'`);
    db.run('PRAGMA ignore_check_constraints=OFF');
    expectInvalid(() => repository.beginWorkerAttempt(
      'attempt-corrupt', 0, Number.MAX_SAFE_INTEGER, 'master_recovery', CREATED_AT + 2,
    ));
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const corruptor = new Database(dbPath, { readwrite: true, strict: true });
    corruptor.run('PRAGMA ignore_check_constraints=ON');
    corruptor.run(`UPDATE configuration_operation_workers SET attempt_no=9007199254740992`);
    corruptor.close(true);
    expectCorrupt(() => ConfigRepository.open(dbPath));
  });
});

describe('draining and exact terminal outcomes', () => {
  test('persists the draining boundary only after all exact targets converge', () => {
    const { repository, dbPath } = open();
    commit(repository, 'drain', [0, 1]);
    repository.beginPublication('drain', CREATED_AT + 1);
    for (const slot of [0, 1]) repository.beginWorkerAttempt('drain', slot, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('drain', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    expectInvalid(() => repository.markDraining('drain', CREATED_AT + 4));
    repository.recordWorkerResult('drain', 1, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 4);
    const draining = repository.markDraining('drain', CREATED_AT + 5);
    expect(draining).toMatchObject({ state: 'draining', result_status: null, error_code: null, error_detail: null });
    const reopened = reopen(repository, dbPath);
    expect(reopened.getActivePublication()?.operation).toMatchObject(draining);
    expect(reopened.markDraining('drain', CREATED_AT + 6)).toEqual(draining);
  });

  test('allows replacement failure only after no target remains pending and at least one failed', () => {
    const { repository } = open();
    commit(repository, 'replacement-failed', [0, 1]);
    repository.beginPublication('replacement-failed', CREATED_AT + 1);
    for (const slot of [0, 1]) repository.beginWorkerAttempt('replacement-failed', slot, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('replacement-failed', 0, {
      kind: 'failed', attempt_no: 1, error: 'startup failed',
    }, CREATED_AT + 3);
    expectInvalid(() => repository.finalizePublication('replacement-failed', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'one replacement failed',
    }, CREATED_AT + 4));
    repository.recordWorkerResult('replacement-failed', 1, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 4);
    expect(repository.finalizePublication('replacement-failed', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'one replacement failed',
    }, CREATED_AT + 5)).toMatchObject({
      state: 'degraded', result_status: 202,
      error_code: 'replacement_convergence_failed', error_detail: 'one replacement failed',
    });
  });

  test('requires old-worker exit proof for converged and drain-failed outcomes', () => {
    for (const outcome of ['converged', 'degraded'] as const) {
      const { repository, dbPath } = open();
      const mutationId = `drain-${outcome}`;
      commit(repository, mutationId);
      repository.beginPublication(mutationId, CREATED_AT + 1);
      repository.beginWorkerAttempt(mutationId, 0, 0, 'initial', CREATED_AT + 2);
      repository.recordWorkerResult(mutationId, 0, {
        kind: 'converged', attempt_no: 1, applied_revision: 2,
      }, CREATED_AT + 3);
      repository.markDraining(mutationId, CREATED_AT + 4);
      const unproved = outcome === 'converged'
        ? { outcome: 'converged', old_workers_exited: false }
        : {
          outcome: 'degraded', error_code: 'old_worker_drain_failed',
          error_detail: 'forced termination completed', old_workers_exited: false,
        };
      expectInvalid(() => Reflect.apply(repository.finalizePublication, repository, [mutationId, unproved, CREATED_AT + 5]));
      const proved = outcome === 'converged'
        ? { outcome: 'converged' as const, old_workers_exited: true as const }
        : {
          outcome: 'degraded' as const, error_code: 'old_worker_drain_failed' as const,
          error_detail: 'forced termination completed', old_workers_exited: true as const,
        };
      const terminal = repository.finalizePublication(mutationId, proved, CREATED_AT + 5);
      const reopened = reopen(repository, dbPath);
      expect(reopened.finalizePublication(mutationId, proved, CREATED_AT + 3)).toEqual(terminal);
      const conflicting = outcome === 'converged'
        ? {
          outcome: 'degraded' as const, error_code: 'old_worker_drain_failed' as const,
          error_detail: 'different', old_workers_exited: true as const,
        }
        : { outcome: 'converged' as const, old_workers_exited: true as const };
      expectInvalid(() => reopened.finalizePublication(mutationId, conflicting, CREATED_AT + 6));
    }
  });
});

describe('publication state corruption', () => {
  test('enforces exact operation terminal combinations in SQLite', () => {
    const { repository } = open();
    commit(repository, 'ddl-terminal');
    const db = repository['db'];
    const invalid = [
      "UPDATE configuration_operations SET state='draining',error_detail='shadow'",
      "UPDATE configuration_operations SET state='degraded',result_status=202,error_code='replacement_convergence_failed',error_detail=NULL",
      "UPDATE configuration_operations SET state='degraded',result_status=202,error_code='old_worker_drain_failed',error_detail='   '",
      "UPDATE configuration_operations SET state='degraded',result_status=202,error_code='worker_convergence_failed',error_detail='failed'",
      `UPDATE configuration_operations SET state='degraded',result_status=202,
       error_code='replacement_convergence_failed',error_detail='${'x'.repeat(513)}'`,
    ] as const;
    for (const sql of invalid) expect(() => db.run(sql)).toThrow();
    expect(() => db.run(`UPDATE configuration_operations SET state='degraded',result_status=202,
      error_code='replacement_convergence_failed',error_detail='failed',drain_recovery_generation=1,
      last_drain_recovery_previous_generation=0`)).toThrow();
    expect(() => db.run(`UPDATE configuration_operations SET state='degraded',result_status=202,
      error_code='control_readiness_failed',error_detail='failed',drain_recovery_generation=1,
      last_drain_recovery_previous_generation=0`)).not.toThrow();
  });

  test('fails closed for invalid operation detail, phase, attempt, and cross-table combinations', () => {
    const corruptions = [
      "UPDATE configuration_operations SET error_detail='shadow'",
      "UPDATE configuration_operations SET state='draining'",
      'UPDATE configuration_operation_workers SET attempt_no=1',
      "UPDATE configuration_operation_workers SET last_begin_reason='retry'",
    ] as const;
    for (const sql of corruptions) {
      const { repository, dbPath } = open();
      commit(repository, 'corrupt');
      repository.close();
      repositories.splice(repositories.indexOf(repository), 1);
      const db = new Database(dbPath, { readwrite: true, strict: true });
      db.run('PRAGMA ignore_check_constraints=ON');
      db.run(sql);
      db.close(true);
      expectCorrupt(() => ConfigRepository.open(dbPath));
    }
  });
});
