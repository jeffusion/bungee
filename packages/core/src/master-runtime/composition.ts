import type { DaemonMetadataV1, Sha256Digest } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { logger } from '../logger';
import type {
  ConfigPublicationRepository,
  ConfigPublicationWorkerFactory,
  ConfigPublicationWorkerProcess,
  MasterConfigPublicationCoordinatorOptions,
  MasterPublicationOutcome,
  PublicationClock,
  ServingConfigWorker,
  WorkerAdmissionController,
  PreparedWorkerAdmission,
} from '../config-publication';
import {
  isPublicationCancelled,
  throwIfPublicationCancelled,
  type PublicationCancellationSignal,
} from '../config-publication/publication-runner';
import {
  MasterIngressController,
  type MasterIngressControllerOptions,
  type MasterIngressRecoveryEvent,
  type MasterIngressRecoveryResult,
  type MasterIngressStartupFailureDisposition,
} from '../ingress/master-controller';
import { parseNormalizeCompileAggregate, type CommitConfigurationCommandV1,
  type ActiveConfigurationPublication,
  type CommitConfigurationResult, type ConfigurationOperationState,
  type ConfigRepositoryOptions, type RepositorySnapshot, type ServingSnapshotKey,
  } from '../config-storage';
import type { CatalogPathResolver } from '../plugin-manifest-catalog/catalog';
import type { ConfigurationRecovery, ConfigurationRecoveryReasonCode } from '../config-storage/repository-types';
import type { AdmittedWorkerSelector } from '../public-listener';
import type { ManagementListenerOptions } from '../management-listener';
import type { AuthenticatedOrphanCleanupResult, IngressBootWorkerCleanupRequest, IngressBootWorkerCleanupResult, SupervisedAdoptionResult, SupervisedConfigWorkerFactoryOptions } from './supervised-worker-factory';
import type {
  MasterProcessOptions,
  WorkerLaunch,
  WorkerLaunchInput,
} from './process-options';
import {
  MasterRuntimeError,
  type MasterRuntimeAdmission,
  type MasterRuntimeCoordinator,
  type MasterRuntimeIngressBootRecoveryGate,
  type MasterRuntimeInstanceLock,
  type MasterRuntimeOptions,
  type MasterRuntimePublicListener,
  type MasterRuntimeRepository,
  type MasterRuntimeWorkerPool,
} from './runtime-contracts';
import type { MasterSignalController, MasterSignalRuntime } from './signal-handlers';
import { createConfigControlApi } from './control-api';
import { hasUnreleasedMasterStatsResource, type MasterStatsApi } from './master-stats';
import { runtimeUpstreams } from './runtime-upstreams';
import { serializeErrorChain } from './error-chain';
import { PublicationTaskManager } from './publication-task-manager';
import { ConfigurationRecoveryRunner } from './configuration-recovery';
import { exactExitProof, isExactServingTarget } from './runtime-evidence';
import { classifyControlError } from '../config-publication/recovery-disposition';
import type { ControllerClaimCapability } from './instance-lock';
import {
  createDatabaseSecretStoreFactory,
  createDatabasePluginStorageFactory,
  createPluginControlHost,
  parsePluginSecretsKey,
  type PluginControlHost,
} from '../plugin-control';
import {
  createPluginControlMasterHttpBridge,
  type PluginControlMasterHttpBridge,
} from '../plugin-control/master-http-bridge';
import { createMasterPluginCatalogApi } from './master-plugin-catalog-api';
import { createMasterUIHandler } from '../ui/server';
import { createDaemonShutdownHandler } from '../daemon-control';
import type { DaemonBootstrap } from '../daemon-control/bootstrap';

export type MasterProcessContext = {
  readonly cwd: string;
  readonly moduleDirectory: string;
  readonly executable: string;
  readonly entry: string;
  readonly pid: number;
  readonly accessLogDbPath: string;
};

export interface MasterPluginCatalog {
  readonly hash: Sha256Digest;
  toCompileOptions(): NonNullable<ConfigRepositoryOptions['compileOptions']>;
  records?(): readonly import('../plugin-manifest-catalog/types').PluginManifestRecord[];
}

export type MasterProcessRepository = ConfigPublicationRepository & MasterRuntimeRepository & {
  appendServingSnapshot(snapshot: RepositorySnapshot, pluginCatalogHash: Sha256Digest): void;
  getServingSnapshot(key: ServingSnapshotKey): RepositorySnapshot | null;
  commit(command: CommitConfigurationCommandV1): CommitConfigurationResult;
  getOperationState(mutationId: string): ConfigurationOperationState | null;
  getRecovery?(recoveryId: string): ConfigurationRecovery | null;
  getCurrentOperationState(): ConfigurationOperationState | null;
  getCurrentRecovery(): ConfigurationRecovery | null;
  createManualRecovery(recoveryId: string, sourceMutationId: string, expectedRevision: number, now: number): ConfigurationRecovery;
  claimRecoveryAttempt(recoveryId: string, previousAttemptCount: number, now: number): ConfigurationRecovery;
  scheduleRecoveryRetry(recoveryId: string, attemptCount: number, nextRetryAt: number, now: number): ConfigurationRecovery;
  succeedRecovery(recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode, reasonDetail: string | null, now: number): ConfigurationRecovery;
  stopRecovery(recoveryId: string, attemptCount: number, reasonCode: ConfigurationRecoveryReasonCode, reasonDetail: string | null, now: number): ConfigurationRecovery;
  requeueRecovery(recoveryId: string, attemptCount: number, now: number): ConfigurationRecovery;
  getDatabase?: () => Database;
  getSupervisionState?(): import('../supervision/state-repository').SupervisionState;
  claimControllerWithCapability?(capability: ControllerClaimCapability, controllerId: string, updatedAt: number): import('../supervision/state-repository').SupervisionState;
};
export type MasterProcessAdmission = WorkerAdmissionController
  & MasterRuntimeAdmission
  & AdmittedWorkerSelector;
export type MasterProcessWorkerFactory = ConfigPublicationWorkerFactory & MasterRuntimeWorkerPool & {
  readonly snapshot?: () => readonly ConfigPublicationWorkerProcess[];
  readonly lookupExactControlSession?: import('../plugin-control/master-http-bridge').PluginControlMasterBridgeFactory['lookupExactControlSession'];
  readonly subscribeEligibilityChange?: (listener: () => void) => () => void;
  setRateLimitSession(session: import('../config-worker/process-environment').SupervisedWorkerRateLimitSession): void;
  retireForIngressBootChange(request: IngressBootWorkerCleanupRequest): Promise<IngressBootWorkerCleanupResult>;
  discoverAndAdopt(admission: import('../ingress').AdmissionSet): Promise<SupervisedAdoptionResult>;
  cleanupAuthenticatedOrphans?(registry: import('../ingress').AdmissionRegistryStatus): Promise<AuthenticatedOrphanCleanupResult>;
};

export interface MasterProcessRuntime extends MasterSignalRuntime {
  start(): Promise<void>;
  shutdownAfterStartupFailure?(): Promise<void>;
  reportAsynchronousFailure(error: MasterRuntimeError): void;
}

export interface MasterProcessCoordinator extends MasterRuntimeCoordinator {
  recoverAndPublish(signal?: PublicationCancellationSignal): Promise<MasterPublicationOutcome | null>;
  startCurrent(
    snapshot: RepositorySnapshot,
    existingWorkers?: readonly ServingConfigWorker[],
    retireWorkers?: readonly ServingConfigWorker[],
    signal?: PublicationCancellationSignal,
  ): Promise<import('../config-publication').StartupPublicationOutcome>;
  publish(
    active: ActiveConfigurationPublication,
    oldWorkers: readonly ServingConfigWorker[],
  ): Promise<MasterPublicationOutcome>;
}

export interface MasterProcessDependencies {
  readonly context: MasterProcessContext;
  readonly clock: PublicationClock;
  readOptions(): MasterProcessOptions;
  acquireInstanceLock(path: string): Promise<MasterRuntimeInstanceLock>;
  migrateAccessDatabase(path: string): Promise<void>;
  createPluginPathResolver(input: {
    readonly moduleDirectory: string;
    readonly cwd: string;
  }): CatalogPathResolver;
  buildPluginCatalog(resolver: CatalogPathResolver): Promise<MasterPluginCatalog>;
  readonly resolveAuthToken: (tokenExpression: string) => unknown;
  openRepository(path: string, options: ConfigRepositoryOptions): MasterProcessRepository;
  createAdmission(): MasterProcessAdmission;
  resolveWorkerLaunch(input: WorkerLaunchInput): WorkerLaunch;
  createWorkerFactory(options: SupervisedConfigWorkerFactoryOptions): MasterProcessWorkerFactory;
  createMasterGeneration(): string;
  createCoordinator(options: MasterConfigPublicationCoordinatorOptions): MasterProcessCoordinator;
  createManagementListener(options: ManagementListenerOptions): MasterRuntimePublicListener;
  readonly createMasterStats?: (path: string) => MasterStatsApi;
  readonly createControllerClaim?: (
    configLock: MasterRuntimeInstanceLock,
    accessLock: MasterRuntimeInstanceLock,
  ) => ControllerClaimCapability;
  createRuntime(options: MasterRuntimeOptions): MasterProcessRuntime;
  readonly createIngressController?: (options: MasterIngressControllerOptions) => MasterIngressController;
  readonly deriveTransportSecret?: (rootKey: Uint8Array, instanceId: string) => string;
  installSignalHandlers(runtime: MasterSignalRuntime): MasterSignalController;
}

export interface MasterProcessHandle {
  readonly runtime: MasterProcessRuntime;
  readonly dataPort?: number | null;
  readonly managementPort?: number | null;
  readonly ingressControlPort?: number;
  shutdown(): Promise<void>;
  removeSignalHandlers(): void;
}

type ConstructionResources = {
  locks: MasterRuntimeInstanceLock[];
  repository: MasterProcessRepository | null;
  admission: MasterProcessAdmission | null;
  workerFactory: MasterProcessWorkerFactory | null;
  listener: MasterRuntimePublicListener | null;
  pluginControl: PluginControlHost | null;
  pluginControlBridge: PluginControlMasterHttpBridge | null;
  pluginControlSubscriptions: (() => void) | null;
  stopBackgroundTasks: (() => Promise<void>) | null;
  stats: MasterStatsApi | null;
  statsResourceUnreleased: boolean;
  ingressController: MasterIngressController | null;
};

const NO_INGRESS_STARTUP_FAILURE_DISPOSITION: MasterIngressStartupFailureDisposition = Object.freeze({
  kind: 'preserved',
  origin: null,
  evidence: Object.freeze({
    registry: null,
    statusRefreshed: false,
    pendingAdmission: false,
    uncertainAdmission: false,
    pendingRetiredRelease: false,
    reason: 'unowned',
  }),
});

function cleanupWorkersAfterStartupFailure(
  factory: MasterProcessWorkerFactory,
  disposition: MasterIngressStartupFailureDisposition | undefined,
): Promise<void> {
  if (disposition === undefined) {
    const owned = factory.snapshot?.() ?? [];
    if (owned.length > 0) factory.forgetProcessesWithoutExitProof(owned);
    return Promise.resolve();
  }
  if (disposition?.kind === 'shutdown_safe_empty') {
    const expectedPids = factory.pids();
    return factory.shutdownAll().then((results) => {
      if (!exactExitProof(expectedPids, results)) {
        throw new MasterRuntimeError(
          'worker_exit_unconfirmed',
          'safe-empty startup workers did not produce exact exit proof',
          { expectedPids },
        );
      }
    });
  }
  if (disposition.kind !== 'preserved' || disposition.origin === null) {
    factory.disconnectAll();
    return Promise.resolve();
  }
  const owned = factory.snapshot?.() ?? [];
  if (owned.length > 0) factory.forgetProcessesWithoutExitProof(owned);
  return Promise.resolve();
}

function activeControlNames(
  snapshot: ReturnType<MasterProcessRepository['getSnapshot']>,
  catalog: MasterPluginCatalog,
): readonly string[] {
  const declared = new Set((catalog.records?.() ?? [])
    .filter(({ manifest }) => manifest.control !== undefined)
    .map(({ name }) => name));
  return snapshot.aggregate.plugin_activations
    .map(({ plugin_name }) => plugin_name)
    .filter((name) => declared.has(name));
}

function controlReadinessFailure(
  repository: MasterProcessRepository,
  active: ActiveConfigurationPublication,
  serving: readonly ServingConfigWorker[],
  error: unknown,
  now: number,
  phase: 'publish' | 'recover',
): MasterPublicationOutcome {
  logger.error({ error: serializeErrorChain(error), phase, mutationId: active.operation.mutation_id, revision: active.snapshot.revision },
    'Plugin control readiness failed before configuration publication');
  const operation = repository.finalizePublication(
    active.operation.mutation_id,
    { outcome: 'degraded', error_code: 'control_readiness_failed', error_detail: 'plugin control readiness failed',
      recovery_disposition: classifyControlError(error) },
    now,
  );
  return {
    kind: 'degraded', http_status: 202, error_code: 'control_readiness_failed',
    failures: [], operation, serving, recovery_disposition: classifyControlError(error),
  };
}

function currentControlReadinessFailure(value: ConfigurationOperationState | null): ConfigurationOperationState['operation'] | null {
  if (value === null) return null;
  const operation = value.operation;
  return operation.state === 'degraded' && operation.error_code === 'control_readiness_failed'
    ? operation : null;
}

function completeCurrentServing(
  serving: readonly ServingConfigWorker[],
  snapshot: ReturnType<MasterProcessRepository['getSnapshot']>,
  catalog: MasterPluginCatalog,
  workerCount: number,
): boolean {
  return serving.length === workerCount && serving.every((worker) => worker.revision === snapshot.revision
    && worker.content_hash === snapshot.content_hash && worker.plugin_catalog_hash === catalog.hash);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function terminalRecoveryCode(code: string | undefined): boolean {
  return code === 'invalid_options' || code === 'target_set_mismatch'
    || code === 'schema_corrupt' || code === 'connection_invariant'
    || code === 'migration_failed' || code === 'serving_snapshot_corrupt';
}

function recoveryError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function startupFailureDispositionEvidence(
  disposition: MasterIngressStartupFailureDisposition,
): Readonly<Record<string, unknown>> {
  const registry = disposition.evidence.registry;
  return Object.freeze({
    kind: disposition.kind,
    origin: disposition.origin,
    reason: disposition.kind === 'preserved' ? disposition.evidence.reason : 'safe_empty',
    status_refreshed: disposition.evidence.statusRefreshed,
    active_present: registry !== null && registry.active !== null,
    prepared_present: registry !== null && registry.prepared !== null,
  });
}

function recordStartupFailureDisposition(disposition: MasterIngressStartupFailureDisposition): void {
  logger.error(startupFailureDispositionEvidence(disposition), 'Master ingress startup failure disposition');
}

async function cleanupConstruction(resources: ConstructionResources): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  const capture = async (operation: () => void | Promise<void>): Promise<void> => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  let listenerStopped = true;
  if (resources.listener !== null) {
    resources.listener.stopAccepting?.();
    try { await resources.listener.stop(); }
    catch (error) { listenerStopped = false; errors.push(error); }
  }
  if (resources.stopBackgroundTasks !== null) await capture(() => resources.stopBackgroundTasks?.());
  if (resources.pluginControlSubscriptions !== null) await capture(() => resources.pluginControlSubscriptions?.());
  if (resources.pluginControlBridge !== null) await capture(() => resources.pluginControlBridge?.dispose());
  if (resources.pluginControl !== null) await capture(() => resources.pluginControl?.dispose());
  let statsClosed = !resources.statsResourceUnreleased;
  if (resources.stats !== null) {
    try { await resources.stats.close(); }
    catch (error) { statsClosed = false; errors.push(error); }
  }
  let ingressDisposition: MasterIngressStartupFailureDisposition | undefined;
  let ingressDispositionKnown = resources.ingressController === null;
  if (resources.ingressController !== null) {
    await capture(async () => {
      const controller = resources.ingressController!;
      if (typeof controller.cleanupAfterStartupFailure === 'function') {
        ingressDisposition = await controller.cleanupAfterStartupFailure();
        ingressDispositionKnown = true;
        recordStartupFailureDisposition(ingressDisposition);
        return;
      }
      await (controller.disconnect?.() ?? controller.stop(false));
      ingressDispositionKnown = true;
    });
  }
  if ((resources.ingressController === null || ingressDisposition?.kind === 'shutdown_safe_empty') && resources.admission !== null) {
    await capture(() => resources.admission?.clear());
  }
  let exitsConfirmed = resources.workerFactory === null;
  let workersCleaned = true;
  if (resources.workerFactory !== null) {
    try {
      await cleanupWorkersAfterStartupFailure(resources.workerFactory,
        resources.ingressController === null ? NO_INGRESS_STARTUP_FAILURE_DISPOSITION : ingressDisposition);
    }
    catch (error) { workersCleaned = false; errors.push(error); }
    exitsConfirmed = true;
  }
  if (resources.repository !== null) await capture(() => resources.repository?.close());
  if (exitsConfirmed && workersCleaned && statsClosed && listenerStopped && ingressDispositionKnown) {
    for (const lock of [...resources.locks].reverse()) await capture(() => lock.release());
  }
  if (resources.locks.length > 0 && (!exitsConfirmed || !workersCleaned || !statsClosed || !listenerStopped || !ingressDispositionKnown)) {
    errors.push(new MasterRuntimeError(
      'cleanup_failed',
      !statsClosed ? 'master stats did not close; instance lock retained'
        : !listenerStopped ? 'management listener did not stop; instance lock retained'
          : !workersCleaned ? 'startup worker cleanup did not complete; instance lock retained'
          : !ingressDispositionKnown ? 'startup ingress disposition was not reported; instance lock retained'
          : 'worker exits were not confirmed; instance lock retained',
    ));
  }
  return errors;
}

export async function startMasterComposition(
  dependencies: MasterProcessDependencies,
  daemonBootstrap: DaemonBootstrap | null = null,
): Promise<MasterProcessHandle> {
  const resources: ConstructionResources = {
    locks: [], repository: null, admission: null, workerFactory: null, listener: null,
    pluginControl: null, pluginControlBridge: null, pluginControlSubscriptions: null, stopBackgroundTasks: null, stats: null,
    statsResourceUnreleased: false,
    ingressController: null,
  };
  let runtime: MasterProcessRuntime | null = null;
  let runtimeLifecycle: MasterProcessRuntime | null = null;
  let shutdownCoordinatorPromise: Promise<void> | null = null;
  let daemonMetadata: DaemonMetadataV1 | null = daemonBootstrap?.metadata ?? null;
  let handlerReady = false;
  let diskPublished = false;
  let shutdownRequested = false;
  let daemonArmPromise: Promise<void> | null = null;
  try {
    const options = dependencies.readOptions();
    const configLock = await dependencies.acquireInstanceLock(options.configDbLockPath);
    resources.locks.push(configLock);
    const accessLock = await dependencies.acquireInstanceLock(`${dependencies.context.accessLogDbPath}.lock`);
    resources.locks.push(accessLock);
    await dependencies.migrateAccessDatabase(dependencies.context.accessLogDbPath);
    let supervisionState: import('../supervision/state-repository').SupervisionState | null = null;
    if (dependencies.createIngressController !== undefined) {
      const bootstrap = dependencies.openRepository(options.configDbPath, {});
      resources.repository = bootstrap;
      const createClaim = dependencies.createControllerClaim;
      if (createClaim === undefined || bootstrap.claimControllerWithCapability === undefined) {
        throw new MasterRuntimeError('startup_incomplete', 'supervision claim is unavailable');
      }
      supervisionState = bootstrap.claimControllerWithCapability(
        createClaim(configLock, accessLock), randomUUID(), dependencies.clock.now(),
      );
      await bootstrap.close();
      resources.repository = null;
    }
    const resolver = dependencies.createPluginPathResolver({
      moduleDirectory: dependencies.context.moduleDirectory,
      cwd: dependencies.context.cwd,
    });
    const catalog = await dependencies.buildPluginCatalog(resolver);
    const compileOptions = catalog.toCompileOptions();
    resources.repository = dependencies.openRepository(options.configDbPath, {
      compileOptions,
    });
    try {
      resources.stats = dependencies.createMasterStats?.(dependencies.context.accessLogDbPath) ?? null;
    } catch (error) {
      resources.statsResourceUnreleased = hasUnreleasedMasterStatsResource(error);
      throw error;
    }
    if (resources.stats?.configureLogging !== undefined || resources.stats?.startCleanup !== undefined) {
      const authoritativeSnapshot = resources.repository.getSnapshot();
      resources.stats.configureLogging?.(authoritativeSnapshot.aggregate.logical_configuration.logging);
      resources.stats.startCleanup?.();
    }
    const material = parsePluginSecretsKey(process.env.BUNGEE_PLUGIN_SECRETS_KEY);
    if (dependencies.createIngressController !== undefined && supervisionState === null) {
      throw new MasterRuntimeError('startup_incomplete', 'supervision state was not claimed');
    }
    const configDatabase = resources.repository.getDatabase?.();
    const accessDatabase = resources.stats?.getDatabase?.();
    const secretStores = configDatabase === undefined
      ? {
        create() { throw new Error('plugin control secret key is unavailable'); },
        revoke() {},
        clear() {},
      }
      : createDatabaseSecretStoreFactory(configDatabase, material);
    const storage = accessDatabase === undefined
      ? { create() { throw new Error('plugin control storage is unavailable'); } }
      : createDatabasePluginStorageFactory(accessDatabase);
    resources.pluginControl = createPluginControlHost({
      records: catalog.records?.() ?? [],
      secretStores,
      storage,
    });
    resources.admission = dependencies.createAdmission();
    const transportSecret = dependencies.createIngressController !== undefined
      ? (material === undefined
        ? (() => { throw new MasterRuntimeError('startup_incomplete', 'BUNGEE_PLUGIN_SECRETS_KEY is required for ingress'); })()
        : (dependencies.deriveTransportSecret === undefined
          ? (() => { throw new MasterRuntimeError('startup_incomplete', 'stable transport derivation is unavailable'); })()
          : dependencies.deriveTransportSecret(material.key, supervisionState!.instance_id)))
      : Buffer.alloc(32).toString('base64url');
    let recoveryGateActive = false;
    let recoveryGateGeneration = 0;
    let recoveryGateStopped = false;
    let recoveryGateController = new AbortController();
    const recoveryGateListeners = new Set<{ readonly generation: number; readonly listener: () => void }>();
    const ingressBootRecoveryGate: MasterRuntimeIngressBootRecoveryGate & {
      activate(): number;
      release(generation: number): void;
      cancel(): void;
      isActive(): boolean;
    } = {
      get generation() { return recoveryGateGeneration; },
      isCurrent: (generation) => recoveryGateActive && generation === recoveryGateGeneration,
      isActive: () => recoveryGateActive,
      get signal() { return recoveryGateController.signal; },
      subscribeReleased(generation, listener) {
        const entry = { generation, listener };
        recoveryGateListeners.add(entry);
        return () => { recoveryGateListeners.delete(entry); };
      },
      activate() {
        if (recoveryGateStopped) return recoveryGateGeneration;
        recoveryGateGeneration += 1;
        recoveryGateActive = true;
        recoveryGateController.abort('ingress boot changed');
        recoveryGateController = new AbortController();
        return recoveryGateGeneration;
      },
      release(generation: number) {
        if (!ingressBootRecoveryGate.isCurrent(generation)) return;
        recoveryGateActive = false;
        for (const entry of [...recoveryGateListeners]) {
          if (entry.generation !== generation && entry.generation !== 0) continue;
          try { entry.listener(); } catch { /* recovery gate release must not strand the callback */ }
        }
      },
      cancel() {
        recoveryGateStopped = true;
        recoveryGateActive = false;
        recoveryGateTokens.clear();
        recoveryGateController.abort('master recovery stopped');
      },
    };
    const recoveryGateTokens = new Map<number, number>();
    const onNewBootAccepted = (event: Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }>): void => {
      const generation = ingressBootRecoveryGate.activate();
      if (!ingressBootRecoveryGate.isCurrent(generation)) return;
      recoveryGateTokens.clear();
      recoveryGateTokens.set(event.token, generation);
      admissionRecovering = true;
      const session = resources.ingressController?.authenticatedRateLimitSession(event.token) ?? null;
      if (session !== null) resources.workerFactory?.setRateLimitSession(session);
    };
    let recoveredCallback: (event: MasterIngressRecoveryEvent) => Promise<MasterIngressRecoveryResult | void> = async (event) =>
      event.kind === 'new_boot' ? 'retryable' : undefined;
    let admissionRecovering = false;
    if (dependencies.createIngressController !== undefined) {
      resources.ingressController = dependencies.createIngressController({
        rootKey: material!.key,
        instanceId: supervisionState!.instance_id,
        controllerId: supervisionState!.current_controller_id!,
        controllerEpoch: supervisionState!.controller_epoch,
        controlPort: options.ingressControlPort ?? 3010,
        publicHost: options.host,
        publicPort: options.port,
        instanceLockPath: options.ingressInstanceLockPath ?? `${options.configDbPath}.ingress.instance.lock`,
        transportSecret,
        executable: dependencies.context.executable,
        entry: dependencies.context.entry,
        cwd: dependencies.context.cwd,
        now: dependencies.clock.now,
        monotonicNow: () => performance.now(),
        onRecovered: (event) => recoveredCallback(event),
        onNewBootAccepted,
        onAdmissionResolved: async ({ target, outcome }) => {
          if (ingressBootRecoveryGate.isActive()) {
            admissionRecovering = true;
            resources.pluginControlBridge?.syncActiveAdmission();
            return;
          }
          if (outcome === 'not_committed') {
            admissionRecovering = true;
            await resources.workerFactory?.discardConfirmedUncommitted(target);
            resources.pluginControlBridge?.syncActiveAdmission();
            return;
          }
          if (startupServing !== null && startupServing.length === target.workers.length
            && startupServing.every((worker) => target.workers.some((candidate) =>
              candidate.master_generation === worker.process.identity.master_generation
              && candidate.worker_instance_id === worker.process.identity.worker_instance_id
              && candidate.worker_slot === worker.process.identity.worker_slot
              && candidate.boot_nonce === worker.boot_nonce
              && candidate.private_port === worker.private_port))) {
            trackedAdmission.adoptCommitted(startupServing, target);
            const snapshotsReady = trackRememberedServing(startupServing);
            resources.workerFactory!.markCommitted(startupServing.map(({ process }) => process));
            const current = resources.repository!.getSnapshot();
            admissionRecovering = !snapshotsReady || target.revision !== current.revision
              || target.content_hash !== current.content_hash || target.plugin_catalog_hash !== catalog.hash;
            await resources.pluginControl?.reconcile(activeControlNames(current, catalog));
          }
          resources.pluginControlBridge?.syncActiveAdmission();
        },
      });
      await resources.ingressController.connect();
      admissionRecovering = resources.ingressController.hasTrustedActiveAdmission?.() === true;
    }
    const launch = dependencies.resolveWorkerLaunch({
      executable: dependencies.context.executable,
      entry: dependencies.context.entry,
    });
    const workerFactoryBase = {
      launch,
      cwd: dependencies.context.cwd,
      transportSecret,
      accessLogDbPath: dependencies.context.accessLogDbPath,
      configDbPath: options.configDbPath,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    };
    const servingSnapshots = new Map<ConfigPublicationWorkerProcess, ReturnType<MasterProcessRepository['getSnapshot']>>();
    const admissionSnapshots = new Map<string, ReturnType<MasterProcessRepository['getSnapshot']>>();
    const syncPluginControlAdmission = (): void => {
      resources.pluginControlBridge?.syncActiveAdmission();
    };
    let runtimeReady = false;
    let runtimeStarted = false;
    let runtimeStopping = false;
    let startupRecoveryFailure: Error | null = null;
    const evidenceKey = (worker: Pick<ServingConfigWorker, 'revision' | 'content_hash' | 'plugin_catalog_hash'>): string =>
      `${worker.revision}:${worker.content_hash}:${worker.plugin_catalog_hash}`;
    const trackServing = (
      workers: readonly ServingConfigWorker[],
      snapshot: ReturnType<MasterProcessRepository['getSnapshot']>,
    ): void => {
      for (const worker of workers) {
        if (worker.revision === snapshot.revision
          && worker.content_hash === snapshot.content_hash
          && worker.plugin_catalog_hash === catalog.hash) {
          servingSnapshots.set(worker.process, snapshot);
        }
      }
    };
    const rememberSnapshot = (
      snapshot: ReturnType<MasterProcessRepository['getSnapshot']>,
      signal?: PublicationCancellationSignal,
    ): void => {
      const key = `${snapshot.revision}:${snapshot.content_hash}:${catalog.hash}`;
      if (admissionSnapshots.has(key)) return;
      throwIfPublicationCancelled(signal);
      resources.repository!.appendServingSnapshot(snapshot, catalog.hash);
      throwIfPublicationCancelled(signal);
      admissionSnapshots.set(key, snapshot);
    };
    const servingSnapshotFor = (
      worker: ServingConfigWorker,
      signal?: PublicationCancellationSignal,
    ): ReturnType<MasterProcessRepository['getSnapshot']> | null => {
      if (worker.plugin_catalog_hash !== catalog.hash) return null;
      const current = resources.repository!.getSnapshot();
      if (worker.revision === current.revision && worker.content_hash === current.content_hash) {
        rememberSnapshot(current, signal);
        return current;
      }
      const key = { revision: worker.revision, content_hash: worker.content_hash, plugin_catalog_hash: worker.plugin_catalog_hash };
      return admissionSnapshots.get(evidenceKey(worker)) ?? resources.repository!.getServingSnapshot(key);
    };
    const trackRememberedServing = (
      workers: readonly ServingConfigWorker[],
      signal?: PublicationCancellationSignal,
    ): boolean => {
      let complete = true;
      for (const worker of workers) {
        throwIfPublicationCancelled(signal);
        const snapshot = servingSnapshotFor(worker, signal);
        if (snapshot === null) { complete = false; continue; }
        trackServing([worker], snapshot);
      }
      return complete;
    };
    const assertIngressBootRecoveryGateOpen = (): void => {
      if (ingressBootRecoveryGate.isActive()) throw new Error('ingress boot recovery gate is active');
    };
    const assertIngressBootRecoveryGeneration = (generation: number): void => {
      if (runtimeStopping) return;
      if (ingressBootRecoveryGate.generation !== generation || ingressBootRecoveryGate.isCurrent(generation)) {
        throw new Error('ingress boot recovery generation is stale');
      }
    };
    const originalPrepare = resources.admission.prepare.bind(resources.admission);
    let committedAdmission: readonly ServingConfigWorker[] = [];
    const trackedAdmission: MasterProcessAdmission = {
      prepare(workers, signal?: AbortSignal) {
        type AdmissionSideState =
          | 'prepared' | 'commit_sent' | 'committed' | 'aborted' | 'boot_disappeared' | 'uncertain';
        type AdmissionSide = {
          handle: PreparedWorkerAdmission | null;
          state: AdmissionSideState | null;
          abortPromise: Promise<void> | null;
        };
        const local: AdmissionSide = { handle: null, state: null, abortPromise: null };
        const remote: AdmissionSide = { handle: null, state: null, abortPromise: null };
        const gateGeneration = ingressBootRecoveryGate.generation;
        const gateSignal = ingressBootRecoveryGate.signal;
        const admissionSignal = signal === undefined ? gateSignal : AbortSignal.any([signal, gateSignal]);
        let abortRequested = admissionSignal.aborted;
        let operationSettled = false;
        let removeAbortListener: (() => void) | null = null;
        const abortSide = async (side: AdmissionSide): Promise<void> => {
          if (side.handle === null || side.state !== 'prepared') return;
          if (side.abortPromise === null) {
            const handle = side.handle;
            side.abortPromise = Promise.resolve().then(() => handle.abort()).then(() => {
              side.state = 'aborted';
            }).finally(() => {
              side.abortPromise = null;
            });
          }
          await side.abortPromise;
        };
        let abortPreparedPromise: Promise<void> | null = null;
        let abortRescanRequested = false;
        const abortPrepared = (): Promise<void> => {
          if (abortPreparedPromise === null) {
            abortPreparedPromise = (async () => {
              const errors: unknown[] = [];
              do {
                abortRescanRequested = false;
                try { await abortSide(remote); } catch (error) { errors.push(error); }
                try { await abortSide(local); } catch (error) { errors.push(error); }
              } while (abortRescanRequested);
              if (operationSettled && local.state !== 'prepared' && remote.state !== 'prepared') finishHandle();
              if (errors.length > 0) throw new AggregateError(errors, 'worker admission abort failed');
            })().finally(() => {
              abortPreparedPromise = null;
            });
          }
          return abortPreparedPromise;
        };
        const checkPrepare = (commitMayHaveBeenSent = false): void => {
          assertIngressBootRecoveryGateOpen();
          if (!runtimeStopping && ingressBootRecoveryGate.generation !== gateGeneration) {
            throw new Error('ingress boot recovery generation is stale');
          }
          throwIfPublicationCancelled(admissionSignal, commitMayHaveBeenSent);
        };
        const onAbort = (): void => {
          abortRequested = true;
          void abortPrepared().catch(() => undefined);
        };
        admissionSignal.addEventListener('abort', onAbort);
        removeAbortListener = () => admissionSignal.removeEventListener('abort', onAbort);
        const finishHandle = (): void => {
          removeAbortListener?.();
          removeAbortListener = null;
        };
        const register = (side: AdmissionSide, handle: PreparedWorkerAdmission): void => {
          side.handle = handle;
          side.state = 'prepared';
          if (abortRequested) {
            abortRescanRequested = abortPreparedPromise !== null;
            void abortPrepared().catch(() => undefined);
          }
        };
        const operation = (async (): Promise<PreparedWorkerAdmission> => {
          try {
            checkPrepare();
            const localPrepared = await originalPrepare(workers, admissionSignal);
            register(local, localPrepared);
            checkPrepare();
            if (abortRequested) {
              await abortPrepared();
              throw admissionSignal.reason ?? new Error('worker admission was aborted');
            }
            if (resources.ingressController !== null && workers.length === options.workerCount) {
              const remotePrepared = await resources.ingressController.prepare(workers, admissionSignal);
              register(remote, remotePrepared);
              checkPrepare();
              if (abortRequested) {
                await abortPrepared();
                throw admissionSignal.reason ?? new Error('worker admission was aborted');
              }
            } else if (resources.ingressController !== null) {
              admissionRecovering = true;
            }
            let commitPromise: Promise<void> | null = null;
            const runCommit = async (): Promise<void> => {
              const previous = workers.map((worker) => [worker.process, servingSnapshots.get(worker.process)] as const);
              const previousAdmission = committedAdmission;
              const checkCommit = (): void => {
                checkPrepare();
                if (abortRequested) throw admissionSignal.reason ?? new Error('worker admission was aborted');
              };
              const commitSide = async (side: AdmissionSide): Promise<void> => {
                if (side.handle === null || side.state !== 'prepared') return;
                checkCommit();
                side.state = 'commit_sent';
                try {
                  await side.handle.commit();
                } catch (error) {
                  if (side === remote) {
                    side.state = errorCode(error) === 'stale_boot' ? 'boot_disappeared'
                      : errorCode(error) === 'admission_not_committed' ? 'prepared' : 'uncertain';
                  } else if (side.state === 'commit_sent') {
                    side.state = 'prepared';
                  }
                  throw error;
                }
                side.state = 'committed';
                checkPrepare(true);
                if (abortRequested) throw admissionSignal.reason ?? new Error('worker admission was aborted');
              };
              try {
                await commitSide(remote);
                await commitSide(local);
                checkCommit();
                if (ingressBootRecoveryGate.isActive()) {
                  resources.admission!.clear();
                  committedAdmission = [];
                  syncPluginControlAdmission();
                  throw new Error('ingress boot recovery gate activated during admission commit');
                }
                trackRememberedServing(workers, admissionSignal);
                throwIfPublicationCancelled(admissionSignal);
                if (runtimeReady) resources.workerFactory!.markCommitted(workers.map(({ process }) => process));
                committedAdmission = workers;
                if (workers.length === options.workerCount && !ingressBootRecoveryGate.isActive()) admissionRecovering = false;
                syncPluginControlAdmission();
                finishHandle();
              } catch (error) {
                await abortPrepared().catch(() => undefined);
                for (const [process, snapshot] of previous) {
                  if (snapshot === undefined) servingSnapshots.delete(process);
                  else servingSnapshots.set(process, snapshot);
                }
                if (ingressBootRecoveryGate.isActive()) {
                  resources.admission!.clear();
                  committedAdmission = [];
                } else {
                  committedAdmission = previousAdmission;
                }
                syncPluginControlAdmission();
                throw error;
              }
            };
            return {
              commit() {
                commitPromise ??= runCommit().catch((error) => {
                  commitPromise = null;
                  throw error;
                });
                return commitPromise;
              },
              async abort() {
                abortRequested = true;
                await abortPrepared();
                finishHandle();
              },
              async releaseRetiredAfterExitProof() {
                checkPrepare();
                if (remote.handle !== null && remote.state !== 'aborted') {
                  await remote.handle.releaseRetiredAfterExitProof();
                  checkPrepare();
                }
              },
            };
          } catch (error) {
            await abortPrepared().catch(() => undefined);
            throw error;
          } finally {
            operationSettled = true;
            if (local.state !== 'prepared' && remote.state !== 'prepared') finishHandle();
          }
        })();
        const compatible = operation as Promise<PreparedWorkerAdmission> & {
          commit: () => Promise<void>;
          abort: () => Promise<void>;
        };
        compatible.commit = () => operation.then((prepared) => prepared.commit());
        compatible.abort = async () => {
          abortRequested = true;
          void abortPrepared().catch(() => undefined);
          try { await operation; } catch { /* prepare failure is reported by the operation */ }
          await abortPrepared();
          finishHandle();
        };
        return compatible;
      },
      snapshot: () => committedAdmission,
      adoptCommitted(workers, remote) {
        assertIngressBootRecoveryGateOpen();
        resources.admission!.adoptCommitted(workers, remote);
        committedAdmission = workers;
      },
      clear() { committedAdmission = []; resources.admission!.clear(); syncPluginControlAdmission(); },
      select: resources.admission.select.bind(resources.admission),
    };
    const pruneServing = (): void => {
      for (const process of servingSnapshots.keys()) {
        if (!resources.workerFactory?.owns(process)) servingSnapshots.delete(process);
      }
      const retained = new Set([...servingSnapshots.values()].map((snapshot) =>
        `${snapshot.revision}:${snapshot.content_hash}:${catalog.hash}`));
      for (const key of admissionSnapshots.keys()) {
        if (!retained.has(key)) admissionSnapshots.delete(key);
      }
    };
    const hasControlPlugins = (catalog.records?.() ?? []).some(({ manifest }) => manifest.control !== undefined);
    const workerFactoryOptions = {
      ...workerFactoryBase,
      rootKey: material?.key ?? new Uint8Array(32),
      runtimeWorkersDirectory: resolve(options.configDbPath, '..', 'runtime', 'workers'),
      managementHost: options.managementHost as '127.0.0.1' | '::1',
      managementPort: options.managementPort,
      authority: {
        controller_epoch: supervisionState?.controller_epoch ?? 0,
        controller_id: supervisionState?.current_controller_id ?? '00000000-0000-4000-8000-000000000000',
      },
      ...(resources.ingressController === null ? {} : (() => {
        const rateLimitSession = resources.ingressController!.authenticatedRateLimitSession();
        if (rateLimitSession === null) {
          throw new MasterRuntimeError('startup_incomplete', 'ingress rate-limit session is not authenticated');
        }
        return { rateLimitSession };
      })()),
      ...(resources.ingressController !== null && typeof resources.ingressController.fenceAndStatus === 'function'
        ? { confirmOrphan: async () => resources.ingressController!.fenceAndStatus() }
        : {}),
    } satisfies SupervisedConfigWorkerFactoryOptions;
    resources.workerFactory = dependencies.createWorkerFactory(workerFactoryOptions);
    if (hasControlPlugins && resources.ingressController !== null) {
      if (resources.workerFactory.lookupExactControlSession === undefined) {
        throw new MasterRuntimeError('startup_incomplete', 'plugin control worker lookup is unavailable');
      }
      resources.pluginControlBridge = createPluginControlMasterHttpBridge({
        ingress: resources.ingressController,
        factory: { lookupExactControlSession: (identity) => resources.workerFactory!.lookupExactControlSession!(identity) },
        repository: {
          getSnapshot: () => resources.repository!.getSnapshot(),
          getServingSnapshot: (process) => servingSnapshots.get(process) ?? null,
        },
        pluginControlHost: resources.pluginControl!,
        catalog: { hash: catalog.hash, records: () => catalog.records?.() ?? [] },
      });
      const unsubscribeIngress = typeof resources.ingressController.subscribeEligibilityChange === 'function'
        ? resources.ingressController.subscribeEligibilityChange(syncPluginControlAdmission)
        : () => undefined;
      const unsubscribeFactory = typeof resources.workerFactory.subscribeEligibilityChange === 'function'
        ? resources.workerFactory.subscribeEligibilityChange(syncPluginControlAdmission)
        : () => undefined;
      const unsubscribeUnavailable = resources.workerFactory.subscribeUnavailable(() => {
        admissionRecovering = true;
        syncPluginControlAdmission();
        recoveryRunner?.wake();
      });
      let unsubscribed = false;
      resources.pluginControlSubscriptions = () => {
        if (unsubscribed) return;
        unsubscribed = true;
        unsubscribeIngress();
        unsubscribeFactory();
        unsubscribeUnavailable();
      };
      syncPluginControlAdmission();
    }
    let startupServing: readonly ServingConfigWorker[] | null = null;
    if (resources.ingressController !== null && resources.workerFactory.cleanupAuthenticatedOrphans !== undefined) {
      try {
        const registry = (await resources.ingressController.status()).registry;
        const cleanup = await resources.workerFactory.cleanupAuthenticatedOrphans(registry);
        if (cleanup.exitUnknown.length > 0) admissionRecovering = true;
      } catch (error) {
        logger.warn({ error: serializeErrorChain(error) }, 'Authenticated orphan cleanup is retryable');
        admissionRecovering = true;
      }
    }
    const remoteAdmission = resources.ingressController?.trustedActiveAdmission() ?? null;
    if (remoteAdmission !== null) {
      const current = resources.repository.getSnapshot();
      const adoption = await resources.workerFactory.discoverAndAdopt(remoteAdmission);
      if (adoption.kind === 'adopted') {
        trackedAdmission.adoptCommitted(adoption.serving, remoteAdmission);
        startupServing = adoption.serving;
        const snapshotsReady = trackRememberedServing(adoption.serving);
        resources.workerFactory.markCommitted(adoption.serving.map(({ process }) => process));
        const recovery = resources.repository.getCurrentRecovery?.() ?? null;
        const exactCurrent = isExactServingTarget(adoption.serving, adoption.serving, current,
          catalog.hash, options.workerCount, resources.workerFactory);
        if (recovery === null || recovery.state === 'succeeded' || exactCurrent) {
          await resources.pluginControl?.reconcile(activeControlNames(current, catalog));
        } else {
          const first = adoption.serving[0];
          const oldSnapshot = first === undefined || adoption.serving.some((worker) =>
            worker.revision !== first.revision || worker.content_hash !== first.content_hash
            || worker.plugin_catalog_hash !== first.plugin_catalog_hash)
            ? null
            : resources.repository.getServingSnapshot({ revision: first.revision,
              content_hash: first.content_hash, plugin_catalog_hash: first.plugin_catalog_hash });
          if (oldSnapshot === null) {
            throw new MasterRuntimeError('startup_incomplete', 'adopted admission has no verified historical snapshot');
          }
          await resources.pluginControl?.reconcile(activeControlNames(oldSnapshot, catalog));
        }
        syncPluginControlAdmission();
        admissionRecovering = !snapshotsReady || !(remoteAdmission.revision === current.revision
          && remoteAdmission.content_hash === current.content_hash
          && remoteAdmission.plugin_catalog_hash === catalog.hash);
      } else {
        admissionRecovering = true;
      }
    }
    const baseCoordinator = dependencies.createCoordinator({
      repository: resources.repository,
      workerFactory: resources.workerFactory,
      workerCount: options.workerCount,
            clock: dependencies.clock,
      startupApplyTimeoutMs: options.startupApplyTimeoutMs,
      drainTimeoutMs: options.drainTimeoutMs,
      pluginCatalogHash: catalog.hash,
      admission: trackedAdmission,
      masterGeneration: remoteAdmission?.master_generation ?? dependencies.createMasterGeneration(),
    });
    let recoveryRunner: ConfigurationRecoveryRunner | null = null;
    let publicationFatalReported = false;
    const consumePublicationRecovery = (outcome: MasterPublicationOutcome): void => {
      if (outcome.kind !== 'degraded') return;
      if (outcome.recovery_disposition === 'retryable') {
        if (!ingressBootRecoveryGate.isActive()) recoveryRunner?.wake();
        return;
      }
      if (outcome.recovery_disposition !== 'fatal' || publicationFatalReported) return;
      publicationFatalReported = true;
      const failure = new MasterRuntimeError('publication_failed', 'configuration recovery finalization was fatal', outcome);
      startupRecoveryFailure ??= failure;
      if (runtimeStarted) runtime?.reportAsynchronousFailure(failure);
    };
    const coordinator: MasterProcessCoordinator = {
      async recoverAndPublish(signal?: PublicationCancellationSignal) {
        assertIngressBootRecoveryGateOpen();
        const gateGeneration = ingressBootRecoveryGate.generation;
        throwIfPublicationCancelled(signal);
        let active: ActiveConfigurationPublication | null;
        try { active = resources.repository!.getActivePublication(); }
        catch (error) {
          const code = errorCode(error);
          if (terminalRecoveryCode(code)) {
            logger.error({ code, error: serializeErrorChain(error) }, 'Master recovery repository failure is terminal');
            throw error;
          }
          return { kind: 'outcome_unknown', fatal: false, code: 'recovery_replacements_failed', error, serving: [], pending: [] };
        }
        if (active === null) {
          const current = resources.repository!.getCurrentOperationState();
          const failed = currentControlReadinessFailure(current);
          const recovery = resources.repository!.getCurrentRecovery?.() ?? null;
          if (failed !== null && recovery?.state !== 'succeeded'
            && !(recovery?.state === 'stopped' && recovery.final_reason_code === 'fatal_source_failure')) {
            return {
              kind: 'degraded', http_status: 202, error_code: 'control_readiness_failed',
              failures: [], operation: failed, serving: [], recovery_disposition: 'retryable',
            };
          }
        }
        if (active !== null) {
          throwIfPublicationCancelled(signal);
          rememberSnapshot(active.snapshot, signal);
          try {
            throwIfPublicationCancelled(signal);
            await resources.pluginControl?.reconcile(activeControlNames(active.snapshot, catalog));
            throwIfPublicationCancelled(signal);
          } catch (error) {
            if (isPublicationCancelled(error)) throw error;
            admissionRecovering = true;
            const failure = controlReadinessFailure(resources.repository!, active, [], error, dependencies.clock.now(), 'recover');
            consumePublicationRecovery(failure);
            return failure;
          }
        } else {
          throwIfPublicationCancelled(signal);
          rememberSnapshot(resources.repository!.getSnapshot(), signal);
        }
        throwIfPublicationCancelled(signal);
        const guardedSignal = signal === undefined
          ? ingressBootRecoveryGate.signal
          : AbortSignal.any([signal, ingressBootRecoveryGate.signal]);
        const outcome = await baseCoordinator.recoverAndPublish(guardedSignal);
        assertIngressBootRecoveryGeneration(gateGeneration);
        throwIfPublicationCancelled(signal);
        if (outcome !== null && active !== null) trackServing(outcome.serving, active.snapshot);
        pruneServing();
        return outcome;
      },
      async startCurrent(snapshot, existingWorkers, retireWorkers = [], signal?: PublicationCancellationSignal) {
        assertIngressBootRecoveryGateOpen();
        const gateGeneration = ingressBootRecoveryGate.generation;
        throwIfPublicationCancelled(signal);
        const durableRecovery = resources.repository!.getCurrentRecovery?.() ?? null;
        if (signal === undefined && !runtimeReady && durableRecovery !== null
          && (durableRecovery.state === 'scheduled' || durableRecovery.state === 'running' || durableRecovery.state === 'stopped')) {
          const serving = trackedAdmission.snapshot();
          startupServing = serving;
          admissionRecovering = true;
          if (serving.length === options.workerCount) {
            return { kind: 'startup_degraded' as const, http_status: 202 as const,
              error_code: 'old_worker_drain_failed' as const, recovery_disposition: 'retryable' as const,
              failures: [], serving };
          }
          return { kind: 'startup_failed' as const,
            failures: [{ slot: -1, code: 'early_exit' as const, detail: 'durable recovery is pending', recovery_disposition: 'retryable' as const }],
            serving };
        }
        throwIfPublicationCancelled(signal);
        rememberSnapshot(snapshot, signal);
        try {
          throwIfPublicationCancelled(signal);
          await resources.pluginControl?.reconcile(activeControlNames(snapshot, catalog));
          throwIfPublicationCancelled(signal);
        } catch (error) {
          if (isPublicationCancelled(error)) throw error;
          admissionRecovering = true;
          logger.error({ error: serializeErrorChain(error), phase: 'start', revision: snapshot.revision },
            'Plugin control readiness failed before startup publication');
          const failure = {
            kind: 'startup_degraded' as const, http_status: 202 as const, error_code: 'control_readiness_failed' as const,
            failures: [], serving: existingWorkers ?? [], recovery_disposition: classifyControlError(error),
          };
          return failure;
        }
        throwIfPublicationCancelled(signal);
        const guardedSignal = signal === undefined
          ? ingressBootRecoveryGate.signal
          : AbortSignal.any([signal, ingressBootRecoveryGate.signal]);
        const outcome = await baseCoordinator.startCurrent(snapshot, existingWorkers, retireWorkers, guardedSignal);
        assertIngressBootRecoveryGeneration(gateGeneration);
        throwIfPublicationCancelled(signal);
        if (outcome.kind === 'startup_ready' || outcome.kind === 'startup_degraded') startupServing = outcome.serving;
        trackServing(outcome.serving, snapshot);
        pruneServing();
        if (outcome.kind === 'startup_ready') admissionRecovering = false;
        else if (outcome.kind === 'startup_degraded' && outcome.error_code === 'old_worker_drain_failed'
          && completeCurrentServing(outcome.serving, snapshot, catalog, options.workerCount)) admissionRecovering = false;
        else admissionRecovering = true;
        return outcome;
      },
      async publish(active, oldWorkers) {
        rememberSnapshot(active.snapshot);
        try {
          await resources.pluginControl?.reconcile(activeControlNames(active.snapshot, catalog));
        } catch (error) {
          admissionRecovering = true;
          const failure = controlReadinessFailure(resources.repository!, active, oldWorkers, error, dependencies.clock.now(), 'publish');
          consumePublicationRecovery(failure);
          return failure;
        }
        const outcome = await baseCoordinator.publish(active, oldWorkers);
        trackServing(outcome.serving, active.snapshot);
        pruneServing();
        consumePublicationRecovery(outcome);
        return outcome;
      },
    };
    const publicationTasks = new PublicationTaskManager({
      publish: (active, oldWorkers) => coordinator.publish(active, oldWorkers),
    });
    recoveryRunner = new ConfigurationRecoveryRunner({
      repository: resources.repository,
      publicationTasks,
      coordinator,
      admission: trackedAdmission,
      workerCount: options.workerCount,
      pluginCatalogHash: catalog.hash,
      now: dependencies.clock.now,
      onFatal: (error) => {
        if (!runtimeReady) startupRecoveryFailure = error;
        if (runtimeStarted) runtime?.reportAsynchronousFailure(new MasterRuntimeError('startup_incomplete', 'master recovery failed', error));
      },
    });
    let backgroundStopPromise: Promise<void> | null = null;
    const stopBackgroundTasks = (): Promise<void> => {
      if (backgroundStopPromise !== null) return backgroundStopPromise;
      backgroundStopPromise = (async () => {
        const errors: unknown[] = [];
        try { await recoveryRunner?.stop(); } catch (error) { errors.push(error); }
        const publicationStop = publicationTasks.stop();
        try { await publicationStop; } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, 'master background task shutdown failed');
      })();
      return backgroundStopPromise;
    };
    resources.stopBackgroundTasks = stopBackgroundTasks;
    recoveredCallback = (event = { kind: 'same_boot' }) => {
      if (event.kind === 'same_boot') {
        return (recoveryRunner?.wake() ?? Promise.resolve({ kind: 'complete' as const })).then((result) => result.kind);
      }
      return publicationTasks.enqueueRecovery(async () => {
        let generation: number | undefined;
        const clearOwnToken = (): void => {
          if (generation !== undefined && recoveryGateTokens.get(event.token) === generation) {
            recoveryGateTokens.delete(event.token);
          }
        };
        try {
          const ingress = resources.ingressController!;
          generation = recoveryGateTokens.get(event.token);
          if (generation === undefined || !ingressBootRecoveryGate.isCurrent(generation)) {
            clearOwnToken();
            return { kind: 'retryable' as const };
          }
          const fenced = await ingress.fenceAndStatus(event.token);
          const cleanup = await resources.workerFactory!.retireForIngressBootChange({
            registry: fenced,
            getFreshRegistry: async () => ingress.fenceAndStatus(event.token),
          });
          if (cleanup.kind !== 'cleaned') {
            return { kind: 'retryable' as const, error: new Error(`ingress boot worker cleanup is ${cleanup.kind}`) };
          }
          ingressBootRecoveryGate.release(generation);
          clearOwnToken();
          return { kind: 'complete' as const };
        } catch (error) {
          if (generation !== undefined && !ingressBootRecoveryGate.isCurrent(generation)) clearOwnToken();
          return { kind: 'retryable' as const, error };
        }
      }).then((result) => result.kind === 'complete' ? 'complete' : result.kind === 'fatal' ? 'fatal' : 'retryable');
    };
    const mutationReadiness = (): boolean => {
      const controller = resources.ingressController;
      if (controller === null) return false;
      if (admissionRecovering) return false;
      if (!controller.isMutationReady()) return false;
      const snapshot = resources.repository!.getSnapshot();
      const operation = resources.repository!.getCurrentOperationState();
      return controller.isMutationReady({
        revision: snapshot.revision,
        content_hash: snapshot.content_hash,
        plugin_catalog_hash: catalog.hash,
        hasActiveOperation: resources.repository!.getActivePublication() !== null
          || operation?.operation.result_status === null,
      });
    };
    let runtimePublicationEligible = false;
    const runtimePublicationAbort = new AbortController();
    const revokeRuntimePublication = (): void => {
      runtimePublicationEligible = false;
      runtimePublicationAbort.abort('master runtime stopping');
    };
    const stopAcceptingRecovery = (): void => {
      runtimeStopping = true;
      ingressBootRecoveryGate.cancel();
      recoveryRunner?.stopAccepting();
      resources.ingressController?.stopRecovery?.();
      revokeRuntimePublication();
    };
    const catalogRecords = catalog.records?.() ?? [];
    const pluginCatalogApi = createMasterPluginCatalogApi({
      catalog: { records: () => catalogRecords },
    });
    const controlApi = createConfigControlApi({
      repository: resources.repository,
      admission: trackedAdmission,
      workerCount: options.workerCount,
      clock: dependencies.clock,
      resolveAuthToken: dependencies.resolveAuthToken,
      parseAggregate: (value) => parseNormalizeCompileAggregate(value, compileOptions),
      publicationTasks,
      pluginControlApi: resources.pluginControl?.api,
      pluginCatalogApi,
      pluginControlPreflight: resources.pluginControl === null ? undefined : {
        controlNames: new Set((catalog.records?.() ?? [])
          .filter(({ manifest }) => manifest.control !== undefined)
          .map(({ name }) => name)),
        status: (name) => resources.pluginControl!.status(name),
        activate: (name) => resources.pluginControl!.activate(name),
        deactivate: (name) => resources.pluginControl!.deactivate(name),
      },
      isMutationReady: mutationReadiness,
      requestManualRecovery: (recoveryId, sourceMutationId, expectedRevision) => {
        if (recoveryRunner === null) return Promise.reject(new Error('configuration recovery runner is unavailable'));
        return recoveryRunner.requestManualRecovery(recoveryId, sourceMutationId, expectedRevision);
      },
      isRecoveryReady: () => runtimeReady && !runtimeStopping && !publicationFatalReported
        && resources.ingressController?.isRecoveryReady() === true,
      runtimePublicationEvidence: () => {
        const trusted = resources.ingressController?.trustedActiveAdmissionIfFresh() ?? null;
        const tracked = trackedAdmission.snapshot();
        const target = resources.repository!.getSnapshot();
        if (trusted === null) return { serving_complete: false, serving_revision: null };
        const unmatched = [...tracked];
        const identitiesMatch = trusted.workers.every((remote) => {
          const index = unmatched.findIndex((worker) => worker.process.slot === remote.worker_slot
            && worker.process.identity.worker_slot === remote.worker_slot
            && worker.process.identity.master_generation === remote.master_generation
            && worker.process.identity.worker_instance_id === remote.worker_instance_id
            && worker.boot_nonce === remote.boot_nonce
            && worker.private_port === remote.private_port);
          if (index < 0) return false;
          unmatched.splice(index, 1);
          return true;
        }) && unmatched.length === 0;
        const evidenceMatches = identitiesMatch && tracked.every((worker) => worker.revision === trusted.revision
          && worker.content_hash === trusted.content_hash && worker.plugin_catalog_hash === trusted.plugin_catalog_hash);
        const servingRevision = evidenceMatches ? trusted.revision : null;
        return {
          serving_complete: evidenceMatches && trusted.revision === target.revision
            && trusted.content_hash === target.content_hash
            && trusted.plugin_catalog_hash === catalog.hash
            && isExactServingTarget(tracked, tracked, target, catalog.hash, options.workerCount, resources.workerFactory!),
          serving_revision: servingRevision,
        };
      },
      statsApi: resources.stats ?? undefined,
      onConfigurationCommitted: (snapshot) => {
        resources.stats?.configureLogging?.(snapshot.aggregate.logical_configuration.logging);
      },
      runtimeUpstreams: () => runtimeUpstreams({
        activeAdmission: () => resources.ingressController?.trustedActiveAdmissionIfFresh() ?? null,
        lookupExactSession: (identity) => resources.workerFactory?.lookupExactControlSession?.(identity) ?? null,
        now: dependencies.clock.now,
        stopSignal: runtimePublicationEligible ? runtimePublicationAbort.signal : AbortSignal.abort('runtime unavailable'),
      }),
    });
    const masterUIHandler = createMasterUIHandler({
      catalog: { get: (name) => catalogRecords.find((record) => record.name === name) },
      getRepositorySnapshot: () => resources.repository!.getSnapshot(),
    });
    let requestShutdown: () => Promise<void> = () => Promise.reject(new MasterRuntimeError(
      'invalid_state', 'master shutdown coordinator is unavailable',
    ));
    const daemonControl = daemonBootstrap === null ? undefined : createDaemonShutdownHandler({
      metadata: () => daemonMetadata!,
      isReady: () => handlerReady,
      onShutdownRequested: () => requestShutdown(),
      onShutdownError: (error) => logger.error({ error: serializeErrorChain(error) }, 'Daemon shutdown failed'),
    });
    resources.listener = dependencies.createManagementListener({
      hostname: options.managementHost,
      port: options.managementPort,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      controlApi,
      internalPluginControl: resources.pluginControlBridge ?? undefined,
      masterUIHandler,
      daemonControl,
    });
    const instanceLocks = [...resources.locks];
    const baseRuntime = dependencies.createRuntime({
      workerCount: options.workerCount,
      expectedPluginCatalogHash: catalog.hash,
            repository: resources.repository,
      coordinator,
      publicationTasks,
      admission: trackedAdmission,
      publicListener: resources.listener!,
      workerPool: resources.workerFactory,
      cleanupWorkersAfterStartupFailure: (disposition) => {
        if (resources.workerFactory === null) return;
        return cleanupWorkersAfterStartupFailure(resources.workerFactory, disposition);
      },
      stopAcceptingRecovery,
      alwaysClose: () => resources.stats?.close(),
      ingressBootRecoveryGate,
      onWorkerUnavailable: () => {
        admissionRecovering = true;
        syncPluginControlAdmission();
        if (!ingressBootRecoveryGate.isActive()) recoveryRunner?.wake();
      },
      startupServing: () => startupServing,
      canReconcileStartup: () => startupServing !== null,
      ancillary: {
        beforeCleanup: stopBackgroundTasks,
        async cleanupAfterStartupFailure() {
          if (resources.ingressController === null) {
            recordStartupFailureDisposition(NO_INGRESS_STARTUP_FAILURE_DISPOSITION);
            return NO_INGRESS_STARTUP_FAILURE_DISPOSITION;
          }
          const disposition = await resources.ingressController.cleanupAfterStartupFailure();
          recordStartupFailureDisposition(disposition);
          return disposition;
        },
        async closeForNormalShutdown() {
          const errors: unknown[] = [];
          try { if (resources.ingressController !== null) await resources.ingressController.shutdownDataPlane(); }
          catch (error) { errors.push(error); }
          if (errors.length > 0) throw new AggregateError(errors, 'master ancillary shutdown failed');
        },
      },
      allowReadOnlyRecovery: () => admissionRecovering && startupServing === null
        && resources.ingressController?.hasTrustedActiveAdmission() === true,
      pluginControlBridge: resources.pluginControlBridge ?? undefined,
      pluginControlSubscriptions: resources.pluginControlSubscriptions ?? undefined,
      pluginControl: resources.pluginControl ?? undefined,
      instanceLock: {
        async release() {
          const errors: unknown[] = [];
          for (const lock of [...instanceLocks].reverse()) {
            try { await lock.release(); } catch (error) { errors.push(error); }
          }
          if (errors.length > 0) throw new AggregateError(errors, 'master instance lock release failed');
        },
      },
    });
    runtimeLifecycle = {
      async start() { await baseRuntime.start(); },
      reportAsynchronousFailure(error) {
        stopAcceptingRecovery();
        baseRuntime.reportAsynchronousFailure(error);
        if (runtimeStarted) void publicShutdown().catch(() => undefined);
      },
      async shutdown() {
        stopAcceptingRecovery();
        resources.listener?.stopAccepting?.();
        const errors: unknown[] = [];
        const startupCleanup = daemonBootstrap === null ? !runtimeReady : !handlerReady && !diskPublished;
        if (startupCleanup && baseRuntime.shutdownAfterStartupFailure === undefined && resources.ingressController !== null) {
          try { await resources.ingressController.disconnect(); } catch (error) { errors.push(error); }
        }
        try {
          if (startupCleanup && baseRuntime.shutdownAfterStartupFailure !== undefined) {
            await baseRuntime.shutdownAfterStartupFailure();
          } else {
            await baseRuntime.shutdown();
          }
        } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, 'master shutdown failed');
      },
    };

    const armDaemon = async (): Promise<void> => {
      if (daemonBootstrap === null) return;
      if (shutdownRequested) throw new MasterRuntimeError('startup_cancelled', 'master shutdown started before daemon arming');
      if (supervisionState === null || supervisionState.instance_id.length === 0) {
        throw new MasterRuntimeError('startup_incomplete', 'authoritative daemon instance is unavailable');
      }
      const host = resources.listener?.hostname;
      const port = resources.listener?.port;
      if ((host !== '127.0.0.1' && host !== '::1') || port === null || port === undefined) {
        throw new MasterRuntimeError('listener_port_unavailable', 'management listener did not expose its bound address');
      }
      const armed: DaemonMetadataV1 = {
        ...daemonBootstrap.metadata,
        state: 'armed',
        pid: daemonBootstrap.pid,
        instance_id: supervisionState.instance_id,
        management_host: host,
        management_port: port,
      };
      daemonMetadata = armed;
      handlerReady = true;
      const transitionPromise = Promise.resolve().then(() => daemonBootstrap.store.transition(daemonBootstrap.metadataPath, {
        expectedBootNonce: daemonBootstrap.bootNonce,
        expectedState: 'starting',
        expectedShutdownSecret: daemonBootstrap.shutdownSecret,
        next: armed,
      }, daemonBootstrap.store.file)).then((confirmed) => {
        if (confirmed.state !== 'armed' || confirmed.pid !== armed.pid
          || confirmed.instance_id !== armed.instance_id || confirmed.management_host !== armed.management_host
          || confirmed.management_port !== armed.management_port) {
          throw new MasterRuntimeError('startup_incomplete', 'daemon armed transition could not be confirmed');
        }
      });
      daemonArmPromise = transitionPromise;
      try {
        await transitionPromise;
        diskPublished = true;
        if (shutdownRequested) throw new MasterRuntimeError('startup_cancelled', 'master shutdown started during daemon arming');
      } catch (error) {
        if (!(error instanceof MasterRuntimeError) || error.code !== 'startup_cancelled') {
          handlerReady = false;
          diskPublished = false;
          daemonMetadata = daemonBootstrap.metadata;
        }
        throw error;
      }
    };

    const markDaemonStopping = async (): Promise<void> => {
      if (daemonBootstrap === null || !diskPublished || daemonMetadata?.state !== 'armed') return;
      const armed = daemonMetadata as Extract<DaemonMetadataV1, { readonly state: 'armed' }>;
      const stopping: DaemonMetadataV1 = { ...armed, state: 'stopping' };
      daemonMetadata = stopping;
      const confirmed = await daemonBootstrap.store.transition(daemonBootstrap.metadataPath, {
        expectedBootNonce: daemonBootstrap.bootNonce,
        expectedState: 'armed',
        expectedShutdownSecret: daemonBootstrap.shutdownSecret,
        next: stopping,
      }, daemonBootstrap.store.file);
      if (confirmed.state !== 'stopping' || confirmed.pid !== stopping.pid
        || confirmed.instance_id !== stopping.instance_id || confirmed.management_host !== stopping.management_host
        || confirmed.management_port !== stopping.management_port) {
        throw new MasterRuntimeError('cleanup_failed', 'daemon stopping transition could not be confirmed');
      }
      daemonMetadata = confirmed;
    };

    const coordinateShutdown = (): Promise<void> => {
      if (shutdownCoordinatorPromise !== null) return shutdownCoordinatorPromise;
      let runtimeShutdown: Promise<void>;
      try {
        runtimeShutdown = runtimeLifecycle!.shutdown();
      } catch (error) {
        runtimeShutdown = Promise.reject(error);
      }
      shutdownRequested = true;
      const stopping = daemonBootstrap !== null && (handlerReady || diskPublished)
        ? (daemonArmPromise ?? Promise.resolve()).then(() => diskPublished ? markDaemonStopping() : undefined)
        : Promise.resolve();
      shutdownCoordinatorPromise = (async () => {
        const [runtimeResult, stoppingResult] = await Promise.allSettled([runtimeShutdown, stopping]);
        const errors: unknown[] = [];
        if (runtimeResult.status === 'rejected') errors.push(runtimeResult.reason);
        if (stoppingResult.status === 'rejected') {
          logger.error({ error: serializeErrorChain(stoppingResult.reason) }, 'Daemon stopping transition failed');
          errors.push(stoppingResult.reason);
        }
        if (errors.length > 0) throw new AggregateError(errors, 'master shutdown failed');
        if (daemonBootstrap !== null && diskPublished && daemonMetadata?.state === 'stopping') {
          try {
            const deleted = await daemonBootstrap.store.deleteForMaster(daemonBootstrap.metadataPath, {
              bootNonce: daemonBootstrap.bootNonce,
              shutdownSecret: daemonBootstrap.shutdownSecret,
              pid: daemonBootstrap.pid,
            }, daemonBootstrap.store.file);
            if (!deleted) throw new MasterRuntimeError('cleanup_failed', 'daemon metadata cleanup was not confirmed');
            daemonMetadata = null;
          } catch (error) {
            logger.error({ error: serializeErrorChain(error) }, 'Daemon metadata cleanup failed');
            throw error;
          }
        }
      })();
      return shutdownCoordinatorPromise;
    };
    let publicShutdown: () => Promise<void> = coordinateShutdown;
    runtime = {
      start: () => runtimeLifecycle!.start(),
      reportAsynchronousFailure: (error) => runtimeLifecycle!.reportAsynchronousFailure(error),
      shutdown: () => publicShutdown(),
    };
    requestShutdown = () => publicShutdown();

    await runtime.start();
    runtimeStarted = true;
    await recoveryRunner.start();
    if (startupRecoveryFailure !== null) throw startupRecoveryFailure;
    runtimePublicationEligible = true;
    resources.workerFactory.markCommitted(trackedAdmission.snapshot().map(({ process }) => process));
    syncPluginControlAdmission();
    runtimeReady = true;
    const signals = dependencies.installSignalHandlers({ shutdown: coordinateShutdown });
    publicShutdown = signals.shutdown;
    requestShutdown = signals.shutdown;
    await armDaemon();
    const baseHandle = {
      runtime,
      shutdown: signals.shutdown,
      removeSignalHandlers: signals.remove,
    };
    return resources.ingressController === null ? baseHandle : {
      ...baseHandle,
      dataPort: resources.ingressController.publicPort,
      managementPort: resources.listener?.port ?? null,
      ingressControlPort: resources.ingressController.controlPort,
    };
  } catch (error) {
    resources.ingressController?.stopRecovery?.();
    const cleanupErrors = runtime === null
      ? await cleanupConstruction(resources)
      : await runtime.shutdown().then(() => [], (cleanupError) => [cleanupError]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'master process startup failed');
    }
    throw error;
  }
}
