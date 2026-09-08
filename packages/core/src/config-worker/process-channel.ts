import type {
  ConfigWorkerProcessChannel,
  ConfigWorkerSignal,
} from '../config-publication/worker-process-runtime';
import type { ConfigWorkerRuntimeMessage } from '../config-publication/worker-runtime-contract';
import type { ControlIpcMessage } from '../plugin-control/ipc';

export interface ConfigWorkerProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly connected?: boolean;
  send(message: ConfigWorkerRuntimeMessage, callback: (error: Error | null) => void): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect' | ConfigWorkerSignal, listener: () => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'disconnect' | ConfigWorkerSignal, listener: () => void): unknown;
  exit(code: number): void;
}

class NativeConfigWorkerProcess implements ConfigWorkerProcess {
  readonly pid = process.pid;
  get ppid(): number { return process.ppid; }
  get connected(): boolean { return process.connected === true; }

  send(message: ConfigWorkerRuntimeMessage, callback: (error: Error | null) => void): boolean {
    if (process.send === undefined) {
      callback(new Error('worker IPC channel is unavailable'));
      return false;
    }
    return process.send(message, callback);
  }

  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect' | ConfigWorkerSignal, listener: () => void): unknown;
  on(event: 'message' | 'disconnect' | ConfigWorkerSignal, listener: ((message: unknown) => void) | (() => void)): unknown {
    return process.on(event, listener);
  }

  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'disconnect' | ConfigWorkerSignal, listener: () => void): unknown;
  off(event: 'message' | 'disconnect' | ConfigWorkerSignal, listener: ((message: unknown) => void) | (() => void)): unknown {
    return process.off(event, listener);
  }

  exit(code: number): void {
    process.exit(code);
  }
}

export class ProcessConfigWorkerChannel implements ConfigWorkerProcessChannel {
  readonly pid: number;

  constructor(private readonly source: ConfigWorkerProcess = new NativeConfigWorkerProcess()) {
    this.pid = source.pid;
  }

  getParentPid(): number {
    return this.source.ppid;
  }

  send(message: ConfigWorkerRuntimeMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.source.connected) {
        reject(new Error('worker IPC channel is disconnected'));
        return;
      }
      try {
        this.source.send(message, (error: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  sendControl(message: ControlIpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.source.connected) { reject(new Error('worker IPC channel is disconnected')); return; }
      try {
        this.source.send(message as unknown as ConfigWorkerRuntimeMessage, (error: Error | null) => {
          if (error) reject(error); else resolve();
        });
      } catch (error) { reject(error); }
    });
  }

  subscribeMessage(listener: (message: unknown) => void): () => void {
    this.source.on('message', listener);
    return () => { this.source.off('message', listener); };
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.source.on('disconnect', listener);
    return () => { this.source.off('disconnect', listener); };
  }

  subscribeSignal(signal: ConfigWorkerSignal, listener: () => void): () => void {
    this.source.on(signal, listener);
    return () => { this.source.off(signal, listener); };
  }

  exit(code: number): void {
    this.source.exit(code);
  }
}
