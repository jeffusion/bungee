import { Database } from 'bun:sqlite';
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
import { readOperationWorkers } from './operation-records';
import { prepareCommitCommand } from './prepared-command';
import { readRepositorySnapshot, verifyRepositoryIntegrity } from './repository-snapshot';
import type {
  ActiveConfigurationPublication,
  CommitConfigurationCommandV1,
  CommitConfigurationResult,
  ConfigurationOperation,
  ConfigurationOperationState,
  ConfigurationOperationWorker,
  ConfigRepositoryOptions,
  FinalizePublicationOutcome,
  RepositorySnapshot,
  WorkerPublicationResult,
  WorkerAttemptReason,
} from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteGet } from './sqlite-query';
import { assertSupportedSqliteVersion, readSqliteVersion } from './sqlite-version';
function configureConnection(db: Database): void {
  assertSupportedSqliteVersion(readSqliteVersion(db));
  const journal = sqliteGet<{ readonly journal_mode: string }, []>(db, 'PRAGMA journal_mode = DELETE')?.journal_mode;
  db.run('PRAGMA synchronous = FULL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
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
    throw new ConfigRepositoryError('repository_failure', 'configuration repository operation failed', error);
  }
}

export class ConfigRepository {
  private constructor(
    private readonly db: Database,
    private readonly options: ConfigRepositoryOptions,
  ) {}

  static open(dbPath: string, options: ConfigRepositoryOptions = {}): ConfigRepository {
    let db: Database | undefined;
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      db = new Database(dbPath, { create: true, readwrite: true, strict: true });
      configureConnection(db);
      migrateConfigurationDatabase(db);
      const repository = new ConfigRepository(db, options);
      repository.getSnapshot();
      return repository;
    } catch (error) {
      db?.close(true);
      if (error instanceof ConfigRepositoryError) throw error;
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

  getActivePublication(): ActiveConfigurationPublication | null {
    return runRepositoryAction(() => this.db.transaction(() => readActivePublication(this.db))());
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
      throw new ConfigRepositoryError('repository_failure', 'configuration commit transaction failed', error);
    }
  }

  getOperation(mutationId: string): ConfigurationOperation | null {
    return runRepositoryAction(() => {
      readRepositorySnapshot(this.db);
      return readOperation(this.db, mutationId);
    });
  }

  getOperationState(mutationId: string): ConfigurationOperationState | null {
    return runRepositoryAction(() => {
      readRepositorySnapshot(this.db);
      const operation = readOperation(this.db, mutationId);
      return operation === null ? null : {
        operation,
        workers: readOperationWorkers(this.db, mutationId),
      };
    });
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
      const operation = finalizeOperationPublication(this.db, mutationId, outcome, updatedAt);
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
