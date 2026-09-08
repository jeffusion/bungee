import { isLowercaseUuid } from '../config-storage/validation';
import type { PublicationScheduler, ScheduledTimeout } from './coordinator-types';
import { sameProcessIdentity } from './message-fields';
import { parseConfigMasterMessage } from './master-messages';
import type {
  ConfigControlResponse,
  ConfigMasterMessage,
  ConfigProcessIdentity,
} from './types';
import { assertNeverConfigPublicationMessage } from './types';
import type {
  ConfigWorkerRuntimeController,
  ConfigWorkerRuntimeMessage,
} from './worker-runtime';
import { isControlIpcMessage, type ControlIpcMessage } from '../plugin-control/ipc';

export type ConfigWorkerSignal = 'SIGINT' | 'SIGTERM';

export interface ConfigWorkerProcessChannel {
  readonly pid: number;
  getParentPid(): number;
  send(message: ConfigWorkerRuntimeMessage): Promise<void>;
  sendControl?(message: ControlIpcMessage): Promise<void>;
  subscribeMessage(listener: (message: unknown) => void): () => void;
  subscribeDisconnect(listener: () => void): () => void;
  subscribeSignal(signal: ConfigWorkerSignal, listener: () => void): () => void;
  exit(code: number): void;
}

export type ConfigWorkerProcessRuntimeOptions = {
  readonly identity: ConfigProcessIdentity;
  readonly masterPid: number;
  readonly heartbeatTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly channel: ConfigWorkerProcessChannel;
  readonly scheduler: PublicationScheduler;
  readonly controller: ConfigWorkerRuntimeController;
  readonly onControlResponse?: (message: ConfigControlResponse) => Promise<void>;
  readonly onControlMessage?: (message: ControlIpcMessage) => void;
  readonly onDisconnect?: () => void;
  readonly onShutdown?: () => void | Promise<void>;
};

export interface ConfigWorkerProcessRuntime {
  start(): Promise<void>;
}

type RuntimePhase = 'created' | 'active' | 'stopping' | 'stopped';

export function createConfigWorkerProcessRuntime(
  options: ConfigWorkerProcessRuntimeOptions,
): ConfigWorkerProcessRuntime {
  const identity = { ...options.identity };
  let phase: RuntimePhase = 'created';
  let sequence = 0;
  let deadline: ScheduledTimeout | null = null;
  let shutdownWatchdog: ScheduledTimeout | null = null;
  let queue = Promise.resolve();
  let shutdownPromise: Promise<void> | null = null;
  let shutdownExitCode: number | null = null;
  let exitAttempted = false;
  let exitRequested = false;
  const unsubscribers: Array<() => void> = [];

  function validOptions(): boolean {
    return Number.isSafeInteger(options.channel.pid) && options.channel.pid > 0
      && Number.isSafeInteger(options.masterPid) && options.masterPid > 0
      && Number.isSafeInteger(options.heartbeatTimeoutMs) && options.heartbeatTimeoutMs > 0
      && Number.isSafeInteger(options.shutdownTimeoutMs) && options.shutdownTimeoutMs > 0
      && Number.isSafeInteger(identity.worker_slot) && identity.worker_slot >= 0
      && isLowercaseUuid(identity.master_generation)
      && isLowercaseUuid(identity.worker_instance_id)
      && options.channel.getParentPid() === options.masterPid;
  }

  function bestEffort(operation: () => void): void {
    try {
      operation();
    } catch {
      return;
    }
  }

  async function bestEffortAsync(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      return;
    }
  }

  function requestExit(exitCode: number): void {
    if (exitRequested) return;
    exitAttempted = true;
    try {
      options.channel.exit(exitCode);
      exitRequested = true;
      phase = 'stopped';
    } catch {
      return;
    }
  }

  async function performShutdown(exitCode: number): Promise<void> {
    if (deadline !== null) {
      const currentDeadline = deadline;
      deadline = null;
      bestEffort(() => currentDeadline.cancel());
    }
    for (const unsubscribe of unsubscribers.splice(0)) bestEffort(unsubscribe);
    try {
      shutdownWatchdog = options.scheduler.schedule(options.shutdownTimeoutMs, () => {
        requestExit(exitCode);
      });
    } catch {
      requestExit(exitCode);
    }
    if (options.onShutdown !== undefined) {
      await bestEffortAsync(async () => { await options.onShutdown?.(); });
    }
    await bestEffortAsync(() => options.controller.failClosed());
    if (shutdownWatchdog !== null) {
      const watchdog = shutdownWatchdog;
      shutdownWatchdog = null;
      bestEffort(() => watchdog.cancel());
    }
    requestExit(exitCode);
  }

  function shutdown(exitCode: number): Promise<void> {
    if (shutdownPromise !== null) {
      if (exitAttempted && !exitRequested && shutdownExitCode !== null) {
        requestExit(shutdownExitCode);
      }
      return shutdownPromise;
    }
    shutdownExitCode = exitCode;
    phase = 'stopping';
    shutdownPromise = performShutdown(exitCode);
    return shutdownPromise;
  }

  function replaceDeadline(): void {
    if (deadline !== null) {
      const currentDeadline = deadline;
      deadline = null;
      currentDeadline.cancel();
    }
    const nextDeadline = options.scheduler.schedule(options.heartbeatTimeoutMs, () => {
      void shutdown(1);
    });
    if (phase === 'active') deadline = nextDeadline;
    else bestEffort(() => nextDeadline.cancel());
  }

  function installSubscription(subscribe: () => () => void): boolean {
    const unsubscribe = subscribe();
    if (phase === 'active') {
      unsubscribers.push(unsubscribe);
      return true;
    }
    bestEffort(unsubscribe);
    return false;
  }

  async function applyMessage(message: ConfigMasterMessage): Promise<void> {
    if (phase !== 'active') return;
    if ('status' in message) {
      if (options.onControlResponse === undefined) {
        await shutdown(1);
        return;
      }
      await options.onControlResponse(message);
      return;
    }
    const result = await options.controller.apply(message);
    if (!result.ok) {
      await shutdown(1);
      return;
    }
    if (phase === 'active') await options.channel.send(result.message);
  }

  function enqueue(message: ConfigMasterMessage): void {
    const pending = queue.then(() => applyMessage(message));
    queue = pending.then(
      () => undefined,
      () => shutdown(1).then(() => undefined),
    );
  }

  function acceptMessage(input: unknown): void {
    if (phase !== 'active') return;
    if (isControlIpcMessage(input)) {
      options.onControlMessage?.(input);
      return;
    }
    let message: ConfigMasterMessage;
    try {
      message = parseConfigMasterMessage(input);
      if (!sameProcessIdentity(message, identity)
        || options.channel.getParentPid() !== options.masterPid) {
        void shutdown(1);
        return;
      }
    } catch {
      void shutdown(1);
      return;
    }
    if ('status' in message) {
      enqueue(message);
      return;
    }
    switch (message.command) {
      case 'master-heartbeat':
        if (message.master_pid !== options.masterPid || message.sequence <= sequence) {
          void shutdown(1);
          return;
        }
        sequence = message.sequence;
        try {
          replaceDeadline();
        } catch {
          void shutdown(1);
        }
        return;
      case 'start-config-worker':
      case 'start-current-config-worker':
      case 'drain-worker':
        enqueue(message);
        return;
      default:
        assertNeverConfigPublicationMessage(message);
    }
  }

  async function start(): Promise<void> {
    if (phase !== 'created') return;
    try {
      if (!validOptions()) {
        await shutdown(1);
        return;
      }
      phase = 'active';
      replaceDeadline();
      if (phase !== 'active') return;
      if (!installSubscription(() => options.channel.subscribeMessage(acceptMessage))) return;
      if (!installSubscription(() => options.channel.subscribeDisconnect(() => {
        options.onDisconnect?.();
        void shutdown(1);
      }))) return;
      if (!installSubscription(() => options.channel.subscribeSignal('SIGINT', () => { void shutdown(0); }))) return;
      installSubscription(() => options.channel.subscribeSignal('SIGTERM', () => { void shutdown(0); }));
    } catch {
      await shutdown(1);
    }
  }

  return { start };
}
