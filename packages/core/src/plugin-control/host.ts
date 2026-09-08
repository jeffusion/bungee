import type { Database } from 'bun:sqlite';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import { loadImmutableControlArtifact } from './artifact-loader';
import {
  clearSecretStore,
  createSecretStore,
  revokeSecretStore,
  type SecretKeyMaterial,
} from './secret-store';
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
  clear(store: SecretStore): void;
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
  readonly lifetime: AbortController;
  status: PluginControlStatus;
  admission: boolean;
};

export type PluginControlHostOptions = {
  readonly records: readonly PluginManifestRecord[];
  readonly secretStores: SecretStoreFactory;
  readonly startTimeoutMs?: number;
  readonly loadControl?: (record: PluginManifestRecord) => Promise<ControlPlugin>;
};

export type PluginControlApi = {
  handle(request: Request): Promise<Response | null>;
};

export type BoundControlInvocation = {
  readonly pluginName: string;
  readonly binding: ControlBindingIdentity;
  readonly attempt: BoundAttemptContext;
};

type LoadedModule = ControlPlugin;

type PendingActivation = {
  readonly name: string;
  readonly lifetime: AbortController;
  readonly secretStore: SecretStore;
  cancelled: boolean;
  revoked: boolean;
};

function artifactIdentity(record: PluginManifestRecord): string {
  // The catalog hash is the identity used by the worker publication contract. It
  // deliberately does not use a mutable path as an import key.
  return `${record.name}:${record.manifest.version}:${record.runtimeHash}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: ControlHostErrorCode): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PluginControlHostError(code, 'control operation timed out')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer)).catch(() => undefined);
  });
}

function pathForPlugin(request: Request): { name: string; path: string } | null {
  const pathname = new URL(request.url).pathname.replace(/^\/__ui(?=\/api\/)/, '');
  const match = /^\/api\/plugins\/([^/]+)\/control(\/.*)?$/.exec(pathname);
  if (match === null) return null;
  try { return { name: decodeURIComponent(match[1]!), path: match[2] ?? '/' }; }
  catch { return null; }
}

function samePath(declared: string, actual: string): boolean {
  const normalized = declared.length > 1 ? declared.replace(/\/+$/, '') : declared;
  return normalized === actual || (normalized === '/' && actual === '');
}

function methodAllowed(methods: readonly string[], method: string): boolean {
  return methods.includes(method.toUpperCase());
}

export function createDatabaseSecretStoreFactory(
  db: Database,
  material: SecretKeyMaterial | null | undefined,
): SecretStoreFactory {
  return {
    create(namespace) { return createSecretStore(db, namespace, material); },
    revoke: revokeSecretStore,
    clear: clearSecretStore,
  };
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
  const invocationCounts = new WeakMap<PluginControlHandle, number>();
  const statuses = new Map<string, PluginControlStatus>();
  const lifecycle = new Map<string, Promise<unknown>>();
  const startTimeoutMs = options.startTimeoutMs ?? CONTROL_START_TIMEOUT_MS;
  const invocationDeadlineMs = 15_000;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  function revokePending(activation: PendingActivation): void {
    activation.cancelled = true;
    activation.lifetime.abort();
    if (!activation.revoked) {
      activation.revoked = true;
      options.secretStores.revoke(activation.secretStore);
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

  async function activateNow(name: string): Promise<PluginControlHandle> {
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
    const lifetime = new AbortController();
    const store = options.secretStores.create(name);
    const activation: PendingActivation = { name, lifetime, secretStore: store, cancelled: false, revoked: false };
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
    let control: PluginControl;
    try {
      const context: ControlHostContext = Object.freeze({ signal: lifetime.signal, secretStore: store });
      control = module.createControl(context);
      assertPending(activation);
    } catch (error) {
      cleanupFailedActivation();
      statuses.set(name, 'degraded');
      throw new PluginControlHostError('start_failed', 'control creation failed', error);
    }
    if (control === null || typeof control !== 'object') {
      cleanupFailedActivation();
      statuses.set(name, 'degraded');
      throw new PluginControlHostError('start_failed', 'createControl returned an invalid control');
    }
    const handle: PluginControlHandle = {
      pluginName: name, artifactIdentity: identity, control, secretStore: store,
      lifetime, status: 'starting', admission: true,
    };
    handles.set(name, handle);
    pending.delete(name);
    invocationCounts.set(handle, 0);
    try {
      if (disposed || lifetime.signal.aborted) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
      await withTimeout(Promise.resolve(control.start()), startTimeoutMs, 'timeout');
      if (disposed || lifetime.signal.aborted || !handle.admission) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
      handle.status = 'ready';
      statuses.set(name, 'ready');
      return handle;
    } catch (error) {
      handle.status = 'degraded';
      handle.admission = false;
      lifetime.abort();
      options.secretStores.revoke(store);
      statuses.set(name, 'degraded');
      throw error instanceof PluginControlHostError ? error : new PluginControlHostError('start_failed', 'control start failed', error);
    }
  }

  function activate(name: string): Promise<PluginControlHandle> {
    return serial(name, () => activateNow(name));
  }

  function closeHandle(handle: PluginControlHandle): void {
    if (handle.status === 'stopping' || handle.status === 'inactive' || handle.status === 'degraded') return;
    handle.status = 'stopping';
    handle.admission = false;
    options.secretStores.revoke(handle.secretStore);
    handle.lifetime.abort();
    statuses.set(handle.pluginName, 'stopping');
  }

  async function deactivateNow(name: string): Promise<void> {
    const handle = handles.get(name);
    if (handle === undefined || handle.status === 'inactive' || handle.status === 'degraded') return;
    closeHandle(handle);
    try {
      await withTimeout(Promise.resolve(handle.control.dispose()), startTimeoutMs, 'timeout');
    } catch (error) {
      handle.status = 'stopping';
      statuses.set(name, 'stopping');
      throw error;
    }
    handle.status = 'inactive';
    statuses.set(name, 'inactive');
  }

  function deactivate(name: string): Promise<void> {
    const activation = pending.get(name);
    if (activation !== undefined) revokePending(activation);
    const handle = handles.get(name);
    if (handle !== undefined) closeHandle(handle);
    return serial(name, () => deactivateNow(name));
  }

  async function reconcile(activeNames: readonly string[]): Promise<void> {
    if (disposed) throw new PluginControlHostError('disposed', 'plugin control host is disposed');
    const wanted = new Set(activeNames.filter((name) => {
      const record = records.get(name);
      return record?.controlPath !== undefined && record.manifest.control !== undefined;
    }));
    const failures: unknown[] = [];
    for (const name of handles.keys()) {
      if (!wanted.has(name)) {
        try { await deactivate(name); } catch (error) { failures.push(error); }
      }
    }
    for (const name of wanted) {
      try { await activate(name); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new PluginControlHostError(
        'start_failed',
        `${failures.length} plugin control reconciliation operation(s) failed`,
        new AggregateError(failures),
      );
    }
  }

  function invokeWithSlot<T>(handle: PluginControlHandle, requestSignal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!handle.admission || handle.status !== 'ready' || handle.lifetime.signal.aborted) {
      return Promise.reject(new PluginControlHostError('inactive', 'plugin control is inactive'));
    }
    if (requestSignal.aborted) return Promise.reject(new PluginControlHostError('deadline', 'control invocation was cancelled'));
    const active = invocationCounts.get(handle) ?? 0;
    if (active >= 64) {
      return Promise.reject(new PluginControlHostError('overloaded', 'plugin control invocation capacity is exhausted'));
    }
    invocationCounts.set(handle, active + 1);
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
      void Promise.resolve().then(() => task(controller.signal)).then(
        (value) => { if (!callerSettled) { callerSettled = true; resolve(value); } },
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
    return invokeWithSlot(handle, invocation.attempt.signal, async (signal) => {
      const attempt: BoundAttemptContext = Object.freeze({ ...invocation.attempt, signal });
      const context: ControlRpcContext = Object.freeze({ signal, secretStore: handle.secretStore, attempt, binding: invocation.binding });
      return declaration.invoke(payload, context);
    });
  }

  const api: PluginControlApi = {
    async handle(request) {
      const target = pathForPlugin(request);
      if (target === null) return null;
      const handle = handles.get(target.name);
      if (handle?.status !== 'ready' || !handle.admission) return Response.json({ error: 'plugin_control_unavailable' }, { status: 503 });
      const record = records.get(target.name);
      const declarations = record?.manifest.contributes?.api?.filter(({ execution }) => execution === 'control') ?? [];
      const declaration = declarations.find(({ path, methods }) => samePath(path, target.path) && methodAllowed(methods, request.method));
      if (declaration === undefined) return Response.json({ error: 'not_found' }, { status: 404 });
      const handler = handle.control.api.find((entry) => entry.handler === declaration.handler);
      if (handler === undefined) return Response.json({ error: 'plugin_control_unavailable' }, { status: 503 });
      try {
        return await invokeWithSlot(handle, request.signal, async (signal) => handler.invoke(Object.freeze({
          request, requestSignal: request.signal, signal, secretStore: handle.secretStore,
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
    status(name) { return handles.get(name)?.status ?? statuses.get(name) ?? 'inactive'; },
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      for (const activation of pending.values()) revokePending(activation);
      for (const handle of handles.values()) closeHandle(handle);
      disposePromise = (async () => {
        let firstError: unknown;
        for (const operation of lifecycle.values()) {
          try { await operation; } catch (error) { firstError ??= error; }
        }
        for (const name of [...handles.keys()]) {
          try { await deactivate(name); } catch (error) { firstError ??= error; }
        }
        if (firstError !== undefined) throw firstError;
      })();
      return disposePromise;
    },
  };
}

export interface PluginControlHost {
  activate(name: string): Promise<PluginControlHandle>;
  deactivate(name: string): Promise<void>;
  reconcile(activeNames: readonly string[]): Promise<void>;
  invokeRpc(name: string, method: string, payload: unknown, invocation: BoundControlInvocation): Promise<unknown>;
  readonly api: PluginControlApi;
  status(name: string): PluginControlStatus;
  dispose(): Promise<void>;
}
