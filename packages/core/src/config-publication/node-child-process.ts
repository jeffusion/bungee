import type { ChildProcess } from 'node:child_process';
import { isLowercaseUuid } from '../config-storage/validation';
import type {
  ConfigPublicationWorkerProcess,
  WorkerExitEvidence,
} from './coordinator-types';
import type { ConfigMasterMessage, ConfigProcessIdentity } from './types';

export type NodeChildProcessAdapterErrorCode =
  | 'invalid_process'
  | 'disconnected'
  | 'send_failed'
  | 'termination_failed';

export class NodeChildProcessAdapterError extends Error {
  readonly name = 'NodeChildProcessAdapterError';

  constructor(readonly code: NodeChildProcessAdapterErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class NodeChildProcessAdapter implements ConfigPublicationWorkerProcess {
  readonly pid: number;
  readonly slot: number;
  readonly identity: ConfigProcessIdentity;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<(evidence: WorkerExitEvidence) => void>();
  private readonly pendingSendFailures = new Set<(error: NodeChildProcessAdapterError) => void>();
  private exitEvidence: WorkerExitEvidence | null = null;
  private ipcError: NodeChildProcessAdapterError | null = null;

  constructor(
    private readonly child: ChildProcess,
    identity: ConfigProcessIdentity,
  ) {
    if (child.pid === undefined || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new NodeChildProcessAdapterError('invalid_process', 'child process must have a positive pid');
    }
    if (!Number.isSafeInteger(identity.worker_slot) || identity.worker_slot < 0
      || !isLowercaseUuid(identity.master_generation) || !isLowercaseUuid(identity.worker_instance_id)) {
      throw new NodeChildProcessAdapterError('invalid_process', 'child process identity is invalid');
    }
    this.identity = { ...identity };
    this.pid = child.pid;
    this.slot = this.identity.worker_slot;
    child.on('message', this.handleMessage);
    child.on('exit', this.handleExit);
    child.on('disconnect', this.handleDisconnect);
    child.on('error', this.handleError);
  }

  private readonly handleMessage = (message: unknown): void => {
    for (const listener of this.messageListeners) listener(message);
  };

  private readonly handleExit = (): void => {
    if (this.exitEvidence !== null) return;
    const evidence = { exited: true, pid: this.pid } satisfies WorkerExitEvidence;
    this.transitionIpc(
      new NodeChildProcessAdapterError('disconnected', 'child process exited'),
    );
    this.exitEvidence = evidence;
    this.child.off('exit', this.handleExit);
    this.child.off('error', this.handleError);
    for (const listener of this.exitListeners) listener(evidence);
    this.exitListeners.clear();
  };

  private readonly handleError = (error: Error): void => {
    this.transitionIpc(new NodeChildProcessAdapterError('send_failed', 'child process emitted an error', error));
  };

  private readonly handleDisconnect = (): void => {
    this.transitionIpc(new NodeChildProcessAdapterError('disconnected', 'child IPC channel disconnected'));
  };

  private transitionIpc(error: NodeChildProcessAdapterError): void {
    if (this.ipcError !== null) return;
    this.ipcError = error;
    this.child.off('message', this.handleMessage);
    this.child.off('disconnect', this.handleDisconnect);
    for (const reject of this.pendingSendFailures) reject(error);
    this.pendingSendFailures.clear();
    this.messageListeners.clear();
  }

  send(message: ConfigMasterMessage): Promise<void> {
    if (this.ipcError !== null) return Promise.reject(this.ipcError);
    if (!this.child.connected) return Promise.reject(
      new NodeChildProcessAdapterError('disconnected', 'child IPC channel is disconnected'),
    );
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: NodeChildProcessAdapterError): void => {
        if (settled) return;
        settled = true;
        this.pendingSendFailures.delete(fail);
        reject(error);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        this.pendingSendFailures.delete(fail);
        resolve();
      };
      this.pendingSendFailures.add(fail);
      try {
        this.child.send(message, (error) => {
          if (error === null) succeed();
          else fail(new NodeChildProcessAdapterError('send_failed', 'child IPC send failed', error));
        });
      } catch (error) {
        fail(new NodeChildProcessAdapterError('send_failed', 'child IPC send threw', error));
      }
    });
  }

  subscribeMessage(listener: (message: unknown) => void): () => void {
    if (this.ipcError !== null) return () => undefined;
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  subscribeExit(listener: (evidence: WorkerExitEvidence) => void): () => void {
    if (this.exitEvidence !== null) {
      listener(this.exitEvidence);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  terminate(mode: 'graceful' | 'force'): Promise<void> {
    if (this.exitEvidence !== null) return Promise.resolve();
    const signal = mode === 'graceful' ? 'SIGTERM' : 'SIGKILL';
    try {
      if (this.child.kill(signal)) return Promise.resolve();
      if (this.exitEvidence !== null) return Promise.resolve();
      return Promise.reject(new NodeChildProcessAdapterError(
        'termination_failed', `child process rejected ${signal}`,
      ));
    } catch (error) {
      if (this.exitEvidence !== null) return Promise.resolve();
      return Promise.reject(new NodeChildProcessAdapterError(
        'termination_failed', `child process ${signal} threw`, error,
      ));
    }
  }
}
