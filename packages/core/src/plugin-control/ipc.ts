import type { ConfigProcessIdentity } from '../config-publication/types';
import type { PluginConfigOptions } from '@jeffusion/bungee-types';
import type { BoundAttemptContext, BoundControlClient, ControlBindingIdentity } from './contracts';
import type { PluginControlHost } from './host';
import { randomUUID } from 'node:crypto';

export const CONTROL_IPC_MAX_PACKET_BYTES = 64 * 1024;
export const CONTROL_IPC_MAX_CONCURRENCY = 64;
export const CONTROL_IPC_MAX_DEADLINE_MS = 15_000;

type ControlIdentity = ConfigProcessIdentity & {
  readonly revision: number;
  readonly endpointId: string;
  readonly attemptId: string;
};

export type ControlCallMessage = {
  readonly kind: 'plugin-control-call';
  readonly requestId: string;
  readonly identity: ControlIdentity;
  readonly binding: ControlBindingIdentity;
  readonly method: string;
  readonly payload: unknown;
  readonly deadlineAt: number;
};

export type ControlResponseMessage = {
  readonly kind: 'plugin-control-response';
  readonly requestId: string;
  readonly identity: ControlIdentity;
  readonly binding: ControlBindingIdentity;
  readonly method: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
};

export type ControlCancelMessage = {
  readonly kind: 'plugin-control-cancel';
  readonly requestId: string;
  readonly identity: ControlIdentity;
  readonly binding: ControlBindingIdentity;
  readonly method: string;
};

export type ControlIpcMessage = ControlCallMessage | ControlResponseMessage | ControlCancelMessage;

export type ControlIpcTransport = {
  send(message: ControlIpcMessage): Promise<void>;
  subscribe(listener: (message: unknown) => void): () => void;
  subscribeDisconnect(listener: () => void): () => void;
  isDisconnected?: () => boolean;
};

function jsonBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return CONTROL_IPC_MAX_PACKET_BYTES + 1; }
}

function validIdentity(value: unknown): value is ControlIdentity {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.master_generation === 'string'
    && typeof candidate.worker_instance_id === 'string'
    && Number.isSafeInteger(candidate.worker_slot) && (candidate.worker_slot as number) >= 0
    && Number.isSafeInteger(candidate.revision) && (candidate.revision as number) > 0
    && typeof candidate.endpointId === 'string' && candidate.endpointId.length > 0
    && typeof candidate.attemptId === 'string' && candidate.attemptId.length > 0;
}

function validBinding(value: unknown): value is ControlBindingIdentity {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.plugin === 'string' && candidate.plugin.length > 0
    && typeof candidate.contributionId === 'string' && candidate.contributionId.length > 0
    && typeof candidate.bindingId === 'string' && candidate.bindingId.length > 0;
}

const SAFE_CONTROL_ERRORS = new Set([
  'binding_options_unavailable', 'not_found', 'disabled', 'revoked', 'reauth_required',
  'invalid_input', 'disposed', 'refresh_failed', 'control_call_failed',
]);

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && SAFE_CONTROL_ERRORS.has(code) ? code : 'control_call_failed';
}

function sameIdentity(left: ControlIdentity, right: ControlIdentity): boolean {
  return left.master_generation === right.master_generation
    && left.worker_instance_id === right.worker_instance_id
    && left.worker_slot === right.worker_slot
    && left.revision === right.revision
    && left.endpointId === right.endpointId
    && left.attemptId === right.attemptId;
}

export function isControlIpcMessage(value: unknown): value is ControlIpcMessage {
  if (jsonBytes(value) > CONTROL_IPC_MAX_PACKET_BYTES || value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'plugin-control-call') {
    return typeof candidate.requestId === 'string' && candidate.requestId.length > 0 && validIdentity(candidate.identity)
      && validBinding(candidate.binding) && typeof candidate.method === 'string' && candidate.method.length > 0
      && Number.isSafeInteger(candidate.deadlineAt);
  }
  if (candidate.kind === 'plugin-control-cancel') {
    return typeof candidate.requestId === 'string' && candidate.requestId.length > 0 && validIdentity(candidate.identity)
      && validBinding(candidate.binding) && typeof candidate.method === 'string' && candidate.method.length > 0;
  }
  return candidate.kind === 'plugin-control-response' && typeof candidate.requestId === 'string'
    && candidate.requestId.length > 0
    && validIdentity(candidate.identity) && validBinding(candidate.binding)
    && typeof candidate.method === 'string' && candidate.method.length > 0
    && typeof candidate.ok === 'boolean';
}

export type BoundControlRpcServerOptions = {
  readonly host: PluginControlHost;
  readonly processIdentity: ConfigProcessIdentity;
  readonly send: (message: ControlIpcMessage) => Promise<void>;
  readonly isBindingCurrent: (identity: ControlIdentity, binding: ControlBindingIdentity) => boolean;
  readonly allowedMethods: (plugin: string) => readonly string[];
  /** Resolves trusted options from the master's revisioned configuration. */
  readonly resolveBindingOptions: (identity: ControlIdentity, binding: ControlBindingIdentity) => PluginConfigOptions | undefined;
  readonly now?: () => number;
};

export function createBoundControlRpcServer(options: BoundControlRpcServerOptions): {
  accept(message: unknown): void;
  dispose(): void;
} {
  const active = new Map<string, { eligible: boolean; timer: ReturnType<typeof setTimeout>; abort: AbortController; identity: ControlIdentity; binding: ControlBindingIdentity; method: string }>();
  const now = options.now ?? Date.now;
  let disposed = false;
  const sendResponse = (response: ControlResponseMessage): Promise<void> => {
    if (jsonBytes(response) <= CONTROL_IPC_MAX_PACKET_BYTES) return options.send(response);
    const bounded: ControlResponseMessage = {
      kind: 'plugin-control-response', requestId: response.requestId, identity: response.identity,
      binding: response.binding, method: response.method, ok: false, error: 'control_call_failed',
    };
    return jsonBytes(bounded) <= CONTROL_IPC_MAX_PACKET_BYTES
      ? options.send(bounded) : Promise.resolve();
  };
  return {
    accept(message) {
      if (disposed || !isControlIpcMessage(message)) return;
      if (message.kind === 'plugin-control-cancel') {
        if (!sameIdentity(message.identity, { ...options.processIdentity, revision: message.identity.revision,
          endpointId: message.identity.endpointId, attemptId: message.identity.attemptId })) return;
        const state = active.get(message.requestId);
        if (state === undefined || !sameIdentity(state.identity, message.identity)
          || !sameBinding(state.binding, message.binding) || state.method !== message.method) return;
        state.eligible = false;
        state.abort.abort();
        return;
      }
      if (message.kind !== 'plugin-control-call') return;
      if (!sameIdentity(message.identity, {
        ...options.processIdentity,
        revision: message.identity.revision,
        endpointId: message.identity.endpointId,
        attemptId: message.identity.attemptId,
      })) return;
      if (message.deadlineAt <= now() || message.deadlineAt > now() + CONTROL_IPC_MAX_DEADLINE_MS) return;
      if (!options.isBindingCurrent(message.identity, message.binding)
        || !options.allowedMethods(message.binding.plugin).includes(message.method)) return;
      const trustedOptions = options.resolveBindingOptions(message.identity, message.binding);
      if (trustedOptions === undefined) return;
      const trustedBinding = { ...message.binding, bindingOptions: trustedOptions };
      if (active.size >= CONTROL_IPC_MAX_CONCURRENCY || active.has(message.requestId)) return;
      const abort = new AbortController();
      const attempt: BoundAttemptContext = {
        attemptId: message.identity.attemptId,
        clientStreaming: false,
        signal: abort.signal,
        boundClient: { call: () => Promise.reject(new Error('nested control calls are unavailable')) },
      };
      const state: { eligible: boolean; timer: ReturnType<typeof setTimeout>; abort: AbortController; identity: ControlIdentity; binding: ControlBindingIdentity; method: string } = { eligible: true, abort, identity: message.identity, binding: message.binding, method: message.method, timer: setTimeout(() => {
        state.eligible = false;
        abort.abort();
      }, Math.max(1, message.deadlineAt - now())) };
      active.set(message.requestId, state);
      void Promise.resolve().then(() => options.host.invokeRpc(trustedBinding.plugin, message.method, message.payload, {
        pluginName: trustedBinding.plugin,
        binding: trustedBinding,
        attempt,
      })).then(
        (result) => {
          if (state.eligible) return sendResponse({ kind: 'plugin-control-response', requestId: message.requestId,
            identity: message.identity, binding: message.binding, method: message.method, ok: true, result });
        },
        (error) => {
          if (state.eligible) return sendResponse({ kind: 'plugin-control-response', requestId: message.requestId,
            identity: message.identity, binding: message.binding, method: message.method, ok: false, error: safeErrorCode(error) });
        },
      ).catch(() => undefined).finally(() => {
        clearTimeout(state.timer);
        active.delete(message.requestId);
      });
    },
    dispose() {
      disposed = true;
      for (const state of active.values()) {
        state.eligible = false;
        state.abort.abort();
      }
    },
  };
}

type Pending<TResult> = { resolve(value: TResult): void; reject(error: unknown): void };

export type BoundControlClientOptions = {
  readonly transport: ControlIpcTransport;
  readonly identity: ConfigProcessIdentity;
  readonly revision: number;
  readonly endpointId: string;
  readonly attemptId: string;
  readonly binding: ControlBindingIdentity;
  readonly methods: readonly string[];
  readonly now?: () => number;
};

export function createBoundControlClient(options: BoundControlClientOptions): BoundControlClient {
  const now = options.now ?? Date.now;
  const pending = new Map<string, { binding: ControlBindingIdentity; method: string; operation: Operation }>();
  const shared = new Map<string, Operation>();
  let disconnected = false;
  let disposed = false;
  const identity = {
    ...options.identity,
    revision: options.revision,
    endpointId: options.endpointId,
    attemptId: options.attemptId,
  } satisfies ControlIdentity;
  type Operation = {
    key: string;
    requestId: string;
    binding: ControlBindingIdentity;
    method: string;
    cancelSent: boolean;
    waiters: Set<{ pending: Pending<unknown>; cancel: () => void; cleanup: () => void }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const finish = (operation: Operation, error: unknown, result?: unknown): void => {
    if (!shared.delete(operation.key)) return;
    const cancellation = error instanceof Error
      && (error.message === 'control call cancelled' || error.message === 'control call deadline exceeded' || error.message === 'control client disposed');
    if (cancellation && !operation.cancelSent) {
      operation.cancelSent = true;
      void options.transport.send({ kind: 'plugin-control-cancel', requestId: operation.requestId,
        identity, binding: operation.binding, method: operation.method }).catch(() => undefined);
    }
    pending.delete(operation.requestId);
    clearTimeout(operation.timer);
    for (const waiter of operation.waiters) {
      waiter.cleanup();
      if (error === undefined) waiter.pending.resolve(result);
      else waiter.pending.reject(error);
    }
    operation.waiters.clear();
    detachIfIdle();
  };
  const handleMessage = (message: unknown): void => {
    if (!isControlIpcMessage(message) || message.kind !== 'plugin-control-response') return;
    if (!sameIdentity(message.identity, identity)) return;
    const item = pending.get(message.requestId);
    if (item === undefined || item.method !== message.method
      || !sameBinding(item.binding, message.binding)) return;
    finish(item.operation, message.ok ? undefined : new Error(message.error ?? 'control_call_failed'), message.result);
  };
  const handleDisconnect = (): void => {
    disconnected = true;
    for (const operation of [...shared.values()]) finish(operation, new Error('control worker disconnected'));
  };
  let unsubscribe: (() => void) | null = null;
  let unsubscribeDisconnect: (() => void) | null = null;
  const ensureSubscribed = (): void => {
    if (unsubscribe !== null) return;
    const nextUnsubscribe = options.transport.subscribe(handleMessage);
    if (shared.size === 0) {
      nextUnsubscribe();
      return;
    }
    unsubscribe = nextUnsubscribe;
    const nextUnsubscribeDisconnect = options.transport.subscribeDisconnect(handleDisconnect);
    if (shared.size === 0) {
      nextUnsubscribeDisconnect();
      const registeredUnsubscribe = unsubscribe;
      unsubscribe = null;
      registeredUnsubscribe?.();
      return;
    }
    unsubscribeDisconnect = nextUnsubscribeDisconnect;
  };
  const detachIfIdle = (): void => {
    if (shared.size !== 0) return;
    unsubscribe?.(); unsubscribe = null;
    unsubscribeDisconnect?.(); unsubscribeDisconnect = null;
  };

  function call<TResult>(method: string, payload: unknown, signal: AbortSignal): Promise<TResult> {
    if (disposed) return Promise.reject(new Error('control client disposed'));
    if (disconnected || options.transport.isDisconnected?.() === true) {
      disconnected = true;
      return Promise.reject(new Error('control worker disconnected'));
    }
    if (options.methods.length > 0 && !options.methods.includes(method)) {
      return Promise.reject(new Error('control method is not declared'));
    }
    if (signal.aborted) return Promise.reject(new Error('control call cancelled'));
    let key: string;
    try {
      key = `${method}:${JSON.stringify(payload)}`;
    } catch {
      return Promise.reject(new Error('control packet is too large'));
    }
    let operation = shared.get(key);
    let messageToSend: ControlCallMessage | undefined;
    if (operation === undefined) {
      if (shared.size >= CONTROL_IPC_MAX_CONCURRENCY) return Promise.reject(new Error('control concurrency limit reached'));
      const requestId = randomUUID();
      const deadlineAt = now() + CONTROL_IPC_MAX_DEADLINE_MS;
      const message: ControlCallMessage = { kind: 'plugin-control-call', requestId, identity, binding: options.binding, method, payload, deadlineAt };
      if (jsonBytes(message) > CONTROL_IPC_MAX_PACKET_BYTES) return Promise.reject(new Error('control packet is too large'));
      const timer = setTimeout(() => {
        if (operation !== undefined) finish(operation, new Error('control call deadline exceeded'));
      }, Math.max(1, deadlineAt - now()));
      operation = { key, requestId, binding: options.binding, method, cancelSent: false, waiters: new Set(), timer };
      shared.set(key, operation);
      pending.set(requestId, { binding: options.binding, method, operation });
      messageToSend = message;
    }
    const result = new Promise<TResult>((resolve, reject) => {
      const waiter: { pending: Pending<unknown>; cancel: () => void; cleanup: () => void } = {
        pending: { resolve, reject },
        cleanup: () => signal.removeEventListener('abort', waiter.cancel),
        cancel: () => {
          if (!operation?.waiters.delete(waiter)) return;
          waiter.cleanup();
          reject(new Error('control call cancelled'));
          if (operation.waiters.size === 0) finish(operation, new Error('control call cancelled'));
        },
      };
      operation!.waiters.add(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
    if (messageToSend !== undefined) {
      try {
        ensureSubscribed();
      } catch {
        finish(operation, new Error('control subscribe failed'));
        return result;
      }
      if (shared.get(key) === operation) void options.transport.send(messageToSend).catch(() => {
        if (operation !== undefined) finish(operation, new Error('control send failed'));
      });
    }
    return result;
  }
  const client = { call } satisfies BoundControlClient;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const operation of [...shared.values()]) finish(operation, new Error('control client disposed'));
    disconnected = true;
    detachIfIdle();
  };
  CLIENT_DISPOSERS.set(client, dispose);
  return client;
}

function sameBinding(left: ControlBindingIdentity, right: ControlBindingIdentity): boolean {
  return left.plugin === right.plugin && left.contributionId === right.contributionId
    && left.bindingId === right.bindingId
    && JSON.stringify(left.bindingOptions) === JSON.stringify(right.bindingOptions);
}

const CLIENT_DISPOSERS = new WeakMap<BoundControlClient, () => void>();

export function disposeBoundControlClient(client: BoundControlClient): void {
  CLIENT_DISPOSERS.get(client)?.();
}
