import { readManagementProtection, readManagementRequestIdentity } from './management-protection';
import { hashConfigurationRequest } from './content-hash';
import { validateMutationId } from './repository-validation';
import { readMenuLayout, writeMenuLayout } from './menu-store';
import type { MenuLayout, PluginBinding, ConfigurationUpstream } from '@jeffusion/bungee-types';
import * as retirementStore from './retirement-store';
import * as runtimeRecoveryBudget from './runtime-recovery-budget';
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
  ManagementProtection,
  ControlProjection,
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

type TailParameters<F extends (...args: any[]) => unknown> = Parameters<F> extends [unknown, ...infer Rest] ? Rest : never;

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
      migrateConfigurationDatabase(db, undefined, options);
      verifyRepositoryIntegrity(db);
      const repository = new ConfigRepository(db, options, freezeSnapshot(readRepositorySnapshot(db)));
      repository.removeUnavailablePlugins();
      repository.getSnapshot();
      repository.getSupervisionState();
      repository.getRuntimeRecoveryBudget();
      repository.getMenuLayout();
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

  getManagementProtection(): ManagementProtection {
    return runRepositoryAction(() => withConsistentRead(this.db, () => Object.freeze(readManagementProtection(this.db))));
  }

  getControlProjection(): ControlProjection {
    const projection = runRepositoryAction(() => withConsistentRead(this.db, () => ({
      snapshot: readActiveRevision(this.db) === this.snapshot.revision ? this.snapshot : freezeSnapshot(readRepositorySnapshot(this.db)),
      managementProtection: Object.freeze(readManagementProtection(this.db)),
    })));
    this.snapshot = projection.snapshot;
    return projection;
  }

  /** Reconcile installed artifacts before exposing a startup snapshot to any consumer. */
  private removeUnavailablePlugins(): void {
    const available = this.options.compileOptions?.availablePlugins;
    // An omitted catalog is used by integrity/inspection tools; it is not an empty catalog.
    if (available === undefined) return;
    runRepositoryAction(() => this.mutationTransaction(() => {
      const snapshot = readRepositorySnapshot(this.db);
      const removed = new Set<string>();
      const installed = (name: string): boolean => {
        if (available.has(name)) return true;
        removed.add(name);
        return false;
      };
      const bindings = (values: readonly PluginBinding[]) => values.filter(value => installed(value.name));
      const endpoints = (values: readonly ConfigurationUpstream[]) => values.map(value => {
        const { managedBy, ...endpoint } = value;
        return { ...endpoint, plugins: bindings(value.plugins),
          ...(managedBy && installed(managedBy.plugin) ? { managedBy } : {}) };
      });
      const logical = snapshot.aggregate.logical_configuration;
      const aggregate = {
        plugin_activations: snapshot.aggregate.plugin_activations.filter(value => installed(value.plugin_name)),
        logical_configuration: {
          ...logical, plugins: bindings(logical.plugins),
          services: logical.services.map(service => ({ ...service,
            plugins: bindings(service.plugins), endpoints: endpoints(service.endpoints) })),
          routes: logical.routes.map(route => ({ ...route, plugins: bindings(route.plugins),
            ...(route.endpoints === undefined ? {} : { endpoints: endpoints(route.endpoints) }) })),
        },
      };
      if (removed.size === 0) return;
      const protection = readManagementProtection(this.db);
      const provider = protection.selectedProvider !== null && available.has(protection.selectedProvider)
        ? protection.selectedProvider : null;
      const now = Date.now(), operationId = randomUUID();
      // Reuse revision/CAS and publication bookkeeping; never edit historical snapshots.
      // Existing bindings have already been audited. Catalog compilation follows in the master.
      const prepared = prepareCommitCommand({ mutation_id: operationId, expected_revision: snapshot.revision,
        aggregate, kind: 'config', created_at: now, target_worker_slots: [] });
      const command = { ...prepared, managementProvider: provider,
        requestHash: hashConfigurationRequest({ kind: prepared.kind, expected_revision: prepared.expectedRevision,
          aggregate: prepared.aggregate, target_worker_slots: [], management_provider: provider, offline_management: true }),
      };
      const result = commitTransaction(this.db, command, this.options, snapshot, true);
      if (result.kind !== 'committed') throw new ConfigRepositoryError('invalid_operation',
        `plugin catalog reconciliation cannot proceed (${result.kind})`);
      beginOperationPublication(this.db, operationId, now);
      markOperationDraining(this.db, operationId, now);
      finalizeOperationPublication(this.db, operationId, { outcome: 'converged', old_workers_exited: true }, now);
    }));
    this.snapshot = freezeSnapshot(readRepositorySnapshot(this.db));
  }

  /** Exclusive stopped-instance operation; ordinary commit never receives this authority. */
  setManagementProviderOffline(provider: string | null, operationId: string, now: number): ControlProjection {
    if (this.options.offline !== true) throw new ConfigRepositoryError('invalid_command', 'management protection changes require an offline repository');
    if (typeof operationId !== 'string' || !validateMutationId(operationId) || !Number.isSafeInteger(now) || now < 0 ||
        (provider !== null && typeof provider !== 'string')) {
      throw new ConfigRepositoryError('invalid_command', 'offline management command is invalid');
    }
    runRepositoryAction(() => this.mutationTransaction(() => {
      const existing = readOperation(this.db, operationId);
      if (existing !== null) {
        const identity = readManagementRequestIdentity(this.db, operationId);
        if (!identity.offline_management || identity.management_provider !== provider) {
          throw new ConfigRepositoryError('idempotency_key_reused', 'offline management operation ID has different input');
        }
        return;
      }
      const providers = this.options.compileOptions?.managementProviders;
      if (provider !== null && !providers?.has(provider)) {
        throw new ConfigRepositoryError('invalid_configuration', 'offline management provider is not in the catalog');
      }
      const snapshot = readRepositorySnapshot(this.db);
      const protection = readManagementProtection(this.db);
      const aggregate = structuredClone(snapshot.aggregate);
      const activations = aggregate.plugin_activations.filter(({ plugin_name }) =>
        plugin_name !== protection.selectedProvider && !providers?.has(plugin_name));
      if (provider !== null) activations.push({ plugin_name: provider });
      // Existing settings and bindings are already audited. Only activation selection changes here.
      const prepared = prepareCommitCommand({
        mutation_id: operationId, expected_revision: snapshot.revision,
        aggregate: { ...aggregate, plugin_activations: activations }, kind: 'config', created_at: now, target_worker_slots: [],
      });
      const offlinePrepared = { ...prepared, managementProvider: provider,
        requestHash: hashConfigurationRequest({ kind: prepared.kind, expected_revision: prepared.expectedRevision,
          aggregate: prepared.aggregate, target_worker_slots: [], management_provider: provider, offline_management: true }),
      };
      const result = commitTransaction(this.db, offlinePrepared, this.options, snapshot, true);
      if (result.kind !== 'committed') {
        throw new ConfigRepositoryError(result.kind === 'recovery_in_progress' ? 'recovery_in_progress' : 'invalid_operation',
          `offline management change cannot proceed (${result.kind})`);
      }
      beginOperationPublication(this.db, operationId, now);
      markOperationDraining(this.db, operationId, now);
      finalizeOperationPublication(this.db, operationId, { outcome: 'converged', old_workers_exited: true }, now);
    }));
    return this.getControlProjection();
  }

  getSnapshot(): RepositorySnapshot {
    return this.snapshot;
  }

  getMenuLayout() {
    return runRepositoryAction(() => withConsistentRead(this.db, () => readMenuLayout(this.db)));
  }

  putMenuLayout(expectedRevision: number, layout: MenuLayout, catalogPageIds: readonly string[]) {
    return runRepositoryAction(() => this.mutationTransaction(() => writeMenuLayout(this.db, expectedRevision, layout, catalogPageIds)));
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
      const decision = this.mutationTransaction(() => {
        const result = commitTransaction(this.db, prepared, this.options, this.snapshot);
        readManagementProtection(this.db);
        return result;
      });
      if (decision.kind === 'committed') {
        this.snapshot = freezeSnapshot({ revision: decision.operation.committed_revision, content_hash: prepared.contentHash, aggregate: prepared.aggregate });
        return { kind: 'committed', snapshot: this.snapshot, operation: decision.operation };
      }
      if (decision.kind === 'duplicate') this.getControlProjection();
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
      const current = readOperationWorkers(this.db, mutationId).find(target => target.worker_slot === workerSlot);
      if (current?.attempt_no === previousAttemptNo) retirementStore.assertPublicationServingAttemptsExited(this.db, mutationId);
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
      if (readOperation(this.db, mutationId)?.drain_recovery_generation === previousGeneration) {
        retirementStore.assertPublicationServingAttemptsExited(this.db, mutationId);
      }
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

  getPublicationServingSet(...args: TailParameters<typeof retirementStore.readPublicationServingSet>): ReturnType<typeof retirementStore.readPublicationServingSet> {
    return runRepositoryAction(() => withConsistentRead(this.db, () => retirementStore.readPublicationServingSet(this.db, ...args)));
  }

  freezePublicationServingSet(...args: TailParameters<typeof retirementStore.freezePublicationServingSet>): ReturnType<typeof retirementStore.freezePublicationServingSet> {
    return runRepositoryAction(() => this.mutationTransaction(() => retirementStore.freezePublicationServingSet(this.db, ...args)));
  }

  confirmPublicationServingMemberExit(...args: TailParameters<typeof retirementStore.confirmPublicationServingMemberExit>): ReturnType<typeof retirementStore.confirmPublicationServingMemberExit> {
    return runRepositoryAction(() => this.mutationTransaction(() => retirementStore.confirmPublicationServingMemberExit(this.db, ...args)));
  }

  getRetirementDescriptorCleanupState(workerInstanceId: string): 'absent' | 'pending' | 'terminal' {
    return runRepositoryAction(() => withConsistentRead(this.db, () => retirementStore.readRetirementDescriptorCleanupState(this.db, workerInstanceId)));
  }

  getRetiredWorkerInstanceIds(): readonly string[] {
    return runRepositoryAction(() => withConsistentRead(this.db, () => retirementStore.readRetiredWorkerInstanceIds(this.db)));
  }

  getPublicationRetirement(...args: TailParameters<typeof retirementStore.readPublicationRetirement>): ReturnType<typeof retirementStore.readPublicationRetirement> {
    return runRepositoryAction(() => withConsistentRead(this.db, () => retirementStore.readPublicationRetirement(this.db, ...args)));
  }

  freezePublicationRetirement(...args: TailParameters<typeof retirementStore.freezePublicationRetirement>): ReturnType<typeof retirementStore.freezePublicationRetirement> {
    return runRepositoryAction(() => this.publicationTransaction(args[0], () => retirementStore.freezePublicationRetirement(this.db, ...args)));
  }

  recordPublicationRetirementEvidence(...args: TailParameters<typeof retirementStore.recordPublicationRetirementEvidence>): ReturnType<typeof retirementStore.recordPublicationRetirementEvidence> {
    return runRepositoryAction(() => this.mutationTransaction(() => retirementStore.recordPublicationRetirementEvidence(this.db, ...args)));
  }

  stopPublicationRetirement(...args: TailParameters<typeof retirementStore.stopPublicationRetirement>): ReturnType<typeof retirementStore.stopPublicationRetirement> {
    return runRepositoryAction(() => this.mutationTransaction(() => retirementStore.stopPublicationRetirement(this.db, ...args)));
  }

  retryPublicationRetirement(...args: TailParameters<typeof retirementStore.retryPublicationRetirement>): ReturnType<typeof retirementStore.retryPublicationRetirement> {
    return runRepositoryAction(() => this.mutationTransaction(() => retirementStore.retryPublicationRetirement(this.db, ...args)));
  }
  freezePublicationRetirementDrainStart(...args:TailParameters<typeof retirementStore.freezePublicationRetirementDrainStart>):ReturnType<typeof retirementStore.freezePublicationRetirementDrainStart> {
    return runRepositoryAction(()=>this.mutationTransaction(()=>retirementStore.freezePublicationRetirementDrainStart(this.db,...args)));
  }
  getPublicationRetirementRetry(...args: TailParameters<typeof retirementStore.readPublicationRetirementRetry>): ReturnType<typeof retirementStore.readPublicationRetirementRetry> {
    return runRepositoryAction(()=>withConsistentRead(this.db,()=>retirementStore.readPublicationRetirementRetry(this.db,...args)));
  }
  requestPublicationRetirementRetry(...args: TailParameters<typeof retirementStore.requestPublicationRetirementRetry>): ReturnType<typeof retirementStore.requestPublicationRetirementRetry> {
    return runRepositoryAction(()=>this.mutationTransaction(()=>{
      if(this.snapshot.revision!==args[2]) throw new ConfigRepositoryError('cas_conflict','retirement retry revision changed');
      return retirementStore.requestPublicationRetirementRetry(this.db,...args);
    }));
  }

  markPublicationRetirementReleased(...args: TailParameters<typeof retirementStore.markPublicationRetirementReleased>): ReturnType<typeof retirementStore.markPublicationRetirementReleased> {
    return runRepositoryAction(() => this.mutationTransaction(() => retirementStore.markPublicationRetirementReleased(this.db, ...args)));
  }

  getRuntimeRecoveryBudget(...args: TailParameters<typeof runtimeRecoveryBudget.readRuntimeRecoveryBudget>): ReturnType<typeof runtimeRecoveryBudget.readRuntimeRecoveryBudget> {
    return runRepositoryAction(() => withConsistentRead(this.db, () => runtimeRecoveryBudget.readRuntimeRecoveryBudget(this.db, ...args)));
  }

  consumeRuntimeRecoveryRestartTicket(...args: TailParameters<typeof runtimeRecoveryBudget.consumeRuntimeRecoveryRestartTicket>): ReturnType<typeof runtimeRecoveryBudget.consumeRuntimeRecoveryRestartTicket> {
    return runRepositoryAction(() => this.mutationTransaction(() => runtimeRecoveryBudget.consumeRuntimeRecoveryRestartTicket(this.db, ...args)));
  }

  getRuntimeRecoveryStartupGate(...args: TailParameters<typeof runtimeRecoveryBudget.readRuntimeRecoveryStartupGate>): ReturnType<typeof runtimeRecoveryBudget.readRuntimeRecoveryStartupGate> {
    return runRepositoryAction(() => withConsistentRead(this.db, () => runtimeRecoveryBudget.readRuntimeRecoveryStartupGate(this.db, ...args)));
  }

  observeRuntimeRecoveryHealth(...args: TailParameters<typeof runtimeRecoveryBudget.observeRuntimeRecoveryHealth>): ReturnType<typeof runtimeRecoveryBudget.observeRuntimeRecoveryHealth> {
    return runRepositoryAction(() => this.mutationTransaction(() => runtimeRecoveryBudget.observeRuntimeRecoveryHealth(this.db, ...args)));
  }

  /** Startup/explicit verification may audit the complete repository. */
  verify(): void {
    verifyRepositoryIntegrity(this.db);
    readRepositorySnapshot(this.db);
    this.getRuntimeRecoveryBudget();
    this.getMenuLayout();
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
