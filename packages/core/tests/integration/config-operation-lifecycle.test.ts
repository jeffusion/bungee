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

const roots: string[] = [];
const repositories: ConfigRepository[] = [];
const CREATED_AT = 1_700_000_000_000;

function aggregate(tokens: readonly string[] = ['literal'], enabled = true): ConfigurationAggregateV2 {
  return {
    logical_configuration: { auth: { enabled, tokens: [...tokens] }, services: [], routes: [], plugins: [] },
    plugin_activations: [],
  };
}

function open() {
  const root = mkdtempSync(join(tmpdir(), 'bungee-config-lifecycle-'));
  roots.push(root);
  const dbPath = join(root, 'config.db');
  const repository = ConfigRepository.open(dbPath);
  repositories.push(repository);
  return { repository, dbPath };
}

function counts(dbPath: string): { readonly revisions: number; readonly operations: number; readonly workers: number } {
  const db = new Database(dbPath, { readonly: true, strict: true });
  const result = {
    revisions: db.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_revisions').get()?.count ?? -1,
    operations: db.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_operations').get()?.count ?? -1,
    workers: db.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_operation_workers').get()?.count ?? -1,
  };
  db.close(true);
  return result;
}

function command(mutationId: string, targets: readonly number[], value = aggregate()) {
  return {
    mutation_id: mutationId,
    expected_revision: 1,
    aggregate: value,
    kind: 'config' as const,
    created_at: CREATED_AT,
    target_worker_slots: targets,
  };
}

function nextCommand(mutationId: string, targets: readonly number[] = [1]) {
  return { ...command(mutationId, targets), expected_revision: 2, created_at: CREATED_AT + 10 };
}

function beginTargets(repository: ConfigRepository, mutationId: string, slots: readonly number[]): void {
  for (const slot of slots) repository.beginWorkerAttempt(mutationId, slot, 0, 'initial', CREATED_AT + 2);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ConfigRepository operation lifecycle', () => {
  test('blocks a new revision while the active operation is committed or publishing without reserving mutation IDs', () => {
    // Given
    const { repository, dbPath } = open();
    repository.commit(command('active-r2', [0]));

    // When / Then
    expect(repository.commit(nextCommand('blocked-committed'))).toEqual({
      kind: 'operation_in_progress', mutation_id: 'active-r2', committed_revision: 2, state: 'committed',
    });
    expect(counts(dbPath)).toEqual({ revisions: 2, operations: 1, workers: 1 });
    expect(repository.getOperation('blocked-committed')).toBeNull();
    repository.beginPublication('active-r2', CREATED_AT + 1);
    expect(repository.commit(nextCommand('blocked-publishing'))).toEqual({
      kind: 'operation_in_progress', mutation_id: 'active-r2', committed_revision: 2, state: 'publishing',
    });
    expect(repository.getOperation('blocked-publishing')).toBeNull();
  });

  test('permits the next revision only after the active operation is terminal and preserves duplicate precedence', () => {
    // Given
    const { repository } = open();
    repository.commit(command('r2-terminal', [0]));
    repository.beginPublication('r2-terminal', CREATED_AT + 1);
    beginTargets(repository, 'r2-terminal', [0]);
    repository.recordWorkerResult('r2-terminal', 0, { kind: 'converged', attempt_no: 1, applied_revision: 2 }, CREATED_AT + 3);
    repository.markDraining('r2-terminal', CREATED_AT + 4);
    const r2 = repository.finalizePublication('r2-terminal', {
      outcome: 'converged', old_workers_exited: true,
    }, CREATED_AT + 5);

    // When
    const r3 = repository.commit(nextCommand('r3-active'));

    // Then
    expect(r3.kind).toBe('committed');
    expect(repository.commit({ ...command('r2-terminal', [0]), created_at: CREATED_AT + 99 })).toEqual({
      kind: 'duplicate', operation: r2,
    });
  });

  test('moves an empty-target operation to draining because its exact target set is converged', () => {
    // Given
    const { repository } = open();
    repository.commit(command('empty-r2', []));

    // When / Then
    expect(repository.commit(nextCommand('empty-blocked'))).toMatchObject({ kind: 'operation_in_progress' });
    repository.beginPublication('empty-r2', CREATED_AT + 1);
    expect(repository.markDraining('empty-r2', CREATED_AT + 2).state).toBe('draining');
    expect(repository.commit(nextCommand('empty-r3')).kind).toBe('operation_in_progress');
  });

  test('rejects publication actions for a non-active nonterminal operation before any write', () => {
    // Given
    const { repository } = open();
    repository.commit(command('old-r2', [0]));
    repository.beginPublication('old-r2', CREATED_AT + 1);
    beginTargets(repository, 'old-r2', [0]);
    repository.recordWorkerResult('old-r2', 0, { kind: 'failed', attempt_no: 1, error: 'failed' }, CREATED_AT + 3);
    repository.finalizePublication('old-r2', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'failed',
    }, CREATED_AT + 4);
    repository.commit(nextCommand('active-r3', [1]));
    const db = repository['db'];
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run("UPDATE configuration_operations SET state='publishing',result_status=NULL,error_code=NULL WHERE mutation_id='old-r2'");
    db.run("UPDATE configuration_operation_workers SET state='pending',applied_revision=NULL,last_error=NULL WHERE mutation_id='old-r2'");
    db.run('PRAGMA ignore_check_constraints=OFF');

    // When / Then
    for (const action of [
      () => repository.beginPublication('old-r2', CREATED_AT + 20),
      () => repository.recordWorkerResult('old-r2', 0, { kind: 'failed', attempt_no: 1, error: 'late' }, CREATED_AT + 20),
      () => repository.finalizePublication('old-r2', {
        outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'late',
      }, CREATED_AT + 20),
    ]) expect(action).toThrow(ConfigRepositoryError);
  });

  test('canonicalizes target slots into request identity and atomically freezes pending targets', () => {
    // Given
    const value = aggregate();
    const { repository, dbPath } = open();

    // When
    const result = repository.commit(command('targets', [3, 1], value));
    const inspector = new Database(dbPath, { readonly: true, strict: true });
    const workers = inspector.query<{
      worker_slot: number; target_revision: number; attempt_no: number;
      last_begin_previous_attempt_no: number | null; last_begin_reason: string | null;
      state: string; applied_revision: number | null; last_error: string | null;
    }, []>(`SELECT worker_slot,target_revision,attempt_no,last_begin_previous_attempt_no,last_begin_reason,
      state,applied_revision,last_error
      FROM configuration_operation_workers ORDER BY worker_slot`).all();
    inspector.close(true);

    // Then
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.operation).toMatchObject({
      state: 'committed', target_worker_count: 2, result_status: null, error_code: null,
    });
    expect(result.operation.request_hash).toBe(hashConfigurationRequest({
      kind: 'config', expected_revision: 1, aggregate: value, target_worker_slots: [1, 3],
    }));
    expect(workers).toEqual([
      { worker_slot: 1, target_revision: 2, state: 'pending', applied_revision: null, last_error: null,
        attempt_no: 0, last_begin_previous_attempt_no: null, last_begin_reason: null },
      { worker_slot: 3, target_revision: 2, state: 'pending', applied_revision: null, last_error: null,
        attempt_no: 0, last_begin_previous_attempt_no: null, last_begin_reason: null },
    ]);
    expect(repository.commit(command('targets', [1, 3], value)).kind).toBe('duplicate');
    expect(repository.commit(command('targets', [1], value))).toEqual({
      kind: 'idempotency_key_reused', mutation_id: 'targets',
    });
  });

  test('rejects duplicate, negative, and unsafe target slots but permits an empty frozen target set', () => {
    // Given
    const { repository } = open();

    // When / Then
    for (const slots of [[1, 1], [-1], [Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => repository.commit(command(`invalid-${String(slots[0])}`, slots))).toThrow(ConfigRepositoryError);
    }
    const empty = repository.commit(command('empty-targets', []));
    expect(empty.kind).toBe('committed');
    repository.beginPublication('empty-targets', CREATED_AT + 1);
    expect(repository.markDraining('empty-targets', CREATED_AT + 2).state).toBe('draining');
  });

  test('transitions through publishing to converged only after every frozen target converges', () => {
    // Given
    const { repository } = open();
    repository.commit(command('converge', [0, 2]));

    // When / Then
    expect(repository.beginPublication('converge', CREATED_AT + 1).state).toBe('publishing');
    beginTargets(repository, 'converge', [0, 2]);
    expect(() => repository.markDraining('converge', CREATED_AT + 3)).toThrow(ConfigRepositoryError);
    expect(repository.recordWorkerResult('converge', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3).state).toBe('converged');
    expect(() => repository.recordWorkerResult('converge', 2, {
      kind: 'converged', attempt_no: 1, applied_revision: 3,
    }, CREATED_AT + 4)).toThrow(ConfigRepositoryError);
    repository.recordWorkerResult('converge', 2, { kind: 'converged', attempt_no: 1, applied_revision: 2 }, CREATED_AT + 4);
    repository.markDraining('converge', CREATED_AT + 5);
    const terminal = repository.finalizePublication('converge', {
      outcome: 'converged', old_workers_exited: true,
    }, CREATED_AT + 6);
    expect(terminal).toMatchObject({ state: 'converged', result_status: 200, error_code: null });
    expect(repository.commit({ ...command('converge', [2, 0]), created_at: CREATED_AT + 99 })).toEqual({
      kind: 'duplicate', operation: terminal,
    });
    expect(() => repository.beginPublication('converge', CREATED_AT + 5)).toThrow(ConfigRepositoryError);
  });

  test('records failed targets and finalizes degraded with a durable 202 result', () => {
    // Given
    const { repository } = open();
    repository.commit(command('degrade', [4]));
    repository.beginPublication('degrade', CREATED_AT + 1);
    beginTargets(repository, 'degrade', [4]);

    // When
    const worker = repository.recordWorkerResult('degrade', 4, {
      kind: 'failed', attempt_no: 1, error: 'worker startup failed', applied_revision: 1,
    }, CREATED_AT + 3);
    const terminal = repository.finalizePublication('degrade', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'worker startup failed',
    }, CREATED_AT + 4);

    // Then
    expect(worker).toMatchObject({ state: 'failed', applied_revision: 1, last_error: 'worker startup failed' });
    expect(terminal).toMatchObject({ state: 'degraded', result_status: 202,
      error_code: 'replacement_convergence_failed', error_detail: 'worker startup failed' });
    expect(repository.getOperation('degrade')).toEqual(terminal);
  });

  test('rejects unknown workers, timestamp regression, premature worker reports, and terminal mutation', () => {
    // Given
    const { repository } = open();
    repository.commit(command('illegal', [0]));

    // When / Then
    expect(() => repository.recordWorkerResult('illegal', 0, {
      kind: 'failed', attempt_no: 1, error: 'failed',
    }, CREATED_AT + 1)).toThrow(ConfigRepositoryError);
    repository.beginPublication('illegal', CREATED_AT + 2);
    repository.beginWorkerAttempt('illegal', 0, 0, 'initial', CREATED_AT + 2);
    expect(() => repository.recordWorkerResult('illegal', 9, {
      kind: 'failed', attempt_no: 1, error: 'failed',
    }, CREATED_AT + 3)).toThrow(ConfigRepositoryError);
    expect(() => repository.recordWorkerResult('illegal', 0, {
      kind: 'failed', attempt_no: 1, error: '',
    }, CREATED_AT + 3)).toThrow(ConfigRepositoryError);
    expect(() => repository.recordWorkerResult('illegal', 0, {
      kind: 'failed', attempt_no: 1, error: 'failed',
    }, CREATED_AT + 1)).toThrow(ConfigRepositoryError);
    repository.recordWorkerResult('illegal', 0, { kind: 'failed', attempt_no: 1, error: 'failed' }, CREATED_AT + 3);
    repository.finalizePublication('illegal', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'failed',
    }, CREATED_AT + 3);
    expect(() => repository.recordWorkerResult('illegal', 0, {
      kind: 'failed', attempt_no: 1, error: 'late',
    }, CREATED_AT + 4)).toThrow(ConfigRepositoryError);
  });

  test('rolls back materialization, operation, revision, and frozen targets when target insertion seam fails', () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'bungee-config-target-rollback-'));
    roots.push(root);
    const dbPath = join(root, 'config.db');
    const failure = new Error('after targets');
    const repository = ConfigRepository.open(dbPath, {
      faultInjection: (stage) => { if (stage === 'after_targets') throw failure; },
    });
    repositories.push(repository);

    // When / Then
    expect(() => repository.commit(command('target-rollback', [0, 1]))).toThrow(ConfigRepositoryError);
    expect(counts(dbPath)).toEqual({ revisions: 1, operations: 0, workers: 0 });
    expect(repository.getSnapshot().revision).toBe(1);
  });

  test('rejects degraded finalization after every target already converged', () => {
    // Given
    const { repository } = open();
    repository.commit(command('truthful-terminal', [0]));
    repository.beginPublication('truthful-terminal', CREATED_AT + 1);
    beginTargets(repository, 'truthful-terminal', [0]);
    repository.recordWorkerResult('truthful-terminal', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);

    // When / Then
    expect(() => repository.finalizePublication(
      'truthful-terminal', {
        outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'false failure',
      }, CREATED_AT + 4,
    )).toThrow(ConfigRepositoryError);
  });
});

describe('ConfigRepository configuration commits', () => {
  test('commits exact configured-auth snapshots as ordinary configuration state', () => {
    // Given
    const { repository: first } = open();
    const { repository: second } = open();

    // When
    const firstAggregate = aggregate(['first-token']);
    const secondAggregate = aggregate(['first-token', 'second-token']);
    const firstResult = first.commit(command('configured-auth-first', [0], firstAggregate));
    const secondResult = second.commit(command('configured-auth-second', [0], secondAggregate));

    // Then
    expect(firstResult.kind).toBe('committed');
    expect(secondResult.kind).toBe('committed');
    expect(first.getSnapshot()).toEqual({
      revision: 2,
      content_hash: hashConfigurationContent(firstAggregate),
      aggregate: firstAggregate,
    });
    expect(second.getSnapshot()).toEqual({
      revision: 2,
      content_hash: hashConfigurationContent(secondAggregate),
      aggregate: secondAggregate,
    });
  });

  test('commits absent, disabled, and enabled configured-auth shapes', () => {
    // Given
    const cases = [
      { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] },
      aggregate([], false),
      aggregate(['configured-token']),
    ] as const;

    // When / Then
    for (const [index, value] of cases.entries()) {
      const { repository, dbPath } = open();
      const result = repository.commit(command(`configured-auth-${index}`, [0], value));
      expect(result.kind).toBe('committed');
      if (result.kind !== 'committed') continue;
      expect(result.snapshot).toEqual({
        revision: 2,
        content_hash: hashConfigurationContent(value),
        aggregate: value,
      });
      const inspector = new Database(dbPath, { readonly: true, strict: true });
      expect(inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_operations').get()?.count).toBe(1);
      inspector.close(true);
      expect(repository.getSnapshot()).toEqual(result.snapshot);
    }
  });
});
