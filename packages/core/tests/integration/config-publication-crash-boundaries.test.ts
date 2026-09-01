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
  const root = mkdtempSync(join(tmpdir(), 'bungee-publication-crash-'));
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
    mutation_id: mutationId, expected_revision: 1, aggregate: AGGREGATE, kind: 'config',
    created_at: CREATED_AT, target_worker_slots: slots,
  }).kind).toBe('committed');
}

function expectInvalid(action: () => unknown): void {
  try {
    action();
    throw new Error('expected invalid_operation');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigRepositoryError);
    if (error instanceof ConfigRepositoryError) expect(error.code).toBe('invalid_operation');
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('publication crash boundaries', () => {
  test('replays beginPublication unchanged after reopen', () => {
    const { repository, dbPath } = open();
    commit(repository, 'begin-replay');
    const publishing = repository.beginPublication('begin-replay', CREATED_AT + 1);
    const reopened = reopen(repository, dbPath);

    expect(reopened.beginPublication('begin-replay', CREATED_AT + 2)).toEqual(publishing);
    expect(reopened.getOperation('begin-replay')?.updated_at).toBe(CREATED_AT + 1);
    expectInvalid(() => reopened.beginPublication('begin-replay', CREATED_AT));
  });

  test('reopens every transition without losing exact operation or attempt state', () => {
    let { repository, dbPath } = open();
    commit(repository, 'phase-reopen');
    const requestHash = repository.getOperation('phase-reopen')?.request_hash;
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()?.operation.state).toBe('committed');

    repository.beginPublication('phase-reopen', CREATED_AT + 1);
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()?.operation.state).toBe('publishing');

    repository.beginWorkerAttempt('phase-reopen', 0, 0, 'initial', CREATED_AT + 2);
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()?.targets[0]).toMatchObject({ state: 'pending', attempt_no: 1 });

    repository.recordWorkerResult('phase-reopen', 0, {
      kind: 'failed', attempt_no: 1, error: 'failed',
    }, CREATED_AT + 3);
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()?.targets[0]).toMatchObject({ state: 'failed', attempt_no: 1 });

    repository.beginWorkerAttempt('phase-reopen', 0, 1, 'retry', CREATED_AT + 4);
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()?.targets[0]).toMatchObject({ state: 'pending', attempt_no: 2 });

    repository.recordWorkerResult('phase-reopen', 0, {
      kind: 'converged', attempt_no: 2, applied_revision: 2,
    }, CREATED_AT + 5);
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()?.targets[0]).toMatchObject({ state: 'converged', attempt_no: 2 });

    repository.markDraining('phase-reopen', CREATED_AT + 6);
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()?.operation.state).toBe('draining');

    repository.finalizePublication('phase-reopen', {
      outcome: 'converged', old_workers_exited: true,
    }, CREATED_AT + 7);
    repository = reopen(repository, dbPath);
    expect(repository.getActivePublication()).toBeNull();
    expect(repository.getOperation('phase-reopen')?.state).toBe('converged');
    expect(repository.getOperation('phase-reopen')?.request_hash).toBe(requestHash);
  });

  test('allows an empty exact target set to cross the draining boundary', () => {
    const { repository, dbPath } = open();
    commit(repository, 'empty-drain', []);
    repository.beginPublication('empty-drain', CREATED_AT + 1);

    const draining = repository.markDraining('empty-drain', CREATED_AT + 2);

    expect(draining.state).toBe('draining');
    const reopened = reopen(repository, dbPath);
    expect(reopened.getActivePublication()?.operation.state).toBe('draining');
    expect(reopened.finalizePublication('empty-drain', {
      outcome: 'converged', old_workers_exited: true,
    }, CREATED_AT + 3).state).toBe('converged');
  });

  test('requires exit proof even when replaying a converged terminal finalization', () => {
    const { repository } = open();
    commit(repository, 'terminal-proof');
    repository.beginPublication('terminal-proof', CREATED_AT + 1);
    repository.beginWorkerAttempt('terminal-proof', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('terminal-proof', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('terminal-proof', CREATED_AT + 4);
    repository.finalizePublication('terminal-proof', {
      outcome: 'converged', old_workers_exited: true,
    }, CREATED_AT + 5);

    expectInvalid(() => Reflect.apply(repository.finalizePublication, repository, [
      'terminal-proof', { outcome: 'converged', old_workers_exited: false }, CREATED_AT + 6,
    ]));
  });

  test('accepts recovery-only drain finalization only for fully converged master-recovery targets', () => {
    const { repository } = open();
    commit(repository, 'recovery-finalize');
    repository.beginPublication('recovery-finalize', CREATED_AT + 1);
    repository.beginWorkerAttempt('recovery-finalize', 0, 0, 'master_recovery', CREATED_AT + 2);
    repository.recordWorkerResult('recovery-finalize', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('recovery-finalize', CREATED_AT + 4);

    const terminal = repository.finalizePublication('recovery-finalize', {
      outcome: 'degraded', error_code: 'old_worker_drain_failed',
      error_detail: 'old generation exit proof unavailable after master recovery',
      master_recovery_without_exit_proof: true,
    }, CREATED_AT + 5);

    expect(terminal).toMatchObject({ state: 'degraded', result_status: 202,
      error_code: 'old_worker_drain_failed' });
  });

  test('rejects recovery-only drain finalization without exact recovery attempt evidence', () => {
    for (const reason of ['initial', 'retry'] as const) {
      const { repository } = open();
      const mutationId = `recovery-proof-${reason}`;
      commit(repository, mutationId);
      repository.beginPublication(mutationId, CREATED_AT + 1);
      repository.beginWorkerAttempt(mutationId, 0, 0, 'initial', CREATED_AT + 2);
      if (reason === 'retry') {
        repository.recordWorkerResult(mutationId, 0, {
          kind: 'failed', attempt_no: 1, error: 'retry target',
        }, CREATED_AT + 3);
        repository.beginWorkerAttempt(mutationId, 0, 1, 'retry', CREATED_AT + 4);
      }
      repository.recordWorkerResult(mutationId, 0, {
        kind: 'converged', attempt_no: reason === 'initial' ? 1 : 2, applied_revision: 2,
      }, CREATED_AT + 5);
      repository.markDraining(mutationId, CREATED_AT + 6);

      expectInvalid(() => repository.finalizePublication(mutationId, {
        outcome: 'degraded', error_code: 'old_worker_drain_failed',
        error_detail: 'missing old generation exit proof',
        master_recovery_without_exit_proof: true,
      }, CREATED_AT + 7));
    }
  });

  test('increments recovery generation across consecutive master crashes and fences stale ACKs', () => {
    const { repository, dbPath } = open();
    commit(repository, 'drain-recovery', [0, 1]);
    repository.beginPublication('drain-recovery', CREATED_AT + 1);
    for (const slot of [0, 1]) repository.beginWorkerAttempt('drain-recovery', slot, 0, 'initial', CREATED_AT + 2);
    for (const slot of [0, 1]) {
      repository.recordWorkerResult('drain-recovery', slot, {
        kind: 'converged', attempt_no: 1, applied_revision: 2,
      }, CREATED_AT + 3);
    }
    repository.markDraining('drain-recovery', CREATED_AT + 4);
    const beforeRecovery = repository.getOperation('drain-recovery');
    if (beforeRecovery === null) throw new Error('drain recovery operation missing');
    const requestHash = beforeRecovery.request_hash;
    let reopened = reopen(repository, dbPath);

    const generationOne = reopened.beginDrainingRecovery('drain-recovery', 0, CREATED_AT + 5);
    expect(generationOne).toMatchObject({ state: 'draining', drain_recovery_generation: 1,
      last_drain_recovery_previous_generation: 0 });
    expect(reopened.getActivePublication()?.targets).toEqual([
      expect.objectContaining({ worker_slot: 0, state: 'pending', attempt_no: 2,
        drain_recovery_generation: 1, last_begin_previous_attempt_no: 1, last_begin_reason: 'master_recovery' }),
      expect.objectContaining({ worker_slot: 1, state: 'pending', attempt_no: 2,
        drain_recovery_generation: 1, last_begin_previous_attempt_no: 1, last_begin_reason: 'master_recovery' }),
    ]);
    reopened = reopen(reopened, dbPath);
    expect(reopened.beginDrainingRecovery('drain-recovery', 0, CREATED_AT + 6)).toEqual(generationOne);
    expect(reopened.getActivePublication()?.targets.map(({ attempt_no }) => attempt_no)).toEqual([2, 2]);
    expectInvalid(() => reopened.recordWorkerResult('drain-recovery', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 6));
    reopened.recordWorkerResult('drain-recovery', 0, {
      kind: 'failed', attempt_no: 2, error: 'generation one failed',
    }, CREATED_AT + 6);
    reopened.beginWorkerAttempt('drain-recovery', 0, 2, 'retry', CREATED_AT + 6);
    const afterRetry = reopened.getOperation('drain-recovery');
    if (afterRetry === null) throw new Error('drain recovery operation missing after retry');
    expect(reopened.beginDrainingRecovery('drain-recovery', 0, CREATED_AT + 7)).toEqual(afterRetry);
    expect(reopened.getActivePublication()?.targets[0]).toMatchObject({
      attempt_no: 3, drain_recovery_generation: 1, last_begin_reason: 'retry',
    });
    reopened.recordWorkerResult('drain-recovery', 0, {
      kind: 'converged', attempt_no: 3, applied_revision: 2,
    }, CREATED_AT + 6);
    reopened.recordWorkerResult('drain-recovery', 1, {
      kind: 'converged', attempt_no: 2, applied_revision: 2,
    }, CREATED_AT + 6);
    reopened = reopen(reopened, dbPath);

    const generationTwo = reopened.beginDrainingRecovery('drain-recovery', 1, CREATED_AT + 7);
    expect(generationTwo).toMatchObject({ drain_recovery_generation: 2,
      last_drain_recovery_previous_generation: 1 });
    expect(reopened.getActivePublication()?.targets).toEqual([
      expect.objectContaining({ worker_slot: 0, state: 'pending', attempt_no: 4, drain_recovery_generation: 2 }),
      expect.objectContaining({ worker_slot: 1, state: 'pending', attempt_no: 3, drain_recovery_generation: 2 }),
    ]);
    expectInvalid(() => reopened.beginDrainingRecovery('drain-recovery', 0, CREATED_AT + 8));
    expectInvalid(() => reopened.recordWorkerResult('drain-recovery', 0, {
      kind: 'converged', attempt_no: 2, applied_revision: 2,
    }, CREATED_AT + 8));
    for (const slot of [0, 1]) reopened.recordWorkerResult('drain-recovery', slot, {
      kind: 'converged', attempt_no: slot === 0 ? 4 : 3, applied_revision: 2,
    }, CREATED_AT + 8);
    expectInvalid(() => reopened.finalizePublication('drain-recovery', {
      outcome: 'converged', old_workers_exited: true,
    }, CREATED_AT + 9));
    const terminalOutcome = {
      outcome: 'degraded', error_code: 'old_worker_drain_failed',
      error_detail: 'drain proof lost during master recovery', old_workers_exited: true,
    } as const;
    const terminal = reopened.finalizePublication('drain-recovery', terminalOutcome, CREATED_AT + 9);
    expect(terminal).toMatchObject({
      state: 'degraded', result_status: 202, error_code: 'old_worker_drain_failed',
      error_detail: 'drain proof lost during master recovery', drain_recovery_generation: 2,
    });
    expect(terminal.request_hash).toBe(requestHash);
    reopened = reopen(reopened, dbPath);
    expect(reopened.finalizePublication('drain-recovery', terminalOutcome, CREATED_AT + 9)).toEqual(terminal);
  });

  test('allows master recovery and retry attempts while draining but never initial', () => {
    const { repository } = open();
    commit(repository, 'draining-attempt');
    repository.beginPublication('draining-attempt', CREATED_AT + 1);
    repository.beginWorkerAttempt('draining-attempt', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('draining-attempt', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('draining-attempt', CREATED_AT + 4);
    repository.beginDrainingRecovery('draining-attempt', 0, CREATED_AT + 5);
    expectInvalid(() => repository.beginWorkerAttempt(
      'draining-attempt', 0, 1, 'master_recovery', CREATED_AT + 5,
    ));
    repository.recordWorkerResult('draining-attempt', 0, {
      kind: 'failed', attempt_no: 2, error: 'failed',
    }, CREATED_AT + 6);

    expect(repository.beginWorkerAttempt(
      'draining-attempt', 0, 2, 'retry', CREATED_AT + 7,
    )).toMatchObject({ state: 'pending', attempt_no: 3, drain_recovery_generation: 1,
      last_begin_reason: 'retry' });
    expectInvalid(() => repository.beginWorkerAttempt(
      'draining-attempt', 0, 3, 'initial', CREATED_AT + 8,
    ));
    expectInvalid(() => repository.beginWorkerAttempt(
      'draining-attempt', 0, 3, 'master_recovery', CREATED_AT + 8,
    ));
    expect(repository.beginDrainingRecovery(
      'draining-attempt', 1, CREATED_AT + 8,
    )).toMatchObject({ drain_recovery_generation: 2 });
  });

  test('rolls back draining recovery fencing when any target attempt would overflow', () => {
    const { repository, dbPath } = open();
    commit(repository, 'drain-overflow', [0, 1]);
    repository.beginPublication('drain-overflow', CREATED_AT + 1);
    for (const slot of [0, 1]) repository.beginWorkerAttempt('drain-overflow', slot, 0, 'initial', CREATED_AT + 2);
    for (const slot of [0, 1]) repository.recordWorkerResult('drain-overflow', slot, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('drain-overflow', CREATED_AT + 4);
    const db = repository['db'];
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run(`UPDATE configuration_operation_workers SET attempt_no=${Number.MAX_SAFE_INTEGER},
      last_begin_previous_attempt_no=${Number.MAX_SAFE_INTEGER - 1},last_begin_reason='master_recovery'
      WHERE worker_slot=1`);
    db.run('PRAGMA ignore_check_constraints=OFF');

    expectInvalid(() => repository.beginDrainingRecovery('drain-overflow', 0, CREATED_AT + 5));
    const reopened = reopen(repository, dbPath);
    expect(reopened.getOperation('drain-overflow')).toMatchObject({ drain_recovery_generation: 0 });
    expect(reopened.getActivePublication()?.targets.map(({ worker_slot, attempt_no }) => ({
      worker_slot, attempt_no,
    }))).toEqual([
      { worker_slot: 0, attempt_no: 1 },
      { worker_slot: 1, attempt_no: Number.MAX_SAFE_INTEGER },
    ]);
  });

  test('accepts an exact worker result replay after publication enters draining', () => {
    const { repository, dbPath } = open();
    commit(repository, 'late-duplicate');
    repository.beginPublication('late-duplicate', CREATED_AT + 1);
    repository.beginWorkerAttempt('late-duplicate', 0, 0, 'initial', CREATED_AT + 2);
    const result = {
      kind: 'converged' as const, attempt_no: 1, applied_revision: 2,
    };
    const worker = repository.recordWorkerResult('late-duplicate', 0, result, CREATED_AT + 3);
    repository.markDraining('late-duplicate', CREATED_AT + 4);
    const reopened = reopen(repository, dbPath);

    expect(reopened.recordWorkerResult('late-duplicate', 0, result, CREATED_AT + 3)).toEqual(worker);
  });

  test('fails closed when persisted begin reason contradicts its attempt transition', () => {
    const corruptions = [
      "UPDATE configuration_operation_workers SET attempt_no=2,last_begin_previous_attempt_no=1,last_begin_reason='initial'",
      "UPDATE configuration_operation_workers SET attempt_no=1,last_begin_previous_attempt_no=0,last_begin_reason='retry'",
    ] as const;
    for (const sql of corruptions) {
      const { repository, dbPath } = open();
      commit(repository, 'reason-corrupt');
      repository.close();
      repositories.splice(repositories.indexOf(repository), 1);
      const db = new Database(dbPath, { readwrite: true, strict: true });
      db.run('PRAGMA ignore_check_constraints=ON');
      db.run(sql);
      db.close(true);
      expect(() => ConfigRepository.open(dbPath)).toThrow(ConfigRepositoryError);
    }
  });

  test('rejects wrong recovery generations and fails closed on generation corruption', () => {
    const corruptions = [
      'UPDATE configuration_operations SET drain_recovery_generation=9007199254740992',
      'UPDATE configuration_operations SET drain_recovery_generation=1,last_drain_recovery_previous_generation=0',
    ] as const;
    for (const sql of corruptions) {
      const { repository, dbPath } = open();
      commit(repository, 'drain-flag-corrupt');
      repository.close();
      repositories.splice(repositories.indexOf(repository), 1);
      const db = new Database(dbPath, { readwrite: true, strict: true });
      db.run('PRAGMA ignore_check_constraints=ON');
      db.run(sql);
      db.close(true);
      expect(() => ConfigRepository.open(dbPath)).toThrow(ConfigRepositoryError);
    }

    const { repository, dbPath } = open();
    commit(repository, 'drain-ledger-corrupt');
    repository.beginPublication('drain-ledger-corrupt', CREATED_AT + 1);
    repository.beginWorkerAttempt('drain-ledger-corrupt', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('drain-ledger-corrupt', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('drain-ledger-corrupt', CREATED_AT + 4);
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const db = new Database(dbPath, { readwrite: true, strict: true });
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run('UPDATE configuration_operations SET drain_recovery_generation=1,last_drain_recovery_previous_generation=0');
    db.close(true);
    expect(() => ConfigRepository.open(dbPath)).toThrow(ConfigRepositoryError);

    const mismatch = open();
    commit(mismatch.repository, 'worker-generation-corrupt');
    mismatch.repository.close();
    repositories.splice(repositories.indexOf(mismatch.repository), 1);
    const mismatchDb = new Database(mismatch.dbPath, { readwrite: true, strict: true });
    mismatchDb.run('PRAGMA ignore_check_constraints=ON');
    mismatchDb.run('UPDATE configuration_operation_workers SET drain_recovery_generation=1');
    mismatchDb.close(true);
    expect(() => ConfigRepository.open(mismatch.dbPath)).toThrow(ConfigRepositoryError);
  });

  test('rejects stale, future, unsafe, and overflowing recovery generations without partial writes', () => {
    const { repository, dbPath } = open();
    commit(repository, 'generation-invalid');
    repository.beginPublication('generation-invalid', CREATED_AT + 1);
    repository.beginWorkerAttempt('generation-invalid', 0, 0, 'initial', CREATED_AT + 2);
    repository.recordWorkerResult('generation-invalid', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 3);
    repository.markDraining('generation-invalid', CREATED_AT + 4);
    repository.beginDrainingRecovery('generation-invalid', 0, CREATED_AT + 5);
    expectInvalid(() => repository.beginDrainingRecovery('generation-invalid', 0, -1));

    for (const generation of [2, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -1]) {
      expectInvalid(() => repository.beginDrainingRecovery('generation-invalid', generation, CREATED_AT + 6));
    }
    const reopened = reopen(repository, dbPath);
    expect(reopened.getOperation('generation-invalid')).toMatchObject({ drain_recovery_generation: 1 });
    expect(reopened.getActivePublication()?.targets[0]).toMatchObject({ attempt_no: 2,
      drain_recovery_generation: 1 });
  });
});
