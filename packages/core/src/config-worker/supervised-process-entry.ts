import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { createConfigWorkerRuntimeController } from '../config-publication/worker-runtime';
import { PluginPathResolver } from '../plugin-path-resolver';
import { PluginManifestCatalog } from '../plugin-manifest-catalog';
import { createConfigWorkerLifecycle } from './lifecycle';
import { createCatalogSnapshotCompiler } from './snapshot-compiler';
import { readKernelBootId } from '../master-runtime/process-identity';
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
  const kernelBootId = await readKernelBootId();
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
    let exitCode = code;
    const cleanupErrors: unknown[] = [];
    try { pluginControl?.dispose(); } catch (error) { cleanupErrors.push(error); }
    try { rateLimit?.dispose(); } catch (error) { cleanupErrors.push(error); }
    setBoundControlClientProvider(null);
    setWorkerRateLimitClient(null);
    setWorkerRateLimitFailureObserver(null);
    try {
      await runtime.failClosed(async () => {
        try { await server?.stop(); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'worker resource or supervision cleanup failed');
      });
    } catch (error) {
      exitCode = exitCode === 0 ? 1 : exitCode;
      process.stderr.write(`${JSON.stringify({ event: 'worker_shutdown_failure', stage: 'shutdown_cleanup',
        error: error instanceof Error ? error.message.slice(0, 512) : 'unknown failure' })}\n`);
    }
    if (profile !== null && !profileWritten) {
      profileWritten = true;
      try { writeRateLimitProfileSummary('worker', profile, environment.identity.worker_slot); }
      catch { /* profiling is best effort and cannot alter exit evidence */ }
    }
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    resolveStopped();
    exitProcess(exitCode);
  };
  const onSigterm = () => { void shutdown(0).catch(() => undefined); };
  const onSigint = () => { void shutdown(0).catch(() => undefined); };
  const controller = createConfigWorkerRuntimeController({
    pid: process.pid,
    identity: environment.identity,
    bootNonce,
    bootId: kernelBootId,
    persistTerminalEvidence: async (message) => {
      if (server === null) throw new Error('worker supervision server is unavailable for terminal evidence persistence');
      await server.persistTerminalEvidence(message);
    },
    requestShutdown: () => { void shutdown(0); },
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
