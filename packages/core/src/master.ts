import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  MasterConfigPublicationCoordinator,
  WorkerAdmissionRegistry,
} from './config-publication';
import { ConfigRepository } from './config-storage';
import { deriveWorkerTransportSecret } from './supervision';
import { processDynamicValue } from './expression-engine';
import { logger } from './logger';
import { MigrationManager } from './migrations';
import {
  startMasterComposition,
  type MasterProcessDependencies,
  type MasterProcessHandle,
} from './master-runtime/composition';
import { acquireMasterInstanceLock, mintControllerClaimCapability } from './master-runtime/instance-lock';
import { SupervisedConfigWorkerFactory } from './master-runtime/supervised-worker-factory';
import { readMasterProcessOptions, resolveWorkerLaunch } from './master-runtime/process-options';
import { MasterRuntime } from './master-runtime/runtime';
import { installMasterSignalHandlers } from './master-runtime/signal-handlers';
import { PluginManifestCatalog } from './plugin-manifest-catalog';
import { PluginPathResolver } from './plugin-path-resolver';
import { createManagementListener } from './management-listener';
import { MasterIngressController } from './ingress/master-controller';
import { createMasterStats } from './master-runtime/master-stats';
import { initializeAccessDatabaseForMaster } from './access-database';
import { takeOverDaemonBootstrap } from './daemon-control/bootstrap';
import { currentLaunchIdentity } from './daemon-control/launch-identity';
import { serializeErrorChain } from './master-runtime/error-chain';

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function resolveAuthToken(token: string): unknown {
  return processDynamicValue(token, {
    headers: {},
    body: {},
    url: { pathname: '', search: '', host: '', protocol: '' },
    method: '',
    env: environment(),
  });
}

function accessLogDatabasePath(): string {
  const value = process.env.BUNGEE_ACCESS_DB_PATH ?? 'logs/access.db';
  if (value.length === 0 || value.trim() !== value) {
    throw new Error('BUNGEE_ACCESS_DB_PATH must be a non-empty unpadded path');
  }
  return resolve(process.cwd(), value);
}

async function migrateAccessDatabase(path: string): Promise<void> {
  const settings = initializeAccessDatabaseForMaster(path);
  logger.info({ version: settings.version, mode: settings.journalMode, synchronous: settings.synchronous },
    'Access database SQLite contract selected');
  const result = await new MigrationManager(path).migrate();
  if (!result.success) {
    throw new Error(`access database migration failed: ${result.error ?? result.userMessage ?? 'unknown error'}`);
  }
}

const PRODUCTION_DEPENDENCIES: MasterProcessDependencies = {
  context: {
    cwd: process.cwd(),
    moduleDirectory: import.meta.dir,
    executable: process.execPath,
    entry: process.argv[1] ?? process.execPath,
    pid: process.pid,
    accessLogDbPath: accessLogDatabasePath(),
  },
  clock: { now: Date.now },
  readOptions: readMasterProcessOptions,
  acquireInstanceLock: acquireMasterInstanceLock,
  migrateAccessDatabase,
  createMasterStats,
  createPluginPathResolver: ({ moduleDirectory, cwd }) =>
    new PluginPathResolver(moduleDirectory, cwd),
  buildPluginCatalog: (resolver) => PluginManifestCatalog.build({ pathResolver: resolver }),
  resolveAuthToken,
  openRepository: ConfigRepository.open,
  createAdmission: () => new WorkerAdmissionRegistry(),
  deriveTransportSecret: deriveWorkerTransportSecret,
  resolveWorkerLaunch,
  createWorkerFactory: (options) => new SupervisedConfigWorkerFactory(options),
  createMasterGeneration: randomUUID,
  createCoordinator: (options) => new MasterConfigPublicationCoordinator(options),
  createManagementListener,
  createControllerClaim: mintControllerClaimCapability,
  createIngressController: (options) => new MasterIngressController(options),
  createRuntime: (options) => new MasterRuntime({
    ...options,
    onFatal(error) {
      process.exitCode = 1;
      logger.error({ error: serializeErrorChain(error) }, 'Master runtime failed');
    },
  }),
  installSignalHandlers: (runtime) => installMasterSignalHandlers({
    runtime,
    onError(error) {
      logger.error({ error: serializeErrorChain(error) }, 'Master shutdown failed');
      process.exitCode = 1;
    },
  }),
};

export async function startMasterProcess(
  dependencies: MasterProcessDependencies = PRODUCTION_DEPENDENCIES,
  bootNonce: string | null = null,
): Promise<MasterProcessHandle> {
  if (dependencies === PRODUCTION_DEPENDENCIES && bootNonce !== null) {
    const identity = currentLaunchIdentity();
    dependencies = {
      ...dependencies,
      context: { ...dependencies.context, entry: identity.entrypoint ?? process.execPath },
    };
  }
  const daemonBootstrap = await takeOverDaemonBootstrap({ marker: bootNonce });
  return startMasterComposition(dependencies, daemonBootstrap);
}
