import { Database } from 'bun:sqlite';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readActivePublication } from './active-publication';
import { commitTransaction } from './commit-transaction';
import { migrateConfigurationDatabase } from './migrations';
import {
  beginPublication as beginOperationPublication,
  beginDrainingRecovery as beginOperationDrainingRecovery,
  beginWorkerAttempt as beginOperationWorkerAttempt,
  finalizePublication as finalizeOperationPublication,
  getOperation as readOperation,
  markDraining as markOperationDraining,
  recordWorkerResult as recordOperationWorkerResult,
} from './operation-store';
import { readAllOperations, readOperationWorkers } from './operation-records';
import { prepareCommitCommand } from './prepared-command';
import { readRepositorySnapshot, verifyRepositoryIntegrity } from './repository-snapshot';
import { appendServingSnapshot, getServingSnapshot } from './serving-snapshot';
import {
  claimRecoveryAttempt,
  createAutomaticRecovery,
  createStoppedRecovery,
  createManualRecovery,
  readLatestRecovery,
  readCurrentRecovery,
  readRecovery,
  requeueRecovery,
  scheduleRecoveryRetry,
  stopRecovery,
  succeedRecovery,
} from './recovery-store';
import type {
  ActiveConfigurationPublication,
  CommitConfigurationCommandV1,
  CommitConfigurationResult,
  ConfigurationOperation,
  ConfigurationOperationState,
  ConfigurationOperationWorker,
  ConfigurationRecovery,
  ConfigurationRecoveryReasonCode,
  ConfigRepositoryOptions,
  FinalizePublicationOutcome,
  RepositorySnapshot,
  ServingSnapshotKey,
  WorkerPublicationResult,
  WorkerAttemptReason,
} from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { randomUUID } from 'node:crypto';
import { sqliteGet } from './sqlite-query';
import { assertSupportedSqliteVersion, readSqliteVersion } from './sqlite-version';
import { SupervisionStateRepository, type SupervisionState } from '../supervision/state-repository';
import type { ControllerClaimCapability } from '../master-runtime/instance-lock';
import { consumeControllerClaimCapability } from '../master-runtime/instance-lock';
import { withConsistentRead } from './consistent-read';
import { isSqliteBusyError, repositoryFailure } from './sqlite-errors';
function configureConnection(db: Database): void {
  const encoding = sqliteGet<{ readonly encoding: string }, []>(db, 'PRAGMA encoding')?.encoding;
  if (encoding !== 'UTF-8') {
    throw new ConfigRepositoryError('connection_invariant', 'SQLite database encoding must be UTF-8');
  }
  db.run('PRAGMA busy_timeout = 5000');
  assertSupportedSqliteVersion(readSqliteVersion(db));
  const journal = sqliteGet<{ readonly journal_mode: string }, []>(db, 'PRAGMA journal_mode = DELETE')?.journal_mode;
  db.run('PRAGMA synchronous = FULL');
  db.run('PRAGMA foreign_keys = ON');
  const synchronous = sqliteGet<{ readonly synchronous: number }, []>(db, 'PRAGMA synchronous')?.synchronous;
  const foreignKeys = sqliteGet<{ readonly foreign_keys: number }, []>(db, 'PRAGMA foreign_keys')?.foreign_keys;
  const busyTimeout = sqliteGet<{ readonly timeout: number }, []>(db, 'PRAGMA busy_timeout')?.timeout;
  if (journal !== 'delete' || synchronous !== 2 || foreignKeys !== 1 || busyTimeout !== 5000) {
    throw new ConfigRepositoryError('connection_invariant', 'SQLite connection invariants were not applied');
  }
}

function runRepositoryAction<Result>(action: () => Result): Result {
  try {
    return action();
  } catch (error) {
    if (error instanceof ConfigRepositoryError) throw error;
    if (isSqliteBusyError(error)) throw repositoryFailure('configuration repository operation was blocked by SQLite', error);
    throw new ConfigRepositoryError('repository_failure', 'configuration repository operation failed', error);
  }
}

export class ConfigRepository {
  private constructor(
    private readonly db: Database,
    private readonly options: ConfigRepositoryOptions,
    private readonly supervision = new SupervisionStateRepository(db),
  ) {}

  /** Opens a repository connection safe to use alongside other repository connections. */
  static open(dbPath: string, options: ConfigRepositoryOptions = {}): ConfigRepository {
    let db: Database | undefined;
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      db = new Database(dbPath, { create: true, readwrite: true, strict: true });
      configureConnection(db);
      migrateConfigurationDatabase(db);
      const repository = new ConfigRepository(db, options);
      repository.getSnapshot();
      repository.getSupervisionState();
      return repository;
    } catch (error) {
      db?.close(true);
      if (error instanceof ConfigRepositoryError) throw error;
      if (isSqliteBusyError(error)) throw repositoryFailure('configuration repository startup was blocked by SQLite', error);
      throw new ConfigRepositoryError('repository_failure', 'configuration repository startup failed', error);
    }
  }

  close(): void {
    this.db.close(true);
  }

  /** Host-owned extensions may share the already configured connection. */
  getDatabase(): Database {
    return this.db;
  }

  getSnapshot(): RepositorySnapshot {
    return readRepositorySnapshot(this.db);
  }

  appendServingSnapshot(snapshot: RepositorySnapshot, pluginCatalogHash: Sha256Digest): void {
    return runRepositoryAction(() => appendServingSnapshot(
      this.db, snapshot, pluginCatalogHash,
    ));
  }

  getServingSnapshot(key: ServingSnapshotKey): RepositorySnapshot | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => getServingSnapshot(this.db, key)));
  }

  getSupervisionState(): SupervisionState {
    return runRepositoryAction(() => this.supervision.get());
  }

  claimControllerWithCapability(
    capability: ControllerClaimCapability,
    controllerId: string,
    updatedAt: number,
  ): SupervisionState {
    return runRepositoryAction(() => consumeControllerClaimCapability(
      capability, () => this.supervision.claim(controllerId, updatedAt),
    ));
  }

  getActivePublication(): ActiveConfigurationPublication | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => readActivePublication(this.db)));
  }

  commit(command: CommitConfigurationCommandV1): CommitConfigurationResult {
    const prepared = prepareCommitCommand(command, this.options.compileOptions);
    try {
      const decide = this.db.transaction(() => commitTransaction(this.db, prepared, this.options));
      const decision = decide.immediate();
      if (decision.kind === 'committed') {
        return {
          kind: 'committed',
          snapshot: {
            revision: decision.operation.committed_revision,
            content_hash: prepared.contentHash,
            aggregate: prepared.aggregate,
          },
          operation: decision.operation,
        };
      }
      return decision;
    } catch (error) {
      if (error instanceof ConfigRepositoryError) throw error;
      if (isSqliteBusyError(error)) throw repositoryFailure('configuration commit was blocked by SQLite', error);
      throw new ConfigRepositoryError('repository_failure', 'configuration commit transaction failed', error);
    }
  }

  getOperation(mutationId: string): ConfigurationOperation | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      readRepositorySnapshot(this.db);
      return readOperation(this.db, mutationId);
    }));
  }

  getOperationState(mutationId: string): ConfigurationOperationState | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      readRepositorySnapshot(this.db);
      const operation = readOperation(this.db, mutationId);
      return operation === null ? null : {
        operation,
        workers: readOperationWorkers(this.db, mutationId),
      };
    }));
  }

  getRecovery(recoveryId: string): ConfigurationRecovery | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      readRepositorySnapshot(this.db);
      return readRecovery(this.db, recoveryId);
    }));
  }

  getCurrentRecovery(): ConfigurationRecovery | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      const snapshot = readRepositorySnapshot(this.db);
      return readCurrentRecovery(this.db, snapshot.revision);
    }));
  }

  getLatestRecovery(targetRevision: number): ConfigurationRecovery | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      if (!Number.isSafeInteger(targetRevision) || targetRevision <= 0) {
        throw new ConfigRepositoryError('invalid_operation', 'recovery target revision is invalid');
      }
      readRepositorySnapshot(this.db);
      return readLatestRecovery(this.db, targetRevision);
    }));
  }

  createManualRecovery(
    recoveryId: string, sourceMutationId: string, expectedRevision: number, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.db.transaction(() => {
      readRepositorySnapshot(this.db);
      const recovery = createManualRecovery(this.db, recoveryId, sourceMutationId, expectedRevision, now);
      verifyRepositoryIntegrity(this.db);
      return recovery;
    }).immediate());
  }

  claimRecoveryAttempt(recoveryId: string, previousAttemptCount: number, now: number): ConfigurationRecovery {
    return runRepositoryAction(() => this.db.transaction(() => {
      readRepositorySnapshot(this.db, true);
      const recovery = claimRecoveryAttempt(this.db, recoveryId, previousAttemptCount, now);
      verifyRepositoryIntegrity(this.db);
      return recovery;
    }).immediate());
  }

  scheduleRecoveryRetry(
    recoveryId: string, attemptCount: number, nextRetryAt: number, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.db.transaction(() => {
      readRepositorySnapshot(this.db, true);
      const recovery = scheduleRecoveryRetry(this.db, recoveryId, attemptCount, nextRetryAt, now);
      verifyRepositoryIntegrity(this.db);
      return recovery;
    }).immediate());
  }

  succeedRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.db.transaction(() => {
      readRepositorySnapshot(this.db, true);
      const recovery = succeedRecovery(this.db, recoveryId, attemptCount, reasonCode, reasonDetail, now);
      verifyRepositoryIntegrity(this.db);
      return recovery;
    }).immediate());
  }

  stopRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.db.transaction(() => {
      readRepositorySnapshot(this.db, reasonCode === 'revision_superseded');
      const recovery = stopRecovery(this.db, recoveryId, attemptCount, reasonCode, reasonDetail, now);
      verifyRepositoryIntegrity(this.db);
      return recovery;
    }).immediate());
  }

  requeueRecovery(recoveryId: string, attemptCount: number, now: number): ConfigurationRecovery {
    return runRepositoryAction(() => this.db.transaction(() => {
      readRepositorySnapshot(this.db, true);
      const recovery = requeueRecovery(this.db, recoveryId, attemptCount, now);
      verifyRepositoryIntegrity(this.db);
      return recovery;
    }).immediate());
  }

  getCurrentOperationState(): ConfigurationOperationState | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      const snapshot = readRepositorySnapshot(this.db);
      const operation = readAllOperations(this.db).find(
        ({ committed_revision }) => committed_revision === snapshot.revision,
      );
      return operation === undefined ? null : {
        operation,
        workers: readOperationWorkers(this.db, operation.mutation_id),
      };
    }));
  }

  beginPublication(mutationId: string, updatedAt: number): ConfigurationOperation {
    return runRepositoryAction(() => this.db.transaction(() => {
      const snapshot = readRepositorySnapshot(this.db);
      this.requireActiveOperation(mutationId, snapshot.revision);
      const operation = beginOperationPublication(this.db, mutationId, updatedAt);
      verifyRepositoryIntegrity(this.db);
      return operation;
    }).immediate());
  }

  beginWorkerAttempt(
    mutationId: string,
    workerSlot: number,
    previousAttemptNo: number,
    reason: WorkerAttemptReason,
    updatedAt: number,
  ): ConfigurationOperationWorker {
    return runRepositoryAction(() => this.db.transaction(() => {
      const snapshot = readRepositorySnapshot(this.db);
      this.requireActiveOperation(mutationId, snapshot.revision);
      const worker = beginOperationWorkerAttempt(
        this.db, mutationId, workerSlot, previousAttemptNo, reason, updatedAt,
      );
      verifyRepositoryIntegrity(this.db);
      return worker;
    }).immediate());
  }

  beginDrainingRecovery(
    mutationId: string,
    previousGeneration: number,
    updatedAt: number,
  ): ConfigurationOperation {
    return runRepositoryAction(() => this.db.transaction(() => {
      const snapshot = readRepositorySnapshot(this.db);
      this.requireActiveOperation(mutationId, snapshot.revision);
      const operation = beginOperationDrainingRecovery(this.db, mutationId, previousGeneration, updatedAt);
      verifyRepositoryIntegrity(this.db);
      return operation;
    }).immediate());
  }

  recordWorkerResult(
    mutationId: string,
    workerSlot: number,
    result: WorkerPublicationResult,
    updatedAt: number,
  ): ConfigurationOperationWorker {
    return runRepositoryAction(() => this.db.transaction(() => {
      const snapshot = readRepositorySnapshot(this.db);
      this.requireActiveOperation(mutationId, snapshot.revision);
      const worker = recordOperationWorkerResult(this.db, mutationId, workerSlot, result, updatedAt);
      verifyRepositoryIntegrity(this.db);
      return worker;
    }).immediate());
  }

  finalizePublication(
    mutationId: string,
    outcome: FinalizePublicationOutcome,
    updatedAt: number,
  ): ConfigurationOperation {
    return runRepositoryAction(() => this.db.transaction(() => {
      const snapshot = readRepositorySnapshot(this.db);
      this.requireActiveOperation(mutationId, snapshot.revision);
      const before = readOperation(this.db, mutationId);
      if (before === null) throw new ConfigRepositoryError('invalid_operation', 'configuration operation was not found');
      const operation = finalizeOperationPublication(this.db, mutationId, outcome, updatedAt);
      if (before.state !== 'converged' && before.state !== 'degraded' &&
          outcome.outcome === 'degraded' &&
          (outcome.error_code === 'replacement_convergence_failed' || outcome.error_code === 'control_readiness_failed')) {
        switch (outcome.recovery_disposition) {
          case 'retryable':
            createAutomaticRecovery(this.db, randomUUID(), mutationId, operation.committed_revision, updatedAt);
            this.options.faultInjection?.('after_automatic_recovery');
            break;
          case 'deterministic_worker_rejection':
          case 'deterministic_protocol_failure':
          case 'deterministic_control_failure':
          case 'fatal':
            createStoppedRecovery(this.db, randomUUID(), mutationId, operation.committed_revision,
              outcome.recovery_disposition === 'fatal' ? 'fatal_source_failure' : outcome.recovery_disposition,
              outcome.error_detail, updatedAt);
            break;
          default: {
            const unhandled: never = outcome.recovery_disposition;
            throw new ConfigRepositoryError('repository_failure', 'unknown recovery disposition', unhandled);
          }
        }
      }
      verifyRepositoryIntegrity(this.db);
      return operation;
    }).immediate());
  }

  markDraining(mutationId: string, updatedAt: number): ConfigurationOperation {
    return runRepositoryAction(() => this.db.transaction(() => {
      const snapshot = readRepositorySnapshot(this.db);
      this.requireActiveOperation(mutationId, snapshot.revision);
      const operation = markOperationDraining(this.db, mutationId, updatedAt);
      verifyRepositoryIntegrity(this.db);
      return operation;
    }).immediate());
  }

  private requireActiveOperation(mutationId: string, activeRevision: number): void {
    const operation = readOperation(this.db, mutationId);
    if (operation === null || operation.committed_revision !== activeRevision) {
      throw new ConfigRepositoryError('invalid_operation', 'only the active revision operation may publish');
    }
  }

}
