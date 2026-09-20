import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { createConfigWorkerRuntimeController } from '../config-publication/worker-runtime';
import { PluginPathResolver } from '../plugin-path-resolver';
import { PluginManifestCatalog } from '../plugin-manifest-catalog';
import { createConfigWorkerLifecycle } from './lifecycle';
import { createCatalogSnapshotCompiler } from './snapshot-compiler';
import {
  parseSupervisedWorkerEnvironment,
  type SupervisedWorkerEnvironment,
} from './process-environment';
import {
  setBoundControlClientProvider,
} from './runtime-dependencies';
import { createWorkerPluginControlHttpProvider, type WorkerPluginControlHttpProvider } from './http-provider';
import {
  createWorkerRateLimitHttpProvider,
  setWorkerRateLimitClient,
  setWorkerRateLimitFailureObserver,
  type WorkerRateLimitHttpProvider,
} from './rate-limit-provider';
import {
  deriveWorkerSupervisionCredential,
  createWorkerRuntimeSnapshotFromState,
  WorkerSupervisionHttpServer,
} from '../supervision';
import {
  createRateLimitProfileCollector,
  rateLimitProfileEnabled,
  writeRateLimitProfileSummary,
} from '../rate-limit';

export type SupervisedWorkerProcessDependencies = {
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly loadCatalog?: () => Promise<PluginManifestCatalog>;
  readonly exitProcess?: (code: number) => void;
};

export async function runSupervisedWorkerProcess(
  dependencies: SupervisedWorkerProcessDependencies = {},
): Promise<void> {
  const environment: SupervisedWorkerEnvironment = parseSupervisedWorkerEnvironment(dependencies.env ?? process.env);
  const exitProcess = dependencies.exitProcess ?? ((code: number) => {
    process.exitCode = code;
    process.exit(code);
  });
  const bootNonce = randomUUID();
  const credential = deriveWorkerSupervisionCredential(environment.supervisionSeed, bootNonce);
  const pathResolver = new PluginPathResolver(resolveConfigWorkerCoreBaseDir(import.meta.dir), process.cwd());
  const loadCatalog = dependencies.loadCatalog ?? (() => PluginManifestCatalog.build({ pathResolver }));

  let server: WorkerSupervisionHttpServer | null = null;
  let pluginControl: WorkerPluginControlHttpProvider | null = null;
  let rateLimit: WorkerRateLimitHttpProvider | null = null;
  const profile = rateLimitProfileEnabled(dependencies.env ?? process.env) ? createRateLimitProfileCollector() : null;
  setWorkerRateLimitFailureObserver(profile?.observer ?? null);
  let profileWritten = false;
  let shuttingDown = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolvePromise) => { resolveStopped = resolvePromise; });
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { pluginControl?.dispose(); } catch { /* control cleanup is best effort */ }
    try { rateLimit?.dispose(); } catch { /* rate-limit cleanup is best effort */ }
    setBoundControlClientProvider(null);
    setWorkerRateLimitClient(null);
    setWorkerRateLimitFailureObserver(null);
    try { await runtime.failClosed(); } catch { /* preserve graceful shutdown */ }
    try { await server?.stop(); } catch { /* descriptor/control cleanup is best effort */ }
    if (profile !== null && !profileWritten) {
      profileWritten = true;
      writeRateLimitProfileSummary('worker', profile, environment.identity.worker_slot);
    }
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    resolveStopped();
    exitProcess(code);
  };
  const onSigterm = () => { void shutdown(0).catch(() => undefined); };
  const onSigint = () => { void shutdown(0).catch(() => undefined); };
  const controller = createConfigWorkerRuntimeController({
    pid: process.pid,
    identity: environment.identity,
    bootNonce,
    lifecycle: createConfigWorkerLifecycle({ transportSecret: environment.transportSecret }),
    compileSnapshot: createCatalogSnapshotCompiler(loadCatalog),
  });
  // The callback closes over the controller and is only invoked after construction.
  const runtime = controller;
  server = new WorkerSupervisionHttpServer({
    credential,
    identity: environment.identity,
    runtime,
    controlPort: environment.controlPort,
    masterControlPort: environment.masterControlPort,
    descriptorPath: environment.descriptorPath,
    attachGraceMs: environment.attachGraceMs,
    startupWatchdogMs: environment.startupWatchdogMs,
    onStartupTimeout: () => shutdown(1),
    onShutdown: () => shutdown(0),
    runtimeSnapshotProvider: createWorkerRuntimeSnapshotFromState,
  });
  pluginControl = createWorkerPluginControlHttpProvider({
    supervision: credential,
    worker: { ...environment.identity, boot_nonce: bootNonce },
    masterControlPort: environment.masterControlPort,
    authoritySource: server,
  });
  setBoundControlClientProvider(pluginControl.provider);
  if (environment.rateLimitSession !== undefined) {
    rateLimit = createWorkerRateLimitHttpProvider({
      transportSecret: environment.transportSecret,
      worker: {
        role: 'worker',
        process_instance_id: environment.identity.worker_instance_id,
        boot_nonce: bootNonce,
        master_generation: environment.identity.master_generation,
        worker_slot: environment.identity.worker_slot,
      },
      expectedIngress: { role: 'ingress', ...environment.rateLimitSession.expectedIngress },
      supervisionPort: environment.rateLimitSession.supervisionPort,
      observer: profile?.observer,
    });
    setWorkerRateLimitClient(rateLimit);
  }
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  try {
    await server.listen();
    await stopped;
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}

function resolveConfigWorkerCoreBaseDir(moduleDirectory: string): string {
  return basename(moduleDirectory) === 'config-worker' ? resolve(moduleDirectory, '..') : moduleDirectory;
}
