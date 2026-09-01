import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  MasterConfigPublicationCoordinator,
  WorkerAdmissionRegistry,
} from './config-publication';
import { ConfigRepository } from './config-storage';
import { generateWorkerTransportSecret } from './config-worker/private-transport';
import { processDynamicValue } from './expression-engine';
import { logger } from './logger';
import { MigrationManager } from './migrations';
import {
  startMasterComposition,
  type MasterProcessDependencies,
  type MasterProcessHandle,
} from './master-runtime/composition';
import { acquireMasterInstanceLock } from './master-runtime/instance-lock';
import { NodeConfigWorkerFactory } from './master-runtime/node-worker-factory';
import { readMasterProcessOptions, resolveWorkerLaunch } from './master-runtime/process-options';
import { MasterRuntime } from './master-runtime/runtime';
import { installMasterSignalHandlers } from './master-runtime/signal-handlers';
import { PluginManifestCatalog } from './plugin-manifest-catalog';
import { PluginPathResolver } from './plugin-path-resolver';
import { createPublicListener } from './public-listener';

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
  createPluginPathResolver: ({ moduleDirectory, cwd }) =>
    new PluginPathResolver(moduleDirectory, cwd),
  buildPluginCatalog: (resolver) => PluginManifestCatalog.build({ pathResolver: resolver }),
  resolveAuthToken,
  openRepository: ConfigRepository.open,
  createAdmission: () => new WorkerAdmissionRegistry(),
  generateTransportSecret: generateWorkerTransportSecret,
  resolveWorkerLaunch,
  createWorkerFactory: (options) => new NodeConfigWorkerFactory(options),
  createMasterGeneration: randomUUID,
  createCoordinator: (options) => new MasterConfigPublicationCoordinator(options),
  createPublicListener,
  createRuntime: (options) => new MasterRuntime({
    ...options,
    onFatal(error) {
      process.exitCode = 1;
      logger.error({ error }, 'Master runtime failed');
    },
  }),
  installSignalHandlers: (runtime) => installMasterSignalHandlers({
    runtime,
    onError(error) {
      logger.error({ error }, 'Master shutdown failed');
      process.exitCode = 1;
    },
  }),
};

export async function startMasterProcess(
  dependencies: MasterProcessDependencies = PRODUCTION_DEPENDENCIES,
): Promise<MasterProcessHandle> {
  return startMasterComposition(dependencies);
}
