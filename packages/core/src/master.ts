import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import {
  MasterConfigPublicationCoordinator,
  WorkerAdmissionRegistry,
} from './config-publication';
import { AsyncConfigRepository } from './config-storage';
import { deriveWorkerTransportSecret } from './supervision';
import { processDynamicValue } from './expression-engine';
import { logger } from './logger';
import {
  startMasterComposition,
  type MasterProcessDependencies,
  type MasterProcessHandle,
} from './master-runtime/composition';
import { acquireMasterInstanceLock, mintControllerClaimCapability } from './master-runtime/instance-lock';
import { SupervisedConfigWorkerFactory } from './master-runtime/supervised-worker-factory';
import { readMasterProcessOptions, resolveWorkerLaunch, resolveStorageWorkerUrls } from './master-runtime/process-options';
import { MasterRuntime } from './master-runtime/runtime';
import { installMasterSignalHandlers } from './master-runtime/signal-handlers';
import { PluginManifestCatalog } from './plugin-manifest-catalog';
import { PluginPathResolver } from './plugin-path-resolver';
import { createManagementListener } from './management-listener';
import { MasterIngressController } from './ingress/master-controller';
import { createAsyncMasterStats, migrateAccessDatabaseAsync, resolveObservabilityWorkerUrl } from './master-runtime/observability-client';
import { takeOverDaemonBootstrap } from './daemon-control/bootstrap';
import { currentLaunchIdentity } from './daemon-control/launch-identity';
import { serializeErrorChain } from './master-runtime/error-chain';
import {ComponentRecovery} from './master-runtime/component-recovery';
import {holdCurrentProcessLifetimeGuard} from './supervision/process-lifetime-guard';
import { UpdateController } from './updates/controller';
import { assertUpdateStart } from './updates/installation';
import { replaceMaster } from './updates/restart';
import { CORE_HOST_VERSION } from './core-version';

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
  migrateAccessDatabase: path => migrateAccessDatabaseAsync(path, resolveObservabilityWorkerUrl(import.meta.url)),
  createMasterStats: path => createAsyncMasterStats(path, {workerUrl:resolveObservabilityWorkerUrl(import.meta.url)}),
  createPluginPathResolver: ({ moduleDirectory, cwd }) =>
    new PluginPathResolver(moduleDirectory, cwd),
  buildPluginCatalog: (resolver) => PluginManifestCatalog.build({ pathResolver: resolver }),
  resolveAuthToken,
  openRepository: (path, options) => AsyncConfigRepository.open(path, { ...options, workerUrl: resolveStorageWorkerUrls(import.meta.url).configuration }),
  createAdmission: () => new WorkerAdmissionRegistry(),
  deriveTransportSecret: deriveWorkerTransportSecret,
  resolveWorkerLaunch,
  createWorkerFactory: (options) => new SupervisedConfigWorkerFactory(options),
  createMasterGeneration: randomUUID,
  createCoordinator: (options) => new MasterConfigPublicationCoordinator(options),
  createManagementListener,
  createControllerClaim: mintControllerClaimCapability,
  createIngressController: (options) => new MasterIngressController(options),
  createRuntime: (options) => new MasterRuntime(options),
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
  const production = dependencies === PRODUCTION_DEPENDENCIES;
  if (production && process.env.BUNGEE_INSTALL_ROOT) assertUpdateStart(process.env.BUNGEE_INSTALL_ROOT, process.env.BUNGEE_UPDATE_TOKEN);
  const daemonBootstrap = await takeOverDaemonBootstrap({ marker: bootNonce,
    runtimeDirectory: production && process.env.BUNGEE_INSTALL_ROOT ? join(process.env.BUNGEE_INSTALL_ROOT, 'run') : undefined });
  if (dependencies === PRODUCTION_DEPENDENCIES) {
    const owner = process.argv.find(argument => argument.startsWith('--bungee-process-identity='))?.slice('--bungee-process-identity='.length) ?? randomUUID();
    const options = readMasterProcessOptions();
    const recovery = await ComponentRecovery.create(owner);
    const executorLifetimeGuard = process.platform === 'win32' ? null
      : holdCurrentProcessLifetimeGuard(resolve(options.configDbPath,'..','runtime','masters'),owner);
    dependencies = {...dependencies,runtimeRecovery:recovery,executorLifetimeGuard};
  }
  if (bootNonce !== null && dependencies.runtimeRecovery !== undefined) {
    const identity = currentLaunchIdentity();
    dependencies = {
      ...dependencies,
      context: { ...dependencies.context, entry: identity.entrypoint ?? process.execPath },
    };
  }
  if (!production) return startMasterComposition(dependencies, daemonBootstrap);
  let handle: MasterProcessHandle | undefined;
  const updates = new UpdateController({ version: CORE_HOST_VERSION, root: process.env.BUNGEE_INSTALL_ROOT,
    publicOrigin: process.env.BUNGEE_PUBLIC_ORIGIN ? new URL(process.env.BUNGEE_PUBLIC_ORIGIN).origin : undefined,
    compiled: resolveWorkerLaunch({ executable: process.execPath, entry: process.argv[1] ?? process.execPath }).source === 'compiled',
    restart: (activate, token, signal) => {
      if (!handle || !process.env.BUNGEE_INSTALL_ROOT) throw new Error('runtime_not_ready');
      return replaceMaster({ handle, bootstrap: daemonBootstrap, options: readMasterProcessOptions(),
        root: process.env.BUNGEE_INSTALL_ROOT, accessDbPath: accessLogDatabasePath(), activate, token, signal });
    } });
  const cancel = () => updates.cancel();
  process.prependListener('SIGTERM', cancel); process.prependListener('SIGINT', cancel);
  handle = await startMasterComposition({ ...dependencies, updates }, daemonBootstrap);
  await updates.completeStartup(process.env.BUNGEE_UPDATE_TOKEN, () => {
    const health = handle?.updateReadiness?.(); return health?.management === true && health.data === true;
  });
  delete process.env.BUNGEE_UPDATE_TOKEN;
  updates.startChecking();
  return handle;
}
