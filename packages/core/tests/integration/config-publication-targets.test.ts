import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConfigurationAggregate, Sha256Digest } from '@jeffusion/bungee-types';
import {
  CONFIG_MIGRATIONS,
  ConfigRepository,
  ConfigRepositoryError,
  hashConfigurationContent,
} from '../../src/config-storage';
import { migrateConfigurationDatabase } from '../../src/config-storage/migrations';
import { prepareConfigurationRuntimeCutover } from '../../src/config-storage/config-repository';
import { verifySchemaFingerprint } from '../../src/config-storage/schema-fingerprint';
import { replaceActiveMaterialization } from '../../src/config-storage/materialize';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';
import { settleWorkerLaunch } from '../helpers/worker-launch';
import { acquireMasterInstanceLock } from '../../src/master-runtime/instance-lock';
import { prepareStoppedDockerCutover } from '../../src/master-runtime/runtime-upgrade';

setDefaultTimeout(STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

const CREATED_AT = 1_700_000_000_000;
const CATALOG: Sha256Digest = `sha256:${'e'.repeat(64)}`;
const OTHER_CATALOG: Sha256Digest = `sha256:${'f'.repeat(64)}`;
const EMPTY: ConfigurationAggregate = {
  logical_configuration: { services: [], routes: [], plugins: [] },
  plugin_activations: [],
};
const VALUE: ConfigurationAggregate = {
  logical_configuration: { ...EMPTY.logical_configuration, log_level: 'warn' },
  plugin_activations: [],
};

const roots: string[] = [];
const repositories: ConfigRepository[] = [];

function databasePath(): string {
  // The offline cutover uses SQLITE_OPEN_NOFOLLOW, including for parent directories.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'bungee-publication-targets-'));
  roots.push(root);
  return join(root, 'config.db');
}

function open(): { readonly repository: ConfigRepository; readonly dbPath: string } {
  const dbPath = databasePath();
  const repository = ConfigRepository.open(dbPath);
  repositories.push(repository);
  return { repository, dbPath };
}

function commit(
  repository: ConfigRepository, mutationId: string, expectedRevision: number,
  now = CREATED_AT, slots: readonly number[] = [0],
) {
  return repository.commit({
    mutation_id: mutationId, expected_revision: expectedRevision, aggregate: VALUE,
    kind: 'config', created_at: now, target_worker_slots: slots,
  });
}

function claim(repository: ConfigRepository, now = CREATED_AT) {
  const publication = repository.claimPublicationTarget(CATALOG, now);
  if (publication === null) throw new Error('expected a claimed publication target');
  return publication;
}

function uuid(seed: string): string {
  return `00000000-0000-4000-8000-${seed.padStart(12, '0')}`;
}

function identity(seed: string, slot = 0) {
  return { master_generation: uuid('1'), worker_instance_id: uuid(seed), worker_slot: slot } as const;
}

function guard(workerInstanceId: string, seed: string) {
  return {
    schema: 'bungee-process-lifetime-guard-v1' as const,
    identity: uuid(seed),
    process_instance_id: workerInstanceId,
    path: resolve(`/tmp/guard-${seed}`),
    device: '2049',
    inode: '42',
    host_boot_id: `linux:${uuid('2')}`,
    domain: 'bungee-local-flock' as const,
  };
}

function allocation(mutationId: string, slot = 0, attemptNo = 1) {
  return { mutation_id: mutationId, worker_slot: slot, attempt_no: attemptNo } as const;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('persisted publication targets', () => {
  test('keeps the owner snapshot frozen while newer expectations persist', () => {
    // Given
    const { repository } = open();
    expect(commit(repository, 'owner-r2', 1).kind).toBe('committed');
    const owner = claim(repository);
    repository.beginPublication('owner-r2', CREATED_AT + 1);

    // When
    expect(commit(repository, 'pending-r3', 2, CREATED_AT + 2).kind).toBe('committed');
    expect(commit(repository, 'pending-r4', 3, CREATED_AT + 3).kind).toBe('committed');
    const again = claim(repository, CREATED_AT + 4);

    // Then
    expect(owner.snapshot).toEqual({ revision: 2, content_hash: hashConfigurationContent(VALUE), aggregate: VALUE });
    expect(again.operation).toMatchObject({ mutation_id: 'owner-r2', committed_revision: 2, state: 'publishing' });
    expect(again.snapshot).toEqual(owner.snapshot);
    expect(repository.getSnapshot().revision).toBe(4);
    expect(repository.getOperation('pending-r3')).toMatchObject({ state: 'pending' });
    expect(repository.getOperation('pending-r4')).toMatchObject({ state: 'pending' });
  });

  test('supersedes unclaimed targets at the claim boundary and keeps duplicate identity', () => {
    // Given
    const { repository } = open();
    commit(repository, 'first-r2', 1);
    commit(repository, 'middle-r3', 2, CREATED_AT + 1);

    // When
    const owner = claim(repository, CREATED_AT + 2);
    const duplicate = commit(repository, 'middle-r3', 2, CREATED_AT + 3);

    // Then
    expect(owner.operation).toMatchObject({ mutation_id: 'middle-r3', committed_revision: 3, state: 'committed' });
    expect(repository.getOperation('first-r2')).toMatchObject({
      state: 'superseded', result_status: 409, error_code: 'revision_superseded',
    });
    expect(duplicate).toMatchObject({
      kind: 'duplicate', operation: { mutation_id: 'middle-r3', committed_revision: 3, state: 'committed' },
    });
    expect(repository.getSnapshot().revision).toBe(3);
  });

  test('lets admission preparation win the race against cancellation', () => {
    // Given
    const { repository } = open();
    commit(repository, 'race-r2', 1);
    claim(repository);
    repository.beginPublication('race-r2', CREATED_AT + 1);

    // When
    const decision = repository.enterPublicationPrepare('race-r2', 2, CREATED_AT + 2);

    // Then
    expect(decision).toMatchObject({ kind: 'granted', operation: { prepare_started: true } });
    let captured: unknown;
    try {
      repository.requestPublicationCancellation('race-r2', 2, CREATED_AT + 3);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ConfigRepositoryError);
    if (captured instanceof ConfigRepositoryError) expect(captured.code).toBe('cancellation_not_permitted');
    expect(repository.getActivePublication()?.operation).toMatchObject({
      mutation_id: 'race-r2', prepare_started: true, cancel_requested: false,
    });
  });

  test('supersedes a started candidate only after per-attempt exit evidence and then claims the newest target', () => {
    // Given
    const { repository } = open();
    commit(repository, 'cancelled-r2', 1);
    claim(repository);
    repository.beginPublication('cancelled-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('cancelled-r2', 0, 0, 'initial', CREATED_AT + 2);
    commit(repository, 'newest-r3', 2, CREATED_AT + 3);

    // When
    expect(() => repository.confirmPublicationCandidateExited('cancelled-r2', 2, CREATED_AT + 4))
      .toThrow(ConfigRepositoryError);
    const requested = repository.requestPublicationCancellation('cancelled-r2', 2, CREATED_AT + 5);
    const decision = repository.enterPublicationPrepare('cancelled-r2', 2, CREATED_AT + 6);

    // Then
    expect(requested.cancel_requested).toBe(true);
    expect(decision).toEqual({ kind: 'cancelled' });
    expect(repository.getActivePublication()?.operation.mutation_id).toBe('cancelled-r2');
    expect(() => repository.confirmPublicationCandidateExited('cancelled-r2', 2, CREATED_AT + 7))
      .toThrow(ConfigRepositoryError);
    expect(repository.getOutstandingPublicationCandidates()).toEqual([
      expect.objectContaining({ mutation_id: 'cancelled-r2', worker_slot: 0, attempt_no: 1 }),
    ]);
    repository.recordPublicationCandidateExit('cancelled-r2', 2, 0, 1,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 8);
    const terminal = repository.confirmPublicationCandidateExited('cancelled-r2', 2, CREATED_AT + 9);
    expect(terminal).toMatchObject({
      mutation_id: 'cancelled-r2', state: 'superseded', result_status: 409, error_code: 'revision_superseded',
    });
    expect(repository.getOutstandingPublicationCandidates()).toEqual([]);
    expect(repository.getActivePublication()).toBeNull();
    const next = claim(repository, CREATED_AT + 10);
    expect(next.operation).toMatchObject({ mutation_id: 'newest-r3', committed_revision: 3, state: 'committed' });
  });

  test('requires exit evidence for every started attempt and keeps the owner on incomplete proof', () => {
    // Given
    const { repository } = open();
    commit(repository, 'evidence-r2', 1, CREATED_AT, [0, 1]);
    claim(repository);
    repository.beginPublication('evidence-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('evidence-r2', 0, 0, 'initial', CREATED_AT + 2);
    repository.beginWorkerAttempt('evidence-r2', 1, 0, 'initial', CREATED_AT + 2);
    repository.requestPublicationCancellation('evidence-r2', 2, CREATED_AT + 3);

    // When / Then
    expect(() => repository.recordPublicationCandidateExit('evidence-r2', 2, 0, 2,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 4)).toThrow(ConfigRepositoryError);
    expect(() => repository.recordPublicationCandidateExit('evidence-r2', 2, 0, 0,
      { kind: 'not_started' }, CREATED_AT + 4)).toThrow(ConfigRepositoryError);
    repository.recordPublicationCandidateExit('evidence-r2', 2, 0, 1,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 4);
    expect(() => repository.confirmPublicationCandidateExited('evidence-r2', 2, CREATED_AT + 5))
      .toThrow(ConfigRepositoryError);
    expect(repository.getActivePublication()?.operation).toMatchObject({
      mutation_id: 'evidence-r2', state: 'publishing', cancel_requested: true,
    });

    repository.recordPublicationCandidateExit('evidence-r2', 2, 1, 1,
      { kind: 'not_started' }, CREATED_AT + 5);
    expect(repository.confirmPublicationCandidateExited('evidence-r2', 2, CREATED_AT + 6))
      .toMatchObject({ state: 'superseded', result_status: 409 });
  });

  test('re-checks the durable latest target inside the prepare transaction', () => {
    // Given
    const { repository } = open();
    commit(repository, 'stale-r2', 1);
    claim(repository);
    repository.beginPublication('stale-r2', CREATED_AT + 1);
    commit(repository, 'newest-r3', 2, CREATED_AT + 2);

    // When
    const decision = repository.enterPublicationPrepare('stale-r2', 2, CREATED_AT + 3);

    // Then
    expect(decision).toEqual({ kind: 'cancelled' });
    expect(repository.getOperation('stale-r2')).toMatchObject({
      state: 'publishing', prepare_started: false, cancel_requested: true,
    });
    expect(repository.confirmPublicationCandidateExited('stale-r2', 2, CREATED_AT + 4))
      .toMatchObject({ state: 'superseded' });
  });

  test('blocks claims after a stopped safety-unknown recovery', () => {
    // Given
    const { repository } = open();
    commit(repository, 'unknown-r2', 1);
    claim(repository);
    repository.beginPublication('unknown-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('unknown-r2', 0, 0, 'initial', CREATED_AT + 2);
    repository.fenceWorkerLaunchNotStarted('unknown-r2', 0, 1, CREATED_AT + 2);
    repository.recordWorkerResult('unknown-r2', 0, {
      kind: 'failed', attempt_no: 1, error: 'outcome unknown',
    }, CREATED_AT + 3);
    repository.finalizePublication('unknown-r2', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed',
      error_detail: 'outcome unknown', recovery_disposition: 'retryable',
    }, CREATED_AT + 4);
    const recoveryId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('unknown-r2')?.recovery_id;
    if (recoveryId === undefined) throw new Error('automatic recovery missing');
    repository.claimRecoveryAttempt(recoveryId, 0, CREATED_AT + 300);
    repository.stopRecovery(recoveryId, 1, 'safety_outcome_unknown', 'exit state unknown', CREATED_AT + 301);
    commit(repository, 'newest-r3', 2, CREATED_AT + 302);

    // When / Then
    let captured: unknown;
    try {
      claim(repository, CREATED_AT + 303);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ConfigRepositoryError);
    if (captured instanceof ConfigRepositoryError) expect(captured.code).toBe('recovery_in_progress');
    expect(repository.getActivePublication()).toBeNull();
  });

  test('keeps the claimed catalog identity immutable', () => {
    // Given
    const { repository } = open();
    commit(repository, 'catalog-r2', 1);
    claim(repository);

    // When / Then
    expect(() => repository.claimPublicationTarget(OTHER_CATALOG, CREATED_AT + 1)).toThrow(ConfigRepositoryError);
    expect(repository.getActivePublication()?.plugin_catalog_hash).toBe(CATALOG);
    expect(repository.getServingSnapshot({
      revision: 2, content_hash: hashConfigurationContent(VALUE), plugin_catalog_hash: OTHER_CATALOG,
    })).toBeNull();
  });
});

describe('publication target migration', () => {
  function versionSevenDatabase(): Database {
    const root = mkdtempSync(join(tmpdir(), 'bungee-publication-migration-'));
    roots.push(root);
    const db = new Database(join(root, 'config.db'), { create: true, readwrite: true, strict: true });
    migrateConfigurationDatabase(db, CONFIG_MIGRATIONS.filter(migration => migration.version <= 7));
    replaceActiveMaterialization(db, VALUE);
    db.run(`INSERT INTO configuration_revisions(revision,content_hash,kind,created_at) VALUES (2,?,'config',?)`,
      [hashConfigurationContent(VALUE), CREATED_AT]);
    db.run(`INSERT INTO configuration_operations
      (mutation_id,request_hash,expected_revision,committed_revision,kind,target_worker_count,state,
       drain_recovery_generation,last_drain_recovery_previous_generation,created_at,updated_at)
      VALUES ('prior-owner',?,1,2,'config',1,'committed',0,NULL,?,?)`,
    [`sha256:${'0'.repeat(64)}`, CREATED_AT, CREATED_AT]);
    db.run(`INSERT INTO configuration_operation_workers
      (mutation_id,worker_slot,target_revision,drain_recovery_generation,attempt_no,last_begin_previous_attempt_no,
       last_begin_reason,state,applied_revision,last_error,updated_at)
      VALUES ('prior-owner',0,2,0,0,NULL,NULL,'pending',NULL,NULL,?)`, [CREATED_AT]);
    db.run('UPDATE configuration_state SET active_revision=2,updated_at=?', [CREATED_AT]);
    return db;
  }

  test('refuses to upgrade a database with an unfinished publication', () => {
    // Given
    const db = versionSevenDatabase();
    try {
      // When
      let captured: unknown;
      try {
        migrateConfigurationDatabase(db, CONFIG_MIGRATIONS);
      } catch (error) {
        captured = error;
      }

      // Then
      expect(captured).toBeInstanceOf(ConfigRepositoryError);
      if (captured instanceof ConfigRepositoryError) expect(captured.code).toBe('migration_failed');
      expect(db.query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual(CONFIG_MIGRATIONS.slice(0, 7).map(({ version }) => ({ version })));
    } finally {
      db.close(true);
    }
  });

  test('upgrades terminal history without fabricating a catalog identity', () => {
    // Given
    const db = versionSevenDatabase();
    try {
      db.run(`UPDATE configuration_operations
        SET state='converged',result_status=200,updated_at=? WHERE mutation_id='prior-owner'`, [CREATED_AT]);
      db.run(`UPDATE configuration_operation_workers SET attempt_no=1,last_begin_previous_attempt_no=0,
        last_begin_reason='initial',state='converged',applied_revision=2,updated_at=? WHERE mutation_id='prior-owner'`,
      [CREATED_AT]);

      // When
      migrateConfigurationDatabase(db, CONFIG_MIGRATIONS);

      // Then
      expect(db.query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual(CONFIG_MIGRATIONS.map(({ version }) => ({ version })));
      expect(db.query<{ plugin_catalog_hash: string | null }, [string]>(
        'SELECT plugin_catalog_hash FROM configuration_operations WHERE mutation_id=?',
      ).get('prior-owner')).toEqual({ plugin_catalog_hash: null });
    } finally {
      db.close(true);
    }
  });
});

describe('worker launch storage', () => {
  test('registers an immutable intent idempotently and rejects allocation or instance reuse', () => {
    // Given
    const { repository } = open();
    commit(repository, 'launch-r2', 1);
    claim(repository);
    repository.beginPublication('launch-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('launch-r2', 0, 0, 'initial', CREATED_AT + 2);
    const first = identity('10');
    const firstGuard = guard(first.worker_instance_id, '11');

    // When
    const registered = repository.registerWorkerLaunch(first, firstGuard, allocation('launch-r2'), CREATED_AT + 3);
    const repeated = repository.registerWorkerLaunch(first, firstGuard, allocation('launch-r2'), CREATED_AT + 3);

    // Then
    expect(registered).toMatchObject({
      identity: first, allocation: allocation('launch-r2'), registered_at: CREATED_AT + 3,
      admitted: false, not_started: false, exited: false, cleanup_released: false,
    });
    expect(repeated).toEqual(registered);
    expect(repository.getWorkerLaunch(first.worker_instance_id)).toEqual(registered);
    expect(repository.getUnsettledWorkerLaunches()).toEqual([{ kind: 'launch', launch: registered }]);

    const other = identity('12');
    expect(() => repository.registerWorkerLaunch(other, guard(other.worker_instance_id, '13'),
      allocation('launch-r2'), CREATED_AT + 4)).toThrow(ConfigRepositoryError);
    expect(() => repository.registerWorkerLaunch(first, firstGuard, null, CREATED_AT + 5))
      .toThrow(ConfigRepositoryError);
    expect(() => repository.fenceWorkerLaunchNotStarted('launch-r2', 0, 1, CREATED_AT + 6))
      .toThrow(ConfigRepositoryError);
  });

  test('rejects registration for a cancelled, historical or terminal allocation', () => {
    // Given / When / Then
    const cancelled = open().repository;
    commit(cancelled, 'cancelled-launch-r2', 1);
    claim(cancelled);
    cancelled.beginPublication('cancelled-launch-r2', CREATED_AT + 1);
    cancelled.beginWorkerAttempt('cancelled-launch-r2', 0, 0, 'initial', CREATED_AT + 2);
    cancelled.requestPublicationCancellation('cancelled-launch-r2', 2, CREATED_AT + 3);
    const afterCancel = identity('90');
    expect(() => cancelled.registerWorkerLaunch(afterCancel, guard(afterCancel.worker_instance_id, '91'),
      allocation('cancelled-launch-r2'), CREATED_AT + 4)).toThrow(ConfigRepositoryError);

    const historical = open().repository;
    commit(historical, 'historical-launch-r2', 1);
    claim(historical);
    historical.beginPublication('historical-launch-r2', CREATED_AT + 1);
    historical.beginWorkerAttempt('historical-launch-r2', 0, 0, 'initial', CREATED_AT + 2);
    historical.recordWorkerResult('historical-launch-r2', 0, {
      kind: 'failed', attempt_no: 1, error: 'failed',
    }, CREATED_AT + 3);
    settleWorkerLaunch(historical, 'historical-launch-r2', 0, 1, CREATED_AT + 4);
    historical.beginWorkerAttempt('historical-launch-r2', 0, 1, 'retry', CREATED_AT + 5);
    const historicalIdentity = identity('92');
    expect(() => historical.registerWorkerLaunch(historicalIdentity, guard(historicalIdentity.worker_instance_id, '93'),
      allocation('historical-launch-r2', 0, 1), CREATED_AT + 6)).toThrow(ConfigRepositoryError);
    expect(historical.registerWorkerLaunch(historicalIdentity, guard(historicalIdentity.worker_instance_id, '93'),
      allocation('historical-launch-r2', 0, 2), CREATED_AT + 6)).toMatchObject({ allocation: allocation('historical-launch-r2', 0, 2) });

    const terminal = open().repository;
    commit(terminal, 'terminal-launch-r2', 1);
    claim(terminal);
    terminal.beginPublication('terminal-launch-r2', CREATED_AT + 1);
    terminal.beginWorkerAttempt('terminal-launch-r2', 0, 0, 'initial', CREATED_AT + 2);
    const terminalIdentity = identity('94');
    terminal.registerWorkerLaunch(terminalIdentity, guard(terminalIdentity.worker_instance_id, '95'),
      allocation('terminal-launch-r2'), CREATED_AT + 3);
    terminal['db'].run(`UPDATE configuration_operations
      SET state='superseded',result_status=409,error_code='revision_superseded',
        error_detail='forced terminal',updated_at=? WHERE mutation_id='terminal-launch-r2'`, [CREATED_AT + 4]);
    const late = identity('96');
    expect(() => terminal.registerWorkerLaunch(late, guard(late.worker_instance_id, '97'),
      allocation('terminal-launch-r2'), CREATED_AT + 5)).toThrow(ConfigRepositoryError);
  });

  test('does not block a new claim on an admitted current serving launch', () => {
    // Given
    const { repository } = open();
    commit(repository, 'admitted-r2', 1);
    claim(repository);
    repository.beginPublication('admitted-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('admitted-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('98');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, '99'),
      allocation('admitted-r2'), CREATED_AT + 3);
    repository.recordWorkerLaunchAdmitted(worker.worker_instance_id, CREATED_AT + 4);
    repository.recordWorkerResult('admitted-r2', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 5);
    repository.markDraining('admitted-r2', CREATED_AT + 6);
    repository.finalizePublication('admitted-r2', { outcome: 'converged', old_workers_exited: true }, CREATED_AT + 7);
    expect(commit(repository, 'after-admitted-r3', 2, CREATED_AT + 8).kind).toBe('committed');

    // When
    const next = claim(repository, CREATED_AT + 9);

    // Then
    expect(next.operation).toMatchObject({ mutation_id: 'after-admitted-r3', committed_revision: 3 });
    const launch = repository.getWorkerLaunch(worker.worker_instance_id);
    if (launch === null) throw new Error('admitted launch missing');
    expect(launch).toMatchObject({ admitted: true, exited: false });
    // The claimed view leaves admitted serving occupancy to the runtime; the full inventory
    // still accounts for it until explicit exit and cleanup.
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    expect(repository.getWorkerLaunchInventory()).toEqual([{ kind: 'launch', launch }]);
  });

  test('inventory retains admitted publication-less launches until explicit exit and cleanup', () => {
    // Given
    const { repository } = open();
    const worker = identity('c0');
    const registered = repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, 'c1'), null, CREATED_AT);
    const admitted = repository.recordWorkerLaunchAdmitted(worker.worker_instance_id, CREATED_AT + 1);

    // When / Then
    expect(registered.allocation).toBeNull();
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    expect(repository.getWorkerLaunchInventory()).toEqual([{ kind: 'launch', launch: admitted }]);

    repository.recordWorkerLaunchExit(worker.worker_instance_id, { kind: 'exited', cleanup: 'unknown' }, CREATED_AT + 2);
    expect(repository.getWorkerLaunchInventory()).toHaveLength(1);

    repository.recordWorkerLaunchExit(worker.worker_instance_id, { kind: 'exited', cleanup: 'released' }, CREATED_AT + 3);
    expect(repository.getWorkerLaunchInventory()).toEqual([]);
  });

  test('blocks draining recovery until the old launch has exit and cleanup proof', () => {
    // Given
    const { repository } = open();
    commit(repository, 'drain-launch-r2', 1);
    claim(repository);
    repository.beginPublication('drain-launch-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('drain-launch-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('a0');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, 'a1'),
      allocation('drain-launch-r2'), CREATED_AT + 3);
    repository.recordWorkerResult('drain-launch-r2', 0, {
      kind: 'converged', attempt_no: 1, applied_revision: 2,
    }, CREATED_AT + 4);
    repository.markDraining('drain-launch-r2', CREATED_AT + 5);

    // When / Then
    expect(() => repository.beginDrainingRecovery('drain-launch-r2', 0, CREATED_AT + 6))
      .toThrow(ConfigRepositoryError);
    repository.recordWorkerLaunchExit(worker.worker_instance_id,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 7);
    expect(repository.beginDrainingRecovery('drain-launch-r2', 0, CREATED_AT + 8))
      .toMatchObject({ state: 'draining', drain_recovery_generation: 1 });
  });

  test('confirms candidate supersession from exact allocation launch proof without duplicated evidence', () => {
    // Given
    const { repository } = open();
    commit(repository, 'launch-proof-r2', 1);
    claim(repository);
    repository.beginPublication('launch-proof-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('launch-proof-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('b0');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, 'b1'),
      allocation('launch-proof-r2'), CREATED_AT + 3);
    repository.recordWorkerLaunchExit(worker.worker_instance_id, { kind: 'not_started' }, CREATED_AT + 4);
    repository.requestPublicationCancellation('launch-proof-r2', 2, CREATED_AT + 5);

    // When
    const facts = repository.getWorkerLaunchAllocationFacts(allocation('launch-proof-r2'));
    const terminal = repository.confirmPublicationCandidateExited('launch-proof-r2', 2, CREATED_AT + 6);

    // Then
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    expect(facts).toMatchObject({
      allocation: allocation('launch-proof-r2'), settled: true,
      not_started_at: CREATED_AT + 4, exited_at: null,
    });
    expect(terminal).toMatchObject({ state: 'superseded', result_status: 409, error_code: 'revision_superseded' });
  });

  test('confirms candidate supersession from launch exit plus cleanup proof', () => {
    // Given
    const { repository } = open();
    commit(repository, 'launch-exit-r2', 1);
    claim(repository);
    repository.beginPublication('launch-exit-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('launch-exit-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('b2');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, 'b3'),
      allocation('launch-exit-r2'), CREATED_AT + 3);
    repository.recordWorkerLaunchExit(worker.worker_instance_id,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 4);
    repository.requestPublicationCancellation('launch-exit-r2', 2, CREATED_AT + 5);

    // When / Then
    expect(repository.getWorkerLaunchAllocationFacts(allocation('launch-exit-r2'))).toMatchObject({
      settled: true, exited_at: CREATED_AT + 4, cleanup_released_at: CREATED_AT + 4,
    });
    expect(repository.confirmPublicationCandidateExited('launch-exit-r2', 2, CREATED_AT + 6))
      .toMatchObject({ state: 'superseded', result_status: 409 });
  });

  test('does not treat an unregistered reservation as settled and rejects conflicting proofs', () => {
    // Given
    const { repository } = open();
    commit(repository, 'proof-conflict-r2', 1);
    claim(repository);
    repository.beginPublication('proof-conflict-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('proof-conflict-r2', 0, 0, 'initial', CREATED_AT + 2);
    expect(repository.getWorkerLaunchAllocationFacts(allocation('proof-conflict-r2'))).toMatchObject({
      settled: false, launch: null, reserved_at: CREATED_AT + 2, not_started_at: null,
    });
    expect(repository.getWorkerLaunchAllocationFacts(allocation('absent', 0, 1))).toBeNull();
    const worker = identity('b4');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, 'b5'),
      allocation('proof-conflict-r2'), CREATED_AT + 3);
    repository.recordWorkerLaunchExit(worker.worker_instance_id, { kind: 'not_started' }, CREATED_AT + 4);

    // When / Then
    expect(() => repository.recordPublicationCandidateExit('proof-conflict-r2', 2, 0, 1,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 5)).toThrow(ConfigRepositoryError);

    const reverse = open().repository;
    commit(reverse, 'reverse-conflict-r2', 1);
    claim(reverse);
    reverse.beginPublication('reverse-conflict-r2', CREATED_AT + 1);
    reverse.beginWorkerAttempt('reverse-conflict-r2', 0, 0, 'initial', CREATED_AT + 2);
    const reverseWorker = identity('b6');
    reverse.registerWorkerLaunch(reverseWorker, guard(reverseWorker.worker_instance_id, 'b7'),
      allocation('reverse-conflict-r2'), CREATED_AT + 3);
    reverse.recordPublicationCandidateExit('reverse-conflict-r2', 2, 0, 1,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 4);
    expect(() => reverse.recordWorkerLaunchExit(reverseWorker.worker_instance_id,
      { kind: 'not_started' }, CREATED_AT + 5)).toThrow(ConfigRepositoryError);
  });

  test('closes the begin-to-register window with an irreversible not_started fence', () => {
    // Given
    const { repository } = open();
    commit(repository, 'fence-r2', 1);
    claim(repository);
    repository.beginPublication('fence-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('fence-r2', 0, 0, 'initial', CREATED_AT + 2);
    expect(repository.getUnsettledWorkerLaunches()).toEqual([
      { kind: 'reservation', allocation: allocation('fence-r2') },
    ]);

    // When
    repository.fenceWorkerLaunchNotStarted('fence-r2', 0, 1, CREATED_AT + 3);
    repository.fenceWorkerLaunchNotStarted('fence-r2', 0, 1, CREATED_AT + 4);

    // Then
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
    expect(() => repository.registerWorkerLaunch(
      identity('20'), guard(uuid('20'), '21'), allocation('fence-r2'), CREATED_AT + 5,
    )).toThrow(ConfigRepositoryError);
    expect(repository.getWorkerLaunch(uuid('20'))).toBeNull();
  });

  test('requires explicit exit plus cleanup proof and never treats an unknown cleanup as settled', () => {
    // Given
    const { repository } = open();
    commit(repository, 'exit-r2', 1);
    claim(repository);
    repository.beginPublication('exit-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('exit-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('30');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, '31'),
      allocation('exit-r2'), CREATED_AT + 3);

    // When
    const exitedOnly = repository.recordWorkerLaunchExit(worker.worker_instance_id,
      { kind: 'exited', cleanup: 'unknown' }, CREATED_AT + 4);

    // Then
    expect(exitedOnly).toMatchObject({ exited: true, cleanup_released: false });
    expect(repository.getUnsettledWorkerLaunches()).toHaveLength(1);
    const released = repository.recordWorkerLaunchExit(worker.worker_instance_id,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 5);
    expect(released).toMatchObject({ exited: true, cleanup_released: true });
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
  });

  test('records a publication-less currentStartup intent without fabricating an owner', () => {
    // Given
    const { repository } = open();
    const worker = identity('40');

    // When
    const registered = repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, '41'), null, CREATED_AT);
    const unsettled = repository.getUnsettledWorkerLaunches();

    // Then
    expect(registered).toMatchObject({ allocation: null, admitted: false });
    expect(unsettled).toEqual([{ kind: 'launch', launch: registered }]);
    repository.recordWorkerLaunchExit(worker.worker_instance_id, { kind: 'not_started' }, CREATED_AT + 1);
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
  });

  test('keeps a terminal owner from hiding an unsettled allocation and blocks the next claim', () => {
    // Given
    const { repository } = open();
    commit(repository, 'old-r2', 1);
    claim(repository);
    repository.beginPublication('old-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('old-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('50');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, '51'),
      allocation('old-r2'), CREATED_AT + 3);
    repository['db'].run(`UPDATE configuration_operations
      SET state='superseded',result_status=409,error_code='revision_superseded',
        error_detail='forced terminal',updated_at=? WHERE mutation_id='old-r2'`, [CREATED_AT + 4]);
    expect(commit(repository, 'new-r3', 2, CREATED_AT + 5).kind).toBe('committed');

    // When / Then
    expect(() => claim(repository, CREATED_AT + 6)).toThrow(ConfigRepositoryError);
    expect(repository.getUnsettledWorkerLaunches()).toHaveLength(1);
    repository.recordWorkerLaunchExit(worker.worker_instance_id,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 7);
    expect(claim(repository, CREATED_AT + 8).operation).toMatchObject({
      mutation_id: 'new-r3', committed_revision: 3, state: 'committed',
    });
  });

  test('blocks replacing an old attempt until its launch has exit and cleanup proof', () => {
    // Given
    const { repository } = open();
    commit(repository, 'retry-r2', 1);
    claim(repository);
    repository.beginPublication('retry-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('retry-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('60');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, '61'),
      allocation('retry-r2'), CREATED_AT + 3);
    repository.recordWorkerResult('retry-r2', 0, {
      kind: 'failed', attempt_no: 1, error: 'startup failed',
    }, CREATED_AT + 4);

    // When / Then
    expect(() => repository.beginWorkerAttempt('retry-r2', 0, 1, 'retry', CREATED_AT + 5))
      .toThrow(ConfigRepositoryError);
    repository.recordWorkerLaunchExit(worker.worker_instance_id,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 6);
    expect(repository.beginWorkerAttempt('retry-r2', 0, 1, 'retry', CREATED_AT + 7))
      .toMatchObject({ attempt_no: 2 });
    expect(repository.getUnsettledWorkerLaunches()).toEqual([
      { kind: 'reservation', allocation: allocation('retry-r2', 0, 2) },
    ]);
    repository.fenceWorkerLaunchNotStarted('retry-r2', 0, 2, CREATED_AT + 8);
  });

  test('refuses degraded finalization while an unadmitted launch has no exit proof', () => {
    // Given
    const { repository } = open();
    commit(repository, 'degraded-r2', 1);
    claim(repository);
    repository.beginPublication('degraded-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('degraded-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('70');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, '71'),
      allocation('degraded-r2'), CREATED_AT + 3);
    repository.recordWorkerResult('degraded-r2', 0, {
      kind: 'failed', attempt_no: 1, error: 'startup failed',
    }, CREATED_AT + 4);
    const outcome = {
      outcome: 'degraded' as const, error_code: 'replacement_convergence_failed' as const,
      error_detail: 'startup failed', recovery_disposition: 'retryable' as const,
    };

    // When / Then
    expect(() => repository.finalizePublication('degraded-r2', outcome, CREATED_AT + 5))
      .toThrow(ConfigRepositoryError);
    repository.recordWorkerLaunchExit(worker.worker_instance_id,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 6);
    expect(repository.finalizePublication('degraded-r2', outcome, CREATED_AT + 7))
      .toMatchObject({ state: 'degraded', result_status: 202 });
  });

  test('accepts candidate cleanup evidence after prepare was granted, but not terminal cancellation', () => {
    // Given
    const { repository } = open();
    commit(repository, 'cleanup-r2', 1);
    claim(repository);
    repository.beginPublication('cleanup-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('cleanup-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('a2');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, 'a3'),
      allocation('cleanup-r2'), CREATED_AT + 2);
    expect(repository.enterPublicationPrepare('cleanup-r2', 2, CREATED_AT + 3).kind).toBe('granted');

    // When / Then
    repository.recordPublicationCandidateExit('cleanup-r2', 2, 0, 1,
      { kind: 'exited', cleanup: 'released' }, CREATED_AT + 4);
    expect(() => repository.confirmPublicationCandidateExited('cleanup-r2', 2, CREATED_AT + 5))
      .toThrow(ConfigRepositoryError);
    expect(repository.getOutstandingPublicationCandidates()).toHaveLength(1);
    expect(repository.getUnsettledWorkerLaunches()).toEqual([]);
  });

  test('rejects update, delete and duplicate launch facts at the database boundary', () => {
    // Given
    const { repository } = open();
    const worker = identity('80');
    repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, '81'), null, CREATED_AT);
    repository.recordWorkerLaunchExit(worker.worker_instance_id, { kind: 'not_started' }, CREATED_AT + 1);
    const db = repository['db'];

    // When / Then
    expect(() => db.run('UPDATE configuration_worker_launch_intents SET worker_slot=1')).toThrow();
    expect(() => db.run('DELETE FROM configuration_worker_launch_intents')).toThrow();
    expect(() => db.run(`UPDATE configuration_worker_launch_facts SET recorded_at=recorded_at+1`)).toThrow();
    expect(() => db.run('DELETE FROM configuration_worker_launch_facts')).toThrow();
  });

  test('capacity reclaim requires an admitted exit and remains distinct from attempt settlement', () => {
    const { repository } = open();
    commit(repository, 'capacity-r2', 1);
    claim(repository);
    repository.beginPublication('capacity-r2', CREATED_AT + 1);
    repository.beginWorkerAttempt('capacity-r2', 0, 0, 'initial', CREATED_AT + 2);
    const worker = identity('a4');
    const workerId = worker.worker_instance_id;
    const originalGuard = guard(workerId, 'a5');
    const attempt = allocation('capacity-r2');
    repository.registerWorkerLaunch(worker, originalGuard, attempt, CREATED_AT + 3);
    const db = repository.getDatabase();
    const save = (when: number) => repository.recordWorkerLaunchCapacityReclaimed(workerId, originalGuard, when);
    expect(() => save(CREATED_AT + 3)).toThrow(ConfigRepositoryError);
    repository.recordWorkerLaunchAdmitted(workerId, CREATED_AT + 4);
    expect(() => save(CREATED_AT + 4)).toThrow(ConfigRepositoryError);
    expect(() => db.run('INSERT INTO configuration_worker_launch_capacity_reclaims VALUES (?,?)', [workerId, CREATED_AT + 4])).toThrow();
    repository.recordWorkerLaunchExit(workerId, { kind: 'exited', cleanup: 'unknown' }, CREATED_AT + 5);
    expect(() => save(CREATED_AT + 4)).toThrow(ConfigRepositoryError);
    expect(() => repository.recordWorkerLaunchCapacityReclaimed(workerId, guard(workerId, 'a6'), CREATED_AT + 5)).toThrow(ConfigRepositoryError);

    save(CREATED_AT + 6);
    save(CREATED_AT + 7);
    expect(repository.getWorkerLaunchInventory()).toMatchObject([{ kind: 'launch', launch: { capacity_reclaimed: true, cleanup_released: false } }]);
    expect(repository.getWorkerLaunchAllocationFacts(attempt)).toMatchObject({ settled: false, cleanup_released_at: null });
    expect(() => repository.beginWorkerAttempt('capacity-r2', 0, 1, 'master_recovery', CREATED_AT + 8))
      .toThrow('previous worker launch attempt has no exit and cleanup proof');
    expect(() => db.run('UPDATE configuration_worker_launch_capacity_reclaims SET recorded_at=recorded_at+1')).toThrow();
    expect(() => db.run('DELETE FROM configuration_worker_launch_capacity_reclaims')).toThrow();
    expect(() => db.run('INSERT OR REPLACE INTO configuration_worker_launch_capacity_reclaims VALUES (?,?)', [workerId, CREATED_AT + 7])).toThrow();
    expect(db.query('SELECT recorded_at FROM configuration_worker_launch_capacity_reclaims').get()).toEqual({ recorded_at: CREATED_AT + 6 });
    expect(() => migrateConfigurationDatabase(db, CONFIG_MIGRATIONS.slice(0, 9))).toThrow('configuration migration history is not an exact baseline prefix');
  });
});

describe('publication safety barriers', () => {
  test('a stopped Docker cutover preserves draining history and lets the new catalog claim revision 109', async () => {
    const { repository, dbPath } = open();
    for (let expected = 1; expected < 105; expected += 1) commit(repository, `saved-${expected + 1}`, expected, CREATED_AT, []);
    commit(repository, 'owner-106', 105, CREATED_AT, [0, 1]);
    claim(repository);
    repository.beginPublication('owner-106', CREATED_AT + 1);
    const serving = [identity('1060', 0), identity('1061', 1)];
    for (const { worker_slot: slot } of serving) repository.beginWorkerAttempt('owner-106', slot, 0, 'initial', CREATED_AT + 2);
    for (const worker of serving) {
      const slot = worker.worker_slot;
      repository.registerWorkerLaunch(worker, guard(worker.worker_instance_id, String(1062 + slot)),
        allocation('owner-106', slot), CREATED_AT + 3);
      repository.recordWorkerResult('owner-106', slot, { kind: 'converged', attempt_no: 1, applied_revision: 106 }, CREATED_AT + 4);
      repository.recordWorkerLaunchAdmitted(worker.worker_instance_id, CREATED_AT + 4);
    }
    expect(repository.enterPublicationPrepare('owner-106', 106, CREATED_AT + 5).kind).toBe('granted');
    repository.markDraining('owner-106', CREATED_AT + 5);
    const members = [0, 1].map(slot => ({
      identity: identity(String(1050 + slot), slot), boot_nonce: uuid(String(1052 + slot)), pid: 20 + slot,
      private_port: 3_010 + slot, revision: 105, content_hash: repository.getSnapshot().content_hash,
      plugin_catalog_hash: CATALOG, publication: null, guard: null, drain_id: uuid(String(1054 + slot)),
      deadline_boot_id: 'fixture-kernel', start_deadline_ns: null,
    }));
    repository.freezePublicationRetirement('owner-106', 0, members, CREATED_AT + 5);
    repository.stopPublicationRetirement('owner-106', 'exit_unknown', CREATED_AT + 6);
    const unconfirmed = identity('1064');
    repository.registerWorkerLaunch(unconfirmed, guard(unconfirmed.worker_instance_id, '1065'), null, CREATED_AT + 6);
    for (let expected = 106; expected < 109; expected += 1) commit(repository, `saved-${expected + 1}`, expected, CREATED_AT + 7, [0, 1]);
    const saved = repository.getSnapshot();
    const history = repository.getOperationState('owner-106');
    const retirement = repository.getPublicationRetirement('owner-106');
    repository.consumeRuntimeRecoveryRestartTicket(uuid('1066'), { owner: uuid('1'), boot_id: 'fixture-kernel', monotonic_ns: '0' });
    expect(() => repository.claimPublicationTarget(OTHER_CATALOG, CREATED_AT + 8)).toThrow('catalog identity is immutable');
    const stoppedContainerId = '1'.repeat(64);
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const accessLockPath = process.env.BUNGEE_ACCESS_DB_PATH;
    process.env.BUNGEE_ACCESS_DB_PATH = join(dbPath, '..', 'access.db');
    try {
      const activeLock = await acquireMasterInstanceLock(`${dbPath}.lock`);
      try { await expect(prepareStoppedDockerCutover(dbPath, stoppedContainerId)).rejects.toThrow('instance lock'); }
      finally { await activeLock.release(); }

      const cutover = await prepareStoppedDockerCutover(dbPath, stoppedContainerId);
      expect(cutover).toMatchObject({ runtime_epoch: 1, saved_revision: 109, stopped_container_id: stoppedContainerId });
      const restarted = ConfigRepository.open(dbPath);
      try {
        expect(restarted.getSnapshot()).toEqual(saved);
        expect(restarted.getActivePublication()).toBeNull();
        expect(restarted.getOutstandingPublicationCandidates()).toEqual([]);
        expect(restarted.getWorkerLaunchInventory()).toEqual([]);
        expect(restarted.getRuntimeRecoveryBudget().tickets).toBe(0);
        expect(restarted.getDatabase().query('SELECT ticket_id FROM runtime_recovery_tickets').all()).toEqual([{ ticket_id: uuid('1066') }]);
        expect(restarted.getOperationState('owner-106')).toEqual(history);
        expect(restarted.getPublicationRetirement('owner-106')).toEqual(retirement);
        expect(restarted.getPublicationRetirement('owner-106')?.evidence).toEqual(members.map(({ identity: worker }) =>
          expect.objectContaining({ member_id: worker.worker_instance_id, exit_state: 'unknown', cleanup_state: 'unknown' })));
        expect(restarted.getWorkerLaunch(unconfirmed.worker_instance_id)).toMatchObject({ exited: false, cleanup_released: false });
        expect(() => restarted.recordWorkerLaunchExit(unconfirmed.worker_instance_id, { kind: 'exited', cleanup: 'released' }, CREATED_AT + 9)).toThrow(ConfigRepositoryError);
        expect(() => restarted.markPublicationRetirementReleased('owner-106', CREATED_AT + 9)).toThrow(ConfigRepositoryError);
        expect(commit(restarted, 'owner-106', 105, CREATED_AT, [0, 1])).toEqual({ kind: 'duplicate', operation: history?.operation });
        expect(restarted.claimPublicationTarget(OTHER_CATALOG, CREATED_AT + 10)).toMatchObject({
          operation: { mutation_id: 'saved-109', state: 'committed' }, snapshot: saved, plugin_catalog_hash: OTHER_CATALOG,
        });
        expect(restarted.getOperation('saved-107')?.state).toBe('superseded');
        expect(restarted.getOperation('saved-108')?.state).toBe('superseded');
        restarted.verify();
      } finally { restarted.close(); }

      expect(await prepareStoppedDockerCutover(dbPath, stoppedContainerId)).toEqual(cutover);
      const reopened = ConfigRepository.open(dbPath);
      try {
        expect(reopened.getRuntimeEpoch()).toBe(1);
        expect(reopened.getActivePublication()?.operation.mutation_id).toBe('saved-109');
      } finally { reopened.close(); }
    } finally {
      if (accessLockPath === undefined) delete process.env.BUNGEE_ACCESS_DB_PATH;
      else process.env.BUNGEE_ACCESS_DB_PATH = accessLockPath;
    }
  });

  test('cutover failure on a version 10 database rolls back the entire migration', () => {
    const dbPath = databasePath();
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
    try {
      migrateConfigurationDatabase(db, CONFIG_MIGRATIONS.slice(0, 10));
      db.run(`CREATE TEMP TRIGGER fail_cutover BEFORE UPDATE ON runtime_recovery_budget
        BEGIN SELECT RAISE(ABORT,'fixture budget update failed'); END`);
      let failure: unknown;
      try { prepareConfigurationRuntimeCutover(db, 'a'.repeat(64), CREATED_AT); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'migration_failed', cause: { message: 'fixture budget update failed' } });
    } finally { db.close(); }

    const reopened = new Database(dbPath, { readwrite: true, strict: true });
    try {
      verifySchemaFingerprint(reopened, 10);
      expect(reopened.query('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual(CONFIG_MIGRATIONS.slice(0, 10).map(({ version }) => ({ version })));
      expect(reopened.query("SELECT name FROM sqlite_schema WHERE name='runtime_cutovers'").get()).toBeNull();
      expect(prepareConfigurationRuntimeCutover(reopened, 'a'.repeat(64), CREATED_AT)).toMatchObject({ runtime_epoch: 1, saved_revision: 1 });
    } finally { reopened.close(); }
  });

  test('cutover rejects a nonempty SQLite file without configuration schema', async () => {
    const dbPath = databasePath();
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
    try { db.run('PRAGMA user_version=7'); }
    finally { db.close(); }
    expect(statSync(dbPath).size).toBeGreaterThan(0);
    const accessDbPath = process.env.BUNGEE_ACCESS_DB_PATH;
    process.env.BUNGEE_ACCESS_DB_PATH = join(dbPath, '..', 'access.db');
    try {
      await expect(prepareStoppedDockerCutover(dbPath, 'b'.repeat(64))).rejects.toThrow('requires an existing configuration database');
    } finally {
      if (accessDbPath === undefined) delete process.env.BUNGEE_ACCESS_DB_PATH;
      else process.env.BUNGEE_ACCESS_DB_PATH = accessDbPath;
    }
    const reopened = new Database(dbPath, { readonly: true, strict: true });
    try {
      expect(reopened.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      expect(reopened.query('SELECT name FROM sqlite_schema').all()).toEqual([]);
    } finally { reopened.close(); }
  });

  test('cutover preserves existing serving authority replay and rejects new archived authority', () => {
    const { repository } = open();
    commit(repository, 'frozen-r2', 1, CREATED_AT, []);
    claim(repository);
    repository.beginPublication('frozen-r2', CREATED_AT + 1);
    const frozen = repository.freezePublicationServingSet('frozen-r2', 0, []);
    prepareConfigurationRuntimeCutover(repository.getDatabase(), 'c'.repeat(64), CREATED_AT + 2);

    commit(repository, 'unfrozen-r3', 2, CREATED_AT + 3, []);
    claim(repository, CREATED_AT + 4);
    repository.beginPublication('unfrozen-r3', CREATED_AT + 4);
    expect(repository.getPublicationServingSet('unfrozen-r3', 0)).toBeNull();
    prepareConfigurationRuntimeCutover(repository.getDatabase(), 'd'.repeat(64), CREATED_AT + 5);

    expect(repository.freezePublicationServingSet('frozen-r2', 0, [])).toEqual(frozen);
    expect(() => repository.freezePublicationServingSet('unfrozen-r3', 0, [])).toThrow('does not belong to the current runtime');
    expect(repository.getPublicationServingSet('unfrozen-r3', 0)).toBeNull();
  });

  test('cutover rolls back atomically and permits startup at the saved revision with an archived recovery', () => {
    const { dbPath, repository } = open();
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const offline = ConfigRepository.open(dbPath, { offline: true });
    repositories.push(offline);
    commit(offline, 'recovery-source', 1, CREATED_AT, []);
    claim(offline);
    offline.beginPublication('recovery-source', CREATED_AT + 1);
    offline.finalizePublication('recovery-source', { outcome: 'degraded', error_code: 'control_readiness_failed',
      error_detail: 'fixture control is unavailable', recovery_disposition: 'deterministic_control_failure' }, CREATED_AT + 2);
    const originalRecovery = offline.createManualRecovery(uuid('2100'), 'recovery-source', 2, CREATED_AT + 3);
    offline.claimRecoveryAttempt(originalRecovery.recovery_id, 0, CREATED_AT + 4);
    const running = offline.getRecovery(originalRecovery.recovery_id);
    const oldOperation = offline.getCurrentOperationState();
    const db = offline.getDatabase();
    db.run(`CREATE TEMP TRIGGER fail_cutover BEFORE UPDATE ON runtime_recovery_budget
      BEGIN SELECT RAISE(ABORT,'fixture budget update failed'); END`);
    const stoppedContainerId = '2'.repeat(64);
    expect(() => prepareConfigurationRuntimeCutover(db, stoppedContainerId, CREATED_AT + 5)).toThrow(ConfigRepositoryError);
    expect(offline.getRuntimeEpoch()).toBe(0);
    expect(offline.getPublicationRecoveryBarrier()).toEqual(running);
    db.run('DROP TRIGGER fail_cutover');

    expect(prepareConfigurationRuntimeCutover(db, stoppedContainerId, CREATED_AT + 5)).toMatchObject({ runtime_epoch: 1, saved_revision: 2 });
    expect(offline.getCurrentRecovery()).toBeNull();
    expect(offline.getPublicationRecoveryBarrier()).toBeNull();
    expect(offline.getCurrentOperationState()).toBeNull();
    expect(offline.getOperationState('recovery-source')).toEqual(oldOperation);
    expect(offline.claimPublicationTarget(OTHER_CATALOG, CREATED_AT + 6)).toBeNull();
    expect(offline.getSnapshot()).toMatchObject({ revision: 2, content_hash: hashConfigurationContent(VALUE) });
    expect(offline.getRecovery(originalRecovery.recovery_id)).toEqual(running);
    expect(offline.createManualRecovery(originalRecovery.recovery_id, 'recovery-source', 2, CREATED_AT + 6)).toEqual(running);
    expect(() => offline.claimRecoveryAttempt(originalRecovery.recovery_id, 0, CREATED_AT + 6)).toThrow(ConfigRepositoryError);
    expect(offline.createManualRecovery(uuid('2101'), 'recovery-source', 2, CREATED_AT + 6)).toMatchObject({ state: 'scheduled' });
    offline.verify();
  });

  test('blocks a new claim while an older batch retirement is unresolved', () => {
    // Given
    const { repository } = open();
    commit(repository, 'old-r2', 1);
    commit(repository, 'new-r3', 2, CREATED_AT + 1);
    repository['db'].run(`INSERT INTO configuration_retirements
      (mutation_id,generation,members_json,state,reason_code,updated_at)
      VALUES ('old-r2',0,'[]','stopped','exit_unknown',?)`, [CREATED_AT + 2]);

    // When / Then
    let captured: unknown;
    try {
      claim(repository);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ConfigRepositoryError);
    if (captured instanceof ConfigRepositoryError) expect(captured.code).toBe('invalid_operation');
    expect(repository.getActivePublication()).toBeNull();

    repository['db'].run("UPDATE configuration_retirements SET state='released',reason_code=NULL WHERE mutation_id='old-r2'");
    const owner = claim(repository, CREATED_AT + 3);
    expect(owner.operation).toMatchObject({ mutation_id: 'new-r3', committed_revision: 3 });
    expect(repository.getOperation('old-r2')).toMatchObject({ state: 'superseded' });
  });
});
