import { readHostRpcCalleeFrame } from '../plugin-services/host-rpc';
import type { PluginDurableState } from '../plugin-durable-state';
import type { ManagementSubject, PluginPolicyPublication, DataPrincipal } from '../plugin-extensions';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import type { PluginStorage } from '../plugin.types';
import { PluginDependencyGraph } from '../plugin-dependencies';
import { PluginServiceCleanupError, PluginServiceHost, type PluginServices } from '../plugin-services';
import { loadImmutableControlArtifact } from './artifact-loader';
import type { SecretKeyMaterial } from './secret-store';
import type {
  BoundAttemptContext,
  ControlApiHandlerContext,
  ControlBindingIdentity,
  ControlHostContext,
  ControlPlugin,
  ControlRpcContext,
  PluginControl,
  SecretStore,
} from './contracts';

const CONTROL_START_TIMEOUT_MS = 15_000;

export type SecretStoreFactory = {
  create(namespace: string): SecretStore;
  revoke(store: SecretStore): void;
  clear(store: SecretStore): void | Promise<void>;
};

export type PluginStorageFactory = {
  create(pluginName: string): PluginStorage;
  revoke(storage: PluginStorage): void;
};

export type ControlHostErrorCode =
  | 'not_declared' | 'inactive' | 'restart_required' | 'start_failed' | 'method_not_allowed'
  | 'key_unavailable' | 'deadline' | 'invalid_binding' | 'disposed' | 'overloaded' | 'timeout';

export class PluginControlHostError extends Error {
  readonly name = 'PluginControlHostError';
  constructor(readonly code: ControlHostErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export type PluginControlStatus = 'inactive' | 'starting' | 'ready' | 'degraded' | 'stopping';

export type PluginControlHandle = {
  readonly pluginName: string;
  readonly artifactIdentity: string;
  readonly control: PluginControl;
  readonly secretStore: SecretStore;
  readonly storage: PluginStorage;
  readonly durableState?: PluginDurableState;
  /** Captured same-process service facade reused by createControl, API, and bound RPC. */
  readonly services: PluginServices;
  readonly lifetime: AbortController;
  status: PluginControlStatus;
  admission: boolean;
};

export type PluginControlHostOptions = {
  readonly records: readonly PluginManifestRecord[];
  /** Catalog-validated dependency graph; defaults to one built from the supplied records. */
  readonly dependencies?: PluginDependencyGraph;
  /** Shared control-process service host; defaults to a local one. */
  readonly services?: PluginServiceHost;
  readonly managementOrigin?: string;
  readonly trustedSource?: (request: Request) => string;
  readonly secretStores: SecretStoreFactory;
  readonly storage: Pick<PluginStorageFactory, 'create'> & Partial<Pick<PluginStorageFactory, 'revoke'>>;
  readonly durableState?: (name: string) => PluginDurableState;
  readonly validateRouteReferences?: (name: string, routeIds: readonly string[]) => boolean | Promise<boolean>;
  readonly readResourceExtensions?: (keyId: string) => Promise<unknown>;
  readonly validateKeyPolicyReferences?: (name: string, keyId: string, policy: unknown) => boolean | Promise<boolean>;
  readonly publishPolicy?: (name: string, policy: PluginPolicyPublication) => Promise<void>;
  readonly runAdmissionOperation?: (name: string, method: string, payload: unknown, callee: unknown, task: (target: import('../plugin-extensions').AdmissionTarget) => unknown | Promise<unknown>) => Promise<unknown>;
  readonly startTimeoutMs?: number;
  readonly loadControl?: (record: PluginManifestRecord) => Promise<ControlPlugin>;
};

export type PluginControlApi = {
  handle(request: Request, subject?: ManagementSubject): Promise<Response | null>;
};

export type BoundControlInvocation = {
  readonly pluginName: string;
  readonly binding: ControlBindingIdentity;
  readonly attempt: BoundAttemptContext;
};

type LoadedModule = ControlPlugin;

/**
 * Host-minted invocation frame for one control API / bound-attempt slot. The
 * purpose and callee are trusted host decisions, never read from plugin input.
 */
type TrustedControlInvocation = {
  readonly purpose: 'management' | 'attempt';
  /** Builds the opaque callee frame from the real per-slot invocation signal. */
  readonly callee?: (signal: AbortSignal) => unknown;
};

type PendingActivation = {
  readonly name: string;
  readonly lifetime: AbortController;
  readonly secretStore: SecretStore;
  readonly storage: PluginStorage;
  readonly services: PluginServices;
  cancelled: boolean;
  revoked: boolean;
};

function artifactIdentity(record: PluginManifestRecord): string {
  // The catalog hash is the identity used by the worker publication contract. It
  // deliberately does not use a mutable path as an import key.
  return `${record.name}:${record.manifest.version}:${record.runtimeHash}`;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: ControlHostErrorCode): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (operation: () => void, clearTimer: boolean): void => {
      if (settled) return;
      if (clearTimer) clearTimeout(timer);
      settled = true;
      operation();
    };
    timer = setTimeout(() => settle(() => reject(new PluginControlHostError(code, 'control operation timed out')), false), timeoutMs);
    promise.then(
      (value) => settle(() => resolve(value), true),
      (error) => settle(() => reject(error), true),
    );
  });
}

function pathForPlugin(request: Request): { name: string; path: string } | null {
  const pathname = new URL(request.url).pathname;
  const match = /^\/api\/plugins\/([^/]+)\/control(\/.*)?$/.exec(pathname);
  if (match === null) return null;
  try { return { name: decodeURIComponent(match[1]!), path: match[2] ?? '/' }; }
  catch { return null; }
}

function samePath(declared: string, actual: string): boolean {
  const normalized = declared.length > 1 ? declared.replace(/\/+$/, '') : declared;
  const pattern = normalized.split('/').map(segment => segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
  return new RegExp('^' + pattern + '$').test(actual) || (normalized === '/' && actual === '');
}

function methodAllowed(methods: readonly string[], method: string): boolean {
  return methods.includes(method.toUpperCase());
}

export function parsePluginSecretsKey(value: string | undefined): SecretKeyMaterial | undefined {
  if (value === undefined || value.length === 0) return undefined;
  let key: Uint8Array;
  try { key = Uint8Array.from(Buffer.from(value, 'base64')); }
  catch { throw new PluginControlHostError('key_unavailable', 'BUNGEE_PLUGIN_SECRETS_KEY is invalid'); }
  if (key.length !== 32 || Buffer.from(key).toString('base64') !== value) {
    throw new PluginControlHostError('key_unavailable', 'BUNGEE_PLUGIN_SECRETS_KEY must be canonical base64 for 32 bytes');
  }
  return { keyId: 'BUNGEE_PLUGIN_SECRETS_KEY:v1', key };
}

export function createPluginControlHost(options: PluginControlHostOptions): PluginControlHost {
  const records = new Map(options.records.map((record) => [record.name, record]));
  const handles = new Map<string, PluginControlHandle>();
  const pending = new Map<string, PendingActivation>();
  const activationIntents = new Map<string, { cancelled: boolean }>();
  const invocationCounts = new WeakMap<PluginControlHandle, number>();
  const invocationTasks = new WeakMap<PluginControlHandle, Set<Promise<void>>>();
  const controlDisposals = new WeakMap<PluginControlHandle, Promise<void>>();
  const serviceDisposals = new WeakMap<PluginControlHandle, Promise<void>>();
  const failedActivationCleanups = new WeakMap<PluginControlHandle, Promise<void>>();
  const statuses = new Map<string, PluginControlStatus>();
  const lifecycle = new Map<string, Promise<unknown>>();
  const startTimeoutMs = options.startTimeoutMs ?? CONTROL_START_TIMEOUT_MS;
  const resourceModules = new Map<string, Promise<ControlPlugin>>();
  const invocationDeadlineMs = 15_000;
  const dependencyGraph = options.dependencies ?? new PluginDependencyGraph(options.records.map((record) => record.manifest));
  const requiredDeclarations = dependencyGraph.declarations();
  const serviceDeclarations = dependencyGraph.serviceDeclarations();
  const serviceHost = options.services ?? new PluginServiceHost('control');
  if (serviceHost.process !== 'control') {
    throw new Error('plugin control host requires a control-process plugin service host');
  }
  serviceHost.setDeclarations(serviceDeclarations);
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  /**
   * Required dependencies whose control instance must be started before the
   * consumer. Activation edges to another process/binding are excluded by the
   * dependency graph.
   */
  function localControlDependencies(name: string): readonly string[] {
    return dependencyGraph.localDependenciesOf(name, 'control');
  }

  /** Synchronous/legacy dependencies need a local instance; RPC may resolve remotely. */
  function requiresLocalInstance(consumer: string, provider: string): boolean {
    const services = (serviceDeclarations.get(consumer)?.consumes ?? []).filter(service => service.plugin === provider && service.process === 'control');
    return services.length === 0 || services.some(service => (service.kind ?? 'local') === 'local');
  }

  /** Provider-before-consumer initialization order for the actual instance set. */
  function controlInitializationOrder(names: readonly string[]): readonly string[] {
    return dependencyGraph.initializationOrder(names, 'control');
  }

  function liveReady(name: string): boolean {
    return handles.get(name)?.status === 'ready';
  }

  /** Live ready control instances, in insertion order. */
  function liveReadyNames(): string[] {
    return [...handles.keys()].filter((name) => liveReady(name));
  }

  /**
   * Live ready owners that hold an actual reference edge to `name` (a required
   * dependency edge or a consumed service). Same-control instances only.
   */
  function liveReferrers(name: string): string[] {
    return serviceHost.references(name)
      .filter((reference) => reference.scope === 'global' && reference.plugin !== name && liveReady(reference.plugin))
      .map((reference) => reference.plugin);
  }

  /** Live consumers that require `name` as a control-local provider: removal is unsafe. */
  function requiredReferrers(name: string): string[] {
    const references = new Set(serviceHost.references(name)
      .filter(reference => reference.scope === 'global' && reference.plugin !== name)
      .map(reference => reference.plugin)
      .filter(consumer => handles.get(consumer)?.status !== 'inactive' && localControlDependencies(consumer).includes(name)));
    // Starting RPC consumers may not have resolved their logical client yet.
    // Protect the provider while bootstrap is in flight, without retaining an
    // unrelated local provider once a ready consumer actually routes remotely.
    for (const [consumer, activation] of pending) {
      if (consumer !== name && !activation.cancelled && localControlDependencies(consumer).includes(name)) references.add(consumer);
    }
    for (const [consumer, intent] of activationIntents) {
      if (consumer !== name && !intent.cancelled && handles.get(consumer)?.status !== 'ready'
        && localControlDependencies(consumer).includes(name)) references.add(consumer);
    }
    for (const [consumer, handle] of handles) {
      if (consumer !== name && handle.status === 'starting' && localControlDependencies(consumer).includes(name)) references.add(consumer);
    }
    return [...references];
  }

  /** Transitive live-referrer closure over the removed seeds (ordered later). */
  function stopClosure(seeds: Iterable<string>): Set<string> {
    const stop = new Set<string>(seeds);
    const queue = [...stop];
    while (queue.length > 0) {
      const removed = queue.pop()!;
      for (const consumer of liveReferrers(removed)) {
        if (!stop.has(consumer)) { stop.add(consumer); queue.push(consumer); }
      }
    }
    return stop;
  }

  /** Consumer-before-provider order from the service host; graph errors propagate. */
  function consumerFirstOrder(names: Iterable<string>): string[] {
    const rank = new Map(serviceHost.disposalOrder().map((owner, index) => [`${owner.plugin}\0${owner.scope}`, index]));
    return [...names].sort((left, right) => (rank.get(`${left}\0global`) ?? Number.MAX_SAFE_INTEGER) - (rank.get(`${right}\0global`) ?? Number.MAX_SAFE_INTEGER));
  }

  let batchChain: Promise<unknown> = Promise.resolve();
  /** FIFO batch gate: reconcile and deactivate batches never interleave. */
  function runBatch<T>(operation: () => Promise<T>): Promise<T> {
    const run = batchChain.catch(() => undefined).then(operation);
    batchChain = run.catch(() => undefined);
    return run;
  }

  async function readModule(record: PluginManifestRecord): Promise<ControlPlugin> {
    if (disposed) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
    const name = record.name;
    let loading = resourceModules.get(name);
    if (!loading) {
      loading = options.loadControl?.(record) ?? loadImmutableControlArtifact(record);
      resourceModules.set(name, loading);
    }
    try { return await withTimeout(loading,startTimeoutMs,'timeout'); }
    catch (error) {
      // A failed/timed-out artifact load is retryable; persisted plugin state is never cached.
      if (resourceModules.get(name) === loading) resourceModules.delete(name);
      throw error;
    }
  }

  function revokePending(activation: PendingActivation): void {
    activation.cancelled = true;
    activation.lifetime.abort();
    if (!activation.revoked) {
      activation.revoked = true;
      options.secretStores.revoke(activation.secretStore);
      options.storage.revoke?.(activation.storage);
      // A pending activation has not published or been referenced, so the
      // captured context revokes synchronously in practice.
      void serviceHost.dispose(activation.name, 'global', activation.services).catch(() => undefined);
    }
  }

  function assertPending(activation: PendingActivation): void {
    if (disposed) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
    if (activation.cancelled || activation.lifetime.signal.aborted) {
      throw new PluginControlHostError('inactive', 'plugin control activation was cancelled');
    }
  }

  function serial<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = lifecycle.get(name) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    lifecycle.set(name, current);
    return current.finally(() => {
      if (lifecycle.get(name) === current) lifecycle.delete(name);
    });
  }

  function disposeControl(handle: PluginControlHandle): Promise<void> {
    const existing = controlDisposals.get(handle);
    if (existing !== undefined) return existing;
    const disposal = Promise.resolve().then(() => handle.control.dispose());
    controlDisposals.set(handle, disposal);
    return disposal;
  }

  /**
   * Disposes the captured service context once per handle. A completed revoke
   * (even with cleanup failures) stays memoized; a reference/drain rejection is
   * retryable because the context was not revoked.
   */
  function disposeServices(handle: PluginControlHandle): Promise<void> {
    const existing = serviceDisposals.get(handle);
    if (existing !== undefined) return existing;
    const disposal = serviceHost.dispose(handle.pluginName, 'global', handle.services);
    serviceDisposals.set(handle, disposal);
    void disposal.catch((error: unknown) => {
      if (error instanceof PluginServiceCleanupError) return;
      if (serviceDisposals.get(handle) === disposal) serviceDisposals.delete(handle);
    });
    return disposal;
  }

  async function waitForPromise(promise: Promise<unknown>): Promise<void> {
    await withTimeout(promise.then(() => undefined, () => undefined), startTimeoutMs, 'timeout');
  }

  async function waitForInvocationTasks(handle: PluginControlHandle): Promise<void> {
    const tasks = invocationTasks.get(handle);
    if (tasks === undefined || tasks.size === 0) return;
    await waitForPromise(Promise.allSettled([...tasks]));
  }

  async function activateNow(name: string, allowed?: ReadonlySet<string>): Promise<PluginControlHandle> {
    if (disposed) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
    const record = records.get(name);
    if (record === undefined || record.controlPath === undefined || record.manifest.control === undefined) throw new PluginControlHostError('not_declared', 'plugin control is not declared');
    if (allowed && !allowed.has(name)) throw new PluginControlHostError('start_failed', `control instance is outside the desired set: ${name}`);
    const intent = { cancelled: false };
    activationIntents.set(name, intent);
    try { return await activateInstance(name, intent, allowed); }
    finally { if (activationIntents.get(name) === intent) activationIntents.delete(name); }
  }

  async function activateInstance(name: string, intent: { cancelled: boolean }, allowed?: ReadonlySet<string>): Promise<PluginControlHandle> {
    if (disposed) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
    const record = records.get(name);
    if (record === undefined || record.controlPath === undefined || record.manifest.control === undefined) {
      throw new PluginControlHostError('not_declared', 'plugin control is not declared');
    }
    const identity = artifactIdentity(record);
    const current = handles.get(name);
    if (current !== undefined) {
      if (current.artifactIdentity !== identity) {
        throw new PluginControlHostError('restart_required', 'control artifact changed; restart the master');
      }
      if (current.status === 'ready') return current;
      if (current.status === 'stopping') throw new PluginControlHostError('timeout', 'previous control instance has not stopped');
      if (current.status === 'degraded' || current.status === 'starting') {
        throw new PluginControlHostError('start_failed', 'previous control instance cannot be replaced');
      }
    } else if (statuses.get(name) === 'degraded' || statuses.get(name) === 'stopping') {
      throw new PluginControlHostError('start_failed', 'previous control activation cannot be replaced');
    }
    // Required control-local providers must be initialized and published before
    // this consumer is created.
    for (const provider of localControlDependencies(name)) {
      if (disposed || intent.cancelled) throw new PluginControlHostError('inactive', 'plugin control activation was cancelled');
      if (allowed && !allowed.has(provider)) {
        if (requiresLocalInstance(name, provider)) throw new PluginControlHostError('start_failed', `desired control consumer requires an undesired provider: ${name} -> ${provider}`);
        // An async logical dependency must resolve through its actual endpoint;
        // never start a local shadow instance outside the explicit desired set.
        continue;
      }
      await activate(provider, allowed);
    }
    if (disposed || intent.cancelled) throw new PluginControlHostError('inactive', 'plugin control activation was cancelled');
    const lifetime = new AbortController();
    let services!: PluginServices;
    let store!: SecretStore;
    let storage!: PluginStorage;
    let hasServices = false;
    let hasStore = false;
    let hasStorage = false;
    try {
      services = serviceHost.createContext(name, 'global', requiredDeclarations.get(name) ?? {});
      hasServices = true;
      store = options.secretStores.create(name);
      hasStore = true;
      storage = options.storage.create(name);
      hasStorage = true;
    } catch (error) {
      // Bounded init cleanup: never leak the service owner or an earlier resource.
      if (hasStorage) options.storage.revoke?.(storage);
      if (hasStore) options.secretStores.revoke(store);
      if (hasServices) void serviceHost.dispose(name, 'global', services).catch(() => undefined);
      statuses.set(name, 'degraded');
      throw new PluginControlHostError('start_failed', 'control resources could not be created', error);
    }
    const activation: PendingActivation = { name, lifetime, secretStore: store, storage, services, cancelled: false, revoked: false };
    pending.set(name, activation);
    statuses.set(name, 'starting');
    const cleanupFailedActivation = (): void => {
      revokePending(activation);
      pending.delete(name);
    };
    let module: LoadedModule;
    try {
      const loading = options.loadControl?.(record) ?? loadImmutableControlArtifact(record);
      module = await withTimeout(Promise.resolve(loading), startTimeoutMs, 'timeout');
      assertPending(activation);
    } catch (error) {
      cleanupFailedActivation();
      statuses.set(name, 'degraded');
      throw error instanceof PluginControlHostError
        ? error
        : new PluginControlHostError('start_failed', 'control artifact could not be loaded', error);
    }
    // Runtime bootstrap RPC (distinct from the management bootstrap): control
    // creation and start may consume required same-process services, so they run
    // inside a trusted host-only `bootstrap` frame bounded by the real start
    // deadline. Legacy hosts without an RPC adapter run exactly as before.
    const runBootstrap = <T>(run: () => T): T => serviceHost.rpc === undefined
      ? run()
      : serviceHost.runInInvocation(services, { purpose: 'bootstrap', signal: lifetime.signal, deadlineAt: Date.now() + startTimeoutMs }, run);
    let control: PluginControl | undefined;
    try {
      const context: ControlHostContext = Object.freeze({ resolveRpcCallee: readHostRpcCalleeFrame, managementOrigin: options.managementOrigin, trustedSource: options.trustedSource, signal: lifetime.signal, secretStore: store, storage, services,
        runAdmissionOperation: options.runAdmissionOperation ? (method: string, payload: unknown, callee: unknown, task: (target: import('../plugin-extensions').AdmissionTarget) => unknown | Promise<unknown>) => options.runAdmissionOperation!(name, method, payload, callee, task) : undefined,
        durableState: options.durableState?.(name), validateRouteReferences: options.validateRouteReferences ? (routeIds: readonly string[]) => options.validateRouteReferences!(name, routeIds) : undefined, readResourceExtensions: options.readResourceExtensions, validateKeyPolicyReferences: options.validateKeyPolicyReferences ? (keyId: string, policy: unknown) => options.validateKeyPolicyReferences!(name, keyId, policy) : undefined, publishPolicy: options.publishPolicy ? (policy: PluginPolicyPublication) => options.publishPolicy!(name, policy) : undefined });
      control = runBootstrap(() => module.createControl(context));
      assertPending(activation);
    } catch (error) {
      cleanupFailedActivation();
      statuses.set(name, 'degraded');
      // createControl may have returned before activation was cancelled; dispose
      // the produced control exactly once so no handler leaks.
      if (control !== undefined && control !== null && typeof control === 'object') {
        try { await withTimeout(Promise.resolve().then(() => control!.dispose()), startTimeoutMs, 'timeout'); }
        catch { /* bounded orphan dispose; the creation error stays authoritative */ }
      }
      throw new PluginControlHostError('start_failed', 'control creation failed', error);
    }
    if (control === null || typeof control !== 'object') {
      cleanupFailedActivation();
      statuses.set(name, 'degraded');
      throw new PluginControlHostError('start_failed', 'createControl returned an invalid control');
    }
    const handle: PluginControlHandle = {
      pluginName: name, artifactIdentity: identity, control, secretStore: store,
      storage, durableState: options.durableState?.(name), services,
      lifetime, status: 'starting', admission: true,
    };
    handles.set(name, handle);
    pending.delete(name);
    invocationCounts.set(handle, 0);
    let startTask: Promise<void> | undefined;
    try {
      if (disposed || lifetime.signal.aborted) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
      startTask = Promise.resolve().then(() => runBootstrap(() => control.start()));
      await withTimeout(startTask, startTimeoutMs, 'timeout');
      if (disposed || lifetime.signal.aborted || !handle.admission) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
      // Publish only after start completed: a started instance is the ready boundary.
      serviceHost.markReady(name, 'global', services);
      handle.status = 'ready';
      statuses.set(name, 'ready');
      return handle;
    } catch (error) {
      handle.status = 'degraded';
      handle.admission = false;
      lifetime.abort();
      options.secretStores.revoke(store);
      options.storage.revoke?.(storage);
      statuses.set(name, 'degraded');
      // Retire and revoke the captured context immediately: a late, timed-out
      // start must not keep publishing while we wait for it to settle.
      serviceHost.retire(name, 'global', services);
      let revoked = false;
      let delayedCleanup: Promise<void> | undefined;
      try { await withTimeout(disposeServices(handle), startTimeoutMs, 'timeout'); revoked = true; }
      catch (cleanupError) {
        if (!(cleanupError instanceof PluginServiceCleanupError)) {
          // The actual service task is still live: finish cleanup only after revoke.
          delayedCleanup = disposeServices(handle).then(() => undefined, laterError => {
            if (!(laterError instanceof PluginServiceCleanupError)) throw laterError;
          }).then(async () => {
            if (startTask) await startTask.catch(() => undefined);
            await disposeControl(handle);
          });
          failedActivationCleanups.set(handle, delayedCleanup);
          void delayedCleanup.catch(() => undefined);
        } else revoked = true;
      }
      try {
        if (startTask !== undefined) await waitForPromise(startTask);
      } catch { /* the original start error remains authoritative */ }
      if (revoked) {
        const cleanup = disposeControl(handle);
        failedActivationCleanups.set(handle, cleanup);
        try { await withTimeout(cleanup, startTimeoutMs, 'timeout'); }
        catch { /* preserve the original activation failure */ }
      }
      throw error instanceof PluginControlHostError ? error : new PluginControlHostError('start_failed', 'control start failed', error);
    }
  }

  function activate(name: string, allowed?: ReadonlySet<string>): Promise<PluginControlHandle> {
    return serial(name, () => activateNow(name, allowed));
  }

  function closeHandle(handle: PluginControlHandle): void {
    if (handle.status === 'stopping' || handle.status === 'inactive' || handle.status === 'degraded') return;
    handle.status = 'stopping';
    handle.admission = false;
    options.secretStores.revoke(handle.secretStore);
    options.storage.revoke?.(handle.storage);
    handle.lifetime.abort();
    try { serviceHost.retire(handle.pluginName, 'global', handle.services); }
    catch { /* the captured context may already be revoked */ }
    statuses.set(handle.pluginName, 'stopping');
  }

  async function stopHandle(name: string): Promise<void> {
    const handle = handles.get(name);
    if (handle === undefined || handle.status === 'inactive') return;
    if (handle.status === 'degraded') {
      const cleanup = failedActivationCleanups.get(handle);
      if (cleanup) await withTimeout(cleanup, startTimeoutMs, 'timeout');
      return;
    }
    closeHandle(handle);
    // Real invocations and service calls must fully drain. A timeout means the
    // task is still live, so keep stopping and never destroy resources.
    await waitForInvocationTasks(handle);
    let serviceCleanupFailure: PluginServiceCleanupError | undefined;
    try {
      // Bounded: if the context is not revoked in time, do not destroy the control.
      await withTimeout(disposeServices(handle), startTimeoutMs, 'timeout');
    } catch (error) {
      if (error instanceof PluginServiceCleanupError) serviceCleanupFailure = error;
      else {
        handle.status = 'stopping';
        statuses.set(name, 'stopping');
        throw error;
      }
    }
    try {
      await withTimeout(disposeControl(handle), startTimeoutMs, 'timeout');
    } catch (error) {
      if (serviceCleanupFailure === undefined) {
        handle.status = 'stopping';
        statuses.set(name, 'stopping');
        throw error;
      }
    }
    if (serviceCleanupFailure !== undefined) {
      handle.status = 'stopping';
      statuses.set(name, 'stopping');
      throw serviceCleanupFailure;
    }
    handle.status = 'inactive';
    statuses.set(name, 'inactive');
  }

  async function applyDesired(effective: ReadonlySet<string>): Promise<void> {
    const initializationOrder = controlInitializationOrder([...effective]);
    // Fail closed: a desired consumer must have every required control-local
    // provider desired too; the authorized set is never expanded silently.
    for (const consumer of effective) {
      for (const provider of localControlDependencies(consumer)) {
        const handle = handles.get(consumer);
        const needsStartup = handle?.status !== 'ready';
        const retainedLocally = serviceHost.references(provider).some(reference => reference.plugin === consumer && reference.scope === 'global');
        if (!effective.has(provider) && (retainedLocally || (needsStartup && requiresLocalInstance(consumer, provider)))) {
          throw new PluginControlHostError('start_failed', `desired control consumer requires an undesired provider: ${consumer} -> ${provider}`);
        }
      }
    }
    const failures: unknown[] = [];

    // Stop instances outside the desired set and every live referrer that must
    // release them first (consumer before provider).
    const removals = new Set<string>();
    for (const name of handles.keys()) if (!effective.has(name)) removals.add(name);
    const stop = stopClosure(removals);
    for (const name of consumerFirstOrder(stop)) {
      try { await serial(name, () => stopHandle(name)); } catch (error) { failures.push(error); }
    }

    // Activate desired instances provider-first; required providers are desired.
    for (const name of initializationOrder) {
      if (handles.get(name)?.status === 'ready') continue;
      try { await serial(name, () => activateNow(name, effective)); } catch (error) { failures.push(error); }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new PluginControlHostError(
        'start_failed',
        `${failures.length} plugin control reconciliation operation(s) failed`,
        new AggregateError(failures),
      );
    }
  }

  function reconcile(activeNames: readonly string[]): Promise<void> {
    return runBatch(async () => {
      if (disposed) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
      const effective = new Set<string>();
      for (const name of activeNames) {
        const record = records.get(name);
        if (record?.controlPath !== undefined && record.manifest.control !== undefined) effective.add(name);
      }
      await applyDesired(effective);
    });
  }

  function deactivate(name: string): Promise<void> {
    const intent = activationIntents.get(name);
    if (intent) intent.cancelled = true;
    const activation = pending.get(name);
    if (activation !== undefined) {
      revokePending(activation);
      return runBatch(async () => { await serial(name, () => stopHandle(name)); });
    }
    const handle = handles.get(name);
    if (handle === undefined || handle.status === 'inactive' || handle.status === 'degraded') {
      return runBatch(async () => { await serial(name, () => stopHandle(name)); });
    }
    // Reference pre-check before any abort/revoke: a live required consumer keeps
    // the provider ready and callable.
    const blocking = requiredReferrers(name);
    if (blocking.length > 0) {
      return Promise.reject(new PluginControlHostError(
        'start_failed',
        `Plugin control provider is referenced by a required consumer: ${name} <- ${blocking.join(', ')}`,
      ));
    }
    // Stop new admission promptly; abort/revoke happen inside the serialized batch.
    if (handle.status === 'ready' || handle.status === 'starting') handle.admission = false;
    return runBatch(async () => {
      try {
        const blocking = requiredReferrers(name);
        if (blocking.length) throw new PluginControlHostError('start_failed', `Plugin control provider is referenced by a required consumer: ${name} <- ${blocking.join(', ')}`);
        const effective = new Set(liveReadyNames());
        effective.delete(name);
        await applyDesired(effective);
      } catch (error) {
        // A validation rejection must not leave the exact still-ready instance disabled.
        if (handles.get(name) === handle && handle.status === 'ready' && !handle.lifetime.signal.aborted) handle.admission = true;
        throw error;
      }
    });
  }

  function invokeWithSlot<T>(handle: PluginControlHandle, requestSignal: AbortSignal, frame: TrustedControlInvocation, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!handle.admission || handle.status !== 'ready' || handle.lifetime.signal.aborted) {
      return Promise.reject(new PluginControlHostError('inactive', 'plugin control is inactive'));
    }
    if (requestSignal.aborted) return Promise.reject(new PluginControlHostError('deadline', 'control invocation was cancelled'));
    // Pin the consumer and its providers synchronously at admission. A lease that
    // cannot be acquired rejects without occupying an invocation slot.
    let releaseLease: (() => void) | undefined;
    try { releaseLease = serviceHost.acquireLease(handle.pluginName, 'global'); }
    catch { return Promise.reject(new PluginControlHostError('inactive', 'plugin control is inactive')); }
    const active = invocationCounts.get(handle) ?? 0;
    if (active >= 64) {
      releaseLease?.();
      return Promise.reject(new PluginControlHostError('overloaded', 'plugin control invocation capacity is exhausted'));
    }
    invocationCounts.set(handle, active + 1);
    // Slot admission instant: the actual service task's RPC frame deadline is the
    // real admission time plus the fixed invocation deadline.
    const admittedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let callerSettled = false;
    const abortFrom = (signal: AbortSignal): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
      if (!callerSettled) {
        callerSettled = true;
        rejectCaller(signal === handle.lifetime.signal
          ? new PluginControlHostError('inactive', 'plugin control is inactive')
          : new PluginControlHostError(timedOut ? 'timeout' : 'deadline', timedOut ? 'control invocation timed out' : 'control invocation was cancelled'));
      }
    };
    let rejectCaller!: (error: unknown) => void;
    const caller = new Promise<T>((resolve, reject) => {
      rejectCaller = reject;
      const onAbort = (): void => abortFrom(requestSignal);
      const onLifetimeAbort = (): void => abortFrom(handle.lifetime.signal);
      requestSignal.addEventListener('abort', onAbort, { once: true });
      handle.lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (!callerSettled) { callerSettled = true; reject(new PluginControlHostError('timeout', 'control invocation timed out')); }
      }, invocationDeadlineMs);
      const taskPromise = Promise.resolve().then(() => {
        // Deactivation that landed before this microtask must not start business.
        if (!handle.admission || handle.lifetime.signal.aborted) throw new PluginControlHostError('inactive', 'plugin control is inactive');
        // The actual business task runs inside the trusted host frame. The lease is
        // the same original release handle and is released only in this task's
        // finally, so caller timeout/cancel can never clear it early.
        if (serviceHost.rpc === undefined) return task(controller.signal);
        return serviceHost.runInInvocation(handle.services, {
          purpose: frame.purpose,
          lease: releaseLease,
          callee: frame.callee?.(controller.signal),
          signal: controller.signal,
          deadlineAt: admittedAt + invocationDeadlineMs,
        }, () => task(controller.signal));
      }).finally(() => { releaseLease?.(); });
      const trackedTask = taskPromise.then(() => undefined, () => undefined);
      const tasks = invocationTasks.get(handle) ?? new Set<Promise<void>>();
      tasks.add(trackedTask);
      invocationTasks.set(handle, tasks);
      void trackedTask.finally(() => tasks.delete(trackedTask)).catch(() => undefined);
      void taskPromise.then(
        (value) => { if (!callerSettled) { callerSettled = true; resolve(value as T); } },
        (error) => { if (!callerSettled) { callerSettled = true; reject(error); } },
      ).finally(() => {
        clearTimeout(timer);
        requestSignal.removeEventListener('abort', onAbort);
        handle.lifetime.signal.removeEventListener('abort', onLifetimeAbort);
        invocationCounts.set(handle, (invocationCounts.get(handle) ?? 1) - 1);
      });
    });
    return caller;
  }

  function invokeRpc(
    name: string,
    method: string,
    payload: unknown,
    invocation: BoundControlInvocation,
  ): Promise<unknown> {
    const handle = handles.get(name);
    if (handle?.status !== 'ready') return Promise.reject(new PluginControlHostError('inactive', 'plugin control is inactive'));
    const declaration = handle.control.rpc.find((entry) => entry.name === method);
    if (declaration === undefined || declaration.handler !== method && declaration.name !== method) {
      return Promise.reject(new PluginControlHostError('method_not_allowed', 'control RPC method is not declared'));
    }
    return invokeWithSlot(handle, invocation.attempt.signal, {
      purpose: 'attempt',
      // Host-resolved binding and attempt identity, never sourced from the RPC payload.
      callee: (signal) => Object.freeze({ binding: invocation.binding, attempt: Object.freeze({ ...invocation.attempt, signal }) }),
    }, async (signal) => {
      const attempt: BoundAttemptContext = Object.freeze({ ...invocation.attempt, signal });
      const context: ControlRpcContext = Object.freeze({ signal, secretStore: handle.secretStore, storage: handle.storage, services: handle.services, durableState: handle.durableState, publishPolicy: options.publishPolicy ? (policy: PluginPolicyPublication) => options.publishPolicy!(name,policy) : undefined, attempt, binding: invocation.binding });
      return declaration.invoke(payload, context);
    });
  }

  const api: PluginControlApi = {
    async handle(request, subject) {
      const target = pathForPlugin(request);
      if (target === null) return null;
      const handle = handles.get(target.name);
      if (handle?.status !== 'ready' || !handle.admission) return Response.json({ error: 'plugin_control_unavailable' }, { status: 503 });
      const record = records.get(target.name);
      const declarations = record?.manifest.contributes?.api ?? [];
      const declaration = declarations.find(({ path, methods }) => samePath(path, target.path) && methodAllowed(methods, request.method));
      if (declaration === undefined) return Response.json({ error: 'not_found' }, { status: 404 });
      const handler = handle.control.api.find((entry) => entry.handler === declaration.handler);
      if (handler === undefined) return Response.json({ error: 'plugin_control_unavailable' }, { status: 503 });
      try {
        return await invokeWithSlot(handle, request.signal, {
          purpose: 'management',
          // Host-resolved management subject (undefined on an auth-disabled host is
          // still a legitimate management call) plus the trusted request context.
          callee: () => Object.freeze({ subject, request }),
        }, async (signal) => handler.invoke(Object.freeze({
          request, subject, requestSignal: request.signal, signal, secretStore: handle.secretStore, storage: handle.storage, services: handle.services, durableState: handle.durableState,
          publishPolicy: options.publishPolicy ? (policy: PluginPolicyPublication) => options.publishPolicy!(target.name, policy) : undefined,
        })));
      } catch (error) {
        const code = error instanceof PluginControlHostError ? error.code : 'start_failed';
        if (code === 'overloaded') return Response.json({ error: code }, { status: 429 });
        if (code === 'timeout' || code === 'deadline') return Response.json({ error: code }, { status: 504 });
        return Response.json({ error: 'plugin_control_failed' }, { status: 503 });
      }
    },
  };

  return {
    activate,
    deactivate,
    reconcile,
    invokeRpc,
    api,
    async readManagementSetup(name: string): Promise<{initialized:boolean}> {
      const record = records.get(name), state = options.durableState?.(name);
      if (!record?.manifest.management || !state) throw new PluginControlHostError('not_declared', 'management provider unavailable');
      const module = await readModule(record);
      if (!module.readManagementSetup) throw new PluginControlHostError('not_declared', 'management setup reader unavailable');
      const result = await module.readManagementSetup(Object.freeze({get:state.get.bind(state),list:state.list.bind(state)}));
      if (typeof result?.initialized !== 'boolean') throw new Error('invalid management setup status');
      return {initialized:result.initialized};
    },
    async readResourceCollection(name: string, resource: string): Promise<readonly unknown[]> {
      const record = records.get(name), state = options.durableState?.(name);
      if (!record?.manifest.contributes?.resourceExtensions?.some(entry => entry.resource === resource)) throw new PluginControlHostError('not_declared', 'resource collection is not declared');
      if (!state) throw new PluginControlHostError('inactive', 'durable state is unavailable');
      const module = await readModule(record);
      if (!module.readResourceCollection) throw new PluginControlHostError('not_declared', 'resource collection reader is not implemented');
      return withTimeout(Promise.resolve(module.readResourceCollection(resource, Object.freeze({get: state.get.bind(state), list: state.list.bind(state)}))), startTimeoutMs, 'timeout');
    },
    async readAdmissionRequirements(name: string): Promise<readonly string[]> {
      const record = records.get(name);
      const state = options.durableState?.(name);
      if (!record?.controlPath) throw new PluginControlHostError('not_declared', 'admission requirements reader is not declared');
      if (!state) throw new PluginControlHostError('inactive', 'durable state is unavailable');
      const module = await readModule(record);
      if (!module.readAdmissionRequirements) throw new PluginControlHostError('not_declared', 'admission requirements reader is not implemented');
      return module.readAdmissionRequirements(Object.freeze({get: state.get.bind(state), list: state.list.bind(state)}));
    },
    async verifyDataPrincipal(name: string, principal: DataPrincipal): Promise<boolean> {
      const record = records.get(name);
      const state = options.durableState?.(name);
      if (!record?.controlPath || !state) return false;
      const module = await readModule(record);
      return module.verifyDataPrincipal?.(principal, Object.freeze({get: state.get.bind(state), list: state.list.bind(state)})) ?? false;
    },
    async readResource(name, resource, id) {
      if (disposed) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
      const record = records.get(name);
      if (!record?.manifest.contributes?.resourceExtensions?.some(entry => entry.resource === resource)) {
        throw new PluginControlHostError('not_declared', 'resource reader is not declared');
      }
      const state = options.durableState?.(name);
      if (!state) throw new PluginControlHostError('inactive', 'durable state is unavailable');
      const module = await readModule(record);
      if (!module.readResource) throw new PluginControlHostError('not_declared', 'resource reader is not implemented');
      const readonlyState = Object.freeze({ get: state.get.bind(state), list: state.list.bind(state) });
      return withTimeout(Promise.resolve(module.readResource(resource, id, readonlyState)), startTimeoutMs, 'timeout');
    },
    get(name) { return handles.get(name) ?? null; },
    status(name) { return handles.get(name)?.status ?? statuses.get(name) ?? 'inactive'; },
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      for (const intent of activationIntents.values()) intent.cancelled = true;
      for (const activation of pending.values()) revokePending(activation);
      for (const handle of handles.values()) closeHandle(handle);
      disposePromise = runBatch(async () => {
        let firstError: unknown;
        for (const operation of lifecycle.values()) {
          try { await operation; } catch (error) { firstError ??= error; }
        }
        // Prefer consumer-before-provider order. An inconsistent graph is recorded
        // and cleanup still runs in discovery order; ordering is never faked.
        let orderedNames: string[];
        try { orderedNames = consumerFirstOrder([...handles.keys()]); }
        catch (error) { firstError ??= error; orderedNames = [...handles.keys()]; }
        for (const name of orderedNames) {
          try { await serial(name, () => stopHandle(name)); } catch (error) { firstError ??= error; }
        }
        if (firstError !== undefined) throw firstError;
      });
      return disposePromise;
    },
  };
}

export interface PluginControlHost {
  readManagementSetup(name:string): Promise<{initialized:boolean}>;
  readResourceCollection(name: string, resource: string): Promise<readonly unknown[]>;
  readAdmissionRequirements(name: string): Promise<readonly string[]>;
  verifyDataPrincipal(name: string, principal: DataPrincipal): Promise<boolean>;
  readResource(name: string, resource: string, id: string): Promise<{ value: unknown; usage?: unknown }>;
  activate(name: string): Promise<PluginControlHandle>;
  deactivate(name: string): Promise<void>;
  reconcile(activeNames: readonly string[]): Promise<void>;
  invokeRpc(name: string, method: string, payload: unknown, invocation: BoundControlInvocation): Promise<unknown>;
  readonly api: PluginControlApi;
  get(name: string): PluginControlHandle | null;
  status(name: string): PluginControlStatus;
  dispose(): Promise<void>;
}
