import {
  createPluginControlHttpClient,
  type PluginControlHttpClient,
  type PluginControlHttpClientOptions,
} from '../plugin-control';
import { createPluginControlRpcCredential, type PluginControlRpcWorker } from '../plugin-control/http-protocol';
import type { BoundControlClient, ControlBindingIdentity } from '../plugin-control/contracts';
import type { ControllerAuthority, SupervisionProcessCredential } from '../supervision';
import type { BoundControlAttemptIdentity, BoundControlClientProvider } from './runtime-dependencies';

export type WorkerPluginControlAuthoritySource = {
  readonly currentControllerAuthorityIfLeased: () => ControllerAuthority | null;
  readonly subscribeControllerAuthority: (listener: (authority: ControllerAuthority | null) => void) => () => void;
};

export type WorkerPluginControlHttpProviderOptions = {
  readonly supervision: SupervisionProcessCredential;
  readonly worker: PluginControlRpcWorker;
  readonly managementHost: '127.0.0.1' | '::1';
  readonly managementPort: number;
  readonly authoritySource: WorkerPluginControlAuthoritySource;
  readonly fetchImpl?: PluginControlHttpClientOptions['fetchImpl'];
  readonly wallClock?: PluginControlHttpClientOptions['wallClock'];
  readonly deadlineMs?: number;
};

export type WorkerPluginControlHttpProvider = {
  readonly provider: BoundControlClientProvider;
  readonly client: PluginControlHttpClient;
  dispose(): void;
};

function baseUrl(host: '127.0.0.1' | '::1', port: number): string {
  return `http://${host === '::1' ? `[${host}]` : host}:${port}/`;
}

function attempt(value: BoundControlAttemptIdentity | undefined): BoundControlAttemptIdentity {
  if (value === undefined || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.endpointId !== 'string' || value.endpointId.length === 0
    || typeof value.attemptId !== 'string' || value.attemptId.length === 0) {
    throw new Error('bound control attempt identity is unavailable');
  }
  return value;
}

export function createWorkerPluginControlHttpProvider(
  options: WorkerPluginControlHttpProviderOptions,
): WorkerPluginControlHttpProvider {
  const credential = createPluginControlRpcCredential(options.supervision, options.worker);
  const client = createPluginControlHttpClient({
    baseUrl: baseUrl(options.managementHost, options.managementPort),
    session: () => {
      const authority = options.authoritySource.currentControllerAuthorityIfLeased();
      return authority === null ? null : { credential, authority };
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.wallClock === undefined ? {} : { wallClock: options.wallClock }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });
  const provider: BoundControlClientProvider = (_binding: ControlBindingIdentity, rawAttempt) => {
    const identity = attempt(rawAttempt);
    const boundClient: BoundControlClient = {
      call: <TResult>(method: string, payload: unknown, signal: AbortSignal): Promise<TResult> =>
        client.call<TResult>({ revision: identity.revision, endpoint_id: identity.endpointId,
          attempt_id: identity.attemptId, method, payload }, signal),
    };
    return boundClient;
  };
  const unsubscribe = options.authoritySource.subscribeControllerAuthority(() => {
    client.invalidateSession('stale_controller');
  });
  let disposed = false;
  return {
    provider,
    client,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      client.invalidateSession('disposed');
      client.dispose();
    },
  };
}
