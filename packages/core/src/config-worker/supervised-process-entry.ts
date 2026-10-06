import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { createConfigWorkerRuntimeController } from '../config-publication/worker-runtime';
import { PluginPathResolver } from '../plugin-path-resolver';
import { PluginManifestCatalog } from '../plugin-manifest-catalog';
import { PluginServiceHost } from '../plugin-services';
import { WorkerPeerBroker, pluginPeerLifecycleIdentity } from '../plugin-services/peer-broker';
import { HostChannelAdapter } from '../plugin-services/channels';
import { createConfigWorkerLifecycle } from './lifecycle';
import { createCatalogSnapshotCompiler } from './snapshot-compiler';
import { readKernelDeadlineClockId } from '../master-runtime/kernel-monotonic-clock';
import {
  parseSupervisedWorkerEnvironment,
  type SupervisedWorkerEnvironment,
} from './process-environment';
import {
  setBoundControlClientProvider,
} from './runtime-dependencies';
import { createWorkerPluginControlPeerProvider } from './http-provider';
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
  readonly kernelBootId?: () => Promise<string>;
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
  const kernelBootId = await (dependencies.kernelBootId ?? readKernelDeadlineClockId)();
  const credential = deriveWorkerSupervisionCredential(environment.supervisionSeed, bootNonce);
  const pathResolver = new PluginPathResolver(resolveConfigWorkerCoreBaseDir(import.meta.dir), process.cwd());
  const loadCatalog = dependencies.loadCatalog ?? (() => PluginManifestCatalog.build({ pathResolver }));

  let server: WorkerSupervisionHttpServer | null = null;
  let pluginControl: ReturnType<typeof createWorkerPluginControlPeerProvider> | null = null;
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
    try { peerBroker.dispose(); } catch (error) { cleanupErrors.push(error); }
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
  /**
   * Canonical worker-process service host plus the authenticated peer link to
   * the control process. Both exist before any plugin runs; the broker connects
   * as soon as the supervision lease publishes the current controller
   * authority, so a bootstrap consumption during plugin initialization already
   * has a real route. The applied catalog hash is pinned from the start command.
   */
  let appliedCatalogHash: string | null = null;
  /** Plugins activated by the applied start command; the control peer's real caller set. */
  let appliedActivatedPlugins: readonly string[] = Object.freeze([]);
  const peerFacts = (): { process: 'worker'; instance: string; generation: number; catalog: string } | null => {
    if (appliedCatalogHash === null) return null;
    const authority = server?.currentControllerAuthorityIfLeased() ?? null;
    return Object.freeze({
      process: 'worker' as const,
      instance: environment.identity.worker_instance_id,
      generation: Math.max(1, authority?.controller_epoch ?? 1),
      catalog: appliedCatalogHash,
    });
  };
  // The broker and the canonical host reference each other: the host routes
  // through the broker's placement directory, while the broker registers its
  // native proxies on the host's canonical adapter. The lazy view below keeps
  // exactly one host instance and defers the adapter read past construction.
  const serviceHostRef: { current: PluginServiceHost | null } = { current: null };
  const brokerServices = Object.freeze({
    get rpc() { return serviceHostRef.current!.rpc!; },
    serviceDeclarations: () => serviceHostRef.current?.serviceDeclarations() ?? new Map(),
  });
  const peerBroker = new WorkerPeerBroker({
    services: brokerServices,
    credential,
    masterGeneration: environment.identity.master_generation,
    workerInstanceId: environment.identity.worker_instance_id,
    bootNonce,
    workerSlot: environment.identity.worker_slot,
    masterControlPort: () => environment.masterControlPort,
    catalog: () => appliedCatalogHash,
    authority: () => server?.currentControllerAuthorityIfLeased() ?? null,
    subscribeAuthority: (listener) => server?.subscribeControllerAuthority(() => listener()) ?? (() => undefined),
    activatedPlugins: () => appliedActivatedPlugins,
  });
  const channels = new HostChannelAdapter({
    hub: peerBroker.channels,
    process: 'worker',
    remoteTransport: () => peerBroker.status.attached,
  });
  // A worker has no durable state/log backend in this scope, so reliable event
  // PROVIDERS are refused with capability_unavailable during plugin startup while
  // reliable CONSUMPTION stays available; the capability is advertised explicitly.
  // A peer-originated lane task keeps the caller host's purpose/deadline/signal
  // and is marked authenticated: the worker link already authenticated the peer.
  peerBroker.setChannelProviderLease((plugin, context) =>
    services.beginChannelOperation(plugin, 'global', { ...context, authenticated: true })?.release ?? null);
  const services: PluginServiceHost = new PluginServiceHost('worker', {
    identity: (plugin, scope) => {
      const facts = peerFacts();
      // Contexts only exist after the start command pinned the exact target, so a
      // missing identity is a real ordering fault and must never be papered over
      // with a placeholder binding the control peer could not match.
      if (facts === null) throw new Error('worker peer identity is not ready');
      return pluginPeerLifecycleIdentity(facts, plugin, scope);
    },
    resolvePlacement: (request) => peerBroker.placementResolver(request),
    // Worker-side durable commands are NOT wired to a real worker durable-state
    // backend in this scope, so they are refused explicitly
    // (`capability_unavailable`) instead of being served from an invented
    // private table. Wiring them needs the real worker durable store hooks.
    resolveJournal: () => null,
    resolveCallee: (): unknown => services.currentInvocation()?.callee ?? null,
    ensureRemoteRoute: peerBroker.ensureRemoteRoute,
    // Channel lanes share the same authenticated worker link; a worker provides no
    // durable reliable-event log in this scope, so reliable provider topics are
    // refused explicitly while reliable consumption stays available.
    channels: (input) => channels.createOwner(input),
  });
  serviceHostRef.current = services;

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
    lifecycle: createConfigWorkerLifecycle({
      transportSecret: environment.transportSecret,
      services,
      onStartTarget: (command) => {
        appliedCatalogHash = command.plugin_catalog_hash;
        appliedActivatedPlugins = Object.freeze([...command.activated_plugin_names]);
        peerBroker.start();
        peerBroker.refresh();
      },
      // Real startup gate: the authenticated peer transport must be attached AND
      // control's real publication directory must actually be loaded before any
      // plugin initializes; bounded and cancelable, never a scan delay and never
      // a socket that merely opened.
      awaitPeerReady: async (signal) => {
        try { await peerBroker.waitUntilDirectoryLoaded({ signal, timeoutMs: 5_000 }); }
        catch (error) {
          // Fixed Host-owned state only: no credential, payload or plugin error
          // message. A logging failure must never replace the original error.
          try { process.stderr.write(`${JSON.stringify({ event: 'plugin_peer_bootstrap_failed', peer: peerBroker.status, masterControlPort: environment.masterControlPort, catalogKnown: appliedCatalogHash !== null })}\n`); }
          catch { /* diagnostics are best-effort */ }
          throw error;
        }
      },
      // The same gate inside the registry itself: after the dependency graph is
      // updated and before the first plugin handler is created, so a hot apply
      // outside the start command is covered too.
      beforeBootstrap: (signal) => peerBroker.waitUntilDirectoryLoaded({ signal, timeoutMs: 5_000 }),
      // Real drain admission point: retire peer admission and host owners
      // synchronously before the HTTP drain window opens.
      onDrainStart: () => {
        peerBroker.retire();
        services.retireAll();
      },
    }),
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
  // Connect as soon as the supervision lease publishes the current authority,
  // so a bootstrap consumption during plugin initialization already has a route.
  peerBroker.start();
  pluginControl = createWorkerPluginControlPeerProvider(async signal => {
    peerBroker.refresh();
    // Draining calls already own the original request lease; bootstrap waits
    // reject retired owners and must not replace that retained authorization.
    if (!peerBroker.status.retired) await peerBroker.waitUntilDirectoryLoaded({ signal, timeoutMs: 5_000 });
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
