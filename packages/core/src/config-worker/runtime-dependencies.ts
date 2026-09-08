import type { BoundControlClient, ControlBindingIdentity } from '../plugin-control/contracts';
import {
  createBoundControlClient,
  type ControlIpcTransport,
} from '../plugin-control/ipc';
import type { ConfigProcessIdentity } from '../config-publication/types';

export type BoundControlAttemptIdentity = {
  readonly revision: number;
  readonly endpointId: string;
  readonly attemptId: string;
};

export type BoundControlClientProvider = (
  binding: ControlBindingIdentity,
  attempt?: BoundControlAttemptIdentity,
) => BoundControlClient;

export function createBoundControlClientProvider(options: {
  readonly transport: ControlIpcTransport;
  readonly identity: ConfigProcessIdentity;
  readonly revision?: number;
  readonly endpointId?: string;
  readonly attemptId?: string;
  readonly resolveAttempt?: () => BoundControlAttemptIdentity | undefined;
  readonly methods: readonly string[];
}): BoundControlClientProvider {
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  let disconnected = false;
  const dispatcher: ControlIpcTransport = {
    send: (message) => options.transport.send(message),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeDisconnect(listener) { disconnectListeners.add(listener); return () => { disconnectListeners.delete(listener); }; },
    isDisconnected: () => disconnected,
  };
  const unsubscribeTransport = options.transport.subscribe((message) => {
    for (const listener of [...listeners]) listener(message);
  });
  const unsubscribeDisconnect = options.transport.subscribeDisconnect(() => {
    disconnected = true;
    for (const listener of [...disconnectListeners]) listener();
  });
  const provider: BoundControlClientProvider = (binding, attempt) => {
    const resolved = attempt ?? options.resolveAttempt?.();
    const revision = resolved?.revision ?? options.revision;
    const endpointId = resolved?.endpointId ?? options.endpointId;
    const attemptId = resolved?.attemptId ?? options.attemptId;
    if (revision === undefined || endpointId === undefined || attemptId === undefined) {
      throw new Error('bound control attempt identity is unavailable');
    }
    return createBoundControlClient({
      transport: dispatcher,
      identity: options.identity,
      revision,
      endpointId,
      attemptId,
      binding,
      methods: options.methods,
    });
  };
  providerCleanup.set(provider, () => {
    disconnected = true;
    for (const listener of [...disconnectListeners]) listener();
    unsubscribeTransport();
    unsubscribeDisconnect();
    listeners.clear();
    disconnectListeners.clear();
  });
  return provider;
}

let provider: BoundControlClientProvider | null = null;
const providerCleanup = new WeakMap<BoundControlClientProvider, () => void>();

export function setBoundControlClientProvider(next: BoundControlClientProvider | null): void {
  if (provider !== next && provider !== null) providerCleanup.get(provider)?.();
  provider = next;
}

export function getBoundControlClient(
  binding: ControlBindingIdentity,
  attempt?: BoundControlAttemptIdentity,
): BoundControlClient {
  if (provider === null) throw new Error('bound control client provider is unavailable');
  return provider(binding, attempt);
}

export function hasBoundControlClientProvider(): boolean {
  return provider !== null;
}
