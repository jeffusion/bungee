import type {
  ConfigControlResponse,
  ConfigProcessIdentity,
  ConfigWorkerProcessChannel,
  ConfigWorkerRuntimeController,
  ConfigWorkerRuntimeMessage,
  PublicationScheduler,
  ScheduledTimeout,
} from '../../src/config-publication';

export const IDENTITY: ConfigProcessIdentity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 2,
};

type Listener = () => void;
type MessageListener = (message: unknown) => void;
type Signal = 'SIGINT' | 'SIGTERM';

export class ManualScheduler implements PublicationScheduler {
  readonly tasks: Array<{ callback: Listener; timeout: FakeTimeout }> = [];
  scheduleFailure: Error | undefined;
  scheduleFailureCall: number | undefined;
  scheduleCalls = 0;
  cancelFailure: Error | undefined;
  fireDuringSchedule = false;

  schedule(_delayMs: number, callback: Listener): ScheduledTimeout {
    this.scheduleCalls += 1;
    if (this.scheduleFailure !== undefined || this.scheduleFailureCall === this.scheduleCalls) {
      throw this.scheduleFailure ?? new Error('schedule failed');
    }
    const timeout = new FakeTimeout(this);
    this.tasks.push({ callback, timeout });
    if (this.fireDuringSchedule) callback();
    return timeout;
  }

  fire(index: number): void {
    const task = this.tasks[index];
    if (task !== undefined && !task.timeout.cancelled) task.callback();
  }
}

class FakeTimeout implements ScheduledTimeout {
  cancelled = false;
  cancelCalls = 0;

  constructor(private readonly scheduler: ManualScheduler) {}

  cancel(): void {
    this.cancelled = true;
    this.cancelCalls += 1;
    if (this.scheduler.cancelFailure !== undefined) throw this.scheduler.cancelFailure;
  }
}

export class FakeChannel implements ConfigWorkerProcessChannel {
  readonly pid: number;
  parentPid = 4321;
  parentPidFailure: Error | undefined;
  readonly sent: ConfigWorkerRuntimeMessage[] = [];
  readonly exits: number[] = [];
  readonly subscriptionCalls: string[] = [];
  messageListener: MessageListener | undefined;
  disconnectListener: Listener | undefined;
  readonly signalListeners = new Map<Signal, Listener>();
  sendFailure: Error | undefined;
  holdSend = false;
  releaseSend: Listener | undefined;
  subscribeFailure: string | undefined;
  messageDuringSubscribe: unknown | undefined;
  unsubscribeFailure: Error | undefined;
  exitFailure: Error | undefined;
  readonly exited: Promise<number>;
  private resolveExit: ((code: number) => void) | undefined;
  private readonly sendWaiters: Array<{ count: number; resolve: Listener }> = [];

  constructor(pid = 777) {
    this.pid = pid;
    this.exited = new Promise<number>((resolve) => { this.resolveExit = resolve; });
  }

  getParentPid(): number {
    if (this.parentPidFailure !== undefined) throw this.parentPidFailure;
    return this.parentPid;
  }

  async send(message: ConfigWorkerRuntimeMessage): Promise<void> {
    if (this.sendFailure !== undefined) throw this.sendFailure;
    this.sent.push(message);
    for (const waiter of this.sendWaiters) {
      if (this.sent.length >= waiter.count) waiter.resolve();
    }
    if (this.holdSend) await new Promise<void>((resolve) => { this.releaseSend = resolve; });
  }

  subscribeMessage(listener: MessageListener): Listener {
    if (this.subscribeFailure === 'message') throw new Error('message subscribe failed');
    this.subscriptionCalls.push('subscribe:message');
    this.messageListener = listener;
    if (this.messageDuringSubscribe !== undefined) listener(this.messageDuringSubscribe);
    return () => {
      this.subscriptionCalls.push('unsubscribe:message');
      if (this.unsubscribeFailure !== undefined) throw this.unsubscribeFailure;
    };
  }

  subscribeDisconnect(listener: Listener): Listener {
    if (this.subscribeFailure === 'disconnect') throw new Error('disconnect subscribe failed');
    this.subscriptionCalls.push('subscribe:disconnect');
    this.disconnectListener = listener;
    return () => {
      this.subscriptionCalls.push('unsubscribe:disconnect');
      if (this.unsubscribeFailure !== undefined) throw this.unsubscribeFailure;
    };
  }

  subscribeSignal(signal: Signal, listener: Listener): Listener {
    if (this.subscribeFailure === signal) throw new Error(`${signal} subscribe failed`);
    this.subscriptionCalls.push(`subscribe:${signal}`);
    this.signalListeners.set(signal, listener);
    return () => {
      this.subscriptionCalls.push(`unsubscribe:${signal}`);
      if (this.unsubscribeFailure !== undefined) throw this.unsubscribeFailure;
    };
  }

  exit(code: number): void {
    this.exits.push(code);
    if (this.exitFailure !== undefined) throw this.exitFailure;
    this.resolveExit?.(code);
  }

  emitMessage(message: unknown): void { this.messageListener?.(message); }
  emitDisconnect(): void { this.disconnectListener?.(); }
  emitSignal(signal: Signal): void { this.signalListeners.get(signal)?.(); }

  async waitForSent(count: number): Promise<void> {
    if (this.sent.length >= count) return;
    await new Promise<void>((resolve) => { this.sendWaiters.push({ count, resolve }); });
  }

  releasePendingSend(): void {
    this.holdSend = false;
    this.releaseSend?.();
  }
}

export class FakeController implements ConfigWorkerRuntimeController {
  readonly applied: unknown[] = [];
  failClosedCalls = 0;
  holdApply = false;
  releaseApply: Listener | undefined;
  holdFailClosed = false;
  releaseFailClosed: Listener | undefined;
  failClosedFailure: Error | undefined;
  private readonly applyWaiters: Array<{ count: number; resolve: Listener }> = [];

  async apply(input: unknown) {
    this.applied.push(input);
    for (const waiter of this.applyWaiters) {
      if (this.applied.length >= waiter.count) waiter.resolve();
    }
    if (this.holdApply) await new Promise<void>((resolve) => { this.releaseApply = resolve; });
    return {
      ok: true as const,
      message: {
        status: 'worker-drained' as const,
        ...IDENTITY,
        pid: 777,
        revision: 1,
        content_hash: `sha256:${'a'.repeat(64)}` as const,
        plugin_catalog_hash: `sha256:${'b'.repeat(64)}` as const,
        publication: null,
      },
    };
  }

  async failClosed(): Promise<void> {
    this.failClosedCalls += 1;
    if (this.failClosedFailure !== undefined) throw this.failClosedFailure;
    if (this.holdFailClosed) {
      await new Promise<void>((resolve) => { this.releaseFailClosed = resolve; });
    }
  }

  releasePendingFailClosed(): void {
    this.holdFailClosed = false;
    this.releaseFailClosed?.();
  }

  async waitForApplied(count: number): Promise<void> {
    if (this.applied.length >= count) return;
    await new Promise<void>((resolve) => { this.applyWaiters.push({ count, resolve }); });
  }
}

export function heartbeat(sequence: number, identity = IDENTITY, masterPid = 4321) {
  return { command: 'master-heartbeat', ...identity, master_pid: masterPid, sequence };
}

export function controlResponse(): ConfigControlResponse {
  return {
    status: 'config-control-response', ...IDENTITY, request_id: 'request-1',
    result: { kind: 'operation', operation: null },
  };
}

export function drainCommand() {
  return {
    command: 'drain-worker', ...IDENTITY, revision: 1,
    content_hash: `sha256:${'a'.repeat(64)}` as const,
    plugin_catalog_hash: `sha256:${'b'.repeat(64)}` as const,
    publication: null,
  };
}

export async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
