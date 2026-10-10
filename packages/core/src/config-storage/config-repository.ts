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
import { OPERATION_SELECT, operationFromRow, type OperationRow, readOperationWorkers } from './operation-records';
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
import { freezeSnapshot } from './immutable-snapshot';
import type { PreparedCommitCommand } from './prepared-command';
import { readActiveRevision } from './current-revision';
import { validateOperationRelations, validateActiveOperationIdentity } from './operation-relations';
import { readSchemaObjectFingerprint } from './schema-fingerprint';
function configureConnection(db: Database): void {
  const encoding = sqliteGet<{ readonly encoding: string }, []>(db, 'PRAGMA encoding')?.encoding;
  if (encoding !== 'UTF-8') {
    throw new ConfigRepositoryError('connection_invariant', 'SQLite database encoding must be UTF-8');
  }
  db.run('PRAGMA busy_timeout = 5000');
  assertSupportedSqliteVersion(readSqliteVersion(db), 'delete');
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
  private readonly schemaObjects: string;
  private constructor(
    private readonly db: Database,
    private readonly options: ConfigRepositoryOptions,
    private snapshot: RepositorySnapshot,
    private readonly supervision = new SupervisionStateRepository(db),
  ) {
    this.schemaObjects = readSchemaObjectFingerprint(db);
  }

  /** Synchronous backend for the exclusive storage executor and stopped-instance tools. */
  static open(dbPath: string, options: ConfigRepositoryOptions = {}): ConfigRepository {
    let db: Database | undefined;
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      db = new Database(dbPath, { create: true, readwrite: true, strict: true });
      configureConnection(db);
      migrateConfigurationDatabase(db);
      verifyRepositoryIntegrity(db);
      const repository = new ConfigRepository(db, options, freezeSnapshot(readRepositorySnapshot(db)));
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

  /** Offline tools only. Production extensions own a separate storage connection. */
  getDatabase(): Database {
    return this.db;
  }

  getSnapshot(): RepositorySnapshot {
    return this.snapshot;
  }

  appendServingSnapshot(snapshot: RepositorySnapshot, pluginCatalogHash: Sha256Digest): void {
    return runRepositoryAction(() => this.mutationTransaction(() => appendServingSnapshot(
      this.db, snapshot, pluginCatalogHash,
    )));
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
      capability, () => this.mutationTransaction(() => this.supervision.claim(controllerId, updatedAt)),
    ));
  }

  getActivePublication(): ActiveConfigurationPublication | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => readActivePublication(this.db, this.snapshot)));
  }

  commit(command: CommitConfigurationCommandV1): CommitConfigurationResult {
    return this.commitPrepared(prepareCommitCommand(command, this.options.compileOptions));
  }

  /** Executes a main-thread compiled command in the exclusive storage thread. */
  commitPrepared(prepared: PreparedCommitCommand): CommitConfigurationResult {
    try {
      const decision = this.mutationTransaction(() => commitTransaction(this.db, prepared, this.options, this.snapshot));
      if (decision.kind === 'committed') {
        this.snapshot = freezeSnapshot({
          revision: decision.operation.committed_revision,
          content_hash: prepared.contentHash,
          aggregate: prepared.aggregate,
        });
        return { kind: 'committed', snapshot: this.snapshot, operation: decision.operation };
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
      return readOperation(this.db, mutationId);
    }));
  }

  getOperationState(mutationId: string): ConfigurationOperationState | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      const operation = readOperation(this.db, mutationId);
      if (operation === null) return null;
      const workers = readOperationWorkers(this.db, mutationId);
      validateOperationRelations(operation, workers);
      return { operation, workers };
    }));
  }

  getRecovery(recoveryId: string): ConfigurationRecovery | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      return readRecovery(this.db, recoveryId);
    }));
  }

  getCurrentRecovery(): ConfigurationRecovery | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      const revision = readActiveRevision(this.db);
      return readCurrentRecovery(this.db, revision);
    }));
  }

  getLatestRecovery(targetRevision: number): ConfigurationRecovery | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      if (!Number.isSafeInteger(targetRevision) || targetRevision <= 0) {
        throw new ConfigRepositoryError('invalid_operation', 'recovery target revision is invalid');
      }
      return readLatestRecovery(this.db, targetRevision);
    }));
  }

  createManualRecovery(
    recoveryId: string, sourceMutationId: string, expectedRevision: number, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.mutationTransaction(() => {
      const recovery = createManualRecovery(this.db, recoveryId, sourceMutationId, expectedRevision, now);
      return recovery;
    }));
  }

  claimRecoveryAttempt(recoveryId: string, previousAttemptCount: number, now: number): ConfigurationRecovery {
    return runRepositoryAction(() => this.mutationTransaction(() => {
      const recovery = claimRecoveryAttempt(this.db, recoveryId, previousAttemptCount, now);
      return recovery;
    }));
  }

  scheduleRecoveryRetry(
    recoveryId: string, attemptCount: number, nextRetryAt: number, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.mutationTransaction(() => {
      const recovery = scheduleRecoveryRetry(this.db, recoveryId, attemptCount, nextRetryAt, now);
      return recovery;
    }));
  }

  succeedRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.mutationTransaction(() => {
      const recovery = succeedRecovery(this.db, recoveryId, attemptCount, reasonCode, reasonDetail, now);
      return recovery;
    }));
  }

  stopRecovery(
    recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode,
    reasonDetail: string | null, now: number,
  ): ConfigurationRecovery {
    return runRepositoryAction(() => this.mutationTransaction(() => {
      const recovery = stopRecovery(this.db, recoveryId, attemptCount, reasonCode, reasonDetail, now);
      return recovery;
    }));
  }

  requeueRecovery(recoveryId: string, attemptCount: number, now: number): ConfigurationRecovery {
    return runRepositoryAction(() => this.mutationTransaction(() => {
      const recovery = requeueRecovery(this.db, recoveryId, attemptCount, now);
      return recovery;
    }));
  }

  getCurrentOperationState(): ConfigurationOperationState | null {
    return runRepositoryAction(() => withConsistentRead(this.db, () => {
      const revision = readActiveRevision(this.db);
      const row = sqliteGet<OperationRow, [number]>(this.db, `${OPERATION_SELECT} WHERE committed_revision=?`, revision);
      const operation = row === null ? null : operationFromRow(row);
      if (operation === null) return null;
      const workers = readOperationWorkers(this.db, operation.mutation_id);
      validateOperationRelations(operation, workers);
      return { operation, workers };
    }));
  }

  beginPublication(mutationId: string, updatedAt: number): ConfigurationOperation {
    return runRepositoryAction(() => this.publicationTransaction(mutationId, () => {
      const operation = beginOperationPublication(this.db, mutationId, updatedAt);
      return operation;
    }));
  }

  beginWorkerAttempt(
    mutationId: string,
    workerSlot: number,
    previousAttemptNo: number,
    reason: WorkerAttemptReason,
    updatedAt: number,
  ): ConfigurationOperationWorker {
    return runRepositoryAction(() => this.publicationTransaction(mutationId, () => {
      const worker = beginOperationWorkerAttempt(
        this.db, mutationId, workerSlot, previousAttemptNo, reason, updatedAt,
      );
      return worker;
    }));
  }

  beginDrainingRecovery(
    mutationId: string,
    previousGeneration: number,
    updatedAt: number,
  ): ConfigurationOperation {
    return runRepositoryAction(() => this.publicationTransaction(mutationId, () => {
      const operation = beginOperationDrainingRecovery(this.db, mutationId, previousGeneration, updatedAt);
      return operation;
    }));
  }

  recordWorkerResult(
    mutationId: string,
    workerSlot: number,
    result: WorkerPublicationResult,
    updatedAt: number,
  ): ConfigurationOperationWorker {
    return runRepositoryAction(() => this.publicationTransaction(mutationId, () => {
      const worker = recordOperationWorkerResult(this.db, mutationId, workerSlot, result, updatedAt);
      return worker;
    }));
  }

  finalizePublication(
    mutationId: string,
    outcome: FinalizePublicationOutcome,
    updatedAt: number,
  ): ConfigurationOperation {
    return runRepositoryAction(() => this.publicationTransaction(mutationId, () => {
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
      return operation;
    }));
  }

  markDraining(mutationId: string, updatedAt: number): ConfigurationOperation {
    return runRepositoryAction(() => this.publicationTransaction(mutationId, () => {
      const operation = markOperationDraining(this.db, mutationId, updatedAt);
      return operation;
    }));
  }

  /** Startup/explicit verification may audit the complete repository. */
  verify(): void {
    verifyRepositoryIntegrity(this.db);
    readRepositorySnapshot(this.db);
  }

  /** Internal execution endpoint. The client consumes the lock capability before IPC. */
  claimController(controllerId: string, updatedAt: number): SupervisionState {
    return runRepositoryAction(() => this.mutationTransaction(() => this.supervision.claim(controllerId, updatedAt)));
  }

  private publicationTransaction<Result>(mutationId: string, action: () => Result): Result {
    return this.mutationTransaction(() => {
      const revision = readActiveRevision(this.db);
      this.requireActiveOperation(mutationId, revision);
      const result = action();
      this.requireActiveOperation(mutationId, revision);
      return result;
    });
  }

  private mutationTransaction<Result>(action: () => Result): Result {
    return this.db.transaction(() => {
      if (readSchemaObjectFingerprint(this.db) !== this.schemaObjects) {
        throw new ConfigRepositoryError('schema_corrupt', 'configuration schema objects changed before mutation');
      }
      return action();
    }).immediate();
  }

  private requireActiveOperation(mutationId: string, activeRevision: number): void {
    const operation = readOperation(this.db, mutationId);
    if (operation === null || operation.committed_revision !== activeRevision) {
      throw new ConfigRepositoryError('invalid_operation', 'only the active revision operation may publish');
    }
    validateActiveOperationIdentity(this.db, operation, readOperationWorkers(this.db, mutationId), this.snapshot);
  }

}
