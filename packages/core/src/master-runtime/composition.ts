import type { Sha256Digest } from '@jeffusion/bungee-types';
import type {
  ConfigPublicationRepository,
  ConfigPublicationWorkerFactory,
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
import { PublicationTaskManager } from './publication-task-manager';

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
}

export type MasterProcessRepository = ConfigPublicationRepository & MasterRuntimeRepository & {
  commit(command: CommitConfigurationCommandV1): CommitConfigurationResult;
  getOperationState(mutationId: string): ConfigurationOperationState | null;
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
};

async function cleanupConstruction(resources: ConstructionResources): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  const capture = async (operation: () => void | Promise<void>): Promise<void> => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  if (resources.listener !== null) await capture(() => resources.listener?.stop());
  if (resources.admission !== null) await capture(() => resources.admission?.clear());

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
  const resources: ConstructionResources = { locks: [], repository: null, admission: null, workerFactory: null, listener: null };
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
    resources.admission = dependencies.createAdmission();
    const transportSecret = dependencies.generateTransportSecret();
    const launch = dependencies.resolveWorkerLaunch({
      executable: dependencies.context.executable,
      entry: dependencies.context.entry,
    });
    resources.workerFactory = dependencies.createWorkerFactory({
      launch,
      masterPid: dependencies.context.pid,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      transportSecret,
      accessLogDbPath: dependencies.context.accessLogDbPath,
    });
    const coordinator = dependencies.createCoordinator({
      repository: resources.repository,
      workerFactory: resources.workerFactory,
      workerCount: options.workerCount,
      clock: dependencies.clock,
      startupApplyTimeoutMs: options.startupApplyTimeoutMs,
      drainTimeoutMs: options.drainTimeoutMs,
      pluginCatalogHash: catalog.hash,
      admission: resources.admission,
      masterGeneration: dependencies.createMasterGeneration(),
    });
    const publicationTasks = new PublicationTaskManager({
      publish: (active, oldWorkers) => coordinator.publish(active, oldWorkers),
    });
    const controlApi = createConfigControlApi({
      repository: resources.repository,
      admission: resources.admission,
      workerCount: options.workerCount,
      clock: dependencies.clock,
      resolveAuthToken: dependencies.resolveAuthToken,
      parseAggregate: (value) => parseNormalizeCompileAggregate(value, compileOptions),
      publicationTasks,
    });
    resources.listener = dependencies.createPublicListener({
      admission: resources.admission,
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
      admission: resources.admission,
      publicListener: resources.listener,
      workerPool: resources.workerFactory,
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
