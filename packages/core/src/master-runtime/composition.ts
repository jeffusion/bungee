import type { Sha256Digest, PluginConfigOptions } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
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
} from '../config-publication';
import { parseNormalizeCompileAggregate, type CommitConfigurationCommandV1,
  type ActiveConfigurationPublication,
  type CommitConfigurationResult, type ConfigurationOperationState,
  type ConfigRepositoryOptions } from '../config-storage';
import type { CatalogPathResolver } from '../plugin-manifest-catalog/catalog';
import type { AdmittedWorkerSelector, PublicListenerOptions } from '../public-listener';
import type { NodeConfigWorkerFactoryOptions } from './node-worker-factory';
import type {
  MasterProcessOptions,
  WorkerLaunch,
  WorkerLaunchInput,
} from './process-options';
import { exactExitProof } from './runtime-evidence';
import {
  MasterRuntimeError,
  type MasterRuntimeAdmission,
  type MasterRuntimeCoordinator,
  type MasterRuntimeInstanceLock,
  type MasterRuntimeOptions,
  type MasterRuntimePublicListener,
  type MasterRuntimeRepository,
  type MasterRuntimeWorkerPool,
} from './runtime-contracts';
import type { MasterSignalController, MasterSignalRuntime } from './signal-handlers';
import { createConfigControlApi } from './control-api';
import { serializeErrorChain } from './error-chain';
import { PublicationTaskManager } from './publication-task-manager';
import {
  createBoundControlRpcServer,
  createDatabaseSecretStoreFactory,
  createPluginControlHost,
  parsePluginSecretsKey,
  type PluginControlHost,
} from '../plugin-control';

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
  commit(command: CommitConfigurationCommandV1): CommitConfigurationResult;
  getOperationState(mutationId: string): ConfigurationOperationState | null;
  getCurrentOperationState(): ConfigurationOperationState | null;
  getDatabase?: () => Database;
};
export type MasterProcessAdmission = WorkerAdmissionController
  & MasterRuntimeAdmission
  & AdmittedWorkerSelector;
export type MasterProcessWorkerFactory = ConfigPublicationWorkerFactory & MasterRuntimeWorkerPool;

export interface MasterProcessRuntime extends MasterSignalRuntime {
  start(): Promise<void>;
}

export interface MasterProcessCoordinator extends MasterRuntimeCoordinator {
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
  generateTransportSecret(): string;
  resolveWorkerLaunch(input: WorkerLaunchInput): WorkerLaunch;
  createWorkerFactory(options: NodeConfigWorkerFactoryOptions): MasterProcessWorkerFactory;
  createMasterGeneration(): string;
  createCoordinator(options: MasterConfigPublicationCoordinatorOptions): MasterProcessCoordinator;
  createPublicListener(options: PublicListenerOptions): MasterRuntimePublicListener;
  createRuntime(options: MasterRuntimeOptions): MasterProcessRuntime;
  installSignalHandlers(runtime: MasterSignalRuntime): MasterSignalController;
}

export interface MasterProcessHandle {
  readonly runtime: MasterProcessRuntime;
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
};

function trustedBindingOptions(
  repository: MasterProcessRepository,
  runtimeSnapshot: ReturnType<MasterProcessRepository['getSnapshot']> | undefined,
  revision: number,
  endpointId: string,
  plugin: string,
  contributionId: string,
  bindingId: string,
): PluginConfigOptions | undefined {
  if (runtimeSnapshot === undefined || runtimeSnapshot.revision !== revision) return undefined;
  const current = repository.getSnapshot();
  if (!current.aggregate.plugin_activations.some(({ plugin_name }) => plugin_name === plugin)) return undefined;
  const endpoints = (snapshot: ReturnType<MasterProcessRepository['getSnapshot']>) => [
    ...snapshot.aggregate.logical_configuration.services.flatMap((service) => service.endpoints),
    ...snapshot.aggregate.logical_configuration.routes.flatMap((route) =>
      'endpoints' in route && route.endpoints !== undefined ? route.endpoints : []),
  ];
  const findBinding = (snapshot: ReturnType<MasterProcessRepository['getSnapshot']>) =>
    endpoints(snapshot).find((endpoint) => endpoint.id === endpointId
      && endpoint.is_disabled !== true
      && endpoint.managedBy?.plugin === plugin
      && endpoint.managedBy.contributionId === contributionId
      && endpoint.managedBy.bindingId === bindingId
      && endpoint.plugins.some((entry) => entry.name === plugin
        && entry.id === bindingId && entry.enabled === true));
  const authoritative = findBinding(current);
  if (authoritative === undefined) return undefined;
  const serving = findBinding(runtimeSnapshot);
  if (serving === undefined) return undefined;
  return serving.plugins.find((entry) => entry.name === plugin && entry.id === bindingId)?.options ?? {};
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
    { outcome: 'degraded', error_code: 'control_readiness_failed', error_detail: 'plugin control readiness failed' },
    now,
  );
  return {
    kind: 'degraded', http_status: 202, error_code: 'control_readiness_failed',
    failures: [], operation, serving,
  };
}

function currentControlReadinessFailure(value: ConfigurationOperationState | null): ConfigurationOperationState['operation'] | null {
  if (value === null) return null;
  const operation = value.operation;
  return operation.state === 'degraded' && operation.error_code === 'control_readiness_failed'
    ? operation : null;
}

async function cleanupConstruction(resources: ConstructionResources): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  const capture = async (operation: () => void | Promise<void>): Promise<void> => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  if (resources.listener !== null) await capture(() => resources.listener?.stop());
  if (resources.admission !== null) await capture(() => resources.admission?.clear());
  if (resources.pluginControl !== null) await capture(() => resources.pluginControl?.dispose());

  let exitsConfirmed = resources.workerFactory === null;
  if (resources.workerFactory !== null) {
    let expectedPids: readonly number[] | null = null;
    await capture(() => { expectedPids = resources.workerFactory?.pids() ?? null; });
    await capture(async () => {
      const results = await resources.workerFactory?.shutdownAll() ?? [];
      exitsConfirmed = expectedPids !== null && exactExitProof(expectedPids, results);
    });
  }
  if (resources.repository !== null) await capture(() => resources.repository?.close());
  if (exitsConfirmed) {
    for (const lock of [...resources.locks].reverse()) await capture(() => lock.release());
  }
  if (resources.locks.length > 0 && !exitsConfirmed) {
    errors.push(new MasterRuntimeError(
      'worker_exit_unconfirmed',
      'worker exits were not confirmed; instance lock retained',
    ));
  }
  return errors;
}

export async function startMasterComposition(
  dependencies: MasterProcessDependencies,
): Promise<MasterProcessHandle> {
  const resources: ConstructionResources = { locks: [], repository: null, admission: null, workerFactory: null, listener: null, pluginControl: null };
  let runtime: MasterProcessRuntime | null = null;
  try {
    const options = dependencies.readOptions();
    resources.locks.push(await dependencies.acquireInstanceLock(options.configDbLockPath));
    resources.locks.push(await dependencies.acquireInstanceLock(`${dependencies.context.accessLogDbPath}.lock`));
    await dependencies.migrateAccessDatabase(dependencies.context.accessLogDbPath);
    const resolver = dependencies.createPluginPathResolver({
      moduleDirectory: dependencies.context.moduleDirectory,
      cwd: dependencies.context.cwd,
    });
    const catalog = await dependencies.buildPluginCatalog(resolver);
    const compileOptions = catalog.toCompileOptions();
    resources.repository = dependencies.openRepository(options.configDbPath, {
      compileOptions,
    });
    const material = parsePluginSecretsKey(process.env.BUNGEE_PLUGIN_SECRETS_KEY);
    const database = resources.repository.getDatabase?.();
    const secretStores = database === undefined
      ? {
        create() { throw new Error('plugin control secret key is unavailable'); },
        revoke() {},
        clear() {},
      }
      : createDatabaseSecretStoreFactory(database, material);
    resources.pluginControl = createPluginControlHost({
      records: catalog.records?.() ?? [],
      secretStores,
    });
    resources.admission = dependencies.createAdmission();
    const transportSecret = dependencies.generateTransportSecret();
    const launch = dependencies.resolveWorkerLaunch({
      executable: dependencies.context.executable,
      entry: dependencies.context.entry,
    });
    const workerFactoryBase = {
      launch,
      cwd: dependencies.context.cwd,
      masterPid: dependencies.context.pid,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      transportSecret,
      accessLogDbPath: dependencies.context.accessLogDbPath,
    };
    const servingSnapshots = new Map<ConfigPublicationWorkerProcess, ReturnType<MasterProcessRepository['getSnapshot']>>();
    const admissionSnapshots = new Map<string, ReturnType<MasterProcessRepository['getSnapshot']>>();
    const disconnectHandlers = new Map<ConfigPublicationWorkerProcess, () => void>();
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
    const rememberSnapshot = (snapshot: ReturnType<MasterProcessRepository['getSnapshot']>): void => {
      admissionSnapshots.set(`${snapshot.revision}:${snapshot.content_hash}:${catalog.hash}`, snapshot);
    };
    const originalPrepare = resources.admission.prepare.bind(resources.admission);
    const trackedAdmission: MasterProcessAdmission = {
      prepare(workers) {
        const prepared = originalPrepare(workers);
        return {
          commit() {
            const previous = workers.map((worker) => [worker.process, servingSnapshots.get(worker.process)] as const);
            for (const worker of workers) {
              const snapshot = admissionSnapshots.get(evidenceKey(worker));
              if (snapshot !== undefined) trackServing([worker], snapshot);
            }
            try {
              prepared.commit();
            } catch (error) {
              for (const [process, snapshot] of previous) {
                if (snapshot === undefined) servingSnapshots.delete(process);
                else servingSnapshots.set(process, snapshot);
              }
              throw error;
            }
          },
        };
      },
      snapshot: resources.admission.snapshot.bind(resources.admission),
      clear: resources.admission.clear.bind(resources.admission),
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
    const onSpawn = (worker: Parameters<NonNullable<NodeConfigWorkerFactoryOptions['onSpawn']>>[0]): void => {
        if (resources.pluginControl === null) return;
        const server = createBoundControlRpcServer({
          host: resources.pluginControl,
          processIdentity: worker.identity,
          send: (message) => worker.send(message as never),
          isBindingCurrent: (identity, binding) => identity.master_generation === worker.identity.master_generation
            && identity.worker_instance_id === worker.identity.worker_instance_id
            && identity.worker_slot === worker.identity.worker_slot
            && resources.pluginControl?.status(binding.plugin) === 'ready'
            && trustedBindingOptions(resources.repository!, servingSnapshots.get(worker), identity.revision, identity.endpointId,
              binding.plugin, binding.contributionId, binding.bindingId) !== undefined,
          allowedMethods: (plugin) => catalog.records?.().find(({ name }) => name === plugin)
            ?.manifest.control?.rpc.map(({ name }) => name) ?? [],
          resolveBindingOptions: (identity, binding) => trustedBindingOptions(
            resources.repository!, servingSnapshots.get(worker), identity.revision, identity.endpointId,
            binding.plugin, binding.contributionId, binding.bindingId,
          ),
        });
        const unsubscribe = worker.subscribeMessage(server.accept);
        disconnectHandlers.set(worker, () => server.dispose());
        worker.subscribeExit(() => {
          server.dispose();
          servingSnapshots.delete(worker);
          unsubscribe();
          disconnectHandlers.delete(worker);
        });
    };
    const workerFactoryOptions: NodeConfigWorkerFactoryOptions = (catalog.records?.() ?? []).some(({ manifest }) => manifest.control !== undefined)
      ? { ...workerFactoryBase, onSpawn, onDisconnect: (worker) => disconnectHandlers.get(worker)?.() }
      : workerFactoryBase;
    resources.workerFactory = dependencies.createWorkerFactory(workerFactoryOptions);
    const baseCoordinator = dependencies.createCoordinator({
      repository: resources.repository,
      workerFactory: resources.workerFactory,
      workerCount: options.workerCount,
      clock: dependencies.clock,
      startupApplyTimeoutMs: options.startupApplyTimeoutMs,
      drainTimeoutMs: options.drainTimeoutMs,
      pluginCatalogHash: catalog.hash,
      admission: trackedAdmission,
      masterGeneration: dependencies.createMasterGeneration(),
    });
    const coordinator: MasterProcessCoordinator = {
      async recoverAndPublish() {
        let active: ActiveConfigurationPublication | null;
        try { active = resources.repository!.getActivePublication(); }
        catch { return baseCoordinator.recoverAndPublish(); }
        if (active === null) {
          const current = resources.repository!.getCurrentOperationState();
          const failed = currentControlReadinessFailure(current);
          if (failed !== null) {
            return {
              kind: 'degraded', http_status: 202, error_code: 'control_readiness_failed',
              failures: [], operation: failed, serving: [],
            };
          }
        }
        if (active !== null) {
          rememberSnapshot(active.snapshot);
          try {
            await resources.pluginControl?.reconcile(activeControlNames(active.snapshot, catalog));
          } catch (error) {
            return controlReadinessFailure(resources.repository!, active, [], error, dependencies.clock.now(), 'recover');
          }
        }
        const outcome = await baseCoordinator.recoverAndPublish();
        if (outcome !== null && active !== null) trackServing(outcome.serving, active.snapshot);
        pruneServing();
        return outcome;
      },
      async startCurrent(snapshot, existingWorkers) {
        rememberSnapshot(snapshot);
        await resources.pluginControl?.reconcile(activeControlNames(snapshot, catalog));
        const outcome = await baseCoordinator.startCurrent(snapshot, existingWorkers);
        trackServing(outcome.serving, snapshot);
        pruneServing();
        return outcome;
      },
      async publish(active, oldWorkers) {
        rememberSnapshot(active.snapshot);
        try {
          await resources.pluginControl?.reconcile(activeControlNames(active.snapshot, catalog));
        } catch (error) {
          return controlReadinessFailure(resources.repository!, active, oldWorkers, error, dependencies.clock.now(), 'publish');
        }
        const outcome = await baseCoordinator.publish(active, oldWorkers);
        trackServing(outcome.serving, active.snapshot);
        pruneServing();
        return outcome;
      },
    };
    const publicationTasks = new PublicationTaskManager({
      publish: (active, oldWorkers) => coordinator.publish(active, oldWorkers),
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
      pluginControlPreflight: resources.pluginControl === null ? undefined : {
        controlNames: new Set((catalog.records?.() ?? [])
          .filter(({ manifest }) => manifest.control !== undefined)
          .map(({ name }) => name)),
        status: (name) => resources.pluginControl!.status(name),
        activate: (name) => resources.pluginControl!.activate(name),
        deactivate: (name) => resources.pluginControl!.deactivate(name),
      },
    });
    resources.listener = dependencies.createPublicListener({
      admission: trackedAdmission,
      transportSecret,
      hostname: options.host,
      port: options.port,
      controlApi,
    });
    const instanceLocks = [...resources.locks];
    runtime = dependencies.createRuntime({
      workerCount: options.workerCount,
      repository: resources.repository,
      coordinator,
      publicationTasks,
      admission: trackedAdmission,
      publicListener: resources.listener,
      workerPool: resources.workerFactory,
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
    await runtime.start();
    const signals = dependencies.installSignalHandlers(runtime);
    return {
      runtime,
      shutdown: signals.shutdown,
      removeSignalHandlers: signals.remove,
    };
  } catch (error) {
    const cleanupErrors = runtime === null
      ? await cleanupConstruction(resources)
      : await runtime.shutdown().then(() => [], (cleanupError) => [cleanupError]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'master process startup failed');
    }
    throw error;
  }
}
