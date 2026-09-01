import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ConfigWorkerSignal } from '../../src/config-publication';
import type { ConfigWorkerRuntimeMessage } from '../../src/config-publication/worker-runtime-contract';
import {
  ProcessConfigWorkerChannel,
  type ConfigWorkerProcess,
} from '../../src/config-worker/process-channel';

class FakeProcess implements ConfigWorkerProcess {
  readonly pid = 4321;
  readonly ppid = 1234;
  connected = true;
  sendResult = true;
  sendError: Error | null = null;
  throwOnSend: Error | null = null;
  exitCode: number | null = null;
  readonly events = new EventEmitter();

  send(_message: ConfigWorkerRuntimeMessage, callback: (error: Error | null) => void): boolean {
    if (this.throwOnSend) throw this.throwOnSend;
    callback(this.sendError);
    return this.sendResult;
  }

  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect' | ConfigWorkerSignal, listener: () => void): unknown;
  on(event: string, listener: ((message: unknown) => void) | (() => void)): unknown {
    return this.events.on(event, listener);
  }

  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'disconnect' | ConfigWorkerSignal, listener: () => void): unknown;
  off(event: string, listener: ((message: unknown) => void) | (() => void)): unknown {
    return this.events.off(event, listener);
  }

  exit(code: number): void {
    this.exitCode = code;
  }
}

const runtimeMessage: ConfigWorkerRuntimeMessage = {
  status: 'worker-drained',
  master_generation: '50000000-0000-4000-8000-000000000001',
  worker_instance_id: '60000000-0000-4000-8000-000000000001',
  worker_slot: 0,
  pid: 4321,
  revision: 1,
  content_hash: `sha256:${'a'.repeat(64)}`,
  plugin_catalog_hash: `sha256:${'b'.repeat(64)}`,
  publication: null,
};

async function expectRejected(promise: Promise<void>, message: string): Promise<void> {
  await promise.then(
    () => { throw new Error('expected send to fail'); },
    (error: unknown) => expect(String(error)).toContain(message),
  );
}

describe('process config worker channel', () => {
  test('treats false send return as backpressure and resolves via callback', async () => {
    const source = new FakeProcess();
    source.sendResult = false;
    await new ProcessConfigWorkerChannel(source).send(runtimeMessage);
  });

  test('rejects disconnected, callback-error, and throwing sends', async () => {
    const source = new FakeProcess();
    const channel = new ProcessConfigWorkerChannel(source);
    source.connected = false;
    await expectRejected(channel.send(runtimeMessage), 'disconnected');
    source.connected = true;
    source.sendError = new Error('callback failed');
    await expectRejected(channel.send(runtimeMessage), 'callback failed');
    source.sendError = null;
    source.throwOnSend = new Error('send threw');
    await expectRejected(channel.send(runtimeMessage), 'send threw');
  });

  test('subscribes and removes exact message, disconnect, and signal listeners', () => {
    const source = new FakeProcess();
    const channel = new ProcessConfigWorkerChannel(source);
    const unsubscribers = [
      channel.subscribeMessage(() => undefined),
      channel.subscribeDisconnect(() => undefined),
      channel.subscribeSignal('SIGINT', () => undefined),
      channel.subscribeSignal('SIGTERM', () => undefined),
    ];
    expect(['message', 'disconnect', 'SIGINT', 'SIGTERM'].map((event) => source.events.listenerCount(event)))
      .toEqual([1, 1, 1, 1]);
    for (const unsubscribe of unsubscribers) unsubscribe();
    expect(['message', 'disconnect', 'SIGINT', 'SIGTERM'].map((event) => source.events.listenerCount(event)))
      .toEqual([0, 0, 0, 0]);
  });

  test('owns process exit', () => {
    const source = new FakeProcess();
    new ProcessConfigWorkerChannel(source).exit(7);
    expect(source.exitCode).toBe(7);
  });
});
